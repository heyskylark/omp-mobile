import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserClientMessage, BrowserServerMessage } from "@omp-mobile/protocol";
import { createBrowserService, type BrowserService, type BrowserViewer } from "./index.ts";

interface Command {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

class FakeRelay {
	readonly commands: Command[] = [];
	running = true;
	probes = 0;
	extensionConnected = true;
	visibility = "visible";
	/** Methods Chrome never answers: captures while the Mac is locked, input and page checks on a covered window. */
	readonly unanswered = new Set<string>();
	readonly tabs = [
		{ targetId: "PAGEa.1", type: "page", title: "Sign in", url: "https://example.com/login" },
		{ targetId: "PAGEa.2", type: "page", title: "Docs", url: "https://example.com/docs" },
	];
	#server?: Bun.Server<undefined>;
	#socket?: Bun.ServerWebSocket<undefined>;

	constructor(readonly port: number) {}

	start(): void {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: this.port,
			fetch: (req, server) => {
				const path = new URL(req.url).pathname;
				if (path === "/json/version") {
					this.probes++;
					if (!this.running) return new Response("not found", { status: 404 });
					if (!this.extensionConnected) return new Response("{}", { status: 503 });
					return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/cdp` });
				}
				if (path === "/cdp" && server.upgrade(req)) return;
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: (ws) => {
					this.#socket = ws;
				},
				message: (ws, raw) => {
					const { id, method, params = {}, sessionId } = JSON.parse(String(raw)) as Command & { id: number };
					this.commands.push({ method, params, sessionId });
					if (method === "Target.setDiscoverTargets")
						for (const targetInfo of this.tabs) this.emit("Target.targetCreated", { targetInfo });
					if ([...this.unanswered].some((prefix) => method.startsWith(prefix))) return;
					ws.send(JSON.stringify({ id, result: this.#result(method, params) }));
				},
			},
		});
	}

	stop(): void {
		this.#server?.stop(true);
	}

	emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
		this.#socket?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
	}

	frame(ackId: number, data: string): void {
		const metadata = { deviceWidth: 1200, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 };
		this.emit("Page.screencastFrame", { data, metadata, sessionId: ackId }, "S-PAGEa.1");
	}

	sent(method: string): Command[] {
		return this.commands.filter((command) => command.method === method);
	}

	#result(method: string, params: Record<string, unknown>): unknown {
		switch (method) {
			case "Target.attachToTarget":
				return { sessionId: `S-${String(params.targetId)}` };
			case "Runtime.evaluate":
				return { result: { type: "string", value: this.visibility } };
			case "Page.captureScreenshot":
				return { data: "c25hcHNob3Q=" };
			case "Page.getLayoutMetrics":
				return { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0 } };
			default:
				return {};
		}
	}
}

class Phone {
	readonly messages: BrowserServerMessage[] = [];
	readonly viewer: BrowserViewer;

	constructor(service: BrowserService, name: string) {
		this.viewer = service.connect(name, { send: (message) => this.messages.push(message), backlog: () => 0 });
	}

	send(message: BrowserClientMessage): void {
		this.viewer.receive(message);
	}

	of<T extends BrowserServerMessage["type"]>(type: T): Array<Extract<BrowserServerMessage, { type: T }>> {
		return this.messages.filter(
			(message): message is Extract<BrowserServerMessage, { type: T }> => message.type === type,
		);
	}
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await Bun.sleep(5);
	}
}

let relay: FakeRelay | undefined;
let service: BrowserService | undefined;
let raised = 0;
afterEach(() => {
	service?.stop();
	relay?.stop();
	service = relay = undefined;
	raised = 0;
});

// These run against real sockets, so time is real too; the service's intervals are shortened instead of faked.
function setup() {
	const port = 20_000 + Math.floor(Math.random() * 20_000);
	relay = new FakeRelay(port);
	service = createBrowserService({
		relayUrl: new URL(`http://127.0.0.1:${port}`),
		retryMs: 20,
		idleCloseMs: 20,
		quietMs: 40,
		answerTimeoutMs: 50,
		raiseBrowser: async () => {
			raised++;
		},
	});
	return { relay, service };
}

async function watchFirstTab(phone: Phone, relay: FakeRelay) {
	await until(() => phone.of("tabs").length > 0);
	phone.send({ type: "watch", tabId: "PAGEa.1", maxWidth: 1170 });
	await until(() => relay.sent("Page.startScreencast").length > 0);
}

describe("browser service", () => {
	test("reports a missing relay once while retrying, then the tabs once it starts", async () => {
		const { relay, service } = setup();
		relay.running = false;
		relay.start();
		const phone = new Phone(service, "iPhone");
		await until(() => relay.probes >= 4);
		expect(phone.of("state")).toEqual([{ type: "state", availability: { kind: "relay_offline" } }]);

		relay.running = true;
		await until(() => phone.of("tabs").length > 0);
		expect(phone.of("state").at(-1)).toEqual({ type: "state", availability: { kind: "ready" } });
		expect(
			phone
				.of("tabs")
				.at(-1)
				?.tabs.map((tab) => tab.title)
				.sort(),
		).toEqual(["Docs", "Sign in"]);
	});

	test("reports a relay without its Chrome extension", async () => {
		const { relay, service } = setup();
		relay.extensionConnected = false;
		relay.start();
		const phone = new Phone(service, "iPhone");
		await until(() => phone.of("state").length > 0);
		expect(phone.of("state")[0]?.availability).toEqual({ kind: "extension_disconnected" });
		expect(await service.availability()).toEqual({ kind: "extension_disconnected" });
	});

	test("a phone that stops acknowledging gets two frames, then the newest one, and holds Chrome back", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		for (let i = 1; i <= 10; i++) relay.frame(i, `frame-${i}`);
		// Relay events arrive in order, so once this rename shows up every frame before it was handled.
		relay.emit("Target.targetInfoChanged", { targetInfo: { ...relay.tabs[1]!, title: "Renamed" } });
		await until(
			() =>
				phone
					.of("tabs")
					.at(-1)
					?.tabs.some((tab) => tab.title === "Renamed") === true,
		);
		expect(phone.of("frame").map((message) => message.frame.jpeg)).toEqual(["frame-1", "frame-2"]);
		await until(() => relay.sent("Page.screencastFrameAck").length === 2);
		expect(relay.sent("Page.screencastFrameAck").map((command) => command.params.sessionId)).toEqual([1, 2]);

		phone.send({ type: "frame.ack", seq: phone.of("frame")[0]!.frame.seq });
		expect(phone.of("frame")[2]?.frame).toMatchObject({ jpeg: "frame-10", width: 1200, height: 800, mode: "live" });
		await until(() => relay.sent("Page.screencastFrameAck").length === 3);
		expect(relay.sent("Page.screencastFrameAck")[2]?.params.sessionId).toBe(10);
		expect(relay.sent("Target.activateTarget")).toEqual([]);
	});

	test("only the phone in control drives the tab, and control passes between phones", async () => {
		const { relay, service } = setup();
		relay.start();
		const first = new Phone(service, "iPhone");
		const second = new Phone(service, "iPad");
		await watchFirstTab(first, relay);
		second.send({ type: "watch", tabId: "PAGEa.1", maxWidth: 1170 });

		first.send({ type: "input.tap", x: 10, y: 20 });
		expect(first.of("error").at(-1)?.error.code).toBe("forbidden");

		first.send({ type: "control.take" });
		expect(first.of("control").at(-1)?.control).toEqual({ kind: "you" });
		expect(second.of("control").at(-1)?.control).toEqual({ kind: "other", deviceName: "iPhone" });
		await until(() => relay.sent("Target.activateTarget").length === 1);
		expect(relay.sent("Target.activateTarget")[0]?.params).toEqual({ targetId: "PAGEa.1" });
		await until(() => raised === 1);

		first.send({ type: "input.tap", x: 10, y: 20 });
		first.send({ type: "input.text", text: "héllo 👋" });
		await until(() => relay.sent("Input.insertText").length === 1);
		expect(
			relay
				.sent("Input.dispatchMouseEvent")
				.map(({ params, sessionId }) => [params.type, params.x, params.y, sessionId]),
		).toEqual([
			["mouseMoved", 10, 20, "S-PAGEa.1"],
			["mousePressed", 10, 20, "S-PAGEa.1"],
			["mouseReleased", 10, 20, "S-PAGEa.1"],
		]);
		expect(relay.sent("Input.insertText")[0]?.params).toEqual({ text: "héllo 👋" });

		second.send({ type: "control.take" });
		expect(first.of("control").at(-1)?.control).toEqual({ kind: "other", deviceName: "iPad" });
		second.viewer.close();
		expect(first.of("control").at(-1)?.control).toEqual({ kind: "none" });
	});

	test("a background tab is shown as stills, a static front tab keeps its frame", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		relay.frame(1, "frame-1");
		await until(() => phone.of("frame").length === 1);
		phone.send({ type: "frame.ack", seq: phone.of("frame")[0]!.frame.seq });
		await until(() => relay.sent("Page.captureScreenshot").length >= 2);
		expect(phone.of("frame")).toHaveLength(1);
		expect(phone.of("drawing")).toEqual([]);

		relay.visibility = "hidden";
		await until(() => phone.of("frame").length === 2);
		expect(phone.of("frame")[1]?.frame).toMatchObject({
			jpeg: "c25hcHNob3Q=",
			width: 1200,
			height: 800,
			mode: "snapshot",
		});
		expect(relay.sent("Target.activateTarget")).toEqual([]);
	});

