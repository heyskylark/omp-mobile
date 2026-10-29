import { homedir } from "node:os";
import { join } from "node:path";

type SessionEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
	customType?: string;
	data?: unknown;
};
type SessionManager = {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionName(): string | undefined;
	getEntries(): SessionEntry[];
	/** Not on OMP's public ReadonlySessionManager type, but present on the runtime object. */
	setSessionName?(name: string, source: "auto" | "user"): Promise<boolean>;
};
type Model = { provider: string; id: string };
type ExtensionContext = {
	sessionManager: SessionManager;
	cwd: string;
	mode: string;
	modelRegistry: unknown;
	model: unknown;
	models: { resolve(spec: string): Model | undefined };
	setTimeout(callback: () => unknown, ms: number): unknown;
};
type Event = Record<string, unknown> & { type: string };
type Described = { describe(text: string): unknown };
type ToolResult = { content: { type: "text"; text: string }[]; details?: unknown };
type ExtensionApi = {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: Record<string, string>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			context: ExtensionContext,
		): Promise<ToolResult>;
	}): void;
	zod: { object(shape: Record<string, unknown>): unknown; string(): Described };
	on(name: string, handler: (event: Event, context: ExtensionContext) => unknown): void;
	registerCommand(
		name: string,
		options: { description?: string; handler(args: string, context: ExtensionContext): Promise<void> },
	): void;
	setModel(model: Model): Promise<boolean>;
	setThinkingLevel(level: string): void;
	appendEntry(customType: string, data?: unknown): void;
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): Promise<void>;
	getCommands(): { name: string; source: string; path?: string }[];
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean },
	): void;
	pi: { settings: { getModelRole(role: string): string | undefined } };
	/** OMP's session event bus; carries the `task:subagent:*` channels. */
	events?: { on(channel: string, handler: (payload: unknown) => void): unknown };
};

/** The server sends `/omp-mobile-model <role>` to its rpc children; keep in sync with `server/src/live/actor.ts`. */
const MODEL_ROLE_COMMAND = "omp-mobile-model";
/** Session entry recording the role picked from the phone; keep in sync with `server/src/history/pager.ts`. */
const MODEL_ROLE_ENTRY = "omp-mobile-model-role";
const MODEL_ROLES: Record<string, true> = { smol: true, default: true, slow: true };
/** The server sends `/omp-mobile-advisor on|off` after OMP's own `/advisor`; keep in sync with `server/src/live/actor.ts`. */
const ADVISOR_COMMAND = "omp-mobile-advisor";
/**
 * Session entry recording the advisor switch, which OMP keeps only in memory, so the server can restore it when it
 * resumes the session; keep in sync with `server/src/history/pager.ts`.
 */
const ADVISOR_ENTRY = "omp-mobile-advisor";
const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};
/** The server passes a new session's agent here as `AgentSnapshot` JSON; keep in sync with `server/src/agents/store.ts`. */
const AGENT_ENV = "OMP_MOBILE_AGENT";
/**
 * Session entry holding the agent snapshot the session started as. It, not the agent's current file, decides the
 * session's tools and instructions for its lifetime; keep in sync with `server/src/history/catalog.ts`.
 */
const AGENT_ENTRY = "omp-mobile-agent";
/** Tools this extension registers; agent sessions keep them so the phone's features work. Keep in sync with `server/src/agents/tools.ts`. */
const OWN_TOOLS = ["schedule_job"];
/** OMP's custom message type for skill content, as its `task` subagents autoload skills. */
const SKILL_PROMPT_MESSAGE = "skill-prompt";
const SKILL_PREFIX = "skill:";

type AgentSnapshot = { name: string; tools?: string[]; prompt: string; autoloadSkills?: string[] };

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function agentSnapshot(value: unknown): AgentSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { name, tools, prompt, autoloadSkills } = value as Record<string, unknown>;
	if (typeof name !== "string" || typeof prompt !== "string") return undefined;
	return { name, prompt, tools: stringList(tools), autoloadSkills: stringList(autoloadSkills) };
}

/**
 * The agent the session started as. A session the server starts as an agent records the snapshot the server passed
 * (`isNew`); later runs of the session, in the server or a terminal, read it back.
 */
