#!/usr/bin/env bun
// Talks to this run's isolated server over loopback.
//   api.ts <run-id> pair-link     POST /admin/pairing; prints the one-time ompmobile://pair link
//   api.ts <run-id> status        GET /admin/status (read-only)
//   api.ts <run-id> get <path>    GET a device API path (e.g. "/v1/sessions?limit=5") as the "verify-probe"
//                                 device, pairing that probe once per run on first use
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PairResponse } from "../../../../packages/protocol/src/index.ts";

const [runId, command, path] = process.argv.slice(2);
if (!runId || !["pair-link", "status", "get"].includes(command ?? "") || (command === "get" && !path?.startsWith("/v1/")))
	throw new Error("usage: api.ts <run-id> pair-link | status | get </v1/...>");

const scratch = join(homedir(), ".cache", "omp-mobile-verify", runId);
// Written by this repository's server (server/src/main.ts).
const server = JSON.parse(readFileSync(join(scratch, "home", "server.json"), "utf8")) as {
	port: number;
	adminToken: string;
};
const base = `http://127.0.0.1:${server.port}`;

async function call(route: string, init: RequestInit = {}): Promise<unknown> {
	const res = await fetch(base + route, init);
	const text = await res.text();
	if (!res.ok) throw new Error(`${init.method ?? "GET"} ${route} -> HTTP ${res.status}: ${text}`);
	return text ? JSON.parse(text) : null;
}
const admin = { authorization: `Bearer ${server.adminToken}` };
const pairing = async () => (await call("/admin/pairing", { method: "POST", headers: admin })) as { code: string; pairingUrl: string };

if (command === "pair-link") {
	console.log((await pairing()).pairingUrl);
} else if (command === "status") {
	console.log(JSON.stringify(await call("/admin/status", { headers: admin }), null, 2));
} else {
	const probeFile = join(scratch, "probe.json");
	const pairProbe = async () => {
		const { code } = await pairing();
		const paired = (await call("/v1/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, deviceName: "verify-probe" }),
		})) as PairResponse;
		writeFileSync(probeFile, JSON.stringify({ token: paired.token }), { mode: 0o600 });
		return paired.token;
	};
	const stored: unknown = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, "utf8")) : null;
	let token =
		stored && typeof stored === "object" && "token" in stored && typeof stored.token === "string"
			? stored.token
			: await pairProbe();
	// A recipe may remove verify-probe (menu bar Remove); pair a new probe once instead of failing.
	if ((await fetch(base + path!, { headers: { authorization: `Bearer ${token}` } })).status === 401) token = await pairProbe();
	console.log(JSON.stringify(await call(path!, { headers: { authorization: `Bearer ${token}` } }), null, 2));
}
