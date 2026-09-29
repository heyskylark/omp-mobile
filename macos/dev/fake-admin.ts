const home = process.env.OMP_MOBILE_HOME;
if (!home) throw new Error("OMP_MOBILE_HOME must point to an isolated temporary directory");

const port = Number(process.env.OMP_MOBILE_FAKE_PORT ?? "18787");
const adminToken = "fake-admin-token";
let pairingNumber = 0;
let devices = [
	{
		id: "iphone-skylark",
		name: "Skylark’s iPhone",
		pairedAt: new Date(Date.now() - 86_400_000).toISOString(),
		lastSeenAt: new Date(Date.now() - 75_000).toISOString(),
	},
];

await Bun.write(
	`${home}/server.json`,
	JSON.stringify({
		port,
		relayPort: port + 1,
		pid: process.pid,
		url: `http://fake-mac.tailnet.ts.net:${port}`,
		adminToken,
		extensionToken: "fake-extension-token",
		startedAt: new Date().toISOString(),
	}),
);
await Bun.$`chmod 600 ${home}/server.json`;
await Bun.$`mkdir -p ${home}/logs`;
await Bun.write(`${home}/logs/server.log`, "Fake admin server running\n");

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	fetch(request) {
		if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
			return json({ code: "unauthorized", message: "Invalid admin token" }, 401);
		}

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/admin/status") {
			return json({
				machineName: "Skylark’s MacBook Pro",
				url: `http://fake-mac.tailnet.ts.net:${port}`,
				ompVersion: "18.4.3",
				apnsConfigured: false,
				devices,
				pairings: [],
				live: { terminal: 2, server: 1, pending: 2 },
				problems: ["Tailscale is disconnected"],
			});
		}

		if (request.method === "POST" && url.pathname === "/admin/pairing") {
			pairingNumber += 1;
			const code = `OMP${String(pairingNumber).padStart(5, "0")}`;
			return json({
				id: `pairing-${pairingNumber}`,
				code,
				expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
				pairingUrl: `ompmobile://pair?v=1&url=${encodeURIComponent(`http://fake-mac.tailnet.ts.net:${port}`)}&code=${code}&name=${encodeURIComponent("Skylark’s MacBook Pro")}`,
			});
		}

		const match = url.pathname.match(/^\/admin\/devices\/([^/]+)$/);
		if (request.method === "DELETE" && match) {
			const id = decodeURIComponent(match[1]!);
			devices = devices.filter((device) => device.id !== id);
			return new Response(null, { status: 204 });
		}

		return json({ code: "not_found", message: "Not found" }, 404);
	},
});

console.log(`Fake admin listening at ${server.url}`);

function stop() {
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
