import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { writePrivateJson } from "./private-json.ts";

const ApnsSchema = z.object({
	keyPath: z.string().min(1),
	keyId: z.string().min(1),
	teamId: z.string().min(1),
	bundleId: z.string().min(1),
});

const ConfigSchema = z.object({
	port: z.number().int().min(1).max(65535).default(8787),
	relayPort: z.number().int().min(1).max(65535).default(8788),
	machineName: z.string().min(1).optional(),
	roots: z.array(z.string().min(1)).min(1).optional(),
	ompPath: z.string().min(1).optional(),
	rpcArgs: z.array(z.string()).optional(),
	apns: ApnsSchema.optional(),
});

export type ApnsConfig = z.infer<typeof ApnsSchema>;
export interface ServerConfig {
	dataDir: string;
	port: number;
	relayPort: number;
	machineName: string;
	roots: string[];
	ompPath: string | null;
	rpcArgs?: string[];
	apns?: ApnsConfig;
}

// `bun run` and npm prepend node_modules/.bin directories, where a package-manager shim for omp may
// exec the compiled binary through Node. Resolve omp from the user's real PATH entries only.
function resolveOmp(path = process.env.PATH ?? ""): string | null {
	const searchPath = path
		.split(":")
		.filter((entry) => !entry.includes("/node_modules/.bin"))
		.join(":");
	return Bun.which("omp", { PATH: searchPath }) ?? null;
}

async function defaultMachineName(): Promise<string> {
	const scutil = Bun.which("scutil") ?? "/usr/sbin/scutil";
	try {
		const proc = Bun.spawn([scutil, "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" });
		const output = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) === 0 && output) return output;
	} catch {}
	return hostname();
}

async function normalizeRoots(paths: string[]): Promise<string[]> {
	return Promise.all(paths.map(async (path) => realpath(resolve(path.replace(/^~(?=\/|$)/, homedir())))));
}

async function readConfigFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
	const dataDir = resolve(env.OMP_MOBILE_HOME ?? join(homedir(), ".omp-mobile"));
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const parsed = ConfigSchema.parse(await readConfigFile(join(dataDir, "config.json")));
	const configuredOmp = parsed.ompPath ? resolve(parsed.ompPath) : resolveOmp(env.PATH);
	return {
		dataDir,
		port: parsed.port,
		relayPort: parsed.relayPort,
		machineName: parsed.machineName ?? (await defaultMachineName()),
		roots: await normalizeRoots(parsed.roots ?? [homedir()]),
		ompPath: configuredOmp,
		...(parsed.rpcArgs ? { rpcArgs: parsed.rpcArgs } : {}),
		...(parsed.apns ? { apns: { ...parsed.apns, keyPath: resolve(parsed.apns.keyPath) } } : {}),
	};
}

export async function saveMachineName(config: ServerConfig, machineName: string): Promise<void> {
	const path = join(config.dataDir, "config.json");
	const raw = z.record(z.string(), z.unknown()).parse(await readConfigFile(path));
	await writePrivateJson(path, { ...raw, machineName });
	config.machineName = machineName;
}

export function configPath(config: ServerConfig, name: string): string {
	return join(config.dataDir, name);
}
