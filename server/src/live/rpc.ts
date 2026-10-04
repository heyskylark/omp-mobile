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
	/** `parts` starts sparse and array iteration skips holes, so completeness is counted rather than scanned. */
	received: number;
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

	/**
	 * Handlers run in frame order but are not awaited, and their failures are logged: one slow or failing handler must
	 * not stall the stream or end it, or every later event and command response would be lost.
	 */
	#dispatch(frame: Frame): void {
		for (const waiter of [...this.#waiters]) {
			if (!waiter.predicate(frame)) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(waiter);
			waiter.resolve(frame);
		}
		for (const handler of this.#handlers) {
			const failed = (error: unknown) => console.error(`OMP ${String(frame.type)} frame handler failed`, error);
			try {
				Promise.resolve(handler(frame)).catch(failed);
			} catch (error) {
				failed(error);
			}
		}
	}

	#accept(frame: Frame): void {
		if (frame.type !== "rpc_chunk") return this.#dispatch(frame);
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
			set = { count: frame.count, byteLength: frame.byteLength, parts: new Array(frame.count), received: 0 };
			this.#chunks.set(frame.chunkId, set);
		}
		if (set.count !== frame.count || frame.index < 0 || frame.index >= set.count) {
			this.#chunks.delete(frame.chunkId);
			return;
		}
		if (set.parts[frame.index] === undefined) set.received += 1;
		set.parts[frame.index] = frame.data;
		if (set.received < set.count) return;
		this.#chunks.delete(frame.chunkId);
		const bytes = Buffer.concat(set.parts.map((part) => Buffer.from(part!, "base64")));
		if (bytes.byteLength !== set.byteLength) return;
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.#dispatch(parsed as Frame);
	}

	async #read(): Promise<void> {
		const reader = this.#proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let failure = new Error("omp closed its RPC output");
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
					try {
						const parsed: unknown = JSON.parse(line);
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.#accept(parsed as Frame);
					} catch (error) {
						console.error(`Skipping an unreadable OMP RPC line: ${line.slice(0, 200)}`, error);
					}
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(failure);
		}
		this.#waiters.clear();
	}
}
