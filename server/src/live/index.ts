import type { CreateSessionRequest, PromptRequest, RespondRequest, ServerMessage } from "@omp-mobile/protocol";
import type { SessionMeta } from "../history/api.ts";
import { SessionActor } from "./actor.ts";
import type { CreateLiveHub, ExtensionEvent, LiveHub, LiveNotification, LiveOptions } from "./api.ts";
import { startLocalRelay, type LocalRelay } from "./relay.ts";

class Hub implements LiveHub {
	#opts: LiveOptions;
	#actors = new Map<string, SessionActor>();
	#broadcasts = new Set<(message: ServerMessage) => void>();
	#notifications = new Set<(notification: LiveNotification) => void>();
	#relay?: LocalRelay;
	#problems: string[] = [];
	#creating = new Map<string, Promise<SessionActor | null>>();
	#provisional = new Set<string>();

	constructor(opts: LiveOptions) {
		this.#opts = opts;
	}
	async start(): Promise<void> {
		if (!this.#relay) this.#relay = startLocalRelay(this.#opts.relayPort);
	}
	async stop(): Promise<void> {
		await Promise.all([...this.#actors.values()].map((actor) => actor.stop()));
		this.#actors.clear();
		this.#relay?.stop();
		this.#relay = undefined;
	}
	overlay(sessionId: string) {
		const actor = this.#actors.get(sessionId);
		return actor
			? { liveness: actor.liveness, pendingCount: actor.pending.length }
			: { liveness: { kind: "idle" as const }, pendingCount: 0 };
	}
	activeSummaries() {
		return [...this.#provisional].flatMap((sessionId) => {
			const actor = this.#actors.get(sessionId);
			return actor ? [actor.summary()] : [];
		});
	}
	async snapshot(sessionId: string, limit: number) {
		const actor = await this.#actor(sessionId);
		if (actor) {
			if (this.#provisional.has(sessionId)) return { session: actor.summary(), items: [], pending: actor.pending };
			return actor.snapshot(limit);
		}
		const meta = await this.#opts.history.getSession(sessionId);
		if (!meta) return null;
		const page = await this.#opts.history.readTimeline(sessionId, { limit });
		return { session: this.#summary(meta), items: page.items, olderCursor: page.olderCursor, pending: [] };
	}

	subscribe(sessionId: string, send: (message: ServerMessage) => void): () => void {
		let active = true;
		let unsubscribe: (() => void) | undefined;
		void this.#actor(sessionId).then((actor) => {
			if (!actor || !active) return;
			unsubscribe = actor.subscribe(send);
			void actor.snapshot(40).then((snapshot) => {
				if (active) send({ type: "session.snapshot", sessionId, snapshot });
			});
		});
		return () => {
			active = false;
			unsubscribe?.();
		};
	}
	onBroadcast(send: (message: ServerMessage) => void): () => void {
		this.#broadcasts.add(send);
		return () => this.#broadcasts.delete(send);
	}

	async createSession(req: CreateSessionRequest): Promise<{ sessionId: string }> {
		const cwd = await this.#opts.history.resolveProjectDir(req.cwd);
		const now = new Date().toISOString();
		const actor = new SessionActor(
			{
				id: "",
				file: "",
				cwd,
				title: req.prompt.slice(0, 80) || "New session",
				createdAt: now,
				updatedAt: now,
				status: "pending",
				preview: req.prompt,
			},
			this.#opts,
			this.#hooks(),
		);
		await actor.createNew(req.prompt, req.operationId, req.images ?? []);
		this.#actors.set(actor.sessionId, actor);
		this.#broadcast();
		return { sessionId: actor.sessionId };
	}
	async prompt(sessionId: string, req: PromptRequest) {
		const actor = await this.#required(sessionId);
		return { state: await actor.prompt(req.operationId, req.text, req.images ?? []) };
	}
	async abort(sessionId: string): Promise<void> {
		await (await this.#required(sessionId)).abort();
	}
	async handoff(sessionId: string): Promise<void> {
		await (await this.#required(sessionId)).handoff();
	}
	async respond(sessionId: string, interactionId: string, req: RespondRequest) {
		return await (await this.#required(sessionId)).respond(interactionId, req);
	}
	ingest(event: ExtensionEvent): void {
		void this.#actor(event.sessionId).then((actor) => {
			if (actor) {
				actor.ingest(event);
				if (this.#provisional.has(event.sessionId))
					void this.#opts.history.getSession(event.sessionId).then((meta) => {
						if (meta) this.#provisional.delete(event.sessionId);
					});
				return;
			}
			if (event.event !== "session_start" || !event.cwd) return;
			const existing = this.#actors.get(event.sessionId);
			if (existing) {
				existing.ingest(event);
				return;
			}
			const now = new Date().toISOString();
			const created = new SessionActor(
				{
					id: event.sessionId,
					file: event.sessionFile ?? "",
					cwd: event.cwd,
					title: "New session",
					createdAt: now,
					updatedAt: now,
					status: "pending",
				},
				this.#opts,
				this.#hooks(),
			);
			this.#actors.set(event.sessionId, created);
			this.#provisional.add(event.sessionId);
			created.ingest(event);
			this.#broadcast();
		});
	}
	onNotify(listener: (notification: LiveNotification) => void): () => void {
		this.#notifications.add(listener);
		return () => this.#notifications.delete(listener);
	}
	status() {
		let server = 0,
			terminal = 0,
			pending = 0;
		for (const actor of this.#actors.values()) {
			if (actor.state.kind === "server") server++;
			if (actor.state.kind === "terminal") terminal++;
			pending += actor.pending.length;
		}
		return {
			server,
			terminal,
			pending,
			collabRelayUrl: this.#relay?.url ?? `ws://127.0.0.1:${this.#opts.relayPort}`,
			problems: [...this.#problems],
		};
	}

	#hooks() {
		return {
			changed: (_actor: SessionActor, transition: boolean) => {
				if (transition) this.#broadcast();
			},
			notify: (notification: LiveNotification) => {
				for (const listener of this.#notifications) listener(notification);
			},
		};
	}
	async #required(sessionId: string): Promise<SessionActor> {
		const actor = await this.#actor(sessionId);
		if (!actor) throw new Error(`Unknown session ${sessionId}`);
		return actor;
	}
	async #actor(sessionId: string): Promise<SessionActor | null> {
		const existing = this.#actors.get(sessionId);
		if (existing) return existing;
		const loading = this.#creating.get(sessionId);
		if (loading) return loading;
		const promise = this.#opts.history
			.getSession(sessionId)
			.then((meta) => {
				if (!meta) return null;
				const actor = new SessionActor(meta, this.#opts, this.#hooks());
				this.#actors.set(sessionId, actor);
				this.#provisional.delete(sessionId);
				return actor;
			})
			.finally(() => this.#creating.delete(sessionId));
		this.#creating.set(sessionId, promise);
		return promise;
	}
	#broadcast(): void {
		const message: ServerMessage = { type: "sessions.changed" };
		for (const send of this.#broadcasts) send(message);
	}
	#summary(meta: SessionMeta) {
		return {
			id: meta.id,
			title: meta.title,
			project: { path: meta.cwd, name: meta.cwd.split("/").filter(Boolean).at(-1) ?? meta.cwd },
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			status: meta.status,
			liveness: { kind: "idle" as const },
			preview: meta.preview,
			pendingCount: 0,
		};
	}
}

export const createLiveHub: CreateLiveHub = (opts) => new Hub(opts);
export type { ExtensionEvent, LiveHub, LiveNotification, LiveOptions } from "./api.ts";
