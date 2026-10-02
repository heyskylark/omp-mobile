import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROBE_TIMEOUT_MS = 1_500;
const COMMAND_TIMEOUT_MS = 15_000;

export function isLoopbackUrl(url: URL): boolean {
	return LOOPBACK_HOSTS.has(url.hostname);
}

export type RelayProbe =
	| { kind: "ready"; wsUrl: string }
	| { kind: "relay_offline" }
	| { kind: "extension_disconnected" };

const VersionSchema = z.object({ webSocketDebuggerUrl: z.string() });

/**
 * Asks the relay's CDP discovery endpoint whether a Chrome extension is connected. The relay answers 503 until
 * one is; anything that is not an HTTP answer means no relay listens there.
 */
export async function probeRelay(relayUrl: URL): Promise<RelayProbe> {
	let response: Response;
	try {
		response = await fetch(new URL("/json/version", relayUrl), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch {
		return { kind: "relay_offline" };
	}
	if (response.status === 503) return { kind: "extension_disconnected" };
	if (!response.ok) return { kind: "relay_offline" };
	const parsed = VersionSchema.safeParse(await response.json().catch(() => null));
	if (!parsed.success) return { kind: "relay_offline" };
	// Whatever answers on the relay port names the socket to dial; never follow it off this machine.
	const wsUrl = new URL(parsed.data.webSocketDebuggerUrl);
	if (!isLoopbackUrl(wsUrl) || wsUrl.port !== relayUrl.port) return { kind: "relay_offline" };
	return { kind: "ready", wsUrl: wsUrl.href };
}

export interface CdpEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

const MessageSchema = z.object({
	id: z.number().optional(),
	method: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	result: z.unknown().optional(),
	error: z.object({ message: z.string() }).optional(),
	sessionId: z.string().optional(),
});

export class CdpTimeoutError extends Error {
	constructor(method: string) {
		super(`${method} timed out`);
	}
}

export class CdpConnection {
	readonly #socket: WebSocket;
	#seq = 0;
	readonly #pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

	private constructor(socket: WebSocket, onEvent: (event: CdpEvent) => void, onClose: () => void) {
		this.#socket = socket;
		socket.onmessage = (event) => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(event.data));
			} catch {
				return;
			}
			const parsed = MessageSchema.safeParse(raw);
			if (!parsed.success) return;
			const message = parsed.data;
			if (message.id !== undefined) {
				const pending = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				if (message.error) pending?.reject(new Error(message.error.message));
				else pending?.resolve(message.result);
			} else if (message.method) {
				onEvent({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
			}
		};
		socket.onclose = () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("Browser relay connection closed"));
			this.#pending.clear();
			onClose();
		};
	}

	static open(wsUrl: string, onEvent: (event: CdpEvent) => void, onClose: () => void): Promise<CdpConnection> {
		const { promise, resolve, reject } = Promise.withResolvers<CdpConnection>();
		const socket = new WebSocket(wsUrl);
		socket.onopen = () => resolve(new CdpConnection(socket, onEvent, onClose));
		socket.onerror = () => reject(new Error("Could not connect to the browser relay"));
		socket.onclose = () => reject(new Error("Could not connect to the browser relay"));
		return promise;
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs = COMMAND_TIMEOUT_MS,
	): Promise<unknown> {
		if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser relay connection closed"));
		const id = ++this.#seq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new CdpTimeoutError(method));
		}, timeoutMs);
		this.#pending.set(id, {
			resolve: (result) => {
				clearTimeout(timer);
				resolve(result);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			},
		});
		this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return promise;
	}

	close(): void {
		this.#socket.close();
	}
}