function sessionAgent(
	api: ExtensionApi,
	sessionManager: SessionManager,
): { agent: AgentSnapshot; isNew: boolean } | undefined {
	const entry = sessionManager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === AGENT_ENTRY);
	if (entry) {
		const agent = agentSnapshot(entry.data);
		return agent && { agent, isNew: false };
	}
	const provided = process.env[AGENT_ENV];
	if (!provided) return undefined;
	// Consumed once, so the session's task subagents and the processes it spawns start without it.
	delete process.env[AGENT_ENV];
	let data: unknown;
	try {
		data = JSON.parse(provided);
	} catch {
		return undefined;
	}
	const agent = agentSnapshot(data);
	if (!agent) return undefined;
	api.appendEntry(AGENT_ENTRY, data);
	return { agent, isNew: true };
}

/**
 * Loads the agent's skills into a new session's context the way OMP's `task` subagents do (`autoload` skill messages
 * before the first prompt). Skills come from OMP's `/skill:<name>` commands, so a skill missing on this computer, or
 * all of them when OMP's `skills.enableSkillCommands` is off, is skipped.
 */
async function autoloadSkills(api: ExtensionApi, names: string[]): Promise<void> {
	const paths = new Map(
		api
			.getCommands()
			.filter((command) => command.source === "skill" && command.name.startsWith(SKILL_PREFIX) && command.path)
			.map((command) => [command.name.slice(SKILL_PREFIX.length), command.path!]),
	);
	for (const name of names) {
		const path = paths.get(name);
		if (!path) continue;
		const body = (await Bun.file(path).text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
		api.sendMessage(
			{
				customType: SKILL_PROMPT_MESSAGE,
				content: `${body}\n\n---\n\nSkill: ${path}`,
				display: false,
				details: { name, path },
			},
			{ triggerTurn: false },
		);
	}
}

/**
 * OMP's extension API resolves a role to its model but drops the `:level` suffix, so read the level from the
 * first configured pattern that resolves to that same model (`smol: anthropic/opus:xhigh, openai/gpt:low`).
 */
function roleThinkingLevel(api: ExtensionApi, context: ExtensionContext, role: string, model: Model) {
	for (const pattern of (api.pi.settings.getModelRole(role) ?? "").split(",")) {
		const trimmed = pattern.trim();
		const resolved = trimmed ? context.models.resolve(trimmed) : undefined;
		if (resolved?.provider !== model.provider || resolved.id !== model.id) continue;
		const level = trimmed.slice(trimmed.lastIndexOf(":") + 1);
		return Object.hasOwn(THINKING_LEVELS, level) ? level : undefined;
	}
	return undefined;
}

async function switchModelRole(api: ExtensionApi, args: string, context: ExtensionContext): Promise<void> {
	const role = args.trim();
	if (!Object.hasOwn(MODEL_ROLES, role)) throw new Error(`Unknown model role "${role}"`);
	const model = context.models.resolve(`@${role}`);
	if (!model) throw new Error(`No available model is configured for the ${role} role`);
	if (!(await api.setModel(model))) throw new Error(`No API key for ${model.provider}/${model.id}`);
	const level = roleThinkingLevel(api, context, role, model);
	if (level) api.setThinkingLevel(level);
	api.appendEntry(MODEL_ROLE_ENTRY, { role });
}

async function recordAdvisor(api: ExtensionApi, args: string): Promise<void> {
	const state = args.trim();
	if (state !== "on" && state !== "off") throw new Error(`Expected on or off, got "${state}"`);
	api.appendEntry(ADVISOR_ENTRY, { enabled: state === "on" });
}

type TitleInternals = {
	generateSessionTitle(
		firstMessage: string,
		registry: unknown,
		settings: unknown,
		sessionId?: string,
		currentModel?: unknown,
	): Promise<string | null>;
	settings: unknown;
};

type ServerConfig = { port: number; extensionToken: string };

async function readServer(): Promise<ServerConfig | null> {
	try {
		const home = process.env.OMP_MOBILE_HOME ?? join(homedir(), ".omp-mobile");
		const parsed: unknown = JSON.parse(await Bun.file(join(home, "server.json")).text());
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!("port" in parsed) ||
			typeof parsed.port !== "number" ||
			!("extensionToken" in parsed) ||
			typeof parsed.extensionToken !== "string"
		)
			return null;
		return { port: parsed.port, extensionToken: parsed.extensionToken };
	} catch {
		return null;
	}
}

