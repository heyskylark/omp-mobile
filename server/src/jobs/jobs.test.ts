import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateSessionRequest, Liveness, PromptRequest } from "@omp-mobile/protocol";
import type { SessionMeta } from "../history/api.ts";
import { createJobService, createJobStore, type JobService, type JobStore } from "./index.ts";

const meta = (id: string): SessionMeta => ({
	id,
	file: `/tmp/${id}.jsonl`,
	cwd: "/tmp/project",
	title: "Session",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	status: "complete",
});

class World {
	files = new Set<string>(["s1"]);
	live = new Set<string>();
	prompts: { sessionId: string; text: string }[] = [];
	created: CreateSessionRequest[] = [];
	failure?: Error;
	gate?: Promise<void>;
	hub = {
		overlay: (sessionId: string) => ({
			liveness: (this.live.has(sessionId) ? { kind: "terminal", attached: true } : { kind: "idle" }) as Liveness,
			pendingCount: 0,
		}),
		prompt: async (sessionId: string, req: PromptRequest) => {
			await this.gate;
			if (this.failure) throw this.failure;
			this.prompts.push({ sessionId, text: req.text });
			return { state: "accepted" as const };
		},
		createSession: async (req: CreateSessionRequest) => {
			this.created.push(req);
			return { sessionId: `new-${this.created.length}` };
		},
	};
	history = {
		getSession: async (id: string) => (this.files.has(id) ? meta(id) : null),
		resolveProjectDir: async (path: string) => path,
	};
}

let directory: string;
let store: JobStore;
let service: JobService;
let world: World;

async function setup() {
	directory = await mkdtemp(join(tmpdir(), "omp-mobile-jobs-"));
	store = createJobStore(join(directory, "jobs.db"));
	world = new World();
	service = createJobService({ store, hub: world.hub, history: world.history });
	return service.create({
		name: "Digest",
		description: "Summarize new issues",
		schedule: "0 9 * * *",
		sessionId: "s1",
		cwd: "/tmp/project",
	});
}

afterEach(async () => {
	service.stop();
	store.close();
	await rm(directory, { recursive: true, force: true });
});

test("schedules read as the computer's local time, not UTC", async () => {
	const zone = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
	try {
		const next = new Date((await setup()).nextRunAt!);
		expect(next.getHours()).toBe(9);
		expect(next.getUTCHours()).not.toBe(9);
	} finally {
		process.env.TZ = zone;
	}
});

describe("scheduled jobs", () => {
	test("a run prompts the job's session with its description", async () => {
		const job = await setup();
		await service.run(job.id);
		expect(world.prompts).toEqual([{ sessionId: "s1", text: "Summarize new issues" }]);
		expect(world.created).toEqual([]);
		expect(service.list()[0]).toMatchObject({ status: "ACTIVE", sessionId: "s1", lastRunAt: expect.any(String) });
	});

	test("a live session without a transcript file yet is still prompted", async () => {
		const job = await setup();
		world.files.clear();
		world.live.add("s1");
		await service.run(job.id);
		expect(world.prompts.map((prompt) => prompt.sessionId)).toEqual(["s1"]);
	});

	test("a deleted session is replaced by a new one in the same folder, which later runs reuse", async () => {
		const job = await setup();
		world.files.clear();
		await service.run(job.id);
		expect(world.created).toMatchObject([{ cwd: "/tmp/project", prompt: "Summarize new issues" }]);
		expect(service.list()[0]?.sessionId).toBe("new-1");

		world.files.add("new-1");
		await service.run(job.id);
		expect(world.created).toHaveLength(1);
		expect(world.prompts.map((prompt) => prompt.sessionId)).toEqual(["new-1"]);
	});

	test("a failed run reports ERROR with the reason, keeps its schedule, and the next good run clears it", async () => {
		const job = await setup();
		world.failure = new Error("Session is controlled by another client");
		await service.run(job.id);
		const failed = service.list()[0]!;
		expect(failed).toMatchObject({ status: "ERROR", errorMessage: "Session is controlled by another client" });
		expect(failed.nextRunAt).toBeDefined();

		world.failure = undefined;
		await service.run(job.id);
		expect(service.list()[0]).toEqual(expect.objectContaining({ status: "ACTIVE" }));
		expect(service.list()[0]).not.toHaveProperty("errorMessage");
	});

	test("pausing clears an error, paused jobs never run, and a pause during a run sticks", async () => {
		const job = await setup();
		world.failure = new Error("boom");
		await service.run(job.id);
		expect(service.setStatus(job.id, "PAUSED")).toMatchObject({ status: "PAUSED" });
		expect(service.list()[0]).not.toHaveProperty("errorMessage");
		world.failure = undefined;
		await service.run(job.id);
		expect(world.prompts).toEqual([]);

		service.setStatus(job.id, "ACTIVE");
		const release = Promise.withResolvers<void>();
		world.gate = release.promise;
		const running = service.run(job.id);
		service.setStatus(job.id, "PAUSED");
		release.resolve();
		await running;
		expect(service.list()[0]).toMatchObject({ status: "PAUSED", lastRunAt: expect.any(String) });
	});

	test("a fire while the previous run is still delivering is skipped", async () => {
		const job = await setup();
		const release = Promise.withResolvers<void>();
		world.gate = release.promise;
		const first = service.run(job.id);
		await service.run(job.id);
		release.resolve();
		await first;
		expect(world.prompts).toHaveLength(1);
	});

	test("jobs survive a restart and the database is private to the user", async () => {
		const job = await setup();
		service.setStatus(job.id, "PAUSED");
		service.stop();
		store.close();
		store = createJobStore(join(directory, "jobs.db"));
		service = createJobService({ store, hub: world.hub, history: world.history });
		expect(service.list()).toEqual([expect.objectContaining({ id: job.id, name: "Digest", status: "PAUSED" })]);
		expect((await stat(join(directory, "jobs.db"))).mode & 0o777).toBe(0o600);
	});

	test("lists the newest job first and keeps that order through pause and resume", async () => {
		const first = await setup();
		const create = (name: string, schedule: string) =>
			service.create({ name, description: "Check CI", schedule, sessionId: "s1", cwd: "/tmp/project" });
		const second = await create("Yearly", "0 0 1 1 *");
		const third = await create("Minutely", "* * * * *");
		const order = [third.id, second.id, first.id];
		expect(service.list().map((job) => job.id)).toEqual(order);
		service.setStatus(third.id, "PAUSED");
		service.setStatus(first.id, "PAUSED");
		service.setStatus(first.id, "ACTIVE");
		expect(service.list().map((job) => job.id)).toEqual(order);
	});

	test("notifies listeners on every change", async () => {
		const job = await setup();
		let changes = 0;
		service.onChange(() => changes++);
		service.setStatus(job.id, "PAUSED");
		service.setStatus(job.id, "ACTIVE");
		await service.run(job.id);
		service.remove(job.id);
		expect(changes).toBe(4);
		expect(service.list()).toEqual([]);
	});
});
