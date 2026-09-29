import { describe, expect, test } from "bun:test";
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
import type { History } from "../history/api.ts";
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

test("terminal session_start creates ownership before history catalog catches up", async () => {
	const history: History = {
		async listSessions() {
			return { items: [] };
		},
		async getSession() {
			return null;
		},
		async readTimeline() {
			return { items: [] };
		},
		async readTail() {
			return { items: [], messageKeys: [] };
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
	const hub = createLiveHub({ history, ompPath: "omp", relayPort: 0, extensionPath: "/tmp/extension.ts" });
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
