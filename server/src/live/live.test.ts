import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeCollabUiRequest,
	normalizeRpcUiRequest,
	planResponse,
	receipt,
	ReceiptLedger,
	requestToPending,
	type InteractionRecord,
} from "./interactions.ts";
import { publicLiveness, reduceOwnership, type OwnershipState } from "./state.ts";
import { AgentCatalog, locateAgent } from "../history/agents.ts";
import type { History, SessionMeta } from "../history/api.ts";
import type { ServerMessage } from "@omp-mobile/protocol";
import { createLiveHub } from "./index.ts";

describe("ownership reducer", () => {
	test("server lifecycle and conflict fail closed", () => {
		let state: OwnershipState = { kind: "idle" };
		state = reduceOwnership(state, { type: "server.starting", pid: 12 });
		expect(publicLiveness(state)).toEqual({ kind: "server", phase: "starting" });
		state = reduceOwnership(state, { type: "server.ready" });
		state = reduceOwnership(state, { type: "server.working" });
		expect(publicLiveness(state)).toEqual({ kind: "server", phase: "working" });
		state = reduceOwnership(state, { type: "terminal.started", pid: 33 });
		expect(state).toEqual({
			kind: "conflict",
			message: "Session is also open in a terminal",
			serverPid: 12,
			terminalPid: 33,
			shutdownSeen: false,
			pidGone: false,
		});
		expect(reduceOwnership(state, { type: "server.closed" })).toEqual({
			kind: "terminal",
			attached: false,
			pid: 33,
			shutdownSeen: false,
			pidGone: false,
		});
		const shutdown = reduceOwnership(state, { type: "terminal.shutdown", pid: 33 });
		const gone = reduceOwnership(shutdown, { type: "terminal.pidGone", pid: 33 });
		expect(reduceOwnership(gone, { type: "server.closed" })).toEqual({ kind: "idle" });
	});

	test("terminal exits only after shutdown and pid death in either order", () => {
		const terminal: OwnershipState = { kind: "terminal", attached: true, pid: 9, shutdownSeen: false, pidGone: false };
		const shutdown = reduceOwnership(terminal, { type: "terminal.shutdown", pid: 9 });
		expect(shutdown.kind).toBe("terminal");
		expect(reduceOwnership(shutdown, { type: "terminal.pidGone", pid: 9 })).toEqual({ kind: "idle" });
		const gone = reduceOwnership(terminal, { type: "terminal.pidGone", pid: 9 });
		expect(gone.kind).toBe("terminal");
		expect(reduceOwnership(gone, { type: "terminal.shutdown", pid: 9 })).toEqual({ kind: "idle" });
	});
});

function stubHistory(sessions: SessionMeta[] = []): History {
	const agents = new AgentCatalog();
	return {
		locateAgent,
		async getSessionByFile(file) {
			return sessions.find((session) => session.file === file) ?? null;
		},
		listAgents(rootFile) {
			return agents.list(rootFile);
		},
		async readAgentTimeline() {
			return { items: [] };
		},
		async readAgentTail() {
			return { items: [], messageKeys: [] };
		},
		async listSessions() {
			return { items: sessions };
		},
		async getSession(sessionId) {
			return sessions.find((session) => session.id === sessionId) ?? null;
		},
		async readTimeline() {
			return { items: [] };
		},
		async readTail() {
			return { items: [], messageKeys: [] };
		},
		async readModelRole() {
			return "default" as const;
		},
		async recentProjects() {
			return [];
		},
		async listDirectories() {
			return { path: "/tmp", roots: ["/tmp"], entries: [] };
		},
		async resolveProjectDir(path) {
			return path;
		},
	};
}

test("terminal session_start creates ownership before history catalog catches up", async () => {
	const hub = createLiveHub({
		history: stubHistory(),
		ompPath: "omp",
		relayPort: 0,
		extensionPath: "/tmp/extension.ts",
	});
	hub.ingest({ event: "session_start", sessionId: "new-terminal", cwd: "/tmp/project", pid: process.pid, mode: "tui" });
	for (let turn = 0; turn < 10 && hub.overlay("new-terminal").liveness.kind === "idle"; turn++) await Promise.resolve();
	expect(hub.activeSummaries()).toEqual([
		expect.objectContaining({
			id: "new-terminal",
			title: "New session",
			project: { path: "/tmp/project", name: "project" },
			liveness: { kind: "terminal", attached: false },
			pendingCount: 0,
		}),
	]);
	expect(await hub.snapshot("new-terminal", 40)).toEqual(
		expect.objectContaining({ items: [], pending: [], session: expect.objectContaining({ id: "new-terminal" }) }),
	);
});

