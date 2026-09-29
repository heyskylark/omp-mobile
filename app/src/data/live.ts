import type { ClientMessage, ServerMessage } from "@omp-mobile/protocol";
import type { PairedMachine } from "../native/types";

type Listener = (message: ServerMessage) => void;
type EpochListener = () => void;

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

class MachineSocket {
	private socket: WebSocket | null = null;
	private listeners = new Set<Listener>();
	private epochListeners = new Set<EpochListener>();
	private subscriptions = new Map<string, number>();
	private retry = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private epoch: string | null = null;

	constructor(private readonly machine: PairedMachine) {}

	start() {
		this.stopped = false;
		this.connect();
	}

	stop() {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.socket?.close();
		this.socket = null;
	}

	onMessage(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onEpochChange(listener: EpochListener) {
		this.epochListeners.add(listener);
		return () => this.epochListeners.delete(listener);
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

	private connect() {
		if (this.stopped || this.socket) return;
		const wsUrl = this.machine.url.replace(/^http/, "ws").replace(/\/$/, "") + "/v1/stream";
		const AuthorizedWebSocket = WebSocket as unknown as AuthorizedWebSocketConstructor;
		const socket = new AuthorizedWebSocket(wsUrl, undefined, {
			headers: { Authorization: `Bearer ${this.machine.token}` },
		});
		this.socket = socket;
		socket.onopen = () => {
			this.retry = 0;
			for (const sessionId of this.subscriptions.keys()) this.send({ type: "subscribe", sessionId });
		};
		socket.onmessage = (event) => {
			const message = parseMessage(event.data);
			if (!message) return;
			if (message.type === "hello") {
				if (this.epoch !== null && this.epoch !== message.epoch) for (const listener of this.epochListeners) listener();
				this.epoch = message.epoch;
			}
			for (const listener of this.listeners) listener(message);
		};
		socket.onerror = () => socket.close();
		socket.onclose = () => {
			if (this.socket === socket) this.socket = null;
			if (this.stopped) return;
			const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
			this.retryTimer = setTimeout(() => this.connect(), delay);
		};
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
