import { homedir } from "node:os";
import { join } from "node:path";

type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };
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
type ExtensionApi = {
	on(name: string, handler: (event: Event, context: ExtensionContext) => unknown): void;
	registerCommand(
		name: string,
		options: { description?: string; handler(args: string, context: ExtensionContext): Promise<void> },
	): void;
	setModel(model: Model): Promise<boolean>;
	setThinkingLevel(level: string): void;
	appendEntry(customType: string, data?: unknown): void;
	pi: { settings: { getModelRole(role: string): string | undefined } };
};

/** The server sends `/omp-mobile-model <role>` to its rpc children; keep in sync with `server/src/live/actor.ts`. */
const MODEL_ROLE_COMMAND = "omp-mobile-model";
/** Session entry recording the role picked from the phone; keep in sync with `server/src/history/pager.ts`. */
const MODEL_ROLE_ENTRY = "omp-mobile-model-role";
const MODEL_ROLES: Record<string, true> = { smol: true, default: true, slow: true };
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

async function post(event: Event, context: ExtensionContext): Promise<void> {
	const server = await readServer();
	if (!server) return;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 750);
	try {
		const { type, ...fields } = event;
		await fetch(`http://127.0.0.1:${server.port}/internal/extension`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-mobile-token": server.extensionToken },
			body: JSON.stringify({
				...fields,
				event: type,
				sessionId: event.sessionId ?? context.sessionManager.getSessionId(),
				sessionFile: context.sessionManager.getSessionFile(),
				cwd: context.cwd,
				pid: process.pid,
				mode: context.mode,
			}),
			signal: controller.signal,
		});
	} catch {
		/* The observer must never affect the agent session. */
	} finally {
		clearTimeout(timeout);
	}
}

export default function ompMobileExtension(api: ExtensionApi): void {
	const forward = (fields: string[]) => (event: Event, context: ExtensionContext) => {
		const payload: Event = { type: event.type };
		for (const field of fields) if (field in event) payload[field] = event[field];
		context.setTimeout(() => post(payload, context), 0);
	};
	api.on("session_start", forward([]));
	api.on("session_shutdown", (event, context) => post({ type: event.type }, context));
	api.on("agent_start", forward([]));
	api.on("agent_end", forward(["willContinue"]));
	api.on("tool_execution_start", forward(["toolCallId", "toolName", "args"]));
	api.on("tool_approval_requested", forward(["sessionId", "toolCallId", "toolName", "reason", "approvalMode"]));
	api.on("tool_approval_resolved", forward(["sessionId", "toolCallId", "toolName", "approved"]));
	api.registerCommand(MODEL_ROLE_COMMAND, {
		description: "Switch to the smol, default, or slow model role (used by OMP Mobile)",
		handler: (args, context) => switchModelRole(api, args, context),
	});
	// rpc modes always set PI_NO_TITLE, so only an explicit `--no-title` (e.g. in the server's rpcArgs) opts out here.
	if (process.argv.includes("--no-title")) return;
	api.on("before_agent_start", (event, context) => {
		if (context.mode === "rpc" && typeof event.prompt === "string") void autoTitle(event.prompt, context);
	});
}
