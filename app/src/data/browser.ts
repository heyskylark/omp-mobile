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
import { useEffect, useMemo, useReducer, useRef } from "react";
import { AppState, Dimensions, PixelRatio, type NativeEventSubscription } from "react-native";
import type { PairedMachine } from "../native/types";
import { openMachineSocket, PING_MS, STALE_MS } from "./live";

const MAX_FRAME_WIDTH = 1280;

const SERVER_MESSAGE_TYPES: Record<BrowserServerMessage["type"], true> = {
	state: true,
	tabs: true,
	watching: true,
	drawing: true,
	unwatched: true,
	control: true,
	frame: true,
	pong: true,
	error: true,
};

function parseMessage(raw: unknown): BrowserServerMessage | null {
	if (typeof raw !== "string") return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || !("type" in value)) return null;
		if (typeof value.type !== "string" || !Object.hasOwn(SERVER_MESSAGE_TYPES, value.type)) return null;
		// Only the type is checked, as the machine socket does; the server is trusted for the payload.
		return value as BrowserServerMessage;
	} catch {
		return null;
	}
}

/** A frame tagged with the connection it arrived on: sequence numbers restart on every socket. */
export interface ViewerFrame extends BrowserFrame {
	epoch: number;
}

/** `reconnecting` keeps the last known tabs and frame on screen while a new socket is opened. */
export type BrowserLink = "open" | "reconnecting";

export type BrowserWatch =
	| { kind: "none" }
	| { kind: "pending"; tabId: string }
	/** `drawing` is false while Chrome draws nothing, as when the computer's screen is locked. */
	| { kind: "watching"; tabId: string; control: BrowserControl; frame: ViewerFrame | null; drawing: boolean }
	| { kind: "closed"; tabId: string };

export type BrowserViewerState =
	| { kind: "connecting" }
	| { kind: "unavailable"; link: BrowserLink; availability: Exclude<BrowserAvailability, { kind: "ready" }> }
	/** `tabs` is null until the server's first list arrives. */
	| { kind: "ready"; link: BrowserLink; tabs: BrowserTab[] | null; watch: BrowserWatch };

type BrowserViewerAction =
	| { type: "reset" }
	| { type: "connected" }
	| { type: "disconnected" }
	| { type: "watch"; tabId: string }
	| { type: "gone"; tabId: string }
	| { type: "message"; message: BrowserServerMessage; epoch: number };

const INITIAL_STATE: BrowserViewerState = { kind: "connecting" };

export function browserViewerReducer(state: BrowserViewerState, action: BrowserViewerAction): BrowserViewerState {
	switch (action.type) {
		case "reset":
			return INITIAL_STATE;
		case "connected":
			return state.kind === "connecting" ? state : { ...state, link: "open" };
		case "disconnected":
			return state.kind === "connecting" ? state : { ...state, link: "reconnecting" };
		case "watch":
			return state.kind === "ready" ? { ...state, watch: { kind: "pending", tabId: action.tabId } } : state;
		case "gone":
			return state.kind === "ready" ? { ...state, watch: { kind: "closed", tabId: action.tabId } } : state;
		case "message":
			return applyMessage(state, action.message, action.epoch);
	}
}

function applyMessage(state: BrowserViewerState, message: BrowserServerMessage, epoch: number): BrowserViewerState {
	const link: BrowserLink = state.kind === "connecting" ? "open" : state.link;
	switch (message.type) {
		case "state": {
			const availability = message.availability;
			if (availability.kind !== "ready") return { kind: "unavailable", link, availability };
			return state.kind === "ready" ? state : { kind: "ready", link, tabs: null, watch: { kind: "none" } };
		}
		case "tabs":
			return state.kind === "ready" ? { ...state, tabs: message.tabs } : state;
		case "watching": {
			if (state.kind !== "ready") return state;
			// A re-watch of the same tab after a reconnect keeps showing the last frame until a new one arrives.
			const frame = state.watch.kind === "watching" && state.watch.tabId === message.tabId ? state.watch.frame : null;
			return {
				...state,
				watch: { kind: "watching", tabId: message.tabId, control: message.control, frame, drawing: true },
			};
		}
		case "drawing":
			return state.kind === "ready" && state.watch.kind === "watching"
				? { ...state, watch: { ...state.watch, drawing: message.drawing } }
				: state;
		case "unwatched":
			return state.kind === "ready" && "tabId" in state.watch && state.watch.tabId === message.tabId
				? { ...state, watch: { kind: "closed", tabId: message.tabId } }
				: state;
		case "control":
			return state.kind === "ready" && state.watch.kind === "watching"
				? { ...state, watch: { ...state.watch, control: message.control } }
				: state;
		case "frame":
			return state.kind === "ready" && state.watch.kind === "watching"
				? { ...state, watch: { ...state.watch, frame: { ...message.frame, epoch } } }
				: state;
		case "pong":
		case "error":
			return state;
	}
}

