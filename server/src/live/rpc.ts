type Frame = Record<string, unknown>;
type FrameHandler = (frame: Frame) => void | Promise<void>;

interface Waiter {
	predicate: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ChunkSet {
	count: number;
	byteLength: number;
	parts: Array<string | undefined>;
}

export class RpcSupervisor {
	readonly pid: number;
	readonly exited: Promise<number>;
	#proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#handlers = new Set<FrameHandler>();
	#waiters = new Set<Waiter>();
	#chunks = new Map<string, ChunkSet>();
	#reader: Promise<void>;
	#closed = false;
	#stderr: Promise<string>;

	constructor(args: string[], cwd: string, env?: Record<string, string>) {
		this.#proc = Bun.spawn(args, {
			cwd,
			...(env ? { env: { ...process.env, ...env } } : {}),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.pid = this.#proc.pid;
		this.exited = this.#proc.exited;
		this.#stderr = new Response(this.#proc.stderr).text();
		this.#reader = this.#read();
	}

	onFrame(handler: FrameHandler): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	send(frame: Frame): void {
		if (this.#closed) throw new Error("RPC process is closed");
		this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#proc.stdin.flush();
	}

	waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 120_000): Promise<Frame> {
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.#waiters.delete(waiter);
					reject(new Error("RPC frame timed out"));
				}, timeoutMs),
			};
			this.#waiters.add(waiter);
		});
	}

	async command(frame: Frame, timeoutMs = 120_000): Promise<Frame> {
		const id = frame.id;
		if (typeof id !== "string") throw new Error("RPC command requires an id");
		const response = this.waitFor((candidate) => candidate.type === "response" && candidate.id === id, timeoutMs);
		this.send(frame);
		return await response;
	}

	async ready(): Promise<void> {
		await this.waitFor((frame) => frame.type === "ready", 30_000);
		const response = await this.command(
			{ id: "omp-mobile-negotiate", type: "negotiate_protocol", protocolVersion: 2 },
			30_000,
		);
		if (response.success !== true)
			throw new Error(`RPC v2 negotiation failed: ${String(response.error ?? "unknown error")}`);
	}

	async close(): Promise<number> {
		if (!this.#closed) {
			this.#closed = true;
			this.#proc.stdin.end();
		}
		const code = await this.exited;
		await this.#reader;
		const stderr = (await this.#stderr).trim();
		if (code !== 0 && stderr) throw new Error(`omp rpc-ui exited ${code}: ${stderr}`);
		return code;
	}

	async #dispatch(frame: Frame): Promise<void> {
		for (const waiter of [...this.#waiters]) {
			if (!waiter.predicate(frame)) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(waiter);
			waiter.resolve(frame);
		}
		for (const handler of this.#handlers) await handler(frame);
	}

	async #accept(frame: Frame): Promise<void> {
		if (frame.type !== "rpc_chunk") return await this.#dispatch(frame);
		if (
			typeof frame.chunkId !== "string" ||
			typeof frame.index !== "number" ||
			typeof frame.count !== "number" ||
			typeof frame.byteLength !== "number" ||
			typeof frame.data !== "string"
		)
			return;
		let set = this.#chunks.get(frame.chunkId);
		if (!set) {
			set = { count: frame.count, byteLength: frame.byteLength, parts: new Array(frame.count) };
			this.#chunks.set(frame.chunkId, set);
		}
		if (set.count !== frame.count || frame.index < 0 || frame.index >= set.count) {
			this.#chunks.delete(frame.chunkId);
			return;
		}
		set.parts[frame.index] = frame.data;
		if (set.parts.some((part) => part === undefined)) return;
		this.#chunks.delete(frame.chunkId);
		const bytes = Buffer.concat(set.parts.map((part) => Buffer.from(part!, "base64")));
		if (bytes.byteLength !== set.byteLength) return;
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) await this.#dispatch(parsed as Frame);
	}

	async #read(): Promise<void> {
		const reader = this.#proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const parsed: unknown = JSON.parse(line);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) await this.#accept(parsed as Frame);
				}
			}
		} catch (error) {
			for (const waiter of this.#waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
			}
			this.#waiters.clear();
		}
	}
}
