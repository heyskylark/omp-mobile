#!/usr/bin/env bun
// Read-only readiness check for one verification run. Exits 1 if any check fails.
// Usage: doctor.ts <run-id> [--no-sim]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { AdminStatus } from "../../../../packages/protocol/src/index.ts";
import { join } from "node:path";

const runId = process.argv[2];
if (!runId) throw new Error("usage: doctor.ts <run-id> [--no-sim]");
const checkSim = !process.argv.includes("--no-sim");
const envFile = join(homedir(), ".cache", "omp-mobile-verify", runId, "run.env");
let failed = false;
const ok = (msg: string) => console.log(`ok    ${msg}`);
const fail = (msg: string) => {
	failed = true;
	console.log(`FAIL  ${msg}`);
};
const installHints: Record<string, string> = {
	omp: "install omp or add its directory to PATH",
	lsof: "add /usr/sbin to PATH",
	xcrun: "install Xcode and select it with xcode-select",
	maestro: "install Maestro or add ~/.maestro/bin to PATH",
	java: "install a JDK 17+ on PATH or set JAVA_HOME",
};
const missing = (tool: string) => {
	if (Bun.which(tool)) return false;
	fail(`${tool} not found on PATH (${installHints[tool]})`);
	return true;
};
// Returns undefined (after recording a FAIL) when the executable is not on PATH.
const run = (argv: string[]) => {
	if (missing(argv[0])) return undefined;
	const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

if (!existsSync(envFile)) {
	console.log(`FAIL  missing ${envFile}; run prepare-run.sh ${runId}`);
	process.exit(1);
}
const env = Object.fromEntries(
	readFileSync(envFile, "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
ok(`run ${runId}: home=${env.OMP_MOBILE_HOME} evidence=${env.EVIDENCE}`);
if (!existsSync(env.EVIDENCE)) fail(`evidence root missing: ${env.EVIDENCE}`);

const omp = run(["omp", "--version"]);
if (omp) omp.code === 0 ? ok(`omp ${omp.out}`) : fail(`omp --version: ${omp.err}`);

const serverJson = join(env.OMP_MOBILE_HOME, "server.json");
if (!existsSync(serverJson)) {
	fail(`${serverJson} missing: server not started for this run (or it exited)`);
} else {
	// Written by this repository's server (server/src/main.ts); the listener and status checks below validate it.
	const server = JSON.parse(readFileSync(serverJson, "utf8")) as { port: number; pid: number; adminToken: string };
	if (String(server.port) !== env.PORT) fail(`server.json port ${server.port} != run port ${env.PORT}`);
	const lsof = run(["lsof", "-nP", "-t", `-iTCP:${env.PORT}`, "-sTCP:LISTEN"]);
	if (lsof) {
		const listeners = lsof.out.split("\n");
		listeners.includes(String(server.pid))
			? ok(`server pid ${server.pid} listens on 127.0.0.1:${env.PORT}`)
			: fail(`port ${env.PORT} listeners [${listeners.join(",")}] do not include server.json pid ${server.pid}`);
	}
	try {
		const res = await fetch(`http://127.0.0.1:${env.PORT}/admin/status`, {
			headers: { authorization: `Bearer ${server.adminToken}` },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const s = (await res.json()) as AdminStatus;
		s.machineName === env.MACHINE_NAME
			? ok(`admin status: machine "${s.machineName}"`)
			: fail(`admin status machine "${s.machineName}" is not this run's "${env.MACHINE_NAME}"`);
		ok(`pairing URL host: ${s.url} (Simulator reaches 127.0.0.1 directly; *.ts.net needs this Mac on the tailnet)`);
		s.ompVersion
			? ok(`server sees omp ${s.ompVersion}; apnsConfigured=${s.apnsConfigured}`)
			: fail("server could not run omp (ompVersion null); check ompPath in config.json");
		ok(`paired devices: ${JSON.stringify(s.devices.map((d) => d.name))}`);
		ok(`live: ${JSON.stringify(s.live)} problems: ${JSON.stringify(s.problems)}`);
	} catch (error) {
		fail(`GET /admin/status: ${error}`);
	}
}

if (checkSim) {
	const udid = env.SIM_UDID;
	if (!udid) {
		fail("run.env has no SIM_UDID; run sim-create.sh");
	} else if (!missing("xcrun")) {
		const devices = JSON.parse(run(["xcrun", "simctl", "list", "devices", "-j"])!.out).devices as Record<
			string,
			{ udid: string; name: string; state: string }[]
		>;
		const found = Object.entries(devices)
			.flatMap(([runtime, list]) => list.map((dev) => ({ runtime, dev })))
			.find(({ dev }) => dev.udid === udid);
		if (!found) fail(`simulator ${udid} does not exist`);
		else if (found.dev.name !== `omp-verify-${runId}`) fail(`simulator ${udid} is "${found.dev.name}", not this run's`);
		else {
			const { runtime, dev } = found;
			dev.state === "Booted" ? ok(`simulator ${dev.name} ${udid} Booted`) : fail(`simulator state ${dev.state}`);
			runtime.includes(".SimRuntime.iOS-26-")
				? ok(`simulator runtime ${runtime}`)
				: fail(
						`simulator runtime ${runtime} is not iOS 26.x (the app crashes at launch on iOS 27); run cleanup.sh ${runId}, then prepare-run.sh and sim-create.sh with a new run id`,
					);
		}

		const bundleId = process.env.OMP_BUNDLE_ID ?? "com.heyskylark.ompmobile";
		const container = run(["xcrun", "simctl", "get_app_container", udid, bundleId, "app"])!;
		if (container.code !== 0) {
			fail(`${bundleId} not installed on ${udid}; run scripts/simulator.sh ${udid}`);
		} else {
			const bundle = join(container.out, "main.jsbundle");
			if (!existsSync(bundle)) {
				fail(`${bundle} missing: installed app is not a Release build with embedded JS`);
			} else {
				const built = statSync(bundle).mtimeMs;
				const newest = ["app/src", "packages/protocol/src"]
					.flatMap((dir) =>
						readdirSync(join(env.REPO, dir), { recursive: true, withFileTypes: true })
							.filter((e) => e.isFile())
							.map((e) => ({ path: join(e.parentPath, e.name), mtime: statSync(join(e.parentPath, e.name)).mtimeMs })),
					)
					.sort((a, b) => b.mtime - a.mtime)[0];
				newest.mtime <= built
					? ok(`installed JS bundle ${new Date(built).toISOString()} is newer than sources`)
					: fail(`installed JS bundle is older than ${newest.path}; rebuild with scripts/simulator.sh ${udid}`);
			}
		}
	}
}

const maestro = run(["maestro", "--version"]);
if (maestro) maestro.code === 0 ? ok(`maestro ${maestro.out.split("\n").pop()}`) : fail(`maestro: ${maestro.err}`);
const java = run(["java", "-version"]);
if (java && java.code !== 0) {
	fail(`java -version: ${java.err} (${installHints.java})`);
} else if (java) {
	const banner = java.err.split("\n")[0];
	// `version "16.0.2"`, `version "17"`, legacy `version "1.8.0_402"` (= 8).
	const parts = banner.match(/version "([^"]+)"/)?.[1].split(/[._-]/) ?? [];
	const major = Number(parts[0] === "1" ? parts[1] : parts[0]);
	if (major >= 17) ok(`java ${banner}`);
	else fail(`java ${Number.isNaN(major) ? "version unknown" : major} found (${banner}); Maestro needs 17+: ${installHints.java}`);
}

process.exit(failed ? 1 : 0);
