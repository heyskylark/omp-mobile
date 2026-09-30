import type { SkillCommand } from "@omp-mobile/protocol";
import { useEffect, useState } from "react";
import type { PairedMachine } from "../native/types";
import { OmpApi } from "./api";
import { acquireMachineSocket } from "./live";

const COMMAND = "/skill:";
const SEPARATORS = new Set(["-", "_", ".", ":", "/", " "]);

/** The `/skill:` token the caret is in: `text.slice(start, end)` is replaced when a skill is picked. */
export interface SkillToken {
	start: number;
	end: number;
	query: string;
}

/**
 * The whitespace-delimited token around `caret` when it starts a `/skill:` command. `/`, `/sk`, and `/skill:` all list
 * every skill; what follows `/skill:` is the query. OMP accepts the command at the start of a prompt or after
 * whitespace, which is where tokens start.
 */
export function skillToken(text: string, caret: number): SkillToken | null {
	let start = caret;
	while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
	let end = caret;
	while (end < text.length && !/\s/.test(text[end]!)) end++;
	const typed = text.slice(start, caret);
	if (!typed.startsWith("/")) return null;
	if (COMMAND.startsWith(typed)) return { start, end, query: "" };
	if (!typed.startsWith(COMMAND)) return null;
	return { start, end, query: typed.slice(COMMAND.length) };
}

/**
 * Subsequence score of `query` in `name`, or null when some character is missing. Consecutive characters, characters
 * right after a separator, and an early first match score higher, so `vom` ranks `verify-omp-mobile` above names that
 * merely contain those letters.
 */
function nameScore(name: string, query: string): number | null {
	let score = 0;
	let previous = -1;
	for (const char of query) {
		const index = name.indexOf(char, previous + 1);
		if (index < 0) return null;
		if (index === previous + 1) score += 3;
		if (index === 0 || SEPARATORS.has(name[index - 1]!)) score += 2;
		score -= Math.min(index - previous - 1, 4) / 4;
		previous = index;
	}
	return score;
}

/** Skills matching `query`, best first: name prefix, then name subsequence, then description text. */
export function rankSkills(skills: readonly SkillCommand[], query: string): SkillCommand[] {
	const needle = query.toLowerCase();
	if (!needle) return [...skills];
	const ranked: { skill: SkillCommand; tier: number; score: number }[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		if (name.startsWith(needle)) {
			ranked.push({ skill, tier: 2, score: -name.length });
			continue;
		}
		const score = nameScore(name, needle);
		if (score !== null) ranked.push({ skill, tier: 1, score });
		else if (needle.length >= 3 && skill.description?.toLowerCase().includes(needle))
			ranked.push({ skill, tier: 0, score: 0 });
	}
	return ranked
		.sort((a, b) => b.tier - a.tier || b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.map((entry) => entry.skill);
}

/** `text` with `token` replaced by the complete command and a trailing space; `caret` sits after that space. */
export function completeSkill(text: string, token: SkillToken, name: string): { text: string; caret: number } {
	const command = `${COMMAND}${name} `;
	const rest = text.slice(token.end).replace(/^ /, "");
	return { text: `${text.slice(0, token.start)}${command}${rest}`, caret: token.start + command.length };
}

const cache = new Map<string, SkillCommand[]>();

/**
 * Skills OMP offers in `cwd` on this computer; the last list shows immediately while a fresh one loads. The list
 * reloads after every reconnect, so a request that failed while the computer was asleep or restarting its server
 * does not leave the menu empty until the screen is reopened.
 */
export function useSkills(machine: PairedMachine | undefined, cwd: string | undefined): SkillCommand[] {
	const key = machine && cwd ? `${machine.machineId}\n${cwd}` : "";
	const [skills, setSkills] = useState<SkillCommand[]>(() => cache.get(key) ?? []);
	useEffect(() => {
		setSkills(cache.get(key) ?? []);
		if (!machine || !cwd) return;
		let active = true;
		const api = new OmpApi(machine);
		const load = () =>
			api
				.skills(cwd)
				.then((loaded) => {
					cache.set(key, loaded);
					if (active) setSkills(loaded);
				})
				// Completion is optional: an unreachable computer or older server leaves the last list in place.
				.catch(() => undefined);
		void load();
		const { socket, release } = acquireMachineSocket(machine);
		const offResync = socket.onResync(() => void load());
		return () => {
			active = false;
			offResync();
			release();
		};
	}, [machine, key, cwd]);
	return skills;
}
