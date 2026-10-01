import type { AgentStatus, AgentSummary, AgentThreadSnapshot, ServerMessage, TimelinePage } from "@omp-mobile/protocol";
import type { AgentFile, History } from "../history/index.ts";

/** One agent's state as OMP's extension reported it; validated at the HTTP boundary. */
export interface AgentSignal {
	id: string;
	sessionFile: string;
	status: "running" | "completed" | "failed" | "aborted";
	description?: string;
	activity?: string;
}

interface LiveAgent {
	status: AgentSignal["status"];
	description?: string;
	activity?: string;
	/** OMP process hosting the agent; a running agent whose process is gone is interrupted. */
	pid: number;
	firstSeen: string;
	at: string;
}

interface Watch {
	sends: Set<(message: ServerMessage) => void>;
	afterEntryId?: string;
	/** Reads run one at a time so the cursor never races. */
	queue: Promise<void>;
	timer?: ReturnType<typeof setInterval>;
	/** The agent ended and one more read has run, so later reads cannot find anything new. */
	drained: boolean;
}

const WATCH_MS = 1000;
const SWEEP_MS = 3000;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The only place an agent's status is decided. The file's end is authoritative once it records how the latest run
 * ended (waking an agent appends a user message, which clears it); otherwise the extension's report counts only
 * while the process it came from is alive.
 */
export function agentStatus(disk: AgentFile | undefined, live: LiveAgent | undefined, alive: boolean): AgentStatus {
	if (disk?.outcome) return disk.outcome;
	if (live && (live.status !== "running" || alive)) return live.status;
	return "interrupted";
}

export class AgentRoster {
	readonly #history: History;
	readonly #session: () => { id: string; file: string };
	readonly #publish: (agents: AgentSummary[]) => void;
	readonly #settled: () => void;
	#disk = new Map<string, AgentFile>();
	readonly #live = new Map<string, LiveAgent>();
	readonly #watches = new Map<string, Watch>();
	#published = "";
	#running = 0;
	#sweepTimer?: ReturnType<typeof setInterval>;

	constructor(deps: {
		history: History;
		session(): { id: string; file: string };
		publish(agents: AgentSummary[]): void;
		/** The last running agent stopped. */
		settled(): void;
	}) {
		this.#history = deps.history;
		this.#session = deps.session;
		this.#publish = deps.publish;
		this.#settled = deps.settled;
	}

	/** Agents currently running; while any run, their OMP process must stay up. */
	get running(): number {
		return this.#running;
	}

