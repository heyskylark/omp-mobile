import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Block, TimelineItem } from "@omp-mobile/protocol";
import type { DurableTail, History, SessionMeta } from "../history/api.ts";
import { createLiveHub } from "./index.ts";

const scratch = `/tmp/omp-mobile-live-smoke-${process.pid}`;
const cwd = join(scratch, "project");
const sessionsDir = join(scratch, "sessions");
const observed = {
	upserts: 0,
	retires: 0,
	asks: 0,
	approvals: 0,
	firstSettled: false,
	childClosed: false,
	respawned: false,
};
let known: SessionMeta | null = null;

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) =>
		part && typeof part === "object" && "text" in part && typeof part.text === "string"
			? [{ kind: "text" as const, text: part.text }]
			: [],
	);
}

async function durableTail(afterEntryId?: string): Promise<DurableTail> {
	if (!known || !(await Bun.file(known.file).exists())) return { items: [], messageKeys: [] };
	const rows = (await Bun.file(known.file).text()).split("\n").flatMap((line) => {
		try {
			const value: unknown = JSON.parse(line);
			return value && typeof value === "object" ? [value] : [];
		} catch {
			return [];
		}
	});
	let start = 0;
	if (afterEntryId) {
		const index = rows.findIndex((row) => "id" in row && row.id === afterEntryId);
		if (index >= 0) start = index + 1;
	}
	const items: TimelineItem[] = [];
	const messageKeys: DurableTail["messageKeys"] = [];
	let lastEntryId: string | undefined;
	for (const row of rows.slice(start)) {
		if (!("id" in row) || typeof row.id !== "string") continue;
		lastEntryId = row.id;
		if (
			!("type" in row) ||
			row.type !== "message" ||
			!("message" in row) ||
			!row.message ||
			typeof row.message !== "object" ||
			!("role" in row.message) ||
			!("timestamp" in row.message)
		)
			continue;
		const timestamp =
			typeof row.message.timestamp === "number" ? row.message.timestamp : Date.parse(String(row.message.timestamp));
		const at = new Date(timestamp).toISOString();
		if (row.message.role === "user" || row.message.role === "assistant") {
			const kind = row.message.role;
			const item: TimelineItem =
				kind === "user"
					? { id: `e:${row.id}`, kind, at, blocks: "content" in row.message ? blocks(row.message.content) : [] }
					: {
							id: `e:${row.id}`,
							kind,
							at,
							blocks: "content" in row.message ? blocks(row.message.content) : [],
							streaming: false,
						};
			items.push(item);
			messageKeys.push({ itemId: item.id, role: kind, timestamp });
		} else if (
			row.message.role === "toolResult" &&
			"toolCallId" in row.message &&
			typeof row.message.toolCallId === "string"
		) {
			items.push({
				id: `t:${row.message.toolCallId}`,
				kind: "tool",
				at,
				name: "toolName" in row.message ? String(row.message.toolName) : "tool",
				title: "toolName" in row.message ? String(row.message.toolName) : "tool",
				input: "",
				state: "succeeded",
				output:
					"content" in row.message
						? blocks(row.message.content)
								.map((block) => (block.kind === "text" ? block.text : ""))
								.join("\n")
						: "",
			});
		}
	}
	return { items, messageKeys, lastEntryId };
}

const history: History = {
	async listSessions() {
		return { items: known ? [known] : [] };
	},
	async getSession(id) {
		return known?.id === id ? known : null;
	},
	async readTimeline() {
		const tail = await durableTail();
		return { items: tail.items };
	},
	readTail(_id, options) {
		return durableTail(options.afterEntryId);
	},
	async recentProjects() {
		return [];
	},
	async listDirectories(path) {
		return { path: path ?? cwd, roots: [cwd], entries: [] };
	},
	async resolveProjectDir(path) {
		if (path !== cwd) throw new Error("outside scratch");
		return path;
	},
};

async function waitFor(predicate: () => boolean, label: string, timeout = 180_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

await mkdir(cwd, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await Bun.write(join(cwd, "tiny.txt"), "smoke\n");
const hub = createLiveHub({
	history,
	ompPath: "omp",
	relayPort: 0,
	extensionPath: join(import.meta.dir, "../../../extension/omp-mobile.ts"),
	settleGraceMs: 250,
	rpcArgs: [
		"--session-dir",
		sessionsDir,
		"--no-lsp",
		"--approval-mode",
		"always-ask",
		"--model",
		process.env.OMP_SMOKE_MODEL ?? "openai-codex/gpt-5.6-terra:medium",
	],
});
try {
	await hub.start();
	const created = await hub.createSession({
		operationId: "create-1",
		cwd,
		prompt:
			"Use ask to ask exactly one question titled Color with options Red and Blue. Then run bash command echo smoke-approved. Finally reply done. Do not skip tools.",
	});
	const actorSnapshot = await hub.snapshot(created.sessionId, 20);
	if (!actorSnapshot) throw new Error("new session missing");
	let files: string[] = [];
	await waitFor(
		() => {
			files = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionsDir, dot: true })];
			return files.length === 1;
		},
		"new session file",
		10_000,
	);
	known = {
		id: created.sessionId,
		file: join(sessionsDir, files[0]!),
		cwd,
		title: "Smoke",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "pending",
	};
	const unsubscribe = hub.subscribe(created.sessionId, (message) => {
		if (message.type === "timeline.upsert") observed.upserts += message.items.length;
		if (message.type === "timeline.retire") observed.retires += message.ids.length;
	});
	for (;;) {
		const snapshot = await hub.snapshot(created.sessionId, 20);
		const pending = snapshot?.pending[0];
		if (pending) {
			if (pending.kind === "approval") {
				observed.approvals++;
				await hub.respond(created.sessionId, pending.id, {
					operationId: `approval-${observed.approvals}`,
					response: { kind: "approve" },
				});
			} else {
				observed.asks++;
				await hub.respond(created.sessionId, pending.id, {
					operationId: `ask-${observed.asks}`,
					response: { kind: "choice", label: "Blue" },
				});
			}
		}
		const live = hub.overlay(created.sessionId).liveness;
		if (live.kind === "server" && live.phase === "ready" && observed.approvals > 0) break;
		await Bun.sleep(50);
	}
	observed.firstSettled = true;
	unsubscribe();
	await waitFor(() => hub.overlay(created.sessionId).liveness.kind === "idle", "graceful child close", 10_000);
	observed.childClosed = true;
	await hub.prompt(created.sessionId, { operationId: "resume-1", text: "Reply only with resumed." });
	observed.respawned = true;
	await waitFor(() => {
		const live = hub.overlay(created.sessionId).liveness;
		return live.kind === "server" && live.phase === "ready";
	}, "resumed session settle");
	await hub.handoff(created.sessionId);
	if (!observed.upserts || !observed.retires || !observed.asks || !observed.approvals)
		throw new Error(`missing observations: ${JSON.stringify(observed)}`);
	console.log(JSON.stringify({ sessionId: created.sessionId, ...observed }));
} finally {
	await hub.stop();
	await rm(scratch, { recursive: true, force: true });
}