let titleInternals: Promise<TitleInternals | null> | undefined;

/**
 * OMP's own title generator and settings, so the user's title model role applies. Dynamic with literal specifiers
 * (OMP's extension loader maps those into its compiled binary) because they only exist inside the omp runtime and are
 * not public API: drift leaves phone sessions untitled instead of breaking the observer.
 */
function loadTitleInternals(): Promise<TitleInternals | null> {
	titleInternals ??= (async () => {
		try {
			// @ts-expect-error OMP-internal module, resolvable only inside the omp runtime.
			const { generateSessionTitle } = await import("@oh-my-pi/pi-coding-agent/utils/title-generator");
			// @ts-expect-error OMP-internal module, resolvable only inside the omp runtime.
			const { settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
			return typeof generateSessionTitle === "function" && settings ? { generateSessionTitle, settings } : null;
		} catch {
			return null;
		}
	})();
	return titleInternals;
}

function firstUserText(sessionManager: SessionManager): string | undefined {
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.flatMap((part) => (part && typeof part === "object" && part.type === "text" ? [String(part.text)] : []))
				.join("\n");
		return undefined;
	}
	return undefined;
}

const titling = new Set<string>();

/**
 * OMP disables its own auto-titler in rpc modes (`PI_NO_TITLE`), so phone sessions would keep the prompt as their
 * name. Titles from the session's first user message (resumed untitled sessions), falling back to the current prompt;
 * low-signal input ("hi") yields no title, so the session stays unnamed and the next prompt retries.
 */
async function autoTitle(prompt: string, context: ExtensionContext): Promise<void> {
	const sessionManager = context.sessionManager;
	const sessionId = sessionManager.getSessionId();
	if (sessionManager.getSessionName() || titling.has(sessionId) || !sessionManager.setSessionName) return;
	titling.add(sessionId);
	try {
		const internals = await loadTitleInternals();
		if (!internals) return;
		let title: string | null = null;
		for (const input of new Set([firstUserText(sessionManager), prompt])) {
			if (!input?.trim()) continue;
			title = await internals.generateSessionTitle(
				input,
				context.modelRegistry,
				internals.settings,
				sessionId,
				context.model,
			);
			if (title) break;
		}
		if (!title || sessionManager.getSessionId() !== sessionId || sessionManager.getSessionName()) return;
		// Source "auto", unlike the extension API's `setSessionName` ("user"), keeps a later user rename authoritative and
		// is ignored if the user renamed the session while the title was generating.
		if (!(await sessionManager.setSessionName(title, "auto"))) return;
		const name = sessionManager.getSessionName();
		if (name) await post({ type: "session_title", title: name }, context);
	} catch {
		/* Titling is best effort; the next prompt retries while the session stays unnamed. */
	} finally {
		titling.delete(sessionId);
	}
}

async function send(body: Record<string, unknown>): Promise<void> {
	const server = await readServer();
	if (!server) return;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 750);
	try {
		await fetch(`http://127.0.0.1:${server.port}/internal/extension`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-mobile-token": server.extensionToken },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch {
		/* The observer must never affect the agent session. */
	} finally {
		clearTimeout(timeout);
	}
}

function post(event: Event, context: ExtensionContext): Promise<void> {
	const { type, ...fields } = event;
	return send({
		...fields,
		event: type,
		sessionId: event.sessionId ?? context.sessionManager.getSessionId(),
		sessionFile: context.sessionManager.getSessionFile(),
		cwd: context.cwd,
		pid: process.pid,
		mode: context.mode,
	});
}

/** How often a terminal session checks whether a new server started. */
const SERVER_WATCH_MS = 5_000;
let serverWatch: ReturnType<typeof setInterval> | undefined;

/**
 * The server learns that a terminal runs a session only from its `session_start`, and forgets it when it restarts.
 * A terminal session announces itself again to each new server (a new `extensionToken` in `server.json`), so the
 * server routes the phone to it instead of resuming the session in a second OMP process, which would make OMP move
 * the session to a new file.
 */
