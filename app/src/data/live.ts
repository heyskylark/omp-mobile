import type { ClientMessage, ServerMessage } from "@omp-mobile/protocol";
import { AppState, type NativeEventSubscription } from "react-native";
import type { PairedMachine } from "../native/types";

type Listener = (message: ServerMessage) => void;
type ResyncListener = () => void;

/** Heartbeat period while the app is active; a socket that stays silent past `STALE_MS` is treated as dead. */
const PING_MS = 15_000;
const STALE_MS = 35_000;

interface AuthorizedWebSocketConstructor {
	new (url: string, protocols: string[] | undefined, options: { headers: Record<string, string> }): WebSocket;
}

function parseMessage(raw: unknown): ServerMessage | null {
	if (typeof raw !== "string") return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string")
			return null;
		const type = (value as { type: string }).type;
		if (
			![
				"hello",
				"session.snapshot",
				"timeline.upsert",
				"timeline.retire",
				"session.update",
				"session.modelRole",
				"sessions.changed",
				"pong",
				"error",
			].includes(type)
		)
			return null;
		return value as ServerMessage;
	} catch {
		return null;
	}
}

/**
 * One websocket per machine. iOS suspends the app with the socket open, and messages sent meanwhile can be lost
 * (a half-open socket, or the server dropping a backlog nobody reads), so the socket closes in the background,
 * reconnects on return, and pings while active. Every reconnect after the first is a resync: the server re-sends
 * snapshots for resubscribed sessions, and `onResync` listeners refetch anything else they show.
 */
class MachineSocket {
	private socket: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private resyncListeners = new Set<ResyncListener>();
	private subscriptions = new Map<string, number>();
	private retry = 0;
	private retryTimer?: number;
	private heartbeat?: number;
	private lastMessageAt = 0;
	private stopped = false;
	private background = false;
	private connectedBefore = false;
	private appState: NativeEventSubscription | null = null;

	constructor(private readonly machine: PairedMachine) {}

	start() {
		this.stopped = false;
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

	onMessage(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Fires after every reconnect, including one to a restarted server; missed pushes are not replayed. */
	onResync(listener: ResyncListener) {
		this.resyncListeners.add(listener);
		return () => this.resyncListeners.delete(listener);
	}

	subscribe(sessionId: string) {
		const count = this.subscriptions.get(sessionId) ?? 0;
		this.subscriptions.set(sessionId, count + 1);
		if (count === 0) this.send({ type: "subscribe", sessionId });
		return () => {
			const next = (this.subscriptions.get(sessionId) ?? 1) - 1;
			if (next <= 0) {
				this.subscriptions.delete(sessionId);
				this.send({ type: "unsubscribe", sessionId });
			} else this.subscriptions.set(sessionId, next);
		};
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

	/** Drops the socket and any pending retry without scheduling another; `connect` starts over. */
	private disconnect() {
		clearTimeout(this.retryTimer);
		clearInterval(this.heartbeat);
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;
		socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
		socket.close();
	}

	private connect() {
		if (this.stopped || this.background || this.socket) return;
		const wsUrl = this.machine.url.replace(/^http/, "ws").replace(/\/$/, "") + "/v1/stream";
		const AuthorizedWebSocket = WebSocket as unknown as AuthorizedWebSocketConstructor;
		const socket = new AuthorizedWebSocket(wsUrl, undefined, {
			headers: { Authorization: `Bearer ${this.machine.token}` },
		});
		this.socket = socket;
		socket.onopen = () => {
			this.retry = 0;
			this.lastMessageAt = Date.now();
			for (const sessionId of this.subscriptions.keys()) this.send({ type: "subscribe", sessionId });
			this.heartbeat = setInterval(() => {
				if (Date.now() - this.lastMessageAt < STALE_MS) this.send({ type: "ping" });
				else this.reconnectSoon();
			}, PING_MS);
		};
		socket.onmessage = (event) => {
			this.lastMessageAt = Date.now();
			const message = parseMessage(event.data);
			if (!message) return;
			if (message.type === "hello") {
				if (this.connectedBefore) for (const listener of this.resyncListeners) listener();
				this.connectedBefore = true;
			}
			for (const listener of this.listeners) listener(message);
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

	private send(message: ClientMessage) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
	}
}

interface SocketEntry {
	socket: MachineSocket;
	references: number;
}

const sockets = new Map<string, SocketEntry>();
export function resetMachineSocket(machineId: string) {
	const entry = sockets.get(machineId);
	if (!entry) return;
	entry.socket.stop();
	sockets.delete(machineId);
}

export function acquireMachineSocket(machine: PairedMachine): { socket: MachineSocket; release: () => void } {
	let entry = sockets.get(machine.machineId);
	if (!entry) {
		entry = { socket: new MachineSocket(machine), references: 0 };
		sockets.set(machine.machineId, entry);
		entry.socket.start();
	}
	entry.references += 1;
	return {
		socket: entry.socket,
		release: () => {
			if (sockets.get(machine.machineId) !== entry) return;
			entry.references -= 1;
			if (entry.references > 0) return;
			entry.socket.stop();
			sockets.delete(machine.machineId);
		},
	};
}
