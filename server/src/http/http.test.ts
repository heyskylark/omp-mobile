import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	AdminStatus,
	BrowserServerMessage,
	Job,
	JobListResponse,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
} from "@omp-mobile/protocol";
import { createBrowserService } from "../browser/index.ts";
import type { History } from "../history/api.ts";
import { ImageStore } from "../history/images.ts";
import { InvalidHistoryCursorError } from "../history/pager.ts";
import { createJobService, createJobStore, type JobService, type JobStore } from "../jobs/index.ts";
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
	modelRole: "default",
	agents: [],
};

class FakeHub implements LiveHub {
	subscriber?: (message: ServerMessage) => void;
	readonly subscription = Promise.withResolvers<void>();
	async start() {}
	async stop() {}
	overlay() {
		return { liveness: { kind: "idle" as const }, pendingCount: 0 };
	}
	active: SessionSummary[] = [];
	activeSummaries() {
		return this.active;
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
	async setModelRole() {}
	async handoff() {}
	async respond(_sessionId: string, _interactionId: string, req: { operationId: string }) {
		return { operationId: req.operationId, state: "applied" as const };
	}
	ingest(_event: ExtensionEvent) {}
	ingestAgents() {}
	async agentSnapshot() {
		return null;
	}
	async agentTimeline() {
		return null;
	}
	subscribeAgent() {
		return () => {};
	}
	onNotify(_listener: (notification: LiveNotification) => void) {
		return () => {};
	}
	async skills() {
		return [];
	}
	async usage() {
		return { fetchedAt: 0, accounts: [] };
	}
	status() {
		return { server: 0, terminal: 0, pending: 0, collabRelayUrl: "ws://127.0.0.1:8788", problems: [] };
	}
}

const history: History = {
	images: new ImageStore("/nonexistent"),
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
	async readModelRole() {
		return "default" as const;
	},
	async locateAgent() {
		return null;
	},
	async getSessionByFile() {
		return null;
	},
	async listAgents() {
		return [];
	},
	async readAgentTimeline() {
		return { items: [] };
	},
	async readAgentTail() {
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
let jobs: { service: JobService; store: JobStore } | undefined;
afterEach(async () => {
	await service?.stop();
	service = undefined;
	jobs?.service.stop();
	jobs?.store.close();
	jobs = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

async function fixture(port = 19000 + Math.floor(Math.random() * 10000)) {
	directory = await mkdtemp(join(tmpdir(), "omp-mobile-http-"));
	const devices = createDeviceStore(join(directory, "devices.json"));
	await devices.load();
	const hub = new FakeHub();
	const store = createJobStore(join(directory, "jobs.db"));
	jobs = { store, service: createJobService({ store, hub, history }) };
	const options: HttpOptions = {
		config: {
			dataDir: directory,
			port,
			relayPort: port + 1,
			machineName: "Mac",
			roots: ["/tmp"],
			ompPath: "/usr/bin/true",
			browserRelayUrl: new URL(`http://127.0.0.1:${port + 2}`),
		},
		machineId: "machine",
		ompVersion: "18.4.3",
		devices,
		history,
		hub,
		browser: createBrowserService({ relayUrl: new URL(`http://127.0.0.1:${port + 2}`) }),
		adminToken: "admin",
		extensionToken: "extension",
		jobs: jobs.service,
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

	test("only OMP sessions create jobs; paired phones list, pause, resume, and delete them", async () => {
		const { options, token } = await fixture();
		const loopback = createHttpHandler(options, "loopback", () => "http://mac:8787");
		const app = createHttpHandler(options, "app", () => "http://mac:8787");
		const create = (schedule: string, extensionToken: string, handler = loopback) =>
			handler(
				new Request("http://mac/internal/jobs", {
					method: "POST",
					headers: { "content-type": "application/json", "x-omp-mobile-token": extensionToken },
					body: JSON.stringify({
						name: "Standup notes",
						description: "Summarize yesterday's commits",
						schedule,
						sessionId: "s1",
						cwd: "/tmp/project",
					}),
				}),
			);
		expect((await create("0 9 * * MON-FRI", "wrong")).status).toBe(401);
		expect((await create("0 9 * * MON-FRI", "extension", app)).status).toBe(404);
		const invalid = await create("every morning", "extension");
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ code: "bad_request", message: expect.stringContaining("5") });
		expect((await create("0 0 30 2 *", "extension")).status).toBe(400);
		expect((await create("* * * * * *", "extension")).status).toBe(400);

		const created = await create(" 0 9 * * MON-FRI ", "extension");
		expect(created.status).toBe(201);
		const job = (await created.json()) as Job;
		expect(job).toMatchObject({
			name: "Standup notes",
			status: "ACTIVE",
			sessionId: "s1",
			schedule: "0 9 * * MON-FRI",
		});
		expect(new Date(job.nextRunAt!).getHours()).toBe(9);
		expect(job).not.toHaveProperty("cwd");

		const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
		const patch = (status: string) =>
			app(new Request(`http://mac/v1/jobs/${job.id}`, { method: "PATCH", headers, body: JSON.stringify({ status }) }));
		expect((await app(new Request("http://mac/v1/jobs"))).status).toBe(401);
		expect((await patch("ERROR")).status).toBe(400);
		const paused = (await (await patch("PAUSED")).json()) as Job;
		expect(paused.status).toBe("PAUSED");
		expect(paused.nextRunAt).toBeUndefined();
		expect(((await (await patch("ACTIVE")).json()) as Job).nextRunAt).toBe(job.nextRunAt);
		const list = (await (await app(new Request("http://mac/v1/jobs", { headers }))).json()) as JobListResponse;
		expect(list.items.map((item) => item.id)).toEqual([job.id]);

		const remove = () => app(new Request(`http://mac/v1/jobs/${job.id}`, { method: "DELETE", headers }));
		expect((await remove()).status).toBe(204);
		expect((await remove()).status).toBe(404);
		expect((await patch("PAUSED")).status).toBe(404);
	});

	test("reports missing APNs through structured status without duplicating it as a problem", async () => {
		const { options } = await fixture();
		const handler = createHttpHandler(
			options,
			"loopback",
			() => "http://mac:8787",
			() => ["Tailscale is disconnected"],
		);
		const response = await handler(
			new Request("http://mac/admin/status", { headers: { authorization: "Bearer admin" } }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			apnsConfigured: false,
			problems: ["Tailscale is disconnected"],
		});
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

	test("re-pairing replaces the device authenticated by the previous token", async () => {
		const { options, devices, token } = await fixture();
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		const pairing = devices.createPairing();
		const response = await handler(
			new Request("http://mac/v1/pair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: pairing.code, deviceName: "Phone", previousToken: token }),
			}),
		);
		const paired = (await response.json()) as { deviceId: string; token: string };

		expect(response.status).toBe(200);
		expect(devices.list().map((device) => device.id)).toEqual([paired.deviceId]);
		expect(await devices.authenticate(token)).toBeNull();
		expect((await devices.authenticate(paired.token))?.id).toBe(paired.deviceId);
	});

	test("renaming the computer keeps other config keys and updates every name the server reports", async () => {
		const { options, token } = await fixture();
		const configFile = join(options.config.dataDir, "config.json");
		await writeFile(configFile, JSON.stringify({ port: 9999, roots: ["/tmp"], machineName: "Old" }));
		const app = createHttpHandler(options, "app", () => "http://mac:8787");
		const loopback = createHttpHandler(options, "loopback", () => "http://mac:8787");
		const rename = (machineName: string) =>
			app(
				new Request("http://mac/v1/machine/name", {
					method: "PUT",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ machineName }),
				}),
			);

		const renamed = await rename("  Studio Mac  ");

		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ machineId: "machine", machineName: "Studio Mac" });
		expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({
			port: 9999,
			roots: ["/tmp"],
			machineName: "Studio Mac",
		});
		const info = await app(new Request("http://mac/v1/info", { headers: { authorization: `Bearer ${token}` } }));
		expect(await info.json()).toMatchObject({ machineName: "Studio Mac" });
		const status = await loopback(
			new Request("http://mac/admin/status", { headers: { authorization: "Bearer admin" } }),
		);
		expect(await status.json()).toMatchObject({ machineName: "Studio Mac" });
		expect((await rename("   ")).status).toBe(400);
		expect((await rename("x".repeat(65))).status).toBe(400);
		expect(options.config.machineName).toBe("Studio Mac");
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

	test("browser viewers authenticate and learn that no relay runs", async () => {
		const { options, token } = await fixture();
		service = await startHttp(options);
		const base = `127.0.0.1:${options.config.port}`;
		const status = await fetch(`http://${base}/v1/browser`, { headers: { authorization: `Bearer ${token}` } });
		expect(await status.json()).toEqual({ availability: { kind: "relay_offline" } });
		expect((await fetch(`http://${base}/v1/browser/stream`)).status).toBe(401);

		const ws = new WebSocket(`ws://${base}/v1/browser/stream`, { headers: { Authorization: `Bearer ${token}` } });
		const first = Promise.withResolvers<BrowserServerMessage>();
		ws.onmessage = (event) => first.resolve(JSON.parse(String(event.data)) as BrowserServerMessage);
		ws.onerror = () => first.reject(new Error("WebSocket failed"));
		expect(await first.promise).toEqual({ type: "state", availability: { kind: "relay_offline" } });
		ws.close();
		options.browser.stop();
	});

	test("browser messages the server cannot read get a short reason, not the parse error", async () => {
		const { options, token } = await fixture();
		service = await startHttp(options);
		const ws = new WebSocket(`ws://127.0.0.1:${options.config.port}/v1/browser/stream`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const errors: BrowserServerMessage[] = [];
		const done = Promise.withResolvers<void>();
		ws.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as BrowserServerMessage;
			if (message.type !== "error") return;
			errors.push(message);
			if (errors.length === 3) done.resolve();
		};
		ws.onerror = () => done.reject(new Error("WebSocket failed"));
		ws.onopen = () => {
			ws.send(JSON.stringify({ type: "clipboard.paste" }));
			ws.send("{not json");
			ws.send(JSON.stringify({ type: "input.text", text: "" }));
		};
		await done.promise;
		expect(errors.map((message) => message.type === "error" && message.error)).toEqual([
			{ code: "bad_request", message: "Update OMP Mobile on this Mac to use this" },
			{ code: "bad_request", message: "Invalid message" },
			{ code: "bad_request", message: expect.not.stringContaining("\n") },
		]);
		ws.close();
		options.browser.stop();
	});

	test("filters page 1 live sessions like history and passes the filter to history", async () => {
		const { options, hub, token } = await fixture();
		const requests: Parameters<History["listSessions"]>[0][] = [];
		options.history = {
			...history,
			async listSessions(opts) {
				requests.push(opts);
				return { items: [meta] };
			},
		};
		const live = (id: string, title: string, path: string): SessionSummary => ({
			...snapshot.session,
			id,
			title,
			project: { path, name: "project" },
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		hub.active = [
			live("live-match", "Session search draft", "/tmp/project"),
			live("live-other-project", "Session", "/tmp/other"),
			live("live-miss", "Deploy", "/tmp/project"),
		];
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		const response = await handler(
			new Request("http://mac/v1/sessions?limit=30&project=%2Ftmp%2Fproject&q=sesion", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		const body = (await response.json()) as { items: SessionSummary[] };
		expect(requests).toEqual([{ cursor: undefined, limit: 30, project: "/tmp/project", query: "sesion" }]);
		// The closer title outranks the newer live session.
		expect(body.items.map((item) => item.id)).toEqual(["s1", "live-match"]);
	});

	test("maps a stale or mismatched cursor to 400 invalid_cursor", async () => {
		const { options, token } = await fixture();
		options.history = {
			...history,
			async listSessions({ cursor }) {
				if (cursor) throw new InvalidHistoryCursorError();
				return { items: [meta] };
			},
		};
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		const response = await handler(
			new Request("http://mac/v1/sessions?cursor=stale&q=session", { headers: { authorization: `Bearer ${token}` } }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
	});

	test("serves a transcript image by hash to paired devices only, with its sniffed type", async () => {
		const { options, token } = await fixture();
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0, 0, 0]);
		const id = "a".repeat(64);
		await writeFile(join(directory!, id), gif);
		await writeFile(join(directory!, "b".repeat(64)), "data:image/png;base64,AAAA");
		options.history = { ...history, images: new ImageStore(directory!) };
		const handler = createHttpHandler(options, "app", () => "http://mac:8787");
		const headers = { authorization: `Bearer ${token}` };
		expect((await handler(new Request(`http://mac/v1/images/${id}`))).status).toBe(401);
		const response = await handler(new Request(`http://mac/v1/images/${id}`, { headers }));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/gif");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(gif);
		// Blobs that are not images, unknown hashes and anything that is not a hash stay private.
		for (const name of ["b".repeat(64), "c".repeat(64), "..%2Fdevices.json"])
			expect((await handler(new Request(`http://mac/v1/images/${name}`, { headers }))).status).toBe(404);
	});
});
