import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AdminStatus, ServerMessage, SessionSnapshot } from "@omp-mobile/protocol";
import type { History } from "../history/api.ts";
import type { ExtensionEvent, LiveHub, LiveNotification } from "../live/api.ts";
import { createDeviceStore } from "../store/devices.ts";
import { createHttpHandler, startHttp, type HttpOptions, type HttpService } from "./index.ts";

const meta = {
	id: "s1",
	file: "/tmp/s1.jsonl",
	cwd: "/tmp/project",
	title: "Session",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:01.000Z",
	status: "complete" as const,
};
const snapshot: SessionSnapshot = {
	session: {
		id: "s1",
		title: "Session",
		project: { path: "/tmp/project", name: "project" },
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		status: "complete",
		liveness: { kind: "idle" },
		pendingCount: 0,
	},
	items: [],
	pending: [],
};

class FakeHub implements LiveHub {
	subscriber?: (message: ServerMessage) => void;
	readonly subscription = Promise.withResolvers<void>();
	async start() {}
	async stop() {}
	overlay() {
		return { liveness: { kind: "idle" as const }, pendingCount: 0 };
	}
	activeSummaries() {
		return [];
	}
	async snapshot() {
		return snapshot;
	}
	subscribe(_sessionId: string, send: (message: ServerMessage) => void) {
		this.subscriber = send;
		this.subscription.resolve();
		return () => {
			this.subscriber = undefined;
		};
	}
	onBroadcast() {
		return () => {};
	}
	async createSession() {
		return { sessionId: "s1" };
	}
	async prompt() {
		return { state: "accepted" as const };
	}
	async abort() {}
	async handoff() {}
	async respond(_sessionId: string, _interactionId: string, req: { operationId: string }) {
		return { operationId: req.operationId, state: "applied" as const };
	}
	ingest(_event: ExtensionEvent) {}
	onNotify(_listener: (notification: LiveNotification) => void) {
		return () => {};
	}
	status() {
		return { server: 0, terminal: 0, pending: 0, collabRelayUrl: "ws://127.0.0.1:8788", problems: [] };
	}
}

const history: History = {
	async listSessions() {
		return { items: [meta] };
	},
	async getSession() {
		return meta;
	},
	async readTimeline() {
		return { items: [] };
	},
	async readTail() {
		return { items: [], messageKeys: [] };
	},
	async recentProjects() {
		return [{ path: "/tmp/project", name: "project", lastUsedAt: meta.updatedAt, sessionCount: 1 }];
	},
	async listDirectories() {
		return {
			path: "/tmp",
			roots: ["/tmp"],
			entries: [{ name: "project", path: "/tmp/project", isGitRepo: true, hasSessions: true }],
		};
	},
	async resolveProjectDir(path) {
		return path;
	},
};

let directory: string | undefined;
let service: HttpService | undefined;
afterEach(async () => {
	await service?.stop();
	service = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function fixture(port = 19000 + Math.floor(Math.random() * 10000)) {
	directory = await mkdtemp(join(tmpdir(), "omp-mobile-http-"));
	const devices = createDeviceStore(join(directory, "devices.json"));
	await devices.load();
	const hub = new FakeHub();
	const options: HttpOptions = {
		config: {
			dataDir: directory,
			port,
			relayPort: port + 1,
			machineName: "Mac",
			roots: ["/tmp"],
			ompPath: "/usr/bin/true",
		},
		machineId: "machine",
		ompVersion: "18.4.3",
		devices,
		history,
		hub,
		adminToken: "admin",
		extensionToken: "extension",
	};
	const pairing = devices.createPairing();
	const paired = await devices.pair(pairing.code, "Phone");
	return { options, devices, hub, token: paired!.token };
}

describe("HTTP API", () => {
	test("requires auth, exposes sessions and fs, and hides admin on app listener", async () => {
		const { options, token } = await fixture();
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		expect((await handler(new Request("http://mac/v1/sessions"))).status).toBe(401);
		const headers = { authorization: `Bearer ${token}` };
		const sessions = await handler(new Request("http://mac/v1/sessions", { headers }));
		expect(await sessions.json()).toMatchObject({ items: [{ id: "s1", project: { name: "project" } }] });
		const dirs = await handler(new Request("http://mac/v1/fs/dirs?path=/tmp", { headers }));
		expect(await dirs.json()).toMatchObject({ entries: [{ isGitRepo: true }] });
		expect(
			(await handler(new Request("http://mac/admin/status", { headers: { authorization: "Bearer admin" } }))).status,
		).toBe(404);
	});

	test("pairing route consumes a code once", async () => {
		const { options, devices } = await fixture();
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		const pairing = devices.createPairing();
		const request = () =>
			new Request("http://mac/v1/pair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: pairing.code, deviceName: "New Phone" }),
			});
		expect((await handler(request())).status).toBe(200);
		expect((await handler(request())).status).toBe(400);
	});

	test("admin status reports which device consumed a pairing code", async () => {
		const { options } = await fixture();
		const loopback = createHttpHandler(options, "loopback", () => "http://mac:8787");
		const pairingResponse = await loopback(
			new Request("http://mac/admin/pairing", {
				method: "POST",
				headers: { authorization: "Bearer admin" },
			}),
		);
		const pairing = (await pairingResponse.json()) as { id: string; code: string };
		const app = createHttpHandler(options, "app", () => "http://mac:8787");
		expect(
			(
				await app(
					new Request("http://mac/v1/pair", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: pairing.code, deviceName: "New Phone" }),
					}),
				)
			).status,
		).toBe(200);

		const status = await loopback(
			new Request("http://mac/admin/status", { headers: { authorization: "Bearer admin" } }),
		);
		const body = (await status.json()) as AdminStatus;
		expect(body.pairings).toContainEqual(
			expect.objectContaining({
				id: pairing.id,
				consumedBy: expect.objectContaining({ name: "New Phone" }),
			}),
		);
	});

	test("WebSocket sends hello and fans out subscribed session messages", async () => {
		const { options, token, hub } = await fixture();
		service = await startHttp(options);
		const ws = new WebSocket(`ws://127.0.0.1:${options.config.port}/v1/stream`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const messages: ServerMessage[] = [];
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as ServerMessage;
			messages.push(message);
			if (message.type === "sessions.changed") resolve();
		};
		ws.onerror = () => reject(new Error("WebSocket failed"));
		ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
		await hub.subscription.promise;
		hub.subscriber!({ type: "sessions.changed" });
		await promise;
		expect(messages[0]?.type).toBe("hello");
		ws.close();
	});
});