/** Maps a point in the on-screen image (layout points, unzoomed) to the tab viewport's CSS pixels. */
export function toCssPoint(
	point: { x: number; y: number },
	layoutWidth: number,
	viewport: { width: number; height: number },
): { x: number; y: number } {
	const scale = layoutWidth > 0 ? viewport.width / layoutWidth : 0;
	return {
		x: Math.min(viewport.width, Math.max(0, Math.round(point.x * scale))),
		y: Math.min(viewport.height, Math.max(0, Math.round(point.y * scale))),
	};
}

/**
 * The viewer's own socket to `/v1/browser/stream`, with the machine socket's lifecycle: closed in the background,
 * reopened on return, pinged while active, retried with jittered backoff. Control and the watched tab do not
 * survive a socket, so after every reconnect the viewer re-watches its tab and retakes control it held.
 */
class BrowserViewer {
	private socket: WebSocket | null = null;
	private retry = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private lastMessageAt = 0;
	private stopped = false;
	private background = false;
	private appState: NativeEventSubscription | null = null;
	private epoch = 0;
	private tabId: string | null = null;
	private controlling = false;
	/** Set when the server no longer watches `tabId` for us; the next tab list decides whether to re-watch. */
	private resume = false;
	/** The watched tab closed: wait for the user to pick rather than auto-watching another. */
	private closed = false;

	constructor(
		private readonly machine: PairedMachine,
		private readonly dispatch: (action: BrowserViewerAction) => void,
		private readonly onError: (error: ApiError) => void,
	) {}

	start() {
		this.stopped = false;
		this.dispatch({ type: "reset" });
		this.background = AppState.currentState === "background";
		this.appState = AppState.addEventListener("change", (state) => {
			if (state === "background") this.enterBackground();
			else if (state === "active") this.enterForeground();
		});
		this.connect();
	}

	stop() {
		this.stopped = true;
		this.appState?.remove();
		this.appState = null;
		this.disconnect();
	}

	watch(tabId: string) {
		this.tabId = tabId;
		this.controlling = false;
		this.closed = false;
		this.resume = false;
		this.dispatch({ type: "watch", tabId });
		this.sendWatch(tabId);
	}

	takeControl() {
		this.controlling = true;
		this.send({ type: "control.take" });
	}

	release() {
		this.controlling = false;
		this.send({ type: "control.release" });
	}

	ack(frame: ViewerFrame) {
		if (frame.epoch === this.epoch) this.send({ type: "frame.ack", seq: frame.seq });
	}