	async ingest(signals: AgentSignal[], pid: number): Promise<void> {
		const now = new Date().toISOString();
		for (const signal of signals) {
			const previous = this.#live.get(signal.id);
			const status = signal.status;
			const description = signal.description ?? previous?.description;
			const activity = status === "running" ? (signal.activity ?? previous?.activity) : undefined;
			const changed =
				status !== previous?.status || description !== previous.description || activity !== previous.activity;
			// Reports repeat about once a second; only a visible change is an update phones need.
			this.#live.set(signal.id, {
				status,
				description,
				activity,
				pid,
				firstSeen: previous?.firstSeen ?? now,
				at: changed ? now : previous.at,
			});
		}
		await this.#refresh();
	}

	async list(): Promise<AgentSummary[]> {
		await this.#refresh();
		return this.#summaries();
	}

	async thread(agentId: string, limit: number): Promise<AgentThreadSnapshot | null> {
		const agents = await this.list();
		if (!agents.some((agent) => agent.id === agentId)) return null;
		const disk = this.#disk.get(agentId);
		const page = disk ? await this.#history.readAgentTimeline(disk, { limit }) : { items: [] };
		return { agents, ...page };
	}

	async older(agentId: string, before: string | undefined, limit: number): Promise<TimelinePage | null> {
		await this.#refresh();
		const disk = this.#disk.get(agentId);
		return disk ? this.#history.readAgentTimeline(disk, { before, limit }) : null;
	}

	/** Sends the newest items of the agent's thread now, then what its transcript gains while the agent runs. */
	watch(agentId: string, send: (message: ServerMessage) => void): () => void {
		let watch = this.#watches.get(agentId);
		if (!watch) {
			watch = { sends: new Set(), queue: Promise.resolve(), drained: false };
			this.#watches.set(agentId, watch);
		}
		const joined = watch;
		joined.sends.add(send);
		this.#read(agentId, joined, async (agent) => {
			const tail = await this.#history.readAgentTail(agent, { limit: 40 });
			joined.afterEntryId ??= tail.lastEntryId;
			if (joined.sends.has(send))
				send({ type: "agent.timeline", sessionId: this.#session().id, agentId, items: tail.items });
		});
		this.#pace(agentId, joined);
		return () => {
			joined.sends.delete(send);
			if (joined.sends.size) return;
			clearInterval(joined.timer);
			this.#watches.delete(agentId);
		};
	}

	stop(): void {
		clearInterval(this.#sweepTimer);
		this.#sweepTimer = undefined;
		for (const watch of this.#watches.values()) clearInterval(watch.timer);
		this.#watches.clear();
	}

	#read(agentId: string, watch: Watch, step: (agent: AgentFile) => Promise<void>): void {
		watch.queue = watch.queue
			.then(async () => {
				if (!this.#disk.has(agentId)) await this.#refresh();
				const agent = this.#disk.get(agentId);
				if (agent && this.#watches.get(agentId) === watch) await step(agent);
			})
			.catch((error) => console.error(`Could not read the thread of agent ${agentId}`, error));
	}

	#step(agentId: string, watch: Watch): void {
		this.#read(agentId, watch, async (agent) => {
			const tail = await this.#history.readAgentTail(agent, { afterEntryId: watch.afterEntryId, limit: 500 });
			watch.afterEntryId = tail.lastEntryId ?? watch.afterEntryId;
			if (tail.items.length) {
				const message: ServerMessage = {
					type: "agent.timeline",
					sessionId: this.#session().id,
					agentId,
					items: tail.items,
				};
				for (const send of watch.sends) send(message);
			}
		});
	}

	/** Reads a watched thread every second while its agent runs, plus once after it stops. */
	#pace(agentId: string, watch: Watch): void {
		const running = this.#summaries().find((agent) => agent.id === agentId)?.status === "running";
		if (running) watch.drained = false;
		if ((running || !watch.drained) && !watch.timer)
			watch.timer = setInterval(() => {
				if (this.#summaries().find((agent) => agent.id === agentId)?.status !== "running") {
					if (watch.drained) {
						clearInterval(watch.timer);
						watch.timer = undefined;
						return;
					}
					watch.drained = true;
				}
				this.#step(agentId, watch);
			}, WATCH_MS);
	}

	async #refresh(): Promise<void> {
		const { file } = this.#session();
		if (file) this.#disk = new Map((await this.#history.listAgents(file)).map((agent) => [agent.agentId, agent]));
		this.#changed();
	}

	#summaries(): AgentSummary[] {
		const ids = new Set([...this.#disk.keys(), ...this.#live.keys()]);
		return [...ids]
			.map((id): AgentSummary => {
				const disk = this.#disk.get(id);
				const live = this.#live.get(id);
				const status = agentStatus(disk, live, live ? processAlive(live.pid) : false);
				const parentId = disk?.parentId ?? (id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : undefined);
				const updatedAt = [disk?.updatedAt, live?.at]
					.filter((at): at is string => at !== undefined)
					.sort()
					.at(-1)!;
				return {
					id,
					...(parentId ? { parentId } : {}),
					status,
					...(live?.description ? { description: live.description } : {}),
					...(status === "running" && live?.activity ? { activity: live.activity } : {}),
					startedAt: disk?.startedAt ?? live!.firstSeen,
					updatedAt,
				};
			})
			.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
	}

	#changed(): void {
		const agents = this.#summaries();
		const json = JSON.stringify(agents);
		if (json !== this.#published) {
			this.#published = json;
			this.#publish(agents);
		}
		const wasRunning = this.#running;
		this.#running = agents.filter((agent) => agent.status === "running").length;
		for (const [agentId, watch] of this.#watches) this.#pace(agentId, watch);
		if (this.#running && !this.#sweepTimer)
			// Heals a lost report: a finished transcript or a dead process ends a "running" agent without one.
			this.#sweepTimer = setInterval(() => void this.#refresh(), SWEEP_MS);
		else if (!this.#running && this.#sweepTimer) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = undefined;
		}
		if (wasRunning && !this.#running) this.#settled();
	}
}
