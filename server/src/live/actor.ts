import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
	PendingInteraction,
	RespondRequest,
	ResponseReceipt,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
} from "@omp-mobile/protocol";
import type { History, SessionMeta } from "../history/api.ts";
import type { ExtensionEvent, LiveNotification, LiveOptions } from "./api.ts";
import { CollabGuest, findCollabLink } from "./collab.ts";
import {
	normalizeCollabUiRequest,
	normalizeRpcUiRequest,
	planResponse,
	receipt,
	requestToPending,
	type InteractionRecord,
	type UiRequest,
} from "./interactions.ts";
import { RpcSupervisor } from "./rpc.ts";
import { publicLiveness, reduceOwnership, type OwnershipEvent, type OwnershipState } from "./state.ts";

type Frame = Record<string, unknown>;
type ActorHooks = {
	changed(actor: SessionActor, transition: boolean): void;
	notify(notification: LiveNotification): void;
};
type RawExtensionEvent = ExtensionEvent & { toolCallId?: string; reason?: string };

function textBlocks(message: unknown): Array<{ kind: "text" | "thinking"; text: string }> {
	if (!message || typeof message !== "object" || !("content" in message)) return [];
	const content = message.content;
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const blocks: Array<{ kind: "text" | "thinking"; text: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || !("type" in part) || !("text" in part) || typeof part.text !== "string")
			continue;
		if (part.type === "text") blocks.push({ kind: "text", text: part.text });
		else if (part.type === "thinking") blocks.push({ kind: "thinking", text: part.text });
	}
	return blocks;
}

