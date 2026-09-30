import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillListResponse } from "@omp-mobile/protocol";

const repo = resolve(import.meta.dir, "..");
const home = process.env.OMP_MOBILE_E2E_HOME ?? "/tmp/omp-mobile-e2e-agent/home";
const port = 18787;
const relayPort = 18788;
const base = `http://127.0.0.1:${port}`;
const cheapModel = "openai-codex/gpt-5.6-terra:medium";
const runRoot = join(homedir(), ".cache", "omp-mobile-e2e", String(Date.now()));
const scratchServer = join(runRoot, "server-session");
const scratchTerminal = join(runRoot, "terminal-session");
const overlayPath = join(runRoot, "collab.yml");
const copiedOmp = join(runRoot, "omp");
const serverPath = join(home, "server.json");
const startedProcesses = new Set<Bun.Subprocess>();
let server: Bun.Subprocess | undefined;
let tui: Bun.Subprocess | undefined;
let token = "";
let adminToken = "";
let tuiOutput = "";
let tuiError = "";
let serverStderr = "";
let checks = 0;
const realPath = (process.env.PATH ?? "")
	.split(":")
	.filter((entry) => !entry.includes("/node_modules/.bin"))
	.join(":");
const resolvedOmp = Bun.which("omp", { PATH: realPath });

function shown(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function pass(name: string, value: unknown): void {
	checks++;
	console.log(`PASS ${name}: ${shown(value)}`);
}

function assert(condition: unknown, name: string, value: unknown): asserts condition {
	if (!condition) {
		console.log(`FAIL ${name}: ${shown(value)}`);
		throw new Error(`${name}: ${shown(value)}`);
	}
	pass(name, value);
}

async function waitFor<T>(
	name: string,
	fn: () => Promise<T | undefined>,
	timeoutMs = 60_000,
	intervalMs = 250,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const result = await fn();
			if (result !== undefined) return result;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(intervalMs);
	}
	throw new Error(`${name} timed out${lastError ? `; last error: ${String(lastError)}` : ""}`);
}

async function request(path: string, init: RequestInit = {}, auth = true): Promise<{ response: Response; json: any }> {
	const headers = new Headers(init.headers);
	if (auth && token) headers.set("authorization", `Bearer ${token}`);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	const response = await fetch(`${base}${path}`, { ...init, headers });
	const text = await response.text();
	let json: any = undefined;
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			json = text;
		}
	}
	return { response, json };
}

async function ok(path: string, init: RequestInit = {}): Promise<any> {
	const result = await request(path, init);
	if (!result.response.ok)
		throw new Error(`${init.method ?? "GET"} ${path} => ${result.response.status}: ${shown(result.json)}`);
	return result.json;
}

function jsonBody(value: unknown): string {
	return JSON.stringify(value);
}
function textOf(item: any): string {
	return [item?.output, ...(Array.isArray(item?.blocks) ? item.blocks.map((block: any) => block?.text) : [])]
		.filter((value) => typeof value === "string")
		.join("\n");
}

class Stream {
	readonly messages: any[] = [];
	readonly ws: WebSocket;
	#waiters = new Set<{
		predicate: (message: any) => boolean;
		resolve: (message: any) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	readonly opened: Promise<void>;

	constructor() {
		const opened = Promise.withResolvers<void>();
		this.opened = opened.promise;
		this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/stream`, {
			headers: { authorization: `Bearer ${token}` },
		});
		this.ws.onopen = () => opened.resolve();
		this.ws.onerror = () => opened.reject(new Error("WebSocket connection failed"));
		this.ws.onmessage = (event) => {
			let message: any;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			this.messages.push(message);
			for (const waiter of [...this.#waiters])
				if (waiter.predicate(message)) {
					clearTimeout(waiter.timer);
					this.#waiters.delete(waiter);
					waiter.resolve(message);
				}
		};
	}

	wait(predicate: (message: any) => boolean, timeoutMs = 120_000): Promise<any> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.#waiters.delete(waiter);
					reject(new Error("WebSocket event timed out"));
				}, timeoutMs),
			};
			this.#waiters.add(waiter);
		});
	}

	send(value: unknown): void {
		this.ws.send(JSON.stringify(value));
	}
	close(): void {
		this.ws.close();
	}
}

async function settle(sessionId: string, predicate: (snapshot: any) => boolean, timeoutMs = 180_000): Promise<any> {
	return waitFor(
		`session ${sessionId} settle`,
		async () => {
			const snapshot = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}?limit=100`);
			const live = snapshot.session?.liveness;
			return (live?.kind === "idle" || (live?.kind === "server" && live.phase === "ready")) && predicate(snapshot)
				? snapshot
				: undefined;
		},
		timeoutMs,
		500,
	);
}

