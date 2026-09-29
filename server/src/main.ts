import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { createHistory } from "./history/index.ts";
import { startHttp, type HttpService } from "./http/index.ts";
import { createLiveHub } from "./live/index.ts";
import { createPushService, type PushService } from "./push/index.ts";
import { createDeviceStore } from "./store/index.ts";

async function ompVersion(path: string | null): Promise<string | null> {
	if (!path) return null;
	try {
		const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
		const output = (await new Response(proc.stdout).text()).trim();
		return (await proc.exited) === 0 ? output : null;
	} catch {
		return null;
	}
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	await chmod(temp, 0o600);
	await rename(temp, path);
}

async function main(): Promise<void> {
	const config = await loadConfig();
	const adminToken = randomBytes(32).toString("base64url");
	const extensionToken = randomBytes(32).toString("base64url");
	const machineId = createHash("sha256").update(`omp-mobile:${hostname()}`).digest("base64url").slice(0, 32);
	const devices = createDeviceStore(join(config.dataDir, "devices.json"));
	await devices.load();
	const history = createHistory({
		sessionsDir: join(homedir(), ".omp", "agent", "sessions"),
		blobsDir: join(homedir(), ".omp", "agent", "blobs"),
		roots: config.roots,
		cursorSecret: randomBytes(32),
	});
	if (!config.ompPath) console.warn("omp executable not found; live actions are unavailable");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const hub = createLiveHub({
		history,
		ompPath: config.ompPath ?? "omp",
		relayPort: config.relayPort,
		extensionPath: join(root, "extension", "omp-mobile.ts"),
		rpcArgs: config.rpcArgs,
	});
	await hub.start();
	let http: HttpService | undefined;
	let push: PushService | undefined;
	const serverPath = join(config.dataDir, "server.json");
	try {
		const version = await ompVersion(config.ompPath);
		http = await startHttp({
			config,
			machineId,
			ompVersion: version,
			devices,
			history,
			hub,
			adminToken,
			extensionToken,
		});
		if (config.apns) push = createPushService(config.apns, machineId, devices, hub);
		await atomicPrivateJson(serverPath, {
			port: config.port,
			relayPort: config.relayPort,
			pid: process.pid,
			url: http.url,
			adminToken,
			extensionToken,
			startedAt: new Date().toISOString(),
		});
		console.log(`OMP Mobile server listening at ${http.url}`);
	} catch (error) {
		await hub.stop();
		throw error;
	}

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		push?.stop();
		await http?.stop();
		await hub.stop();
		await rm(serverPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

await main();
