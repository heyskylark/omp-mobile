const knownKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const [
	machineId = "test-machine",
	pushKey = Buffer.from(knownKey).toString("base64"),
	sessionId = "test-session",
	interactionId = "test-interaction",
] = Bun.argv.slice(2);
const key = new Uint8Array(Buffer.from(pushKey, "base64"));
if (key.length !== 32) throw new Error("pushKey must be a base64-encoded 32-byte key");
const nonce = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);

const plaintext = {
	v: 1,
	machineId,
	sessionId,
	interactionId,
	category: "OMP_APPROVAL",
	title: "OMP approval needed",
	body: "Allow the sample tool call?",
};

const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
const sealed = await crypto.subtle.encrypt(
	{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(machineId), tagLength: 128 },
	cryptoKey,
	new TextEncoder().encode(JSON.stringify(plaintext)),
);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const payload = {
	aps: {
		alert: { title: "OMP", body: "New activity" },
		"mutable-content": 1,
		category: "OMP_APPROVAL",
		"thread-id": sessionId,
		sound: "default",
	},
	m: machineId,
	e: { n: base64(nonce), c: base64(new Uint8Array(sealed)) },
};

const output = `${JSON.stringify(payload, null, 2)}\n`;
await Bun.write(new URL("push-sample.apns", import.meta.url), output);
console.log(`Wrote push-sample.apns; pair ${machineId} with pushKey ${base64(key)}`);
