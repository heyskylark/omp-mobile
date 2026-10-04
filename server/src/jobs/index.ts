import { randomUUID } from "node:crypto";
import type { Job } from "@omp-mobile/protocol";
import { Cron } from "croner";
import type { History } from "../history/api.ts";
import type { LiveHub } from "../live/api.ts";
import type { JobStore, NewJob, StoredJob } from "./store.ts";

export { createJobStore, type JobStore, type NewJob } from "./store.ts";

export class InvalidScheduleError extends Error {}

/**
 * Next fire time after `from`, in the computer's local time zone. Croner instead of `Bun.cron`, which reads schedules
 * as UTC through at least Bun 1.3.14. Croner also takes seconds and years fields; a 5-field limit keeps a job from
 * prompting the model every second.
 */
function nextRun(schedule: string, from: number): Date {
	if (!schedule.startsWith("@") && schedule.split(/\s+/).length !== 5)
		throw new InvalidScheduleError(
			`"${schedule}" is not a 5-field cron expression (minute hour day month weekday) or a nickname such as @daily`,
		);
	let next: Date | null;
	try {
		next = new Cron(schedule, { paused: true }).nextRun(new Date(from));
	} catch (error) {
		throw new InvalidScheduleError(error instanceof Error ? error.message : String(error));
	}
	if (!next) throw new InvalidScheduleError(`"${schedule}" never fires`);
	return next;
}

export interface JobService {
	/** Newest first; pausing or running a job never moves it. */
	list(): Job[];
	/** Throws `InvalidScheduleError` for an unparsable schedule and `ProjectPathError` for a folder outside the roots. */
	create(job: NewJob): Promise<Job>;
	setStatus(id: string, status: "ACTIVE" | "PAUSED"): Job | null;
	remove(id: string): boolean;
	run(id: string): Promise<void>;
	onChange(listener: () => void): () => void;
	stop(): void;
}

export interface JobServiceOptions {
	store: JobStore;
	hub: Pick<LiveHub, "overlay" | "prompt" | "createSession">;
	history: Pick<History, "getSession" | "resolveProjectDir">;
	now?: () => number;
}

class Scheduler implements JobService {
	#opts: JobServiceOptions;
	#now: () => number;
	#crons = new Map<string, Cron>();
	#running = new Set<string>();
	#listeners = new Set<() => void>();

	constructor(opts: JobServiceOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		for (const job of opts.store.list()) this.#arm(job);
	}

	list(): Job[] {
		return this.#opts.store.list().map((job) => this.#view(job));
	}
	async create(job: NewJob): Promise<Job> {
		nextRun(job.schedule, this.#now());
		const cwd = await this.#opts.history.resolveProjectDir(job.cwd);
		const stored = this.#opts.store.create({
			name: job.name,
			description: job.description,
			sessionId: job.sessionId,
			cwd,
			schedule: job.schedule,
		});
		this.#arm(stored);
		this.#changed();
		return this.#view(stored);
	}
	setStatus(id: string, status: "ACTIVE" | "PAUSED"): Job | null {
		const job = this.#opts.store.setStatus(id, status);
		if (!job) return null;
		this.#arm(job);
		this.#changed();
		return this.#view(job);
	}
	remove(id: string): boolean {
		this.#disarm(id);
		const removed = this.#opts.store.remove(id);
		if (removed) this.#changed();
		return removed;
	}
	async run(id: string): Promise<void> {
		const job = this.#opts.store.get(id);
		if (!job || job.status === "PAUSED" || this.#running.has(id)) return;
		this.#running.add(id);
		try {
			const sessionId = await this.#deliver(job);
			this.#opts.store.recordRun(id, { sessionId });
		} catch (error) {
			this.#opts.store.recordRun(id, { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.#running.delete(id);
			this.#changed();
		}
	}
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	stop(): void {
		for (const cron of this.#crons.values()) cron.stop();
		this.#crons.clear();
	}

	async #deliver(job: StoredJob): Promise<string> {
		const { hub, history } = this.#opts;
		const operationId = randomUUID();
		const live = hub.overlay(job.sessionId).liveness.kind !== "idle";
		if (live || (await history.getSession(job.sessionId))) {
			await hub.prompt(job.sessionId, { operationId, text: job.description });
			return job.sessionId;
		}
		return (await hub.createSession({ operationId, cwd: job.cwd, prompt: job.description })).sessionId;
	}
	#arm(job: StoredJob): void {
		this.#disarm(job.id);
		if (job.status === "PAUSED") return;
		const id = job.id;
		this.#crons.set(
			id,
			new Cron(job.schedule, () => this.run(id).catch((error) => console.error("Could not record a job run", error))),
		);
	}
	#disarm(id: string): void {
		this.#crons.get(id)?.stop();
		this.#crons.delete(id);
	}
	#view(job: StoredJob): Job {
		const { cwd: _cwd, ...fields } = job;
		return job.status === "PAUSED"
			? fields
			: { ...fields, nextRunAt: nextRun(job.schedule, this.#now()).toISOString() };
	}
	#changed(): void {
		for (const listener of this.#listeners) listener();
	}
}

export function createJobService(opts: JobServiceOptions): JobService {
	return new Scheduler(opts);
}