	test("a browser that stops drawing is reported until a frame arrives again", async () => {
		const { relay, service } = setup();
		relay.start();
		relay.unanswered.add("Page.captureScreenshot");
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		await until(() => phone.of("drawing").length === 1);
		expect(phone.of("drawing")[0]).toEqual({ type: "drawing", drawing: false });
		expect(phone.of("frame")).toEqual([]);

		const late = new Phone(service, "iPad");
		late.send({ type: "watch", tabId: "PAGEa.1", maxWidth: 1170 });
		expect(late.of("drawing")).toEqual([{ type: "drawing", drawing: false }]);

		relay.frame(1, "frame-1");
		await until(() => phone.of("drawing").length === 2);
		expect(phone.of("drawing")[1]).toEqual({ type: "drawing", drawing: true });
		expect(phone.of("frame")[0]?.frame.jpeg).toBe("frame-1");
	});

	test("a frozen tab whose page never answers is shown as stills", async () => {
		const { relay, service } = setup();
		relay.start();
		relay.unanswered.add("Runtime.evaluate");
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		await until(() => phone.of("frame").length === 1);
		expect(phone.of("frame")[0]?.frame).toMatchObject({ jpeg: "c25hcHNob3Q=", mode: "snapshot" });
		expect(phone.of("drawing")).toEqual([]);
	});

