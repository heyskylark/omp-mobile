import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { readSlices } from "./catalog";
import { parseHeader, parseLine } from "./jsonl";

/** Where a task agent's transcript sits in OMP's layout: `<root minus .jsonl>/[<Parent>/]<AgentId>.jsonl`. */
export interface AgentLocation {
	rootFile: string;
	agentId: string;
	parentId?: string;
}

export type AgentOutcome = "completed" | "failed" | "aborted";

export interface AgentFile extends AgentLocation {
	file: string;
	startedAt: string;
	updatedAt: string;
	/** How the agent's latest run ended; absent while it has not ended, or when it ended without a trace. */
	outcome?: AgentOutcome;
}

async function isFile(path: string) {
	return stat(path).then(
		(info) => info.isFile(),
		() => false,
	);
}

function stem(sessionFile: string) {
	return sessionFile.slice(0, -".jsonl".length);
}

function locationIn(rootFile: string, file: string): AgentLocation {
	const parts = relative(stem(rootFile), file).split(sep);
	return {
		rootFile,
		agentId: basename(file, ".jsonl"),
		...(parts.length > 1 ? { parentId: parts.at(-2)! } : {}),
	};
}

/**
 * OMP's own rule (its session manager): a session file belongs to a task agent when `<its directory>.jsonl` is a
 * session file; the root is the outermost such file.
 */
export async function locateAgent(file: string): Promise<AgentLocation | null> {
	if (!file.endsWith(".jsonl")) return null;
	let root = `${dirname(file)}.jsonl`;
	if (!(await isFile(root))) return null;
	for (let depth = 0; depth < 8; depth++) {
		const outer = `${dirname(root)}.jsonl`;
		if (!(await isFile(outer))) break;
		root = outer;
	}
	return locationIn(root, file);
}

/** True when OMP ends the agent's run on this `yield` result (its `shouldTerminate` in `tools/yield.ts`). */
function endsRun(message: Record<string, unknown>): boolean {
	if (message.isError === true) return false;
	const details = message.details;
	if (!details || typeof details !== "object") return true;
	const sections = "type" in details ? details.type : undefined;
	const status = "status" in details ? details.status : undefined;
	return !(
		status === "success" &&
		Array.isArray(sections) &&
		sections.length > 0 &&
		sections.every((section) => typeof section === "string")
	);
}

/**
 * The newest run's end, read backwards from the file's end. A later user message means the agent was woken again,
 * and a later background-job delivery makes OMP discard the yield before it and ask for a new one.
 */
export function agentOutcome(suffix: string): AgentOutcome | undefined {
	const lines = suffix.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const value = parseLine(lines[index] ?? "");
		if (value?.type === "custom_message" && value.customType === "async-result") return undefined;
		if (value?.type !== "message" || !value.message || typeof value.message !== "object") continue;
		const message = value.message as Record<string, unknown>;
		if (message.role === "user") return undefined;
		if (message.role === "toolResult" && message.toolName === "yield" && endsRun(message)) {
			const details = message.details;
			const status = details && typeof details === "object" && "status" in details ? details.status : undefined;
			return status === "success" ? "completed" : "failed";
		}
		if (message.role === "assistant" && message.stopReason === "aborted") return "aborted";
		if (message.role === "assistant" && message.stopReason === "error") return "failed";
	}
	return undefined;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	agent?: AgentFile;
}

export class AgentCatalog {
	readonly #cache = new Map<string, CacheEntry>();

	async list(rootFile: string): Promise<AgentFile[]> {
		let names: string[];
		try {
			names = await readdir(stem(rootFile), { recursive: true });
		} catch {
			return [];
		}
		// OMP writes advisor transcripts (`__advisor[.<slug>].jsonl`) beside agents' and never lists them as agents.
		const files = names
			.filter(
				(name) =>
					name.endsWith(".jsonl") &&
					!name.split(sep).some((part) => part.startsWith(".")) &&
					!basename(name).startsWith("__advisor"),
			)
			.map((name) => join(stem(rootFile), name));
		const agents = await Promise.all(files.map((file) => this.#scan(rootFile, file)));
		return agents
			.filter((agent): agent is AgentFile => agent !== undefined)
			.sort(
				(left, right) => left.startedAt.localeCompare(right.startedAt) || left.agentId.localeCompare(right.agentId),
			);
	}

	async #scan(rootFile: string, file: string): Promise<AgentFile | undefined> {
		let info;
		try {
			info = await stat(file);
		} catch {
			return undefined;
		}
		const cached = this.#cache.get(file);
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.agent;
		let agent: AgentFile | undefined;
		try {
			const slices = await readSlices(file, info.size);
			const header = parseHeader(slices.prefix)?.header;
			if (header) {
				const outcome = agentOutcome(slices.suffix);
				agent = {
					...locationIn(rootFile, file),
					file,
					startedAt: new Date(header.timestamp ?? (info.birthtimeMs || info.mtimeMs)).toISOString(),
					updatedAt: info.mtime.toISOString(),
					...(outcome ? { outcome } : {}),
				};
			}
		} catch {}
		this.#cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, agent });
		return agent;
	}
}
