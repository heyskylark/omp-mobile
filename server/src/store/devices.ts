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
	id: string;
	code: string;
	expiresAt: string;
}

export interface PairingStatus {
	id: string;
	expiresAt: string;
	consumedBy?: { deviceId: string; name: string; pairedAt: string };
}

export interface PairedDevice {
	device: StoredDevice;
	token: string;
}

export interface DeviceStore {
	load(): Promise<void>;
	list(): StoredDevice[];
	listPairings(): PairingStatus[];
	createPairing(): PairingCode;
	pair(code: string, name: string, push?: StoredDevice["push"]): Promise<PairedDevice | null>;
	authenticate(token: string): Promise<StoredDevice | null>;
	setPush(deviceId: string, push: StoredDevice["push"]): Promise<void>;
	clearPush(deviceId: string): Promise<void>;
	remove(deviceId: string): Promise<boolean>;
}

interface PendingCode {
	id: string;
	digest: Buffer;
	expiresAt: number;
	consumedBy?: PairingStatus["consumedBy"];
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

	const prunePairings = () => {
		const timestamp = now();
		for (const [id, pairing] of pairingCodes) {
			const retainUntil = pairing.consumedBy
				? Date.parse(pairing.consumedBy.pairedAt) + PAIRING_TTL_MS
				: pairing.expiresAt;
			if (retainUntil <= timestamp) pairingCodes.delete(id);
		}
	};

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
		listPairings() {
			prunePairings();
			return [...pairingCodes.values()].map(({ id, expiresAt, consumedBy }) => ({
				id,
				expiresAt: new Date(expiresAt).toISOString(),
				...(consumedBy ? { consumedBy: structuredClone(consumedBy) } : {}),
			}));
		},
		createPairing() {
			prunePairings();
			let code = "";
			const bytes = randomBytes(8);
			for (const byte of bytes) code += PAIRING_ALPHABET.charAt(byte % PAIRING_ALPHABET.length);
			const id = randomUUID();
			const expiresAt = now() + PAIRING_TTL_MS;
			pairingCodes.set(id, { id, digest: createHash("sha256").update(code).digest(), expiresAt });
			return { id, code, expiresAt: new Date(expiresAt).toISOString() };
		},
		async pair(code, name, push) {
			prunePairings();
			const candidate = createHash("sha256").update(code).digest();
			let matched: PendingCode | undefined;
			for (const pending of pairingCodes.values()) {
				if (!pending.consumedBy && timingSafeEqual(candidate, pending.digest) && pending.expiresAt > now()) {
					matched = pending;
				}
			}
			if (!matched) return null;
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
			matched.consumedBy = { deviceId: device.id, name: device.name, pairedAt };
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
