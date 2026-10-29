import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentStore } from "./agents/store.ts";
import { ToolCatalog } from "./agents/tools.ts";
import { createBrowserService } from "./browser/index.ts";
import { loadConfig } from "./config.ts";
import { loadMachineId } from "./machine-id.ts";
import { createHistory } from "./history/index.ts";
import { startHttp, type HttpService } from "./http/index.ts";
import { createJobService, createJobStore, type JobService } from "./jobs/index.ts";
import { createLiveHub } from "./live/index.ts";
import { createPushService, type PushService } from "./push/index.ts";
import { createDeviceStore, createPinStore } from "./store/index.ts";
import { writePrivateJson } from "./private-json.ts";

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

async function main(): Promise<void> {
	const config = await loadConfig();
	const adminToken = randomBytes(32).toString("base64url");
	const extensionToken = randomBytes(32).toString("base64url");
	const devices = createDeviceStore(join(config.dataDir, "devices.json"));
	await devices.load();
	const machineId = await loadMachineId(config.dataDir, { paired: devices.list().length > 0 });
	const pins = createPinStore(join(config.dataDir, "pins.json"));
	await pins.load();
	const ompAgentDir = join(homedir(), ".omp", "agent");
	const history = createHistory({
		sessionsDir: join(ompAgentDir, "sessions"),
		blobsDir: join(ompAgentDir, "blobs"),
		roots: config.roots,
		cursorSecret: randomBytes(32),
	});
	const agents = new AgentStore(join(ompAgentDir, "agents"));
	if (!config.ompPath) console.warn("omp executable not found; live actions are unavailable");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const hub = createLiveHub({
		history,
		agents,
		ompPath: config.ompPath ?? "omp",
		relayPort: config.relayPort,
		extensionPath: join(root, "extension", "omp-mobile.ts"),
		rpcArgs: config.rpcArgs,
	});
	await hub.start();
	const browser = createBrowserService({ relayUrl: config.browserRelayUrl });
	let http: HttpService | undefined;
	let push: PushService | undefined;
	let jobs: JobService | undefined;
	const jobStore = createJobStore(join(config.dataDir, "jobs.db"));
	const serverPath = join(config.dataDir, "server.json");
	try {
		const version = await ompVersion(config.ompPath);
		jobs = createJobService({ store: jobStore, hub, history });
		http = await startHttp({
			config,
			machineId,
			ompVersion: version,
			devices,
			history,
			hub,
			browser,
			adminToken,
			extensionToken,
			jobs,
			pins,
			agents,
			tools: new ToolCatalog(config.ompPath ?? "omp"),
		});
		if (config.apns) push = createPushService(config.apns, machineId, devices, hub);
		await writePrivateJson(serverPath, {
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
		jobs?.stop();
		jobStore.close();
		await hub.stop();
		throw error;
	}

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		jobs?.stop();
		push?.stop();
		await http?.stop();
		browser.stop();
		await hub.stop();
		jobStore.close();
		await rm(serverPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

await main();
