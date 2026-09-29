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

	test("expired pairing codes cannot be redeemed", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-devices-"));
		let now = 1_000;
		const store = createDeviceStore(join(directory, "devices.json"), () => now);
		const pairing = store.createPairing();
		now += 10 * 60 * 1000 + 1;
		expect(await store.pair(pairing.code, "Phone")).toBeNull();
	});
});
