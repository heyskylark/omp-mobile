import type { AgentListResponse } from "@omp-mobile/protocol";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import type { PairedMachine } from "../native/types";
import { OmpApi } from "./api";

const cache = new Map<string, AgentListResponse>();

export interface AgentList {
	/** Last loaded list; shows immediately from the previous load while a fresh one is in flight. */
	list: AgentListResponse | undefined;
	/** Why the latest load failed, or null. */
	error: string | null;
	reload(): Promise<void>;
}

/**
 * The agent files on `machine` (`~/.omp/agent/agents`) and the tool names its OMP offers. Reloads whenever the screen
 * gains focus, so returning from the agent editor shows the computer's current files.
 */
export function useAgentList(machine: PairedMachine | undefined): AgentList {
	const key = machine?.machineId ?? "";
	const [list, setList] = useState<AgentListResponse | undefined>(() => cache.get(key));
	const [error, setError] = useState<string | null>(null);
	const reload = useCallback(async () => {
		if (!machine) return;
		try {
			const loaded = await new OmpApi(machine).agents();
			cache.set(machine.machineId, loaded);
			setList(loaded);
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not load agents.");
		}
	}, [machine]);
	useEffect(() => setList(cache.get(key)), [key]);
	useFocusEffect(
		useCallback(() => {
			void reload();
		}, [reload]),
	);
	return { list, error, reload };
}

/** Names typed as a comma- or newline-separated list, trimmed, without blanks or repeats. */
export function splitNames(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[,\n]/)
				.map((name) => name.trim())
				.filter(Boolean),
		),
	];
}