	send(message: BrowserClientMessage) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
	}

	private sendWatch(tabId: string) {
		const maxWidth = Math.min(MAX_FRAME_WIDTH, Math.round(Dimensions.get("window").width * PixelRatio.get()));
		this.send({ type: "watch", tabId, maxWidth });
	}

	private handle(message: BrowserServerMessage) {
		this.dispatch({ type: "message", message, epoch: this.epoch });
		switch (message.type) {
			case "state":
				if (message.availability.kind !== "ready") this.resume = this.tabId !== null;
				break;
			case "tabs": {
				if (this.resume && this.tabId !== null) {
					this.resume = false;
					const tabId = this.tabId;
					if (message.tabs.some((tab) => tab.id === tabId)) {
						this.sendWatch(tabId);
						if (this.controlling) this.send({ type: "control.take" });
						break;
					}
					this.tabId = null;
					this.controlling = false;
					this.closed = true;
					this.dispatch({ type: "gone", tabId });
					break;
				}
				// Opening an arbitrary background tab would land on one Chrome put to sleep; without a front tab the
				// screen shows the tab list instead.
				const front = message.tabs.find((tab) => tab.front);
				if (this.tabId === null && !this.closed && front) this.watch(front.id);
				break;
			}
			case "unwatched":
				if (message.tabId === this.tabId) {
					this.tabId = null;
					this.controlling = false;
					this.closed = true;
				}
				break;
			case "control":
				this.controlling = message.control.kind === "you";
				break;
			case "error":
				this.onError(message.error);
				break;
			default:
				break;
		}
	}

	private enterBackground() {
		this.background = true;
		this.disconnect();
	}

	private enterForeground() {
		if (!this.background) return;
		this.background = false;
		this.retry = 0;
		this.connect();
	}

	private disconnect() {
		clearTimeout(this.retryTimer);
		clearInterval(this.heartbeat);
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;
		socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
		socket.close();
		if (!this.stopped) this.dispatch({ type: "disconnected" });
	}

	private connect() {
		if (this.stopped || this.background || this.socket) return;
		const socket = openMachineSocket(this.machine, "/v1/browser/stream");
		this.socket = socket;
		socket.onopen = () => {
			this.retry = 0;
			this.epoch += 1;
			this.lastMessageAt = Date.now();
			this.resume = this.tabId !== null;
			this.dispatch({ type: "connected" });
			this.heartbeat = setInterval(() => {
				if (Date.now() - this.lastMessageAt < STALE_MS) this.send({ type: "ping" });
				else this.reconnectSoon();
			}, PING_MS);
		};
		socket.onmessage = (event) => {
			this.lastMessageAt = Date.now();
			const message = parseMessage(event.data);
			if (message) this.handle(message);
		};
		socket.onerror = () => this.reconnectSoon();
		socket.onclose = () => this.reconnectSoon();
	}

	private reconnectSoon() {
		this.disconnect();
		if (this.stopped || this.background) return;
		const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}
}

export interface BrowserViewerControls {
	watch(tabId: string): void;
	takeControl(): void;
	release(): void;
	bringToFront(): void;
	tap(x: number, y: number): void;
	scroll(x: number, y: number, dx: number, dy: number): void;
	type(text: string): void;
	key(key: BrowserKey): void;
	/** Call once the frame is on screen; the server stops sending after two unacknowledged frames. */
	ack(frame: ViewerFrame): void;
}

/** Owns one browser stream socket for the calling screen's lifetime. */
export function useBrowserViewer(
	machine: PairedMachine | undefined,
	onError: (error: ApiError) => void,
): { state: BrowserViewerState } & BrowserViewerControls {
	const [state, dispatch] = useReducer(browserViewerReducer, INITIAL_STATE);
	const viewer = useRef<BrowserViewer | null>(null);
	const errorHandler = useRef(onError);
	useEffect(() => {
		errorHandler.current = onError;
	}, [onError]);
	useEffect(() => {
		if (!machine) return;
		const instance = new BrowserViewer(machine, dispatch, (error) => errorHandler.current(error));
		viewer.current = instance;
		instance.start();
		return () => {
			instance.stop();
			viewer.current = null;
		};
	}, [machine]);
	const controls = useMemo<BrowserViewerControls>(
		() => ({
			watch: (tabId) => viewer.current?.watch(tabId),
			takeControl: () => viewer.current?.takeControl(),
			release: () => viewer.current?.release(),
			bringToFront: () => viewer.current?.send({ type: "tab.activate" }),
			tap: (x, y) => viewer.current?.send({ type: "input.tap", x, y }),
			scroll: (x, y, dx, dy) => viewer.current?.send({ type: "input.scroll", x, y, dx, dy }),
			type: (text) => viewer.current?.send({ type: "input.text", text }),
			key: (key) => viewer.current?.send({ type: "input.key", key }),
			ack: (frame) => viewer.current?.ack(frame),
		}),
		[],
	);
	return { state, ...controls };
}
