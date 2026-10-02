import type {
	ApiError,
	BrowserAvailability,
	BrowserClientMessage,
	BrowserControl,
	BrowserFrame,
	BrowserKey,
	BrowserServerMessage,
	BrowserTab,
} from "@omp-mobile/protocol";
import { z } from "zod";
import { raiseBrowser } from "./front.ts";
import { CdpConnection, type CdpEvent, CdpTimeoutError, probeRelay } from "./relay.ts";

const FRAME_CREDIT = 2;
const MAX_SOCKET_BACKLOG = 512 * 1024;
const MAX_FRAME_WIDTH = 1280;
const JPEG_QUALITY = 60;
const PROBE_CACHE_MS = 3_000;
const ANSWER_TIMEOUT_MS = 3_000;
/** Captures that never return still queue up in Chrome, so a browser that does not draw is checked rarely. */
const STALLED_RECHECK_MS = 10_000;

export interface BrowserServiceOptions {
	relayUrl: URL;
	/** Delay between attempts to reach the relay while a viewer is open. */
	retryMs?: number;
	/** How long the relay connection outlives the last viewer, covering app background/foreground churn. */
	idleCloseMs?: number;
	/** A watched tab silent this long is checked for being in the background. */
	quietMs?: number;
	/** How long Chrome may take to answer an input or a check of the tab before the tab counts as stalled. */
	answerTimeoutMs?: number;
	/** Brings the browser in front of other apps on the computer. */
	raiseBrowser?: () => Promise<void>;
}

export interface ViewerOutput {
	send(message: BrowserServerMessage): void;
	/** Bytes the socket has not yet written. */
	backlog(): number;
}

export interface BrowserViewer {
	receive(message: BrowserClientMessage): void;
	close(): void;
}

export interface BrowserService {
	availability(): Promise<BrowserAvailability>;
	connect(deviceName: string, out: ViewerOutput): BrowserViewer;
	stop(): void;
}

type Link =
	| { kind: "closed" }
	| { kind: "connecting" }
	| { kind: "waiting"; timer: Timer }
	| { kind: "open"; cdp: CdpConnection };

interface Frame extends Omit<BrowserFrame, "seq"> {
	id: number;
}

class Viewer {
	tabId: string | null = null;
	maxWidth = MAX_FRAME_WIDTH;
	readonly inflight = new Set<number>();
	lastFrameId = 0;
	#seq = 0;

	constructor(
		readonly deviceName: string,
		readonly out: ViewerOutput,
	) {}

	deliver(frame: Frame): boolean {
		if (frame.id <= this.lastFrameId || this.inflight.size >= FRAME_CREDIT || this.out.backlog() > MAX_SOCKET_BACKLOG)
			return false;
		const seq = ++this.#seq;
		this.inflight.add(seq);
		this.lastFrameId = frame.id;
		const { id: _id, ...rest } = frame;
		this.out.send({ type: "frame", frame: { seq, ...rest } });
		return true;
	}

	error(code: ApiError["code"], message: string): void {
		this.out.send({ type: "error", error: { code, message } });
	}
}

class TabStream {
	sessionId: string | null = null;
	latest: Frame | null = null;
	/** A screencast frame Chrome waits on: no viewer had room for it, so Chrome must not produce the next yet. */
	unackedFrame: number | null = null;
	lastFrameAt = 0;
	closed = false;
	checking = false;
	/** Whether Chrome answers captures of the tab. Nothing on a Mac draws while its screen is locked. */
	drawing = true;
	nextDrawCheckAt = 0;
	timer?: Timer;
	/** Input runs one command sequence at a time so a tap's press and release never interleave with a keystroke. */
	input: Promise<void> = Promise.resolve();
	/** Bumped when input stalls, so the input queued behind the stalled command is dropped rather than replayed. */
	inputGeneration = 0;
	readonly viewers = new Set<Viewer>();

	constructor(readonly tabId: string) {}
}

