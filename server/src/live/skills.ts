import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillCommand } from "@omp-mobile/protocol";
import { RpcSupervisor } from "./rpc.ts";

const SKILL_PREFIX = "skill:";
const PROBE_TIMEOUT_MS = 20_000;
// Long enough to absorb a screen reopening, short enough that a new SKILL.md shows up without restarting anything.
const FRESH_MS = 30_000;
const PROBE_HOME = join(tmpdir(), "omp-mobile-skill-probe-no-server");

interface Entry {
	at: number;
	skills: Promise<SkillCommand[]>;
}

/**
 * Lists the `/skill:<name>` commands OMP offers in a project by asking a short-lived `omp --mode rpc` child, so the
 * list matches OMP's own discovery (user, project, and plugin skills, disabled skills, `enableSkillCommands`).
 */
export class SkillCatalog {
	readonly #ompPath: string;
	readonly #rpcArgs: string[];
	readonly #entries = new Map<string, Entry>();

	constructor(ompPath: string, rpcArgs: string[] = []) {
		this.#ompPath = ompPath;
		this.#rpcArgs = rpcArgs;
	}

	list(cwd: string): Promise<SkillCommand[]> {
		const now = Date.now();
		for (const [key, entry] of this.#entries) if (now - entry.at >= FRESH_MS) this.#entries.delete(key);
		const cached = this.#entries.get(cwd);
		if (cached) return cached.skills;
		const entry: Entry = { at: now, skills: this.#probe(cwd) };
		this.#entries.set(cwd, entry);
		entry.skills.catch(() => {
			if (this.#entries.get(cwd) === entry) this.#entries.delete(cwd);
		});
		return entry.skills;
	}

	async #probe(cwd: string): Promise<SkillCommand[]> {
		const rpc = new RpcSupervisor(
			[this.#ompPath, "--mode", "rpc", "--no-session", "--no-title", "--no-lsp", "--cwd", cwd, ...this.#rpcArgs],
			cwd,
			// A globally installed OMP Mobile extension finds the server through `OMP_MOBILE_HOME/server.json`; a home
			// without one keeps it from reporting this throwaway session to the phone.
			{ OMP_MOBILE_HOME: PROBE_HOME },
		);
		const exited = rpc.exited.then((code) => {
			throw new Error(`omp exited with code ${code} before listing skills`);
		});
		try {
			return await Promise.race([
				(async () => {
					await rpc.ready();
					const response = await rpc.command(
						{ id: "omp-mobile-skills", type: "get_available_commands" },
						PROBE_TIMEOUT_MS,
					);
					if (response.success !== true)
						throw new Error(`OMP could not list skills: ${String(response.error ?? "unknown error")}`);
					return parseSkills(response.data);
				})(),
				exited,
			]);
		} finally {
			await rpc.close().catch(() => undefined);
		}
	}
}

function parseSkills(data: unknown): SkillCommand[] {
	const commands =
		data && typeof data === "object" && "commands" in data && Array.isArray(data.commands) ? data.commands : [];
	const skills: SkillCommand[] = [];
	for (const command of commands as unknown[]) {
		if (!command || typeof command !== "object") continue;
		const { name, description, source } = command as Record<string, unknown>;
		if (source !== "skill" || typeof name !== "string" || !name.startsWith(SKILL_PREFIX)) continue;
		const summary = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
		skills.push({ name: name.slice(SKILL_PREFIX.length), ...(summary ? { description: summary } : {}) });
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
