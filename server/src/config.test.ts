import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("loadConfig", () => {
	test("expands ~ in apns.keyPath and ompPath to the home directory", async () => {
		directory = await mkdtemp(join(tmpdir(), "omp-mobile-config-"));
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({
				machineName: "Test",
				roots: [directory],
				ompPath: "~/bin/omp",
				apns: { keyPath: "~/k.p8", keyId: "KEY", teamId: "TEAM", bundleId: "com.example.app" },
			}),
		);
		const config = await loadConfig({ OMP_MOBILE_HOME: directory });
		expect(config.apns?.keyPath).toBe(join(homedir(), "k.p8"));
		expect(config.ompPath).toBe(join(homedir(), "bin/omp"));
	});
});
