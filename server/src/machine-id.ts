import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "./private-json.ts";

const MachineFileSchema = z.object({ machineId: z.string().min(1) });

export interface MachineIdOptions {
	/** Whether phones are already paired. They hold their push keys under the id older servers derived from the host name. */
	paired: boolean;
	/** Resolves the host name older servers hashed; replaceable in tests. */
	legacyHostname?: () => Promise<string>;
}

/** The id servers before `machine.json` derived on every start, which changed whenever the host name did. */
export function hostnameMachineId(host: string): string {
	return createHash("sha256").update(`omp-mobile:${host}`).digest("base64url").slice(0, 32);
}

async function scutil(key: string): Promise<string | null> {
	try {
		const proc = Bun.spawn([Bun.which("scutil") ?? "/usr/sbin/scutil", "--get", key], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = (await new Response(proc.stdout).text()).trim();
		return (await proc.exited) === 0 && output ? output : null;
	} catch {
		return null;
	}
}

/**
 * The host name macOS reports when DHCP does not override it: the user-set `HostName`, else the
 * Bonjour `LocalHostName` with `.local`. A DHCP-assigned name is transient, so it is ignored here.
 */
export async function stableHostname(): Promise<string> {
	const configured = await scutil("HostName");
	if (configured) return configured;
	const local = await scutil("LocalHostName");
	return local ? `${local}.local` : hostname();
}

/**
 * Returns the id stored in `machine.json`, creating it on first start. Phones key their pairing and push
 * decryption by this id, so it must never change for an installation. An installation that already has
 * paired phones keeps the host-name id they paired with; a fresh one gets a random id.
 */
export async function loadMachineId(dataDir: string, options: MachineIdOptions): Promise<string> {
	const path = join(dataDir, "machine.json");
	try {
		return MachineFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).machineId;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const machineId = options.paired
		? hostnameMachineId(await (options.legacyHostname ?? stableHostname)())
		: randomBytes(24).toString("base64url");
	await writePrivateJson(path, { machineId });
	return machineId;
}