async function launchServer(): Promise<void> {
	await rm(home, { recursive: true, force: true });
	await mkdir(home, { recursive: true, mode: 0o700 });
	const ompPath = resolvedOmp;
	if (!ompPath) throw new Error("omp is not on PATH");
	await writeFile(
		join(home, "config.json"),
		JSON.stringify(
			{
				port,
				relayPort,
				roots: [homedir()],
				ompPath,
				rpcArgs: ["--approval-mode", "always-ask", "--model", cheapModel, "--no-lsp", "--no-title"],
			},
			null,
			2,
		),
	);
	server = Bun.spawn(["bun", "server/src/main.ts"], {
		cwd: repo,
		env: { ...process.env, OMP_MOBILE_HOME: home },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	startedProcesses.add(server);
	void (async () => {
		for await (const chunk of server!.stderr) serverStderr += new TextDecoder().decode(chunk);
	})();
	await waitFor(
		"server.json",
		async () => {
			try {
				const parsed = JSON.parse(await readFile(serverPath, "utf8"));
				adminToken = parsed.adminToken;
				return parsed;
			} catch {
				if (await Promise.race([server!.exited.then(() => true), Bun.sleep(1).then(() => false)]))
					throw new Error(`server exited: ${serverStderr}`);
			}
		},
		30_000,
	);
}

async function phaseA(): Promise<void> {
	console.log("\n[A] Pairing and basics");
	const unauthorized = await request("/admin/status", {}, false);
	assert(unauthorized.response.status === 401, "loopback admin requires token", unauthorized.response.status);
	const pairing = await request(
		"/admin/pairing",
		{ method: "POST", headers: { authorization: `Bearer ${adminToken}` } },
		false,
	);
	assert(pairing.response.ok && typeof pairing.json?.code === "string", "admin creates pairing code", {
		status: pairing.response.status,
		codeLength: pairing.json?.code?.length,
	});
	const paired = await request(
		"/v1/pair",
		{ method: "POST", body: jsonBody({ code: pairing.json.code, deviceName: "e2e" }) },
		false,
	);
	assert(paired.response.ok && typeof paired.json?.token === "string", "pairing exchanges code", {
		status: paired.response.status,
		deviceId: paired.json?.deviceId,
	});
	token = paired.json.token;
	const reused = await request(
		"/v1/pair",
		{ method: "POST", body: jsonBody({ code: pairing.json.code, deviceName: "reuse" }) },
		false,
	);
	assert(reused.response.status === 400, "pairing code reuse rejected", {
		status: reused.response.status,
		code: reused.json?.code,
	});

	const info = await ok("/v1/info");
	assert(
		["history", "rpc", "collab"].every((capability) => info.capabilities?.includes(capability)),
		"info advertises core capabilities",
		info.capabilities,
	);
	const sessions = await ok("/v1/sessions?limit=5");
	assert(
		Array.isArray(sessions.items) && sessions.items.every((item: any) => item.id && item.liveness?.kind),
		"session summaries include liveness",
		sessions.items.map((item: any) => ({ id: item.id, liveness: item.liveness })),
	);
	assert(sessions.items.length > 0, "real session history exists", sessions.items.length);
	const newest = sessions.items[0];
	const snapshot = await ok(`/v1/sessions/${encodeURIComponent(newest.id)}?limit=20`);
	assert(
		Array.isArray(snapshot.items) && typeof snapshot.olderCursor === "string",
		"recent session snapshot is pageable",
		{ id: newest.id, items: snapshot.items?.length, hasCursor: Boolean(snapshot.olderCursor) },
	);
	const older = await ok(
		`/v1/sessions/${encodeURIComponent(newest.id)}/items?limit=20&before=${encodeURIComponent(snapshot.olderCursor)}`,
	);
	const overlap = older.items
		.filter((item: any) => snapshot.items.some((recent: any) => recent.id === item.id))
		.map((item: any) => item.id);
	assert(
		Array.isArray(older.items) && older.items.length > 0 && overlap.length === 0,
		"older timeline page has no id overlap",
		{ items: older.items.length, overlap },
	);
	const projects = await ok("/v1/projects/recent");
	assert(Array.isArray(projects.projects), "recent projects endpoint", projects.projects.length);
	const dirs = await ok("/v1/fs/dirs");
	assert(Array.isArray(dirs.entries) && Array.isArray(dirs.roots), "directory browser endpoint", {
		path: dirs.path,
		entries: dirs.entries.length,
		roots: dirs.roots,
	});
	const etc = await request("/v1/fs/dirs?path=%2Fetc");
	assert(etc.response.status === 403, "directory browser rejects /etc", {
		status: etc.response.status,
		code: etc.json?.code,
	});
	const escape = await request(`/v1/fs/dirs?path=${encodeURIComponent(join(homedir(), "..", "etc"))}`);
	assert(escape.response.status === 403, "directory browser rejects root escape", {
		status: escape.response.status,
		code: escape.json?.code,
	});

	const status = await request("/admin/status", { headers: { authorization: `Bearer ${adminToken}` } }, false);
	assert(status.response.ok, "loopback admin accepts token", { status: status.response.status, url: status.json?.url });
	const publicUrl = String(status.json.url);
	assert(!publicUrl.includes("127.0.0.1"), "server exposes MagicDNS URL", publicUrl);
	const tailAdmin = await fetch(`${publicUrl}/admin/status`, { headers: { authorization: `Bearer ${adminToken}` } });
	assert(tailAdmin.status === 404, "tailnet listener hides admin routes", { url: publicUrl, status: tailAdmin.status });
}

async function respond(sessionId: string, interaction: any, operationId: string, response: any): Promise<any> {
	return ok(
		`/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interaction.id)}/respond`,
		{ method: "POST", body: jsonBody({ operationId, response }) },
	);
}

async function approveUntilSettled(
	stream: Stream,
	sessionId: string,
	stop: () => boolean,
	timeoutMs = 180_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const answered = new Set<string>();
	while (Date.now() < deadline && !stop()) {
		for (const message of stream.messages)
			for (const pending of message.type === "session.update" && message.sessionId === sessionId
				? (message.pending ?? [])
				: []) {
				if (pending.kind === "approval" && !answered.has(pending.id)) {
					answered.add(pending.id);
					const receipt = await respond(sessionId, pending, `approve-${sessionId}-${pending.id}`, { kind: "approve" });
					assert(receipt.state === "applied", "approval response applied", { interactionId: pending.id, receipt });
				}
			}
		await Bun.sleep(100);
	}
}

async function phaseB(): Promise<string> {
	console.log("\n[B] Server-owned session");
	const stream = new Stream();
	await stream.opened;
	const hello = await stream.wait((message) => message.type === "hello", 10_000);
	assert(hello.info?.capabilities?.includes("rpc"), "WebSocket hello", {
		epoch: hello.epoch,
		capabilities: hello.info?.capabilities,
	});
	const skillDir = join(scratchServer, ".omp", "skills", "e2e-again");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		"---\nname: e2e-again\ndescription: E2E project skill that replies with one word.\n---\n\nReply with the word again. Do not use tools.\n",
	);
	const { skills }: SkillListResponse = await ok(`/v1/skills?cwd=${encodeURIComponent(scratchServer)}`);
	assert(
		skills.some((skill) => skill.name === "e2e-again" && skill.description?.includes("one word")),
		"skills endpoint lists the project skill",
		skills.map((skill) => skill.name),
	);
	// The probe is a throwaway omp; a globally installed extension must not report it as a session.
	await Bun.sleep(1_000);
	const probed = await ok(`/v1/sessions?project=${encodeURIComponent(scratchServer)}`);
	assert(probed.items.length === 0, "skill probe leaves no session behind", probed.items);
	const created = await ok("/v1/sessions", {
		method: "POST",
		body: jsonBody({
			cwd: scratchServer,
			prompt:
				"Use the ask tool to ask me one question titled Color with options Red and Blue. After I answer, run bash: echo picked-<color lowercase>. Then reply with one short sentence.",
			operationId: "create-server-e2e",
		}),
	});
	const sessionId = created.sessionId;
	assert(typeof sessionId === "string", "phone creates server-owned session", sessionId);
	stream.send({ type: "subscribe", sessionId });
	await stream.wait((message) => message.type === "session.snapshot" && message.sessionId === sessionId, 30_000);
	const questionUpdate = await stream.wait(
		(message) =>
			message.type === "session.update" &&
			message.sessionId === sessionId &&
			message.pending?.some((pending: any) => pending.kind === "question" && pending.title === "Color"),
		120_000,
	);
	const question = questionUpdate.pending.find(
		(pending: any) => pending.kind === "question" && pending.title === "Color",
	);
	assert(
		question.options?.some((option: any) => option.label === "Blue"),
		"ask question reaches phone",
		question,
	);
	const operationId = "answer-blue-e2e";
	const receipt = await respond(sessionId, question, operationId, { kind: "choice", label: "Blue" });
	assert(receipt.state === "applied", "choice response applied", receipt);
	let settled = false;
	const approvals = approveUntilSettled(stream, sessionId, () => settled);
	const snapshot = await settle(sessionId, (page) => {
		const hasTool = page.items.some(
			(item: any) => item.kind === "tool" && item.state === "succeeded" && textOf(item).includes("picked-blue"),
		);
		const hasAssistant = page.items.some((item: any) => item.kind === "assistant" && textOf(item).trim());
		return hasTool && hasAssistant;
	});
	settled = true;
	await approvals;
	assert(
		snapshot.items.some(
			(item: any) => item.kind === "tool" && item.state === "succeeded" && textOf(item).includes("picked-blue"),
		),
		"server timeline contains successful bash output",
		snapshot.items
			.filter((item: any) => item.kind === "tool")
			.map((item: any) => ({ id: item.id, state: item.state, output: textOf(item) })),
	);
	assert(
		snapshot.items.some((item: any) => item.kind === "assistant" && textOf(item).trim()),
		"server timeline contains assistant reply",
		snapshot.items.filter((item: any) => item.kind === "assistant").map(textOf),
	);
	assert(
		new Set(snapshot.items.map((item: any) => item.id)).size === snapshot.items.length,
		"server timeline has no duplicate ids",
		snapshot.items.length,
	);
	assert(
		stream.messages.some(
			(message) => message.type === "timeline.retire" && message.sessionId === sessionId && message.ids?.length,
		),
		"live timeline items retire",
		stream.messages.filter((message) => message.type === "timeline.retire"),
	);
	const duplicate = await respond(sessionId, question, operationId, { kind: "choice", label: "Blue" });
	assert(JSON.stringify(duplicate) === JSON.stringify(receipt), "interaction response is idempotent", duplicate);
	const follow = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
		method: "POST",
		body: jsonBody({ operationId: "again-e2e", text: "/skill:e2e-again" }),
	});
	assert(follow.state === "accepted", "follow-up skill prompt accepted", follow);
	const again = await settle(sessionId, (page) =>
		page.items.some((item: any) => item.kind === "assistant" && /\bagain\b/i.test(textOf(item))),
	);
	assert(
		again.items.some((item: any) => item.kind === "assistant" && /\bagain\b/i.test(textOf(item))),
		"skill follow-up assistant reply observed",
		"again",
	);
	assert(
		again.items.some((item: any) => item.kind === "user" && textOf(item) === "/skill:e2e-again"),
		"skill prompt shows as the typed command",
		again.items.filter((item: any) => item.kind === "user").map(textOf),
	);
	await ok(`/v1/sessions/${encodeURIComponent(sessionId)}/handoff`, { method: "POST" });
	const idle = await waitFor(
		"server handoff",
		async () => {
			const page = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}?limit=5`);
			return page.session.liveness.kind === "idle" ? page : undefined;
		},
		30_000,
	);
	assert(idle.session.liveness.kind === "idle", "handoff closes rpc child", idle.session.liveness);
	stream.close();
	return sessionId;
}

async function phaseC(): Promise<string> {
	console.log("\n[C] Terminal Collab session");
	const sourceOmp = resolvedOmp;
	if (!sourceOmp) throw new Error("omp is not on PATH");
	await copyFile(sourceOmp, copiedOmp);
	await chmod(copiedOmp, 0o700);
	await writeFile(overlayPath, `collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:${relayPort}\n`);
	const env = { ...process.env, OMP_MOBILE_HOME: home };
	delete env.BUN_BE_BUN;
	tui = Bun.spawn(
		[
			"python3",
			join(repo, "scripts/pty-run.py"),
			copiedOmp,
			"--config",
			overlayPath,
			"-e",
			join(repo, "extension/omp-mobile.ts"),
			"--approval-mode",
			"always-ask",
			"--cwd",
			scratchTerminal,
			"--model",
			cheapModel,
			"--no-lsp",
			"--no-title",
		],
		{ cwd: scratchTerminal, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	startedProcesses.add(tui);
	void (async () => {
		for await (const chunk of tui!.stdout) {
			tuiOutput += new TextDecoder().decode(chunk);
			if (tuiOutput.length > 500_000) tuiOutput = tuiOutput.slice(-250_000);
		}
	})();
	void (async () => {
		for await (const chunk of tui!.stderr) tuiError += new TextDecoder().decode(chunk);
	})();
	const terminal = await waitFor(
		"terminal registration",
		async () => {
			const list = await ok("/v1/sessions?limit=100");
			const found = list.items.find(
				(item: any) => item.project?.path === scratchTerminal && item.liveness?.kind === "terminal",
			);
			if (found) return found;
			if (await Promise.race([tui!.exited.then(() => true), Bun.sleep(1).then(() => false)]))
				throw new Error(`TUI exited: ${tuiError || tuiOutput.slice(-3000)}`);
		},
		45_000,
	);
	const sessionId = terminal.id;
	assert(terminal.liveness.kind === "terminal", "extension registers terminal ownership", {
		sessionId,
		liveness: terminal.liveness,
	});
	const stream = new Stream();
	await stream.opened;
	await stream.wait((message) => message.type === "hello", 10_000);
	stream.send({ type: "subscribe", sessionId });
	await stream.wait((message) => message.type === "session.snapshot" && message.sessionId === sessionId, 30_000);
	const prompt = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
		method: "POST",
		body: jsonBody({ operationId: "terminal-prompt-e2e", text: "Run bash: echo hello-from-phone. Then reply done." }),
	});
	assert(prompt.state === "accepted", "phone prompts terminal Collab session", prompt);
	const pendingUpdate = await stream.wait(
		(message) =>
			message.type === "session.update" &&
			message.sessionId === sessionId &&
			message.pending?.some((pending: any) => pending.kind === "approval"),
		120_000,
	);
	const approval = pendingUpdate.pending.find((pending: any) => pending.kind === "approval");
	assert(approval, "terminal approval reaches phone", approval);
	const receipt = await respond(sessionId, approval, "terminal-approve-e2e", { kind: "approve" });
	assert(receipt.state === "applied", "terminal approval receipt applied", receipt);
	const complete = await waitFor(
		"terminal tool completion",
		async () => {
			const page = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}?limit=100`);
			return page.session?.liveness?.kind === "terminal" &&
				page.items.some(
					(item: any) =>
						item.kind === "tool" && item.state === "succeeded" && textOf(item).includes("hello-from-phone"),
				)
				? page
				: undefined;
		},
		180_000,
		500,
	);
	assert(
		complete.items.some(
			(item: any) => item.kind === "tool" && item.state === "succeeded" && textOf(item).includes("hello-from-phone"),
		),
		"terminal timeline contains successful bash output",
		complete.items
			.filter((item: any) => item.kind === "tool")
			.map((item: any) => ({ state: item.state, output: textOf(item) })),
	);
	const admin = await request("/admin/status", { headers: { authorization: `Bearer ${adminToken}` } }, false);
	assert(
		admin.response.ok && admin.json.apnsConfigured === false && !admin.json.problems?.includes("APNs not configured"),
		"APNs-less server reports structured status without a duplicate problem",
		{
			status: admin.response.status,
			apnsConfigured: admin.json?.apnsConfigured,
			problems: admin.json?.problems,
		},
	);

	tui.stdin.write("/exit\r");
	const exitCode = await Promise.race([tui.exited, Bun.sleep(20_000).then(() => undefined)]);
	assert(exitCode !== undefined, "terminal process exits after /exit", exitCode);
	const idle = await waitFor(
		"terminal idle",
		async () => {
			const page = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}?limit=10`);
			return page.session.liveness.kind === "idle" ? page : undefined;
		},
		20_000,
	);
	assert(idle.session.liveness.kind === "idle", "terminal shutdown and pid exit produce idle", idle.session.liveness);
	const resumed = await ok(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
		method: "POST",
		body: jsonBody({ operationId: "resume-e2e", text: "Reply with the word resumed." }),
	});
	assert(resumed.state === "accepted", "idle terminal session resumes under server", resumed);
	const resumedPage = await settle(
		sessionId,
		(page) =>
			page.session.liveness.kind === "server" &&
			page.items.some((item: any) => item.kind === "assistant" && /\bresumed\b/i.test(textOf(item))),
		180_000,
	);
	assert(
		resumedPage.session.liveness.kind === "server" &&
			resumedPage.items.some((item: any) => item.kind === "assistant" && /\bresumed\b/i.test(textOf(item))),
		"resumed session replies under server ownership",
		resumedPage.session.liveness,
	);
	await ok(`/v1/sessions/${encodeURIComponent(sessionId)}/handoff`, { method: "POST" });
	await waitFor(
		"resumed handoff",
		async () =>
			(await ok(`/v1/sessions/${encodeURIComponent(sessionId)}?limit=5`)).session.liveness.kind === "idle"
				? true
				: undefined,
		30_000,
	);
	pass("resumed rpc child handed off", "idle");
	stream.close();
	return sessionId;
}

async function stopProcess(proc: Bun.Subprocess | undefined): Promise<void> {
	if (!proc) return;
	const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(50).then(() => false)]);
	if (!exited) {
		proc.kill("SIGTERM");
		if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]))) proc.kill("SIGKILL");
	}
	startedProcesses.delete(proc);
}

let failure: unknown;
try {
	await mkdir(scratchServer, { recursive: true });
	await mkdir(scratchTerminal, { recursive: true });
	if (process.env.OMP_MOBILE_E2E_SERVER_URL)
		throw new Error("External server mode is not supported with the fixed isolated-home contract");
	await launchServer();
	await phaseA();
	const serverSession = await phaseB();
	const terminalSession = await phaseC();
	console.log(
		`\nPASS E2E complete: ${checks} checks; serverSession=${serverSession}; terminalSession=${terminalSession}`,
	);
} catch (error) {
	failure = error;
	console.error(`\nFAIL E2E: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (tuiOutput || tuiError) console.error(`TUI tail:\n${tuiOutput.slice(-3000)}\n${tuiError.slice(-2000)}`);
	if (serverStderr) console.error(`Server stderr tail:\n${serverStderr.slice(-4000)}`);
	process.exitCode = 1;
} finally {
	await stopProcess(tui);
	await stopProcess(server);
	for (const proc of [...startedProcesses]) await stopProcess(proc);
	await rm(runRoot, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
	if (!failure) pass("cleanup removed isolated scratch and server home", { runRoot, home });
}