function messageTimestamp(message: unknown): number {
	if (!message || typeof message !== "object" || !("timestamp" in message)) return Date.now();
	return typeof message.timestamp === "number"
		? message.timestamp
		: typeof message.timestamp === "string"
			? Date.parse(message.timestamp)
			: Date.now();
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value) {
		const blocks = value.content;
		if (Array.isArray(blocks))
			return blocks
				.map((block) =>
					block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "",
				)
				.join("\n");
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export class SessionActor {
	sessionId: string;
	meta: SessionMeta;
	state: OwnershipState = { kind: "idle" };
	#opts: LiveOptions;
	#hooks: ActorHooks;
	#rpc?: RpcSupervisor;
	#collab?: CollabGuest;

	async createNew(prompt: string, operationId: string): Promise<void> {
		if (this.sessionId) throw new Error("Actor already owns a session");
		const args = [
			this.#opts.ompPath,
			"--mode",
			"rpc-ui",
			"--cwd",
			this.meta.cwd,
			"-e",
			this.#opts.extensionPath,
			...(this.#opts.rpcArgs ?? []),
		];
		const rpc = new RpcSupervisor(args, this.meta.cwd);
		this.#rpc = rpc;
		this.state = reduceOwnership(this.state, { type: "server.starting", pid: rpc.pid });
		await rpc.ready();
		const state = await rpc.command({ id: `state:${operationId}`, type: "get_state" }, 30_000);
		if (
			state.success !== true ||
			!state.data ||
			typeof state.data !== "object" ||
			!("sessionId" in state.data) ||
			typeof state.data.sessionId !== "string" ||
			!("sessionFile" in state.data) ||
			typeof state.data.sessionFile !== "string"
		) {
			await rpc.close();
			throw new Error("OMP did not report the new session identity");
		}
		this.sessionId = state.data.sessionId;
		this.meta = { ...this.meta, id: state.data.sessionId, file: state.data.sessionFile };
		rpc.onFrame((frame) => this.#onFrame(frame, "rpc"));
		void rpc.exited.then(() => this.#onRpcExit(rpc));
		this.#transition({ type: "server.ready", pid: rpc.pid });
		this.#startPolling();
		this.#promptOperations.add(operationId);
		await rpc.command({ id: operationId, type: "prompt", message: prompt });
	}
	#subscribers = new Set<(message: ServerMessage) => void>();
	#pending = new Map<string, InteractionRecord>();
	#receipts = new Map<string, ResponseReceipt>();
	#promptOperations = new Set<string>();
	#live = new Map<string, TimelineItem>();
	#messageKeys = new Map<string, { role: "user" | "assistant"; timestamp: number }>();
	#lastEntryId?: string;
	#run = 0;
	#messageNumber = 0;
	#closeTimer?: ReturnType<typeof setTimeout>;
	#pollTimer?: ReturnType<typeof setInterval>;
	#handoffWait?: { promise: Promise<void>; resolve: () => void };
	#responseEvidence = new Map<string, () => void>();
	#rpcBusy = false;

	constructor(meta: SessionMeta, opts: LiveOptions, hooks: ActorHooks) {
		this.sessionId = meta.id;
		this.meta = meta;
		this.#opts = opts;
		this.#hooks = hooks;
	}
	get pending(): PendingInteraction[] {
		return [...this.#pending.values()].map((record) => record.pending);
	}
	get subscriberCount(): number {
		return this.#subscribers.size;
	}
	get liveness() {
		return publicLiveness(this.state);
	}

	async snapshot(limit: number): Promise<SessionSnapshot> {
		if (!this.meta.file) return { session: this.summary(), items: [], pending: this.pending };
		const page = await this.#opts.history.readTimeline(this.sessionId, { limit });
		const durableIds = new Set(page.items.map((item) => item.id));
		return {
			session: this.summary(),
			items: [...page.items, ...[...this.#live.values()].filter((item) => !durableIds.has(item.id))],
			olderCursor: page.olderCursor,
			pending: this.pending,
		};
	}

	summary(): SessionSummary {
		return {
			id: this.meta.id,
			title: this.meta.title,
			project: { path: this.meta.cwd, name: basename(this.meta.cwd) || this.meta.cwd },
			createdAt: this.meta.createdAt,
			updatedAt: this.meta.updatedAt,
			status:
				this.state.kind === "server" && (this.state.phase === "working" || this.state.phase === "settling")
					? "working"
					: this.meta.status,
			liveness: this.liveness,
			preview: this.meta.preview,
			pendingCount: this.#pending.size,
		};
	}

	subscribe(send: (message: ServerMessage) => void): () => void {
		this.#subscribers.add(send);
		if (this.#closeTimer) {
			clearTimeout(this.#closeTimer);
			this.#closeTimer = undefined;
		}
		if (this.state.kind === "terminal" && !this.state.attached) void this.#ensureCollab();
		return () => {
			this.#subscribers.delete(send);
			this.#scheduleClose();
			if (this.#subscribers.size === 0 && this.#pending.size === 0) this.#leaveCollab();
		};
	}

	async prompt(operationId: string, text: string): Promise<"accepted" | "duplicate"> {
		if (this.#promptOperations.has(operationId)) return "duplicate";
		this.#assertWritable();
		this.#promptOperations.add(operationId);
		try {
			if (this.state.kind === "terminal") {
				await this.#ensureCollab();
				await this.#collab!.send({ t: "prompt", text });
			} else {
				await this.#ensureRpc();
				await this.#rpc!.command({ id: operationId, type: "prompt", message: text });
			}
		} catch (error) {
			this.#promptOperations.delete(operationId);
			throw error;
		}
		return "accepted";
	}

	async abort(): Promise<void> {
		this.#assertWritable();
		if (this.state.kind === "terminal") {
			await this.#ensureCollab();
			await this.#collab!.send({ t: "abort" });
		} else if (this.#rpc) this.#rpc.send({ type: "abort" });
	}

	async handoff(): Promise<void> {
		if (!this.#rpc) return;
		if (this.state.kind === "server" && (this.state.phase === "working" || this.state.phase === "settling")) {
			this.#rpc.send({ type: "abort" });
			const gate = Promise.withResolvers<void>();
			this.#handoffWait = gate;
			await Promise.race([
				gate.promise,
				Bun.sleep(120_000).then(() => {
					throw new Error("Timed out waiting for session to settle");
				}),
			]);
		}
		await this.#closeRpc();
	}

	async respond(interactionId: string, request: RespondRequest): Promise<ResponseReceipt> {
		const prior = this.#receipts.get(request.operationId);
		if (prior) return prior;
		if (this.state.kind === "conflict") return this.#remember(receipt(request.operationId, "conflict"));
		const record = this.#pending.get(interactionId);
		if (!record) return this.#remember(receipt(request.operationId, "unavailable"));
		const plan = planResponse(record, request.response);
		if (typeof plan === "string") return this.#remember(receipt(request.operationId, plan));
		try {
			if (record.source.transport === "collab") await this.#ensureCollab();
			else await this.#ensureRpc();
			if (plan.kind === "other") {
				const editorPromise = this.#waitForEditor(record.pending.title);
				await this.#sendUi(record, { value: plan.selector });
				const editor = await editorPromise;
				record.source.requestId = editor.id;
				record.source.request = editor;
				await this.#sendUi(record, { value: plan.text });
			} else await this.#sendUi(record, plan);
			record.closed = { cancelled: request.response.kind === "cancel" };
			this.#pending.delete(interactionId);
			this.#changed(false);
			return this.#remember(receipt(request.operationId, request.response.kind === "cancel" ? "closed" : "applied"));
		} catch (error) {
			return this.#remember(
				receipt(request.operationId, "closed", error instanceof Error ? error.message : String(error)),
			);
		}
	}

	ingest(event: RawExtensionEvent): void {
		if (event.sessionFile) this.meta.file = event.sessionFile;
		if (event.cwd) this.meta.cwd = event.cwd;
		if (event.event === "session_start" && event.mode === "tui") {
			this.#transition({ type: "terminal.started", pid: event.pid });
			if (this.state.kind === "conflict") this.#scheduleClose();
			return;
		}
		if (event.event === "session_shutdown") {
			this.#transition({ type: "terminal.shutdown", pid: event.pid });
			this.#checkPid(event.pid);
			return;
		}
		if (
			event.event === "tool_approval_requested" ||
			(event.event === "tool_execution_start" && event.toolName === "ask")
		)
			void this.#ensureCollab();
		if (event.event === "agent_end" && this.state.kind === "server") void this.#notifyFinished();
	}

	async stop(): Promise<void> {
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		if (this.#closeTimer) clearTimeout(this.#closeTimer);
		this.#leaveCollab();
		if (this.#rpc) await this.#closeRpc();
	}

	async #ensureRpc(): Promise<void> {
		if (this.#rpc) return;
		if (this.state.kind !== "idle") this.#assertWritable();
		const cwdExists = await stat(this.meta.cwd).then(
			(info) => info.isDirectory(),
			() => false,
		);
		if (!cwdExists) throw new Error(`The project folder ${this.meta.cwd} no longer exists on this computer.`);
		const args = [
			this.#opts.ompPath,
			"--mode",
			"rpc-ui",
			"--resume",
			this.meta.file,
			"--cwd",
			this.meta.cwd,
			"-e",
			this.#opts.extensionPath,
			...(this.#opts.rpcArgs ?? []),
		];
		const rpc = new RpcSupervisor(args, this.meta.cwd);
		this.#rpc = rpc;
		this.#transition({ type: "server.starting", pid: rpc.pid });
		rpc.onFrame((frame) => this.#onFrame(frame, "rpc"));
		void rpc.exited.then(() => this.#onRpcExit(rpc));
		await rpc.ready();
		this.#transition({ type: "server.ready", pid: rpc.pid });
		this.#startPolling();
	}

	async #ensureCollab(): Promise<void> {
		if (this.#collab || this.state.kind !== "terminal") return;
		try {
			const link = await findCollabLink(this.#opts.ompPath, this.sessionId);
			const guest = new CollabGuest(
				(frame) => this.#onCollab(frame),
				() => {
					this.#collab = undefined;
					this.#transition({ type: "terminal.detached" });
				},
			);
			this.#collab = guest;
			await guest.connect(link);
			this.#transition({ type: "terminal.attached" });
			this.#startPolling();
		} catch {
			this.#collab = undefined;
		}
	}

	#leaveCollab(): void {
		this.#collab?.close();
		this.#collab = undefined;
		if (this.state.kind === "terminal") this.#transition({ type: "terminal.detached" });
	}

	async #onCollab(frame: Frame): Promise<void> {
		if (frame.t === "event" && frame.event && typeof frame.event === "object") {
			this.#resolveResponseEvidence();
			await this.#onFrame(frame.event as Frame, "collab");
		} else if (frame.t === "ui-request") {
			this.#resolveResponseEvidence();
			const request = normalizeCollabUiRequest(frame);
			if (request) this.#openInteraction(request, "collab", Number(request.id));
		} else if (frame.t === "ui-request-end" && typeof frame.reqId === "number") {
			this.#resolveResponseEvidence(String(frame.reqId));
			this.#closeSourceRequest(frame.reqId, false);
		} else if (frame.t === "entry") {
			this.#resolveResponseEvidence();
			await this.#reconcile();
		}
	}

	async #onFrame(frame: Frame, transport: "rpc" | "collab"): Promise<void> {
		this.#resolveResponseEvidence();
		if (frame.type === "extension_ui_request") {
			const request = normalizeRpcUiRequest(frame);
			if (request) this.#openInteraction(request, transport, request.id);
			return;
		}
		if (frame.type === "agent_start") {
			this.#rpcBusy = true;
			this.#run++;
			this.#messageNumber = 0;
			this.#transition({ type: "server.working" });
		} else if (frame.type === "message_start" || frame.type === "message_update") this.#upsertMessage(frame);
		else if (frame.type === "tool_execution_start") this.#upsertTool(frame, "running");
		else if (frame.type === "tool_execution_update") this.#upsertTool(frame, "running");
		else if (frame.type === "tool_execution_end")
			this.#upsertTool(frame, frame.isError === true ? "failed" : "succeeded");
		else if (frame.type === "agent_end") {
			this.#rpcBusy = false;
			await this.#reconcile(true);
			if (this.state.kind === "server") this.#transition({ type: "server.settling" });
			await this.#notifyFinished();
		} else if (frame.type === "session_settled") {
			this.#rpcBusy = false;
			if (this.state.kind === "server") this.#transition({ type: "server.ready" });
			this.#handoffWait?.resolve();
			this.#handoffWait = undefined;
			this.#scheduleClose();
		}
	}

	#upsertMessage(frame: Frame): void {
		if (
			!frame.message ||
			typeof frame.message !== "object" ||
			!("role" in frame.message) ||
			frame.message.role !== "assistant"
		)
			return;
		const key = typeof frame.messageId === "string" ? frame.messageId : `message-${this.#messageNumber}`;
		let itemId = [...this.#messageKeys.keys()].find((id) => id.endsWith(`:${key}`));
		if (!itemId) {
			itemId = `live:${this.#run}:${key || ++this.#messageNumber}`;
			this.#messageKeys.set(itemId, { role: "assistant", timestamp: messageTimestamp(frame.message) });
		}
		const timestamp = this.#messageKeys.get(itemId)!.timestamp;
		const item: TimelineItem = {
			id: itemId,
			kind: "assistant",
			at: new Date(timestamp).toISOString(),
			blocks: textBlocks(frame.message),
			streaming: true,
		};
		this.#live.set(itemId, item);
		this.#emit({ type: "timeline.upsert", sessionId: this.sessionId, items: [item] });
	}

	#upsertTool(frame: Frame, state: "running" | "succeeded" | "failed"): void {
		if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") return;
		const old = this.#live.get(`t:${frame.toolCallId}`);
		const previous = old?.kind === "tool" ? old : undefined;
		const argsIntent =
			frame.args && typeof frame.args === "object" && typeof (frame.args as Frame).i === "string"
				? ((frame.args as Frame).i as string)
				: undefined;
		const title = (typeof frame.intent === "string" && frame.intent) || argsIntent || previous?.title || frame.toolName;
		const input = frame.args === undefined ? (previous?.input ?? "") : outputText(frame.args);
		const result = frame.result ?? frame.partialResult;
		const item: TimelineItem = {
			id: `t:${frame.toolCallId}`,
			kind: "tool",
			at: old?.at ?? new Date().toISOString(),
			name: frame.toolName,
			title,
			input,
			state,
			...(result === undefined ? {} : { output: outputText(result) }),
		};
		this.#live.set(item.id, item);
		this.#emit({ type: "timeline.upsert", sessionId: this.sessionId, items: [item] });
	}

	#openInteraction(request: UiRequest, transport: "rpc" | "collab", requestId: string | number): void {
		for (const record of this.#pending.values())
			if (
				record.pending.kind === "question" &&
				record.pending.allowOther &&
				request.method === "editor" &&
				record.pending.title === request.title &&
				record.otherEditor
			) {
				record.otherEditor.requestId = requestId;
				record.otherEditor.resolve(request);
				return;
			}
		const pending = requestToPending(this.sessionId, request);
		const record: InteractionRecord = { pending, source: { transport, requestId, request } };
		this.#pending.set(pending.id, record);
		this.#changed(false);
		this.#hooks.notify({
			sessionId: this.sessionId,
			category: pending.kind === "approval" ? "OMP_APPROVAL" : "OMP_QUESTION",
			title: this.meta.title,
			body: pending.kind === "approval" ? pending.detail || pending.title : pending.title,
			interaction: pending,
			collapseKey: pending.id,
		});
	}

	#closeSourceRequest(requestId: string | number, cancelled: boolean): void {
		for (const [id, record] of this.#pending)
			if (String(record.source.requestId) === String(requestId)) {
				record.closed = { cancelled };
				this.#pending.delete(id);
				this.#changed(false);
			}
	}

	async #waitForEditor(title: string): Promise<UiRequest> {
		const record = [...this.#pending.values()].find(
			(candidate) =>
				candidate.pending.title === title && candidate.pending.kind === "question" && candidate.pending.allowOther,
		);
		if (!record) throw new Error("Interaction closed before custom answer");
		const gate = Promise.withResolvers<UiRequest>();
		record.otherEditor = { requestId: "", resolve: gate.resolve, reject: gate.reject };
		return await Promise.race([
			gate.promise,
			Bun.sleep(30_000).then(() => {
				throw new Error("Custom answer editor did not open");
			}),
		]);
	}

	async #sendUi(
		record: InteractionRecord,
		value: { value?: string; confirmed?: boolean; cancelled?: true },
	): Promise<void> {
		const key = String(record.source.requestId);
		const gate = Promise.withResolvers<void>();
		this.#responseEvidence.set(key, gate.resolve);
		if (record.source.transport === "rpc") this.#rpc!.send({ type: "extension_ui_response", id: key, ...value });
		else await this.#collab!.send({ t: "ui-response", reqId: Number(record.source.requestId), ...value });
		await Promise.race([
			gate.promise,
			Bun.sleep(30_000).then(() => {
				this.#responseEvidence.delete(key);
				throw new Error("OMP did not confirm closing the interaction");
			}),
		]);
	}

	#resolveResponseEvidence(key?: string): void {
		if (key) {
			const resolve = this.#responseEvidence.get(key);
			if (resolve) {
				this.#responseEvidence.delete(key);
				resolve();
			}
			return;
		}
		for (const resolve of this.#responseEvidence.values()) resolve();
		this.#responseEvidence.clear();
	}

	async #reconcile(retireAll = false): Promise<void> {
		const tail = await this.#opts.history.readTail(this.sessionId, { afterEntryId: this.#lastEntryId, limit: 500 });
		if (tail.lastEntryId) this.#lastEntryId = tail.lastEntryId;
		const retire: string[] = [];
		for (const [liveId, key] of this.#messageKeys)
			if (
				retireAll ||
				tail.messageKeys.some((durable) => durable.role === key.role && durable.timestamp === key.timestamp)
			) {
				retire.push(liveId);
				this.#messageKeys.delete(liveId);
				this.#live.delete(liveId);
			}
		if (retireAll)
			for (const [id, item] of this.#live)
				if (item.kind === "assistant") {
					retire.push(id);
					this.#live.delete(id);
				}
		if (retire.length) this.#emit({ type: "timeline.retire", sessionId: this.sessionId, ids: retire });
		if (tail.items.length) this.#emit({ type: "timeline.upsert", sessionId: this.sessionId, items: tail.items });
	}

	#startPolling(): void {
		if (this.#pollTimer) return;
		this.#pollTimer = setInterval(() => void this.#reconcile(), 400);
	}
	#emit(message: ServerMessage): void {
		for (const send of this.#subscribers) send(message);
	}
	#changed(transition: boolean): void {
		this.#emit({ type: "session.update", sessionId: this.sessionId, session: this.summary(), pending: this.pending });
		this.#hooks.changed(this, transition);
	}
	#transition(event: OwnershipEvent): void {
		const before = JSON.stringify(publicLiveness(this.state));
		this.state = reduceOwnership(this.state, event);
		this.#changed(before !== JSON.stringify(publicLiveness(this.state)));
	}
	#remember(value: ResponseReceipt): ResponseReceipt {
		this.#receipts.set(value.operationId, value);
		return value;
	}
	#assertWritable(): void {
		if (this.state.kind === "conflict") throw new Error("Session ownership conflict");
		if (this.state.kind === "unavailable") throw new Error(this.state.reason);
		if (this.state.kind === "terminal" && this.state.shutdownSeen) throw new Error("Terminal session is shutting down");
	}
	#scheduleClose(): void {
		if (
			!this.#rpc ||
			this.#subscribers.size ||
			this.#rpcBusy ||
			(this.state.kind === "server" && (this.state.phase === "working" || this.state.phase === "settling"))
		)
			return;
		if (this.#closeTimer) clearTimeout(this.#closeTimer);
		this.#closeTimer = setTimeout(() => void this.#closeRpc(), this.#opts.settleGraceMs ?? 30_000);
	}
	async #closeRpc(): Promise<void> {
		const rpc = this.#rpc;
		if (!rpc) return;
		this.#rpc = undefined;
		try {
			await rpc.close();
		} finally {
			if (this.state.kind === "server" || this.state.kind === "conflict") this.#transition({ type: "server.closed" });
		}
	}
	#onRpcExit(rpc: RpcSupervisor): void {
		if (this.#rpc !== rpc) return;
		this.#rpc = undefined;
		for (const [id, record] of this.#pending)
			if (record.source.transport === "rpc") {
				record.closed = { cancelled: true };
				this.#pending.delete(id);
			}
		for (const [id, item] of this.#live)
			if (item.kind === "assistant")
				this.#live.set(id, {
					...item,
					streaming: false,
					stopReason: "error",
					error: "OMP process exited before completion",
				});
		this.#transition({ type: "server.crashed" });
	}
	#checkPid(pid: number): void {
		const poll = () => {
			try {
				process.kill(pid, 0);
				setTimeout(poll, 250).unref();
			} catch {
				this.#transition({ type: "terminal.pidGone", pid });
			}
		};
		poll();
	}
	async #notifyFinished(): Promise<void> {
		const tail = await this.#opts.history.readTail(this.sessionId, { limit: 20 });
		const assistant = [...tail.items].reverse().find((item) => item.kind === "assistant");
		const body =
			assistant?.kind === "assistant"
				? assistant.blocks
						.filter((block) => block.kind === "text")
						.map((block) => block.text)
						.join(" ")
						.slice(0, 180) || "New activity"
				: "New activity";
		this.#hooks.notify({
			sessionId: this.sessionId,
			category: "OMP_INFO",
			title: "Finished",
			body,
			collapseKey: `finished:${this.sessionId}`,
		});
	}
}
