import type { AgentStatus, AgentSummary, TimelineItem } from "@omp-mobile/protocol";

const STATUS_LABEL: Record<AgentStatus, string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	aborted: "Stopped",
	interrupted: "Interrupted",
};

/** Nested ids are dotted ("Alpha.Gamma"); the last segment is the agent's own name. */
export function agentName(id: string): string {
	return id.slice(id.lastIndexOf(".") + 1);
}

export function statusLabel(status: AgentStatus): string {
	return STATUS_LABEL[status];
}

function isDescendant(agent: AgentSummary, under: string, byId: ReadonlyMap<string, AgentSummary>): boolean {
	const seen = new Set<string>();
	let parentId = agent.parentId;
	while (parentId !== undefined && !seen.has(parentId)) {
		if (parentId === under) return true;
		seen.add(parentId);
		parentId = byId.get(parentId)?.parentId;
	}
	return false;
}

export function runningCount(agents: readonly AgentSummary[], under?: string): number {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	return agents.filter(
		(agent) => agent.status === "running" && (under === undefined || isDescendant(agent, under, byId)),
	).length;
}

export function agentRows(
	agents: readonly AgentSummary[],
	under?: string,
): Array<{ agent: AgentSummary; depth: number }> {
	const children = new Map<string | undefined, AgentSummary[]>();
	for (const agent of agents) {
		const siblings = children.get(agent.parentId);
		if (siblings) siblings.push(agent);
		else children.set(agent.parentId, [agent]);
	}
	for (const siblings of children.values())
		siblings.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
	const rows: Array<{ agent: AgentSummary; depth: number }> = [];
	const visited = new Set<string>();
	const visit = (parentId: string | undefined, depth: number) => {
		for (const agent of children.get(parentId) ?? []) {
			if (visited.has(agent.id)) continue;
			visited.add(agent.id);
			rows.push({ agent, depth });
			visit(agent.id, depth + 1);
		}
	};
	visit(under, 0);
	return rows;
}

export function toolIsWorking(
	item: Extract<TimelineItem, { kind: "tool" }>,
	agentsById: ReadonlyMap<string, AgentSummary>,
): boolean {
	return item.state === "running" || (item.agentIds ?? []).some((id) => agentsById.get(id)?.status === "running");
}