const TargetInfoSchema = z.object({ targetId: z.string(), type: z.string(), title: z.string(), url: z.string() });
const TargetEventSchema = z.object({ targetInfo: TargetInfoSchema });
const TargetIdSchema = z.object({ targetId: z.string() });
const SessionIdSchema = z.object({ sessionId: z.string() });
const ScreencastFrameSchema = z.object({
	data: z.string(),
	sessionId: z.number(),
	metadata: z.object({ deviceWidth: z.number(), deviceHeight: z.number() }),
});
const ScreenshotSchema = z.object({ data: z.string() });
const LayoutSchema = z.object({
	cssLayoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
});
const EvaluateSchema = z.object({ result: z.object({ value: z.unknown() }) });

const KEYS: Record<BrowserKey, { code: string; keyCode: number; text?: string }> = {
	Backspace: { code: "Backspace", keyCode: 8 },
	Enter: { code: "Enter", keyCode: 13, text: "\r" },
	Tab: { code: "Tab", keyCode: 9 },
	Escape: { code: "Escape", keyCode: 27 },
	ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	ArrowRight: { code: "ArrowRight", keyCode: 39 },
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

type InputMessage = Extract<BrowserClientMessage, { type: `input.${string}` }>;

export function inputCommands(input: InputMessage): Array<[method: string, params: Record<string, unknown>]> {
	switch (input.type) {
		case "input.tap": {
			const at = { x: input.x, y: input.y };
			return [
				["Input.dispatchMouseEvent", { type: "mouseMoved", ...at }],
				["Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 }],
				["Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 }],
			];
		}
		case "input.scroll":
			return [
				[
					"Input.dispatchMouseEvent",
					{ type: "mouseWheel", x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy },
				],
			];
		case "input.text":
			return [["Input.insertText", { text: input.text }]];
		case "input.key": {
			const { code, keyCode, text } = KEYS[input.key];
			const key = { key: input.key, code, windowsVirtualKeyCode: keyCode };
			return [
				["Input.dispatchKeyEvent", { type: "keyDown", ...key, ...(text ? { text } : {}) }],
				["Input.dispatchKeyEvent", { type: "keyUp", ...key }],
			];
		}
	}
}

export function createBrowserService(options: BrowserServiceOptions): BrowserService {
	return new Service(options);
}

class Service implements BrowserService {
	readonly #relayUrl: URL;
	readonly #retryMs: number;
	readonly #idleCloseMs: number;
	readonly #quietMs: number;
	readonly #answerTimeoutMs: number;
	readonly #raiseBrowser: () => Promise<void>;
	#link: Link = { kind: "closed" };
	#availability: BrowserAvailability | null = null;
	readonly #viewers = new Set<Viewer>();
	readonly #tabs = new Map<string, BrowserTab>();
	readonly #streams = new Map<string, TabStream>();
	readonly #controllers = new Map<string, Viewer>();
	#frameIds = 0;
	#idleTimer?: Timer;
	#tabsTimer?: Timer;
	#probe: { at: number; result: Promise<BrowserAvailability> } | null = null;

	constructor(options: BrowserServiceOptions) {
		this.#relayUrl = options.relayUrl;
		this.#retryMs = options.retryMs ?? 3_000;
		this.#idleCloseMs = options.idleCloseMs ?? 15_000;
		this.#quietMs = options.quietMs ?? 2_000;
		this.#answerTimeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
		this.#raiseBrowser = options.raiseBrowser ?? raiseBrowser;
	}

	async availability(): Promise<BrowserAvailability> {
		if (this.#link.kind === "open" && this.#availability) return this.#availability;
		if (!this.#probe || Date.now() - this.#probe.at > PROBE_CACHE_MS) {
			const result = probeRelay(this.#relayUrl).then(
				(probe): BrowserAvailability => (probe.kind === "ready" ? { kind: "ready" } : probe),
			);
			this.#probe = { at: Date.now(), result };
		}
		return this.#probe.result;
	}

	connect(deviceName: string, out: ViewerOutput): BrowserViewer {
		const viewer = new Viewer(deviceName, out);
		this.#viewers.add(viewer);
		clearTimeout(this.#idleTimer);
		if (this.#availability) out.send({ type: "state", availability: this.#availability });
		if (this.#link.kind === "open") out.send({ type: "tabs", tabs: this.#sortedTabs() });
		if (this.#link.kind === "closed") void this.#dial();
		return {
			receive: (message) => this.#receive(viewer, message),
			close: () => this.#disconnect(viewer),
		};
	}

	stop(): void {
		clearTimeout(this.#idleTimer);
		clearTimeout(this.#tabsTimer);
		this.#viewers.clear();
		this.#closeLink();
	}

	async #dial(): Promise<void> {
		this.#link = { kind: "connecting" };
		const probe = await probeRelay(this.#relayUrl);
		if (this.#link.kind !== "connecting") return;
		if (probe.kind === "ready") {
			try {
				const cdp = await CdpConnection.open(
					probe.wsUrl,
					(event) => this.#onEvent(event),
					() => this.#onRelayClosed(cdp),
				);
				if (this.#link.kind !== "connecting") {
					cdp.close();
					return;
				}
				this.#link = { kind: "open", cdp };
				await cdp.send("Target.setDiscoverTargets", { discover: true });
				this.#setAvailability({ kind: "ready" });
				for (const viewer of this.#viewers) {
					if (!viewer.tabId) continue;
					if (this.#tabs.has(viewer.tabId)) this.#join(viewer);
					else this.#tabGone(viewer);
				}
				this.#broadcast({ type: "tabs", tabs: this.#sortedTabs() });
				if (!this.#viewers.size) this.#scheduleIdleClose();
				return;
			} catch {
				if (this.#link.kind !== "connecting") return;
				this.#setAvailability({ kind: "relay_offline" });
			}
		} else this.#setAvailability(probe);
		if (!this.#viewers.size) {
			this.#link = { kind: "closed" };
			return;
		}
		this.#link = { kind: "waiting", timer: setTimeout(() => void this.#dial(), this.#retryMs) };
	}

	#onRelayClosed(cdp: CdpConnection): void {
		if (this.#link.kind !== "open" || this.#link.cdp !== cdp) return;
		this.#link = { kind: "closed" };
		this.#forgetBrowser();
		if (this.#viewers.size) void this.#dial();
	}

	#closeLink(): void {
		const link = this.#link;
		this.#link = { kind: "closed" };
		if (link.kind === "waiting") clearTimeout(link.timer);
		this.#forgetBrowser();
		if (link.kind === "open") link.cdp.close();
	}

	/** Drops everything learned over a relay connection; a new connection rediscovers tabs with new ids. */
	#forgetBrowser(): void {
		for (const stream of this.#streams.values()) {
			stream.closed = true;
			clearInterval(stream.timer);
		}
		this.#streams.clear();
		this.#tabs.clear();
		this.#controllers.clear();
	}

	#scheduleIdleClose(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (!this.#viewers.size) this.#closeLink();
		}, this.#idleCloseMs);
	}

	#setAvailability(availability: BrowserAvailability): void {
		if (this.#availability?.kind === availability.kind) return;
		this.#availability = availability;
		this.#broadcast({ type: "state", availability });
	}

	#broadcast(message: BrowserServerMessage): void {
		for (const viewer of this.#viewers) viewer.out.send(message);
	}

	#onEvent(event: CdpEvent): void {
		switch (event.method) {
			case "Target.targetCreated":
			case "Target.targetInfoChanged": {
				const parsed = TargetEventSchema.safeParse(event.params);
				if (!parsed.success || parsed.data.targetInfo.type !== "page") return;
				const { targetId, title, url } = parsed.data.targetInfo;
				this.#tabs.set(targetId, { id: targetId, title, url, lastActivityAt: Date.now() });
				this.#setAvailability({ kind: "ready" });
				this.#scheduleTabs();
				return;
			}
			case "Target.targetDestroyed": {
				const parsed = TargetIdSchema.safeParse(event.params);
				if (!parsed.success || !this.#tabs.delete(parsed.data.targetId)) return;
				this.#controllers.delete(parsed.data.targetId);
				const stream = this.#streams.get(parsed.data.targetId);
				if (stream) this.#endStream(stream);
				this.#scheduleTabs();
				return;
			}
			case "Target.detachedFromTarget": {
				const parsed = SessionIdSchema.safeParse(event.params);
				if (!parsed.success) return;
				const stream = [...this.#streams.values()].find((candidate) => candidate.sessionId === parsed.data.sessionId);
				if (stream) this.#endStream(stream);
				return;
			}
			case "Page.screencastFrame": {
				const parsed = ScreencastFrameSchema.safeParse(event.params);
				const stream = [...this.#streams.values()].find((candidate) => candidate.sessionId === event.sessionId);
				if (parsed.success && stream) this.#onScreencastFrame(stream, parsed.data);
				return;
			}
		}
	}

	#endStream(stream: TabStream): void {
		this.#closeStream(stream, false);
		for (const viewer of stream.viewers) this.#tabGone(viewer);
	}

	#scheduleTabs(): void {
		if (this.#tabsTimer) return;
		this.#tabsTimer = setTimeout(() => {
			this.#tabsTimer = undefined;
			this.#broadcast({ type: "tabs", tabs: this.#sortedTabs() });
			// With every tab gone the extension may have disconnected while the relay stays up.
			if (!this.#tabs.size)
				void probeRelay(this.#relayUrl).then((probe) => {
					if (probe.kind !== "ready" && this.#link.kind === "open") this.#setAvailability(probe);
				});
		}, 100);
	}

	#sortedTabs(): BrowserTab[] {
		return [...this.#tabs.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	#receive(viewer: Viewer, message: BrowserClientMessage): void {
		switch (message.type) {
			case "ping":
				viewer.out.send({ type: "pong" });
				return;
			case "watch":
				this.#watch(viewer, message.tabId, message.maxWidth);
				return;
			case "unwatch":
				this.#leave(viewer);
				return;
			case "frame.ack":
				this.#ack(viewer, message.seq);
				return;
			case "tab.activate":
				if (viewer.tabId) this.#activate(viewer.tabId);
				return;
			case "control.take":
				this.#take(viewer);
				return;
			case "control.release":
				if (viewer.tabId && this.#controllers.get(viewer.tabId) === viewer) {
					this.#controllers.delete(viewer.tabId);
					this.#announceControl(viewer.tabId);
				}
				return;
			default:
				this.#input(viewer, message);
		}
	}

	#disconnect(viewer: Viewer): void {
		this.#leave(viewer);
		this.#viewers.delete(viewer);
		if (!this.#viewers.size) this.#scheduleIdleClose();
	}

	#watch(viewer: Viewer, tabId: string, maxWidth: number): void {
		if (this.#link.kind !== "open") {
			viewer.error("unavailable", "The browser is not connected");
			return;
		}
		if (!this.#tabs.has(tabId)) {
			viewer.error("not_found", "That tab is no longer open");
			return;
		}
		if (viewer.tabId !== tabId) {
			this.#leave(viewer);
			viewer.tabId = tabId;
			viewer.maxWidth = Math.min(MAX_FRAME_WIDTH, Math.max(320, Math.round(maxWidth)));
		}
		this.#join(viewer);
	}

	#join(viewer: Viewer): void {
		const tabId = viewer.tabId;
		if (!tabId) return;
		const stream = this.#streams.get(tabId) ?? this.#openStream(tabId, viewer.maxWidth);
		stream.viewers.add(viewer);
		viewer.out.send({ type: "watching", tabId, control: this.#controlFor(viewer) });
		if (!stream.drawing) viewer.out.send({ type: "drawing", drawing: false });
		viewer.inflight.clear();
		viewer.lastFrameId = 0;
		if (stream.latest) viewer.deliver(stream.latest);
	}

	#leave(viewer: Viewer): void {
		const tabId = viewer.tabId;
		if (!tabId) return;
		viewer.tabId = null;
		viewer.inflight.clear();
		if (this.#controllers.get(tabId) === viewer) {
			this.#controllers.delete(tabId);
			this.#announceControl(tabId);
		}
		const stream = this.#streams.get(tabId);
		if (!stream) return;
		stream.viewers.delete(viewer);
		if (!stream.viewers.size) this.#closeStream(stream, true);
	}

	#tabGone(viewer: Viewer): void {
		const tabId = viewer.tabId;
		if (!tabId) return;
		viewer.tabId = null;
		viewer.inflight.clear();
		viewer.out.send({ type: "unwatched", tabId });
	}

	#controlFor(viewer: Viewer): BrowserControl {
		const holder = viewer.tabId ? this.#controllers.get(viewer.tabId) : undefined;
		if (!holder) return { kind: "none" };
		return holder === viewer ? { kind: "you" } : { kind: "other", deviceName: holder.deviceName };
	}

	#announceControl(tabId: string): void {
		for (const viewer of this.#viewers)
			if (viewer.tabId === tabId) viewer.out.send({ type: "control", control: this.#controlFor(viewer) });
	}

	#take(viewer: Viewer): void {
		const tabId = viewer.tabId;
		if (!tabId) {
			viewer.error("bad_request", "Watch a tab before taking control");
			return;
		}
		this.#activate(tabId);
		if (this.#controllers.get(tabId) === viewer) {
			viewer.out.send({ type: "control", control: { kind: "you" } });
			return;
		}
		this.#controllers.set(tabId, viewer);
		this.#announceControl(tabId);
	}

	#activate(tabId: string): void {
		if (this.#link.kind !== "open") return;
		void this.#link.cdp
			.send("Target.activateTarget", { targetId: tabId })
			.catch(() => {})
			.then(() => this.#raiseBrowser())
			.catch(() => {});
	}

	#input(viewer: Viewer, input: InputMessage): void {
		const tabId = viewer.tabId;
		const stream = tabId ? this.#streams.get(tabId) : undefined;
		if (!tabId || this.#controllers.get(tabId) !== viewer) {
			viewer.error("forbidden", "Take control of this tab first");
			return;
		}
		const sessionId = stream?.sessionId;
		if (!stream || !sessionId || this.#link.kind !== "open") {
			viewer.error("unavailable", "The tab is still connecting");
			return;
		}
		const cdp = this.#link.cdp;
		const generation = stream.inputGeneration;
		stream.input = stream.input.then(async () => {
			if (generation !== stream.inputGeneration) return;
			try {
				for (const [method, params] of inputCommands(input))
					await cdp.send(method, params, sessionId, this.#answerTimeoutMs);
			} catch (error) {
				if (generation !== stream.inputGeneration) return;
				stream.inputGeneration++;
				viewer.error(
					"unavailable",
					error instanceof CdpTimeoutError
						? "Chrome isn't answering this tab. Bring it to the front on the computer."
						: error instanceof Error
							? error.message
							: "Input failed",
				);
			}
		});
	}

	#openStream(tabId: string, maxWidth: number): TabStream {
		const stream = new TabStream(tabId);
		this.#streams.set(tabId, stream);
		void this.#startStream(stream, maxWidth);
		return stream;
	}

	async #startStream(stream: TabStream, maxWidth: number): Promise<void> {
		if (this.#link.kind !== "open") return;
		const cdp = this.#link.cdp;
		try {
			const { sessionId } = SessionIdSchema.parse(
				await cdp.send("Target.attachToTarget", { targetId: stream.tabId, flatten: true }),
			);
			if (stream.closed) {
				void cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
				return;
			}
			stream.sessionId = sessionId;
			await cdp.send("Page.enable", {}, sessionId);
			await cdp.send(
				"Page.startScreencast",
				{ format: "jpeg", quality: JPEG_QUALITY, maxWidth, maxHeight: maxWidth * 2, everyNthFrame: 1 },
				sessionId,
			);
			stream.lastFrameAt = Date.now();
			stream.timer = setInterval(() => void this.#checkQuiet(stream), this.#quietMs);
		} catch (error) {
			if (stream.closed) return;
			this.#closeStream(stream, true);
			for (const viewer of stream.viewers) {
				viewer.error("unavailable", error instanceof Error ? error.message : "Could not open the tab");
				this.#tabGone(viewer);
			}
		}
	}

	#closeStream(stream: TabStream, detach: boolean): void {
		stream.closed = true;
		clearInterval(stream.timer);
		this.#streams.delete(stream.tabId);
		const sessionId = stream.sessionId;
		if (!detach || !sessionId || this.#link.kind !== "open") return;
		const cdp = this.#link.cdp;
		void cdp
			.send("Page.stopScreencast", {}, sessionId)
			.catch(() => {})
			.then(() => cdp.send("Target.detachFromTarget", { sessionId }))
			.catch(() => {});
	}

	#publish(stream: TabStream, frame: Omit<Frame, "id">): boolean {
		const latest: Frame = { id: ++this.#frameIds, ...frame };
		stream.latest = latest;
		let delivered = false;
		for (const viewer of stream.viewers) if (viewer.deliver(latest)) delivered = true;
		return delivered;
	}

	#onScreencastFrame(stream: TabStream, frame: z.infer<typeof ScreencastFrameSchema>): void {
		stream.lastFrameAt = Date.now();
		this.#setDrawing(stream, true);
		const delivered = this.#publish(stream, {
			jpeg: frame.data,
			width: frame.metadata.deviceWidth,
			height: frame.metadata.deviceHeight,
			mode: "live",
		});
		if (delivered) this.#ackScreencast(stream, frame.sessionId);
		else stream.unackedFrame = frame.sessionId;
	}

	#ackScreencast(stream: TabStream, frameSession: number): void {
		if (this.#link.kind !== "open" || !stream.sessionId) return;
		void this.#link.cdp.send("Page.screencastFrameAck", { sessionId: frameSession }, stream.sessionId).catch(() => {});
	}

	#ack(viewer: Viewer, seq: number): void {
		viewer.inflight.delete(seq);
		const stream = viewer.tabId ? this.#streams.get(viewer.tabId) : undefined;
		if (!stream) return;
		if (stream.latest) viewer.deliver(stream.latest);
		if (stream.unackedFrame !== null) {
			this.#ackScreencast(stream, stream.unackedFrame);
			stream.unackedFrame = null;
		}
	}

	#setDrawing(stream: TabStream, drawing: boolean): void {
		if (stream.drawing === drawing) return;
		stream.drawing = drawing;
		for (const viewer of stream.viewers) viewer.out.send({ type: "drawing", drawing });
	}

	/**
	 * Chrome only paints, and so only screencasts, the tab in front of a window that is itself on screen, and nothing
	 * at all while the Mac's screen is locked. A quiet stream is a static page, whose last frame is still current, a
	 * hidden tab, which gets a still every check instead, or a tab Chrome does not draw, whose captures never return.
	 */
	async #checkQuiet(stream: TabStream): Promise<void> {
		const sessionId = stream.sessionId;
		const now = Date.now();
		if (
			stream.checking ||
			!sessionId ||
			stream.unackedFrame !== null ||
			now - stream.lastFrameAt < this.#quietMs ||
			(!stream.drawing && now < stream.nextDrawCheckAt) ||
			this.#link.kind !== "open"
		)
			return;
		const cdp = this.#link.cdp;
		stream.checking = true;
		try {
			// Chrome freezes some background tabs, and their pages never answer; such a tab is hidden.
			const hidden = await cdp
				.send(
					"Runtime.evaluate",
					{ expression: "document.visibilityState", returnByValue: true },
					sessionId,
					this.#answerTimeoutMs,
				)
				.then(
					(result) => EvaluateSchema.parse(result).result.value === "hidden",
					(error: unknown) => {
						if (error instanceof CdpTimeoutError) return true;
						throw error;
					},
				);
			if (!hidden && stream.latest) {
				// A static front tab needs no new picture, only proof that Chrome still draws. A clipped capture would
				// briefly resize the page, and the screencast would stream that one-pixel picture to the phone.
				await cdp.send(
					"Runtime.evaluate",
					{ expression: "new Promise((done) => requestAnimationFrame(() => done(true)))", awaitPromise: true },
					sessionId,
					this.#answerTimeoutMs,
				);
				if (!stream.closed) this.#setDrawing(stream, true);
				return;
			}
			const [shot, layout] = await Promise.all([
				cdp.send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY }, sessionId, this.#answerTimeoutMs),
				cdp.send("Page.getLayoutMetrics", {}, sessionId),
			]);
			if (stream.closed) return;
			this.#setDrawing(stream, true);
			const viewport = LayoutSchema.parse(layout).cssLayoutViewport;
			this.#publish(stream, {
				jpeg: ScreenshotSchema.parse(shot).data,
				width: viewport.clientWidth,
				height: viewport.clientHeight,
				mode: hidden ? "snapshot" : "live",
			});
		} catch (error) {
			if (stream.closed || !(error instanceof CdpTimeoutError)) return;
			this.#setDrawing(stream, false);
			stream.nextDrawCheckAt = Date.now() + STALLED_RECHECK_MS;
		} finally {
			stream.checking = false;
		}
	}
}
