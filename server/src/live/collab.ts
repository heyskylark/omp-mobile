type Frame = Record<string, unknown> & { t: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// OMP's Collab host rejects any other version, and frame shapes may change with it; scripts/e2e.ts re-proves it.
const COLLAB_PROTO = 3;

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(value);
}

function parseLink(raw: string): { url: string; key: Uint8Array; writeToken?: string } {
	const inner = raw.includes("#") ? decodeURIComponent(raw.slice(raw.indexOf("#") + 1)) : raw.trim();
	const url = new URL(inner);
	const match = /^\/r\/([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]+)$/.exec(url.pathname);
	if (!match) throw new Error("Invalid Collab link");
	const secret = Uint8Array.from(Buffer.from(match[2]!, "base64url"));
	if (secret.byteLength !== 32 && secret.byteLength !== 48) throw new Error("Invalid Collab secret");
	return {
		url: `${url.protocol}//${url.host}/r/${match[1]}?role=guest`,
		key: secret.slice(0, 32),
		writeToken: secret.byteLength === 48 ? Buffer.from(secret.slice(32)).toString("base64url") : undefined,
	};
}

export class CollabGuest {
	#socket?: WebSocket;
	#key?: CryptoKey;
	#handler: (frame: Frame) => void | Promise<void>;
	#onClose: (code: number) => void;

	constructor(handler: (frame: Frame) => void | Promise<void>, onClose: (code: number) => void) {
		this.#handler = handler;
		this.#onClose = onClose;
	}

	async connect(link: string): Promise<void> {
		const parsed = parseLink(link);
		this.#key = await crypto.subtle.importKey("raw", ownedBytes(parsed.key), "AES-GCM", false, ["encrypt", "decrypt"]);
		const socket = new WebSocket(parsed.url);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		const opened = Promise.withResolvers<void>();
		const welcomed = Promise.withResolvers<void>();
		socket.onopen = () => opened.resolve();
		socket.onerror = () => opened.reject(new Error("Collab connection failed"));
		socket.onclose = (event) => this.#onClose(event.code);
		socket.onmessage = (event) =>
			void this.#receive(event.data)
				.then((frame) => {
					if (frame?.t === "welcome") {
						if (frame.proto === COLLAB_PROTO) welcomed.resolve();
						else
							welcomed.reject(
								new Error(`Collab protocol ${String(frame.proto)} is not supported (expected ${COLLAB_PROTO})`),
							);
					} else if (frame?.t === "error")
						welcomed.reject(new Error(`Collab host refused the guest: ${String(frame.message)}`));
				})
				.catch(welcomed.reject);
		await opened.promise;
		await this.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "omp-mobile",
			...(parsed.writeToken ? { writeToken: parsed.writeToken } : {}),
		});
		await Promise.race([
			welcomed.promise,
			Bun.sleep(30_000).then(() => {
				throw new Error("Collab welcome timed out");
			}),
		]);
	}

	async send(frame: Frame): Promise<void> {
		if (!this.#socket || !this.#key || this.#socket.readyState !== WebSocket.OPEN)
			throw new Error("Collab guest is not connected");
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const plaintext = encoder.encode(JSON.stringify(frame));
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv: ownedBytes(iv) }, this.#key, plaintext),
		);
		const envelope = new Uint8Array(16 + ciphertext.byteLength);
		envelope.set(iv, 4);
		envelope.set(ciphertext, 16);
		this.#socket.send(envelope);
	}

	close(): void {
		this.#socket?.close(1000, "idle");
		this.#socket = undefined;
	}

	async #receive(data: unknown): Promise<Frame | undefined> {
		if (typeof data === "string") {
			const control: unknown = JSON.parse(data);
			if (control && typeof control === "object" && "t" in control && control.t === "room-closed") this.#onClose(4001);
			return;
		}
		if (!this.#key) return;
		const envelope =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: data instanceof Blob
					? new Uint8Array(await data.arrayBuffer())
					: undefined;
		if (!envelope || envelope.byteLength <= 16) return;
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: ownedBytes(envelope.slice(4, 16)) },
			this.#key,
			ownedBytes(envelope.slice(16)),
		);
		const parsed: unknown = JSON.parse(decoder.decode(plaintext));
		if (!parsed || typeof parsed !== "object" || !("t" in parsed) || typeof parsed.t !== "string") return;
		const frame = parsed as Frame;
		await this.#handler(frame);
		return frame;
	}
}

export async function findCollabLink(ompPath: string, sessionId: string): Promise<string> {
	const list = Bun.spawnSync([ompPath, "collab", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
	if (list.exitCode !== 0) throw new Error(new TextDecoder().decode(list.stderr));
	const parsed: unknown = JSON.parse(new TextDecoder().decode(list.stdout));
	if (!parsed || typeof parsed !== "object" || !("hosts" in parsed) || !Array.isArray(parsed.hosts))
		throw new Error("Invalid collab list");
	const host = parsed.hosts.find(
		(candidate) =>
			candidate && typeof candidate === "object" && "sessionId" in candidate && candidate.sessionId === sessionId,
	);
	if (!host || typeof host !== "object") throw new Error("Terminal Collab room is unavailable");
	const identifier =
		"instanceId" in host && typeof host.instanceId === "string"
			? host.instanceId
			: "pid" in host && typeof host.pid === "number"
				? String(host.pid)
				: undefined;
	if (!identifier) throw new Error("Collab host has no identifier");
	const link = Bun.spawnSync([ompPath, "collab", "link", identifier], { stdout: "pipe", stderr: "pipe" });
	if (link.exitCode !== 0) throw new Error(new TextDecoder().decode(link.stderr));
	const output = new TextDecoder().decode(link.stdout).trim();
	const match = output.match(/ws:\/\/[^\s\x1b]+\/r\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
	if (!match) throw new Error("Collab link was not present in command output");
	return match[0];
}