	test("input Chrome does not answer is dropped and reported once, and later input still goes through", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		phone.send({ type: "control.take" });
		relay.unanswered.add("Input.");
		for (let i = 0; i < 5; i++) phone.send({ type: "input.tap", x: i, y: i });
		await until(() => phone.of("error").length === 1);
		expect(phone.of("error")[0]?.error).toEqual({
			code: "unavailable",
			message: "Chrome isn't answering this tab. Bring it to the front on the computer.",
		});
		expect(relay.sent("Input.dispatchMouseEvent")).toHaveLength(1);

		relay.unanswered.delete("Input.");
		phone.send({ type: "input.text", text: "back" });
		await until(() => relay.sent("Input.insertText").length === 1);
		expect(relay.sent("Input.dispatchMouseEvent")).toHaveLength(1);
		expect(phone.of("error")).toHaveLength(1);
	});

	test("bringing the watched tab to the front raises the browser", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		phone.send({ type: "tab.activate" });
		await until(() => raised === 1);
		expect(relay.sent("Target.activateTarget")).toHaveLength(1);
	});

	test("a closed tab stops the stream and tells its viewers", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		relay.emit("Target.targetDestroyed", { targetId: "PAGEa.1" });
		await until(() => phone.of("unwatched").length === 1);
		expect(phone.of("unwatched")[0]).toEqual({ type: "unwatched", tabId: "PAGEa.1" });
		await until(() => phone.of("tabs").at(-1)?.tabs.length === 1);
	});

	test("the last viewer leaving stops the screencast", async () => {
		const { relay, service } = setup();
		relay.start();
		const phone = new Phone(service, "iPhone");
		await watchFirstTab(phone, relay);
		phone.viewer.close();
		await until(() => relay.sent("Target.detachFromTarget").length === 1);
		expect(relay.sent("Page.stopScreencast")).toHaveLength(1);
	});
});