// The fake runs as a real child process, so tests poll for its effects instead of faking time.
async function until(condition: () => boolean | Promise<boolean>, label: string) {
	for (const deadline = Date.now() + 3_000; !(await condition()); await Bun.sleep(10))
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
}

describe("task agents", () => {
	const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp/project" })}\n`;

	async function layout() {
		const dir = await mkdtemp(join(tmpdir(), "omp-mobile-agents-"));
		const root = join(dir, "root.jsonl");
		await writeFile(root, header("root"));
		await mkdir(join(dir, "root"));
		return { dir, root, agentFile: (id: string) => join(dir, "root", `${id}.jsonl`) };
	}

	test("a task agent's own OMP session never becomes a session", async () => {
		const { dir, agentFile } = await layout();
		await writeFile(agentFile("Alpha"), header("alpha"));
		const hub = createLiveHub({ history: stubHistory(), ompPath: "omp", relayPort: 0, extensionPath: "/tmp/e.ts" });
		try {
			const start = { event: "session_start" as const, cwd: "/tmp/project", pid: process.pid };
			hub.ingest({ ...start, sessionId: "alpha", sessionFile: agentFile("Alpha"), mode: "print" });
			hub.ingest({ ...start, sessionId: "terminal", sessionFile: join(dir, "terminal.jsonl"), mode: "tui" });
			await until(() => hub.activeSummaries().length > 0, "the terminal session");
			expect(hub.activeSummaries().map((session) => session.id)).toEqual(["terminal"]);
		} finally {
			await hub.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an agent's transcript end beats a stale report, and a report from a dead process is not running", async () => {
		const { dir, root, agentFile } = await layout();
		const result = { role: "toolResult", toolName: "yield", toolCallId: "y", details: { status: "success" } };
		await writeFile(agentFile("Done"), header("done") + JSON.stringify({ type: "message", id: "y", message: result }));
		await writeFile(agentFile("Orphan"), header("orphan"));
		await writeFile(agentFile("Busy"), header("busy"));
		const exited = Bun.spawn(["true"]);
		await exited.exited;
		const session = {
			id: "root",
			file: root,
			cwd: "/tmp/project",
			title: "Root",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "complete" as const,
		};
		const hub = createLiveHub({
			history: stubHistory([session]),
			ompPath: "omp",
			relayPort: 0,
			extensionPath: "/tmp/e.ts",
		});
		try {
			const running = (id: string) => ({ id, sessionFile: agentFile(id), status: "running" as const });
			hub.ingestAgents({ pid: process.pid, agents: [running("Done"), { ...running("Busy"), activity: "Reading" }] });
			hub.ingestAgents({ pid: exited.pid, agents: [running("Orphan")] });
			const statuses = async () =>
				Object.fromEntries(
					((await hub.snapshot("root", 40))?.agents ?? []).map((agent) => [agent.id, [agent.status, agent.activity]]),
				);
			await until(async () => Object.keys(await statuses()).length === 3, "all three agents");
			expect(await statuses()).toEqual({
				Done: ["completed", undefined],
				Busy: ["running", "Reading"],
				Orphan: ["interrupted", undefined],
			});
		} finally {
			await hub.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("server-owned session", () => {
	// Minimal `omp --mode rpc-ui`: answers commands and runs each prompt as one turn with one finished bash call.
	const fakeOmp = `#!/usr/bin/env bun
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
out({ type: "ready" });
let turn = 0;
for await (const line of console) {
	if (!line.trim()) continue;
	const command = JSON.parse(line);
	if (command.type === "get_state")
		out({ type: "response", id: command.id, success: true, data: { sessionId: "fake", sessionFile: process.cwd() + "/fake.jsonl" } });
	else out({ type: "response", id: command.id, success: true });
	if (command.type !== "prompt") continue;
	const call = "call-" + ++turn;
	out({ type: "agent_start" });
	out({ type: "tool_execution_start", toolCallId: call, toolName: "bash", args: { command: "true" } });
	out({ type: "tool_execution_end", toolCallId: call, toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } });
	out({ type: "agent_end" });
	out({ type: "session_settled" });
}
`;

	test("keeps OMP running while its task agents run, and closes it once they stop", async () => {
		// The fake reports its cwd's real path, as OMP does.
		const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-mobile-fake-omp-")));
		const ompPath = join(dir, "omp");
		await writeFile(ompPath, fakeOmp, { mode: 0o755 });
		await writeFile(join(dir, "fake.jsonl"), "");
		await mkdir(join(dir, "fake"));
		const agentFile = join(dir, "fake", "Alpha.jsonl");
		await writeFile(agentFile, `${JSON.stringify({ type: "session", version: 3, id: "alpha", cwd: dir })}\n`);
		const settleGraceMs = 500;
		const hub = createLiveHub({
			history: stubHistory(),
			ompPath,
			relayPort: 0,
			extensionPath: "/tmp/e.ts",
			settleGraceMs,
		});
		const report = (status: "running" | "completed") =>
			hub.ingestAgents({ pid: process.pid, agents: [{ id: "Alpha", sessionFile: agentFile, status }] });
		try {
			const { sessionId } = await hub.createSession({ cwd: dir, prompt: "spawn", operationId: "op-1" });
			// The turn has ended and armed the close timer before the agent's first report arrives.
			report("running");
			// The close timer guards a real child process, so only real time can show it did not fire.
			await Bun.sleep(settleGraceMs * 2);
			expect(hub.overlay(sessionId).liveness).toEqual({ kind: "server", phase: "ready" });
			report("completed");
			await until(() => hub.overlay(sessionId).liveness.kind === "idle", "OMP to close after its agent finished");
		} finally {
			await hub.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("keeps following OMP after a history read fails and does not replay finished tools", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-mobile-fake-omp-"));
		const ompPath = join(dir, "omp");
		await writeFile(ompPath, fakeOmp, { mode: 0o755 });
		let failNextRead = true;
		const hub = createLiveHub({
			history: {
				...stubHistory(),
				async readTail() {
					if (failNextRead) {
						failNextRead = false;
						throw new Error("history unavailable");
					}
					return { items: [], messageKeys: [] };
				},
			},
			ompPath,
			relayPort: 0,
			extensionPath: "/tmp/extension.ts",
			settleGraceMs: 60_000,
		});
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { sessionId } = await hub.createSession({ cwd: dir, prompt: "first", operationId: "op-1" });
			const ready = () => {
				const liveness = hub.overlay(sessionId).liveness;
				return liveness.kind === "server" && liveness.phase === "ready";
			};
			await until(() => ready() && !failNextRead, "the first turn to settle");
			// A reader stopped by the failed read never delivers this response; the race keeps the test from hanging.
			expect(
				await Promise.race([
					hub.prompt(sessionId, { operationId: "op-2", text: "second" }),
					Bun.sleep(3_000).then(() => "no response"),
				]),
			).toEqual({ state: "accepted" });
			await until(ready, "the second turn to settle");
			await until(
				async () => (await hub.snapshot(sessionId, 40))?.items.length === 0,
				"finished tools to leave the snapshot",
			);
		} finally {
			errors.mockRestore();
			await hub.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("session_title from the extension", () => {
	const prompt = "I want to plan a weekly irrigation schedule for my backyard vegetable garden. Reply only with OK.";
	function setup() {
		const hub = createLiveHub({
			history: stubHistory([
				{
					id: "phone-1",
					file: "/tmp/project/phone-1.jsonl",
					cwd: "/tmp/project",
					title: prompt.slice(0, 80),
					createdAt: "2026-09-29T00:00:00.000Z",
					updatedAt: "2026-09-29T00:00:00.000Z",
					status: "complete",
				},
			]),
			ompPath: "omp",
			relayPort: 0,
			extensionPath: "/tmp/extension.ts",
		});
		const broadcasts: ServerMessage[] = [];
		hub.onBroadcast((message) => broadcasts.push(message));
		const updates: ServerMessage[] = [];
		hub.subscribe("phone-1", (message) => updates.push(message));
		const title = (text: string | undefined) =>
			hub.ingest({ event: "session_title", sessionId: "phone-1", pid: process.pid, mode: "rpc", title: text });
		const settle = async () => {
			for (let turn = 0; turn < 10; turn++) await Promise.resolve();
		};
		return { hub, broadcasts, updates, title, settle };
	}

	test("replaces the prompt title for summaries and subscribers and invalidates the list", async () => {
		const { hub, broadcasts, updates, title, settle } = setup();
		await settle();
		title("Plan   Weekly Backyard\nGarden Irrigation");
		await settle();
		expect(broadcasts).toEqual([{ type: "sessions.changed" }]);
		expect(updates).toContainEqual(
			expect.objectContaining({
				type: "session.update",
				sessionId: "phone-1",
				session: expect.objectContaining({ title: "Plan Weekly Backyard Garden Irrigation" }),
			}),
		);
		expect((await hub.snapshot("phone-1", 40))?.session.title).toBe("Plan Weekly Backyard Garden Irrigation");
	});

	test("caps titles like the history catalog and ignores empty or unchanged titles", async () => {
		const { hub, broadcasts, title, settle } = setup();
		title("x".repeat(120));
		await settle();
		expect((await hub.snapshot("phone-1", 40))?.session.title).toBe("x".repeat(80));
		title("x".repeat(80));
		title("   ");
		title(undefined);
		await settle();
		expect(broadcasts).toHaveLength(1);
		expect((await hub.snapshot("phone-1", 40))?.session.title).toBe("x".repeat(80));
	});
});
describe("UI request mapping", () => {
	test("maps exact RPC approval and ask frames", () => {
		const approval = normalizeRpcUiRequest({
			type: "extension_ui_request",
			id: "1592ec62700a5bcc",
			method: "select",
			title: "Allow tool: bash\nCommand: echo picked-blue",
			options: ["Approve", "Deny"],
		})!;
		expect(requestToPending("s", approval, "2026-01-01T00:00:00.000Z")).toEqual({
			id: approval.id,
			sessionId: "s",
			createdAt: "2026-01-01T00:00:00.000Z",
			kind: "approval",
			title: "Allow tool: bash",
			detail: "Command: echo picked-blue",
		});
		const ask = normalizeRpcUiRequest({
			type: "extension_ui_request",
			id: "1592ec601d0a5bcb",
			method: "select",
			title: "Pick a color",
			options: ["Red", "Blue", "Other (type your own)"],
		})!;
		expect(requestToPending("s", ask).kind).toBe("question");
		const pending = requestToPending("s", ask);
		expect(pending.kind === "question" && pending).toMatchObject({
			options: [{ label: "Red" }, { label: "Blue" }],
			allowOther: true,
		});
	});

	test("maps exact Collab ask and filters host-only choices", () => {
		const request = normalizeCollabUiRequest({
			t: "ui-request",
			request: {
				kind: "select",
				title: "Color",
				options: ["Red", "Blue", "Other (type your own)", "Chat about this"],
				initialIndex: 0,
				selectionMarker: "radio",
				markableCount: 2,
				reqId: 2,
			},
		})!;
		expect(requestToPending("s", request)).toMatchObject({
			id: "2",
			kind: "question",
			options: [{ label: "Red" }, { label: "Blue" }],
			allowOther: true,
		});
	});

	test("maps input/editor to text and confirm to Yes/No", () => {
		expect(requestToPending("s", { id: "e", method: "editor", title: "Details" })).toMatchObject({
			kind: "text",
			title: "Details",
		});
		expect(requestToPending("s", { id: "c", method: "confirm", title: "Continue?" })).toMatchObject({
			kind: "question",
			options: [{ label: "Yes" }, { label: "No" }],
		});
	});
});

describe("responses and receipts", () => {
	function record(request: InteractionRecord["source"]["request"]): InteractionRecord {
		return { pending: requestToPending("s", request), source: { transport: "rpc", requestId: request.id, request } };
	}
	test("maps approval, choice, cancel, and Other editor sequence", () => {
		expect(
			planResponse(record({ id: "a", method: "select", title: "Allow\ncommand", options: ["Approve", "Deny"] }), {
				kind: "approve",
			}),
		).toEqual({ kind: "send", value: "Approve" });
		expect(
			planResponse(record({ id: "q", method: "select", title: "Color", options: ["Red", "Other (type your own)"] }), {
				kind: "choice",
				label: "Red",
			}),
		).toEqual({ kind: "send", value: "Red" });
		expect(
			planResponse(record({ id: "q", method: "select", title: "Color", options: ["Red", "Other (type your own)"] }), {
				kind: "text",
				text: "teal",
			}),
		).toEqual({ kind: "other", selector: "Other (type your own)", text: "teal" });
		expect(
			planResponse(record({ id: "q", method: "select", title: "Color", options: ["Red"] }), { kind: "cancel" }),
		).toEqual({ kind: "send", cancelled: true });
	});

	test("closed requests are not reported applied and operations are idempotent", () => {
		const closed = record({ id: "q", method: "input", title: "Name" });
		closed.closed = { cancelled: false };
		expect(planResponse(closed, { kind: "text", text: "A" })).toBe("closed");
		const ledger = new ReceiptLedger();
		expect(ledger.record(receipt("op", "applied"))).toEqual({ operationId: "op", state: "applied" });
		expect(ledger.record(receipt("op", "closed"))).toEqual({ operationId: "op", state: "applied" });
		expect(ledger.get("missing")).toBeUndefined();
	});
});
