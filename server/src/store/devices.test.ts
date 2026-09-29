import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeviceStore } from "./devices.ts";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("device store", () => {
	test("pairing codes are one-use and device tokens authenticate", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-devices-"));
		let now = 1_000;
		const path = join(directory, "devices.json");
		const store = createDeviceStore(path, () => now);
		await store.load();
		const pairing = store.createPairing();
		const paired = await store.pair(pairing.code, "Phone");
		expect(paired).not.toBeNull();
		expect(await store.pair(pairing.code, "Other")).toBeNull();
		expect((await store.authenticate(paired!.token))?.id).toBe(paired!.device.id);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8")).devices).toHaveLength(1);
	});

	test("re-pairing with the previous token replaces that device", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-devices-"));
		const store = createDeviceStore(join(directory, "devices.json"));
		const firstCode = store.createPairing();
		const first = await store.pair(firstCode.code, "Phone");
		const secondCode = store.createPairing();
		const second = await store.pair(secondCode.code, "Phone", undefined, first!.token);

		expect(store.list().map((device) => device.id)).toEqual([second!.device.id]);
		expect(await store.authenticate(first!.token)).toBeNull();
		expect((await store.authenticate(second!.token))?.id).toBe(second!.device.id);
	});

	test("an invalid previous token does not prevent pairing", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-devices-"));
		const store = createDeviceStore(join(directory, "devices.json"));
		const firstCode = store.createPairing();
		await store.pair(firstCode.code, "Phone");
		const secondCode = store.createPairing();
		const second = await store.pair(secondCode.code, "Phone", undefined, "expired-token");

		expect(second).not.toBeNull();
		expect(store.list()).toHaveLength(2);
	});

	test("expired pairing codes cannot be redeemed", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-devices-"));
		let now = 1_000;
		const store = createDeviceStore(join(directory, "devices.json"), () => now);
		const pairing = store.createPairing();
		now += 10 * 60 * 1000 + 1;
		expect(await store.pair(pairing.code, "Phone")).toBeNull();
	});
});
