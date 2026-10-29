import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AGENT_NAME_PATTERN,
	THINKING_LEVELS,
	type AgentDefinition,
	type AgentInput,
	type ThinkingLevel,
} from "@omp-mobile/protocol";

/** Thrown when a session is to start as an agent this computer has no file for. */
export class UnknownAgentError extends Error {}

/** Environment variable carrying a new session's `AgentSnapshot` JSON to `extension/omp-mobile.ts`; keep in sync. */
export const AGENT_ENV = "OMP_MOBILE_AGENT";

/** What a session needs from its agent; the extension records it in the session (`extension/omp-mobile.ts`). */
export interface AgentSnapshot {
	name: string;
	tools?: string[];
	prompt: string;
	autoloadSkills?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export function agentSnapshot(agent: AgentDefinition): AgentSnapshot {
	return {
		name: agent.name,
		...(agent.tools ? { tools: agent.tools } : {}),
		prompt: agent.prompt,
		...(agent.autoloadSkills ? { autoloadSkills: agent.autoloadSkills } : {}),
		...(agent.model ? { model: agent.model } : {}),
		...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
	};
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
/** Spellings OMP accepts for the thinking level; it writes `thinking-level`. */
const THINKING_KEYS = ["thinking-level", "thinkingLevel", "thinking"];

type Frontmatter = Record<string, unknown>;

/** OMP reads list fields as YAML lists or comma-separated strings. */
function list(value: unknown): string[] | undefined {
	const items = Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: typeof value === "string"
			? value.split(",")
			: undefined;
	const trimmed = items?.map((item) => item.trim()).filter(Boolean);
	return trimmed?.length ? trimmed : undefined;
}

function thinkingLevel(frontmatter: Frontmatter): ThinkingLevel | undefined {
	for (const key of THINKING_KEYS) {
		const value = frontmatter[key];
		if (typeof value === "string") {
			const level = value.trim();
			return (THINKING_LEVELS as readonly string[]).includes(level) ? (level as ThinkingLevel) : undefined;
		}
	}
	return undefined;
}

function parse(text: string): { frontmatter: Frontmatter; body: string } | null {
	const match = FRONTMATTER.exec(text);
	if (!match) return null;
	let frontmatter: unknown;
	try {
		frontmatter = Bun.YAML.parse(match[1]!);
	} catch {
		return null;
	}
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return null;
	return { frontmatter: frontmatter as Frontmatter, body: text.slice(match[0].length) };
}

/** Null for files OMP itself skips: no frontmatter or no description. */
function definition(name: string, text: string): AgentDefinition | null {
	const parsed = parse(text);
	if (!parsed) return null;
	const { frontmatter, body } = parsed;
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return null;
	const tools = list(frontmatter.tools);
	const model = list(frontmatter.model)?.join(", ");
	const level = thinkingLevel(frontmatter);
	const autoloadSkills = list(frontmatter.autoloadSkills);
	return {
		name,
		description: frontmatter.description.trim(),
		...(tools ? { tools } : {}),
		...(model ? { model } : {}),
		...(level ? { thinkingLevel: level } : {}),
		...(autoloadSkills ? { autoloadSkills } : {}),
		prompt: body.trim(),
		structured: frontmatter.output !== undefined,
	};
}

/**
 * Applies the editable fields to the file's frontmatter. Keys this server does not model (`spawns`, `output`, …) and
 * modeled values the input leaves unchanged keep their spelling and position.
 */
function merge(name: string, frontmatter: Frontmatter, input: AgentInput): Frontmatter {
	// A new file starts with `name`; an existing one keeps its key order.
	const next: Frontmatter = { name, ...frontmatter };
	next.name = name;
	next.description = input.description;
	// List items never contain commas (OMP splits on them), so comma-joined strings compare the lists.
	if (String(list(next.tools) ?? []) !== String(input.tools ?? [])) {
		if (input.tools?.length) next.tools = input.tools.join(", ");
		else delete next.tools;
	}
	if (list(next.model)?.join(", ") !== input.model) {
		if (input.model) next.model = input.model;
		else delete next.model;
	}
	if (thinkingLevel(next) !== input.thinkingLevel) {
		for (const key of THINKING_KEYS) delete next[key];
		if (input.thinkingLevel) next["thinking-level"] = input.thinkingLevel;
	}
	if (String(list(next.autoloadSkills) ?? []) !== String(input.autoloadSkills ?? [])) {
		if (input.autoloadSkills?.length) next.autoloadSkills = input.autoloadSkills;
		else delete next.autoloadSkills;
	}
	return next;
}

function render(frontmatter: Frontmatter, prompt: string): string {
	// Bun leaves a space after a key whose value starts on the next line.
	const yaml = Bun.YAML.stringify(frontmatter, null, 2).replace(/:[ \t]+$/gm, ":");
	const body = prompt.trim();
	return `---\n${yaml.trimEnd()}\n---\n${body ? `\n${body}\n` : ""}`;
}

function isMissing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * OMP's user agent files (`~/.omp/agent/agents/<name>.md`): YAML frontmatter plus the prompt. The same files define
 * the computer's `task` subagents, so writes keep OMP's own spellings (`thinking-level`, comma-separated `tools`).
 */
export class AgentStore {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	#file(name: string) {
		if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`Invalid agent name "${name}"`);
		return join(this.#dir, `${name}.md`);
	}

	async #read(name: string): Promise<string | null> {
		try {
			return await readFile(this.#file(name), "utf8");
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	/** Sorted by name; files whose stem is not a valid agent name or that OMP would skip are left out. */
	async list(): Promise<AgentDefinition[]> {
		let names: string[];
		try {
			names = await readdir(this.#dir);
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		const stems = names
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -".md".length))
			.filter((stem) => AGENT_NAME_PATTERN.test(stem))
			.sort();
		const agents = await Promise.all(stems.map((stem) => this.get(stem)));
		return agents.filter((agent): agent is AgentDefinition => agent !== null);
	}

	async get(name: string): Promise<AgentDefinition | null> {
		if (!AGENT_NAME_PATTERN.test(name)) return null;
		const text = await this.#read(name);
		return text === null ? null : definition(name, text);
	}

	async put(name: string, input: AgentInput): Promise<{ agent: AgentDefinition; created: boolean }> {
		const file = this.#file(name);
		const existing = await this.#read(name);
		const parsed = existing === null ? null : parse(existing);
		const text = render(merge(name, parsed?.frontmatter ?? {}, input), input.prompt);
		await mkdir(this.#dir, { recursive: true });
		const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, text);
		try {
			await rename(temporary, file);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
		return { agent: definition(name, text)!, created: existing === null };
	}

	/** False when there was no such agent. */
	async remove(name: string): Promise<boolean> {
		try {
			await rm(this.#file(name));
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}
}
