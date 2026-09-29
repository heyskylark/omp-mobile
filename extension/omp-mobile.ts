import { homedir } from "node:os";
import { join } from "node:path";

type SessionManager = { getSessionId(): string; getSessionFile(): string | undefined };
type ExtensionContext = {
	sessionManager: SessionManager;
	cwd: string;
	mode: string;
	setTimeout(callback: () => unknown, ms: number): unknown;
};
type Event = Record<string, unknown> & { type: string };
type ExtensionApi = { on(name: string, handler: (event: Event, context: ExtensionContext) => unknown): void };

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
}
