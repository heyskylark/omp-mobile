import { homedir } from "node:os";
import { join } from "node:path";

type SessionManager = { getSessionId(): string; getSessionFile(): string | undefined };
type Model = { provider: string; id: string };
type ExtensionContext = {
	sessionManager: SessionManager;
	cwd: string;
	mode: string;
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
}
