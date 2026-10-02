#!/usr/bin/env bun
// Stands in for the OMP Browser Relay so the app's browser screen can be driven without Chrome, for example while
// the Mac's screen is locked and no Chrome draws. Serves one tab, streams the two fixture JPEGs as screencast frames
// (one per acknowledged frame, at most 10 a second), answers the copy button's selection check with `Fake selection`,
// and prints every input and activation it receives as `CMD <method> <params>`.
//   fake-browser-relay.ts [port]    default 29224; point the run's config.json "browserRelayUrl" at it
import { join } from "node:path";

const port = Number(process.argv[2] ?? 29224);
const fixtures = join(import.meta.dir, "..", "fixtures");
const frames = await Promise.all(
	["browser-frame-1.jpg", "browser-frame-2.jpg"].map(async (name) =>
		Buffer.from(await Bun.file(join(fixtures, name)).arrayBuffer()).toString("base64"),
	),
);
const tab = { targetId: "PAGEfake.1", type: "page", title: "Fake sign-in page", url: "https://example.com/login" };
const RESULTS: Record<string, unknown> = {
	"Target.attachToTarget": { sessionId: "S1" },
	"Runtime.evaluate": { result: { type: "string", value: "visible" } },
};

let timer: Timer | undefined;
let frameId = 0;
let awaitingAck = false;

Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch(req, server) {
		const path = new URL(req.url).pathname;
		if (path === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp` });
		if (path === "/cdp" && server.upgrade(req)) return;
		return new Response("not found", { status: 404 });
	},
	websocket: {
		message(ws, raw) {
			const { id, method, params = {} } = JSON.parse(String(raw)) as {
				id: number;
				method: string;
				params?: Record<string, unknown>;
			};
			if (method.startsWith("Input.") || method === "Target.activateTarget")
				console.log("CMD", method, JSON.stringify(params));
			if (method === "Target.setDiscoverTargets")
				ws.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: tab } }));
			if (method === "Page.screencastFrameAck") awaitingAck = false;
			if (method === "Page.startScreencast") {
				clearInterval(timer);
				awaitingAck = false;
				timer = setInterval(() => {
					if (awaitingAck) return;
					awaitingAck = true;
					frameId++;
					const metadata = { deviceWidth: 1200, deviceHeight: 749, offsetTop: 0, pageScaleFactor: 1 };
					const params = { data: frames[frameId % 2], sessionId: frameId, metadata };
					ws.send(JSON.stringify({ sessionId: "S1", method: "Page.screencastFrame", params }));
				}, 100);
			}
			if (method === "Page.stopScreencast") clearInterval(timer);
			const selection = method === "Runtime.evaluate" && String(params.expression).includes("getSelection");
			const result = selection ? { result: { value: { text: "Fake selection" } } } : (RESULTS[method] ?? {});
			if (selection) console.log("CMD copy");
			ws.send(JSON.stringify({ id, result }));
		},
		close() {
			clearInterval(timer);
		},
	},
});
console.log(`fake browser relay listening on ${port}`);
