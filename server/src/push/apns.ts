import { connect, type ClientHttp2Session } from "node:http2";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { PushPlaintext } from "@omp-mobile/protocol";
import type { ApnsConfig } from "../config.ts";
import type { LiveHub, LiveNotification } from "../live/api.ts";
import type { DeviceStore, StoredDevice } from "../store/devices.ts";

const encoder = new TextEncoder();
const JWT_MAX_AGE_MS = 50 * 60 * 1000;

interface JwtCacheEntry {
	value: string;
	createdAt: number;
}

export interface ApnsResult {
	status: number;
	reason?: string;
}

export interface PushService {
	stop(): void;
}

const jwtCache = new Map<string, JwtCacheEntry>();

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function pemToDer(pem: string): ArrayBuffer {
	const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const bytes = Uint8Array.from(Buffer.from(body, "base64"));
	return bytes.buffer;
}

export async function createApnsJwt(keyPem: string, keyId: string, teamId: string, now = Date.now()): Promise<string> {
	const cacheKey = `${keyId}:${teamId}:${keyPem}`;
	const cached = jwtCache.get(cacheKey);
	if (cached && now - cached.createdAt < JWT_MAX_AGE_MS) return cached.value;
	const header = base64Url(encoder.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
	const claims = base64Url(encoder.encode(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) })));
	const input = `${header}.${claims}`;
	const key = await crypto.subtle.importKey("pkcs8", pemToDer(keyPem), { name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
	]);
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)),
	);
	const value = `${input}.${base64Url(signature)}`;
	jwtCache.set(cacheKey, { value, createdAt: now });
	return value;
}

export async function sealPushPayload(
	machineId: string,
	pushKey: string,
	plaintext: PushPlaintext,
): Promise<{ n: string; c: string }> {
	const nonce = randomBytes(12);
	const key = await crypto.subtle.importKey("raw", Buffer.from(pushKey, "base64"), "AES-GCM", false, ["encrypt"]);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(machineId), tagLength: 128 },
		key,
		encoder.encode(JSON.stringify(plaintext)),
	);
	return { n: nonce.toString("base64"), c: Buffer.from(ciphertext).toString("base64") };
}

async function sendRequest(
	session: ClientHttp2Session,
	headers: Record<string, string>,
	body: string,
): Promise<ApnsResult> {
	return new Promise((resolve, reject) => {
		const request = session.request(headers);
		let status = 0;
		let response = "";
		request.setEncoding("utf8");
		request.on("response", (received) => {
			status = Number(received[":status"] ?? 0);
		});
		request.on("data", (chunk: string) => {
			response += chunk;
		});
		request.on("end", () => {
			let reason: string | undefined;
			try {
				reason = (JSON.parse(response) as { reason?: string }).reason;
			} catch {}
			resolve({ status, ...(reason ? { reason } : {}) });
		});
		request.on("error", reject);
		request.end(body);
	});
}

export async function sendApnsNotification(
	config: ApnsConfig,
	machineId: string,
	device: StoredDevice,
	notification: LiveNotification,
): Promise<ApnsResult> {
	if (!device.push) throw new Error("Device has no push token");
	const interactionId = notification.interaction?.id;
	const plaintext: PushPlaintext = {
		v: 1,
		machineId,
		sessionId: notification.sessionId,
		...(interactionId ? { interactionId } : {}),
		category: notification.category,
		title: notification.title,
		body: notification.body,
	};
	const encrypted = await sealPushPayload(machineId, device.pushKey, plaintext);
	const payload = JSON.stringify({
		aps: {
			alert: { title: "OMP", body: "New activity" },
			"mutable-content": 1,
			category: notification.category,
			"thread-id": notification.sessionId,
			sound: "default",
		},
		m: machineId,
		e: encrypted,
	});
	const origin =
		device.push.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
	const session = connect(origin);
	try {
		const jwt = await createApnsJwt(await readFile(config.keyPath, "utf8"), config.keyId, config.teamId);
		return await sendRequest(
			session,
			{
				":method": "POST",
				":path": `/3/device/${encodeURIComponent(device.push.token)}`,
				authorization: `bearer ${jwt}`,
				"apns-topic": config.bundleId,
				"apns-push-type": "alert",
				"apns-collapse-id": notification.collapseKey,
				"apns-priority": "10",
			},
			payload,
		);
	} finally {
		session.close();
	}
}

export function createPushService(
	config: ApnsConfig,
	machineId: string,
	devices: DeviceStore,
	hub: LiveHub,
): PushService {
	const unsubscribe = hub.onNotify((notification) => {
		for (const device of devices.list()) {
			if (!device.push) continue;
			void sendApnsNotification(config, machineId, device, notification)
				.then(async (result) => {
					if (result.status === 410 || result.reason === "BadDeviceToken") await devices.clearPush(device.id);
				})
				.catch((error) => console.error("APNs delivery failed", error));
		}
	});
	return { stop: unsubscribe };
}
