import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostnameMachineId, loadMachineId } from "./machine-id.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-mobile-machine-id-"));
	directories.push(path);
	return path;
}

const hostnames = (...names: string[]) => {
	let index = 0;
	return async () => names[Math.min(index++, names.length - 1)]!;
};

describe("loadMachineId", () => {
	test("hostnameMachineId matches the id older servers derived", () => {
		expect(hostnameMachineId("Brandons-MacBook-Pro.local")).toBe("gSifip6AFZJxCXwfS6mZ3CkOFUE-FuAS");
	});

	test("a stored id wins regardless of the host name", async () => {
		const dir = await dataDir();
		await writeFile(join(dir, "machine.json"), JSON.stringify({ machineId: "stored-id" }));
		for (const paired of [true, false]) {
			expect(await loadMachineId(dir, { paired, legacyHostname: hostnames("MacBookPro.attlocal.net") })).toBe(
				"stored-id",
			);
		}
	});

	test("a paired install without machine.json keeps its host-name id across host name changes", async () => {
		const dir = await dataDir();
		const legacyHostname = hostnames("Brandons-MacBook-Pro.local", "MacBookPro.attlocal.net");
		const first = await loadMachineId(dir, { paired: true, legacyHostname });
		expect(first).toBe(hostnameMachineId("Brandons-MacBook-Pro.local"));
		expect(JSON.parse(await readFile(join(dir, "machine.json"), "utf8"))).toEqual({ machineId: first });
		expect((await stat(join(dir, "machine.json"))).mode & 0o777).toBe(0o600);
		expect(await loadMachineId(dir, { paired: true, legacyHostname })).toBe(first);
	});

	test("a fresh install gets a random id that persists across loads", async () => {
		const dir = await dataDir();
		const legacyHostname = hostnames("Brandons-MacBook-Pro.local");
		const first = await loadMachineId(dir, { paired: false, legacyHostname });
		expect(first).not.toBe(hostnameMachineId("Brandons-MacBook-Pro.local"));
		expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect((await stat(join(dir, "machine.json"))).mode & 0o777).toBe(0o600);
		expect(await loadMachineId(dir, { paired: true, legacyHostname })).toBe(first);

		const other = await dataDir();
		expect(await loadMachineId(other, { paired: false, legacyHostname })).not.toBe(first);
	});

	test("an unreadable machine.json stops the server instead of re-identifying it", async () => {
		const dir = await dataDir();
		await writeFile(join(dir, "machine.json"), "{");
		await expect(loadMachineId(dir, { paired: true, legacyHostname: hostnames("x") })).rejects.toThrow();
	});
});
