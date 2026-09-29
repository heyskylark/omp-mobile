import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PushEnvironment } from "@omp-mobile/protocol";
import { z } from "zod";

const StoredDeviceSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
	pushKey: z.string().refine((value) => Buffer.from(value, "base64").byteLength === 32, "pushKey must be 32 bytes"),
	push: z.object({ token: z.string().min(1), environment: z.enum(["sandbox", "production"]) }).optional(),
	pairedAt: z.iso.datetime(),
	lastSeenAt: z.iso.datetime().optional(),
});
const DeviceFileSchema = z.object({ devices: z.array(StoredDeviceSchema) });

export interface StoredDevice {
	id: string;
	name: string;
	tokenHash: string;
	pushKey: string;
	push?: { token: string; environment: PushEnvironment };
	pairedAt: string;
	lastSeenAt?: string;
}

export interface PairingCode {
	code: string;
	expiresAt: string;
}

export interface PairedDevice {
	device: StoredDevice;
	token: string;
}

export interface DeviceStore {
	load(): Promise<void>;
	list(): StoredDevice[];
	createPairing(): PairingCode;
	pair(code: string, name: string, push?: StoredDevice["push"], previousToken?: string): Promise<PairedDevice | null>;
	authenticate(token: string): Promise<StoredDevice | null>;
	setPush(deviceId: string, push: StoredDevice["push"]): Promise<void>;
	clearPush(deviceId: string): Promise<void>;
	remove(deviceId: string): Promise<boolean>;
}

interface PendingCode {
	digest: Buffer;
	expiresAt: number;
}

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function createDeviceStore(path: string, now: () => number = Date.now): DeviceStore {
	const devices = new Map<string, StoredDevice>();
	const pairingCodes = new Map<string, PendingCode>();
	let writeQueue = Promise.resolve();

	const persist = () => {
		const snapshot = JSON.stringify({ devices: [...devices.values()] }, null, 2) + "\n";
		writeQueue = writeQueue.then(async () => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temp, snapshot, { mode: 0o600 });
			await chmod(temp, 0o600);
			await rename(temp, path);
		});
		return writeQueue;
	};

	return {
		async load() {
			try {
				const parsed = DeviceFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
				devices.clear();
				for (const device of parsed.devices) devices.set(device.id, device);
				await chmod(path, 0o600);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		},
		list() {
			return [...devices.values()].map((device) => structuredClone(device));
		},
		createPairing() {
			for (const [existing, pending] of pairingCodes) {
				if (pending.expiresAt <= now()) pairingCodes.delete(existing);
			}
			let code = "";
			const bytes = randomBytes(8);
			for (const byte of bytes) code += PAIRING_ALPHABET.charAt(byte % PAIRING_ALPHABET.length);
			const expiresAt = now() + PAIRING_TTL_MS;
			pairingCodes.set(code, { digest: createHash("sha256").update(code).digest(), expiresAt });
			return { code, expiresAt: new Date(expiresAt).toISOString() };
		},
		async pair(code, name, push, previousToken) {
			const candidate = createHash("sha256").update(code).digest();
			let matchedKey: string | undefined;
			for (const [key, pending] of pairingCodes) {
				if (timingSafeEqual(candidate, pending.digest) && pending.expiresAt > now()) matchedKey = key;
			}
			if (!matchedKey) return null;
			pairingCodes.delete(matchedKey);
			const previousTokenHash = previousToken ? sha256(previousToken) : undefined;
			if (previousTokenHash) {
				for (const [id, existing] of devices) {
					const matches = timingSafeEqual(
						Buffer.from(previousTokenHash, "hex"),
						Buffer.from(existing.tokenHash, "hex"),
					);
					if (matches) devices.delete(id);
				}
			}
			const token = randomBytes(32).toString("base64url");
			const pairedAt = new Date(now()).toISOString();
			const device: StoredDevice = {
				id: randomUUID(),
				name,
				tokenHash: sha256(token),
				pushKey: randomBytes(32).toString("base64"),
				...(push ? { push } : {}),
				pairedAt,
				lastSeenAt: pairedAt,
			};
			devices.set(device.id, device);
			await persist();
			return { device: structuredClone(device), token };
		},
		async authenticate(token) {
			const digest = Buffer.from(sha256(token), "hex");
			for (const device of devices.values()) {
				if (!timingSafeEqual(digest, Buffer.from(device.tokenHash, "hex"))) continue;
				device.lastSeenAt = new Date(now()).toISOString();
				await persist();
				return structuredClone(device);
			}
			return null;
		},
		async setPush(deviceId, push) {
			const device = devices.get(deviceId);
			if (!device) throw new Error("Device not found");
			device.push = push;
			await persist();
		},
		async clearPush(deviceId) {
			const device = devices.get(deviceId);
			if (!device || !device.push) return;
			delete device.push;
			await persist();
		},
		async remove(deviceId) {
			if (!devices.delete(deviceId)) return false;
			await persist();
			return true;
		},
	};
}