function followServer(context: ExtensionContext): void {
	clearInterval(serverWatch);
	let token: string | undefined;
	const known = readServer().then((server) => {
		token = server?.extensionToken;
	});
	const watch = setInterval(async () => {
		await known;
		const current = (await readServer())?.extensionToken;
		if (watch !== serverWatch || current === token) return;
		token = current;
		if (current) await post({ type: "session_start" }, context);
	}, SERVER_WATCH_MS);
	watch.unref();
	serverWatch = watch;
}

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function scheduleJob(
	params: Record<string, string>,
	context: ExtensionContext,
	agent: string | undefined,
): Promise<ToolResult> {
	const server = await readServer();
	if (!server) throw new Error("The OMP Mobile server is not running on this computer, so jobs cannot be scheduled.");
	const response = await fetch(`http://127.0.0.1:${server.port}/internal/jobs`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-mobile-token": server.extensionToken },
		body: JSON.stringify({
			name: params.name,
			description: params.description,
			schedule: params.schedule,
			sessionId: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			agent,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const body = (await response.json().catch(() => ({}))) as { message?: string; nextRunAt?: string };
	if (!response.ok) throw new Error(`Could not schedule the job: ${body.message ?? `HTTP ${response.status}`}`);
	const next = body.nextRunAt ? new Date(body.nextRunAt).toLocaleString("en-US", { timeZone: TIME_ZONE }) : "unknown";
	return {
		content: [
			{
				type: "text",
				text: `Scheduled "${params.name}" (${params.schedule}). Next run: ${next} (${TIME_ZONE}). The user can pause, resume, or delete it in the OMP app's Jobs panel.`,
			},
		],
		details: body,
	};
}

type AgentSignal = {
	id: string;
	sessionFile: string;
	status: "running" | "completed" | "failed" | "aborted";
	description?: string;
	activity?: string;
};

const AGENT_STATUS: Record<string, AgentSignal["status"]> = {
	started: "running",
	pending: "running",
	running: "running",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

function text(record: object, key: string): string | undefined {
	const value: unknown = key in record ? Reflect.get(record, key) : undefined;
	return typeof value === "string" && value ? value.slice(0, 500) : undefined;
}

/** Reads a `task:subagent:lifecycle` payload, or the `progress` of a `task:subagent:progress` payload. */
function agentSignal(state: unknown, sessionFile: unknown): AgentSignal | undefined {
	if (!state || typeof state !== "object" || typeof sessionFile !== "string") return undefined;
	const id = text(state, "id");
	const status = AGENT_STATUS[text(state, "status") ?? ""];
	if (!id || !status) return undefined;
	const description = text(state, "description");
	const activity = text(state, "lastIntent") ?? text(state, "currentTool");
	return { id, sessionFile, status, ...(description ? { description } : {}), ...(activity ? { activity } : {}) };
}

/** Latest unsent state per agent. OMP reports progress every ~150 ms per agent; the phone needs about one a second. */
const agentQueue = new Map<string, AgentSignal>();
let agentFlush: ReturnType<typeof setTimeout> | undefined;
/** Posts go out one at a time so the server sees each agent's states in order. */
let agentPosts = Promise.resolve();

function reportAgent(signal: AgentSignal | undefined, urgent: boolean): void {
	if (!signal) return;
	const queued = agentQueue.get(signal.id);
	agentQueue.set(signal.id, {
		...signal,
		description: signal.description ?? queued?.description,
	});
	if (urgent) clearTimeout(agentFlush);
	else if (agentFlush) return;
	agentFlush = setTimeout(
		() => {
			agentFlush = undefined;
			const agents = [...agentQueue.values()];
			agentQueue.clear();
			agentPosts = agentPosts.then(() => send({ event: "subagent", pid: process.pid, agents }));
		},
		urgent ? 0 : 1000,
	);
}

export default function ompMobileExtension(api: ExtensionApi): void {
	const forward = (fields: string[]) => (event: Event, context: ExtensionContext) => {
		const payload: Event = { type: event.type };
		for (const field of fields) if (field in event) payload[field] = event[field];
		context.setTimeout(() => post(payload, context), 0);
	};
	// Each session gets its own bus; OMP publishes every task agent's events, nested ones included, on its root's.
	api.events?.on("task:subagent:lifecycle", (payload) => {
		if (payload && typeof payload === "object")
			reportAgent(agentSignal(payload, Reflect.get(payload, "sessionFile")), true);
	});
	api.events?.on("task:subagent:progress", (payload) => {
		if (payload && typeof payload === "object")
			reportAgent(agentSignal(Reflect.get(payload, "progress"), Reflect.get(payload, "sessionFile")), false);
	});
	// The agent the current session runs as, and the tools it replaced (restored if the process moves to a session
	// without an agent).
	let agent: AgentSnapshot | undefined;
	let defaultTools: string[] | undefined;
	const applyAgent = async (context: ExtensionContext) => {
		const found = sessionAgent(api, context.sessionManager);
		agent = found?.agent;
		if (agent?.tools) {
			defaultTools ??= api.getActiveTools();
			await api.setActiveTools([...new Set([...agent.tools, ...OWN_TOOLS])]);
		} else if (defaultTools) {
			await api.setActiveTools(defaultTools);
			defaultTools = undefined;
		}
		// Skill messages become part of the session, so a resumed session already has them.
		if (found?.isNew && agent?.autoloadSkills?.length) await autoloadSkills(api, agent.autoloadSkills);
	};
	api.on("session_start", async (event, context) => {
		forward([])(event, context);
		if (context.mode === "tui") followServer(context);
		await applyAgent(context);
	});
	api.on("session_switch", (_event, context) => applyAgent(context));
	api.on("before_agent_start", (event) => {
		if (agent?.prompt && Array.isArray(event.systemPrompt))
			return { systemPrompt: [...event.systemPrompt, agent.prompt] };
		return undefined;
	});
	api.on("session_shutdown", (event, context) => {
		clearInterval(serverWatch);
		serverWatch = undefined;
		return post({ type: event.type }, context);
	});
	api.on("agent_start", forward([]));
	api.on("agent_end", forward(["willContinue"]));
	api.on("tool_execution_start", forward(["toolCallId", "toolName", "args"]));
	api.on("tool_approval_requested", forward(["sessionId", "toolCallId", "toolName", "reason", "approvalMode"]));
	api.on("tool_approval_resolved", forward(["sessionId", "toolCallId", "toolName", "approved"]));
	api.registerCommand(MODEL_ROLE_COMMAND, {
		description: "Switch to the smol, default, or slow model role (used by OMP Mobile)",
		handler: (args, context) => switchModelRole(api, args, context),
	});
	api.registerCommand(ADVISOR_COMMAND, {
		description: "Record that OMP Mobile turned the advisor on or off (used by OMP Mobile)",
		handler: (args) => recordAdvisor(api, args),
	});
	const z = api.zod;
	api.registerTool({
		name: "schedule_job",
		label: "Schedule job",
		description: [
			"Schedule a recurring job through OMP Mobile. Each time the schedule fires, the computer sends `description` to this session as a new user message (or to a new session in this folder if this one was deleted).",
			"Use it only when the user asks for something to run on a schedule or repeatedly.",
			`\`schedule\` is a 5-field cron expression (minute hour day-of-month month day-of-week) in this computer's time zone, ${TIME_ZONE}; nicknames such as @hourly and @daily also work. Example: "0 9 * * MON-FRI" is 9:00 every weekday.`,
		].join(" "),
		parameters: z.object({
			name: z.string().describe("Short label, at most 80 characters, that the user sees in the Jobs panel"),
			description: z
				.string()
				.describe(
					"Self-contained instruction you will receive on every run, written so it makes sense without this conversation",
				),
			schedule: z.string().describe("5-field cron expression or nickname, in the computer's local time"),
		}),
		execute: (_toolCallId, params, _signal, _onUpdate, context) => scheduleJob(params, context, agent?.name),
	});
	// rpc modes always set PI_NO_TITLE, so only an explicit `--no-title` (e.g. in the server's rpcArgs) opts out here.
	if (process.argv.includes("--no-title")) return;
	api.on("before_agent_start", (event, context) => {
		if (context.mode === "rpc" && typeof event.prompt === "string") void autoTitle(event.prompt, context);
	});
}
