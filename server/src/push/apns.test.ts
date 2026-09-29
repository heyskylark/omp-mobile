import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApnsJwt, sealPushPayload } from "./apns.ts";
import type { PushPlaintext } from "@omp-mobile/protocol";

const decodePart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("APNs cryptography", () => {
	test("sealed payload decrypts with machine id as authenticated data", async () => {
		const keyBytes = randomBytes(32);
		const machineId = "machine-1";
		const plaintext: PushPlaintext = {
			v: 1,
			machineId,
			sessionId: "session-1",
			category: "OMP_INFO",
			title: "Done",
			body: "Ready",
		};
		const sealed = await sealPushPayload(machineId, keyBytes.toString("base64"), plaintext);
		expect(Buffer.from(sealed.n, "base64")).toHaveLength(12);
		const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes).buffer, "AES-GCM", false, ["decrypt"]);
		const clear = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: Uint8Array.from(Buffer.from(sealed.n, "base64")),
				additionalData: new TextEncoder().encode(machineId),
				tagLength: 128,
			},
			key,
			Buffer.from(sealed.c, "base64"),
		);
		expect(JSON.parse(new TextDecoder().decode(clear))).toEqual(plaintext);
	});

	test("JWT contains the APNs ES256 header and issuer claims", async () => {
		const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
		const pem = `-----BEGIN PRIVATE KEY-----\n${der
			.toString("base64")
			.match(/.{1,64}/g)!
			.join("\n")}\n-----END PRIVATE KEY-----`;
		const now = 1_700_000_000_000;
		const token = await createApnsJwt(pem, "KEY123", "TEAM456", now);
		const [header, claims, signature] = token.split(".");
		expect(decodePart(header!)).toEqual({ alg: "ES256", kid: "KEY123" });
		expect(decodePart(claims!)).toEqual({ iss: "TEAM456", iat: Math.floor(now / 1000) });
		expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
	});
});
