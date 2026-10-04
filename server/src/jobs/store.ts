import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { JobStatus } from "@omp-mobile/protocol";

export type StoredJob = {
	id: string;
	name: string;
	description: string;
	sessionId: string;
	cwd: string;
	schedule: string;
	createdAt: string;
	lastRunAt?: string;
} & ({ status: "ACTIVE" | "PAUSED" } | { status: "ERROR"; errorMessage: string });

export type NewJob = Pick<StoredJob, "name" | "description" | "sessionId" | "cwd" | "schedule">;

export type RunOutcome = { sessionId: string } | { error: string };

export interface JobStore {
	list(): StoredJob[];
	get(id: string): StoredJob | null;
	create(job: NewJob): StoredJob;
	/** A user's pause or resume; clears a run error. */
	setStatus(id: string, status: "ACTIVE" | "PAUSED"): StoredJob | null;
	/** A job paused while its run was in flight stays paused. */
	recordRun(id: string, outcome: RunOutcome): StoredJob | null;
	remove(id: string): boolean;
	close(): void;
}

type Row = {
	id: string;
	name: string;
	description: string;
	status: JobStatus;
	error_message: string | null;
	session_id: string;
	cwd: string;
	schedule: string;
	created_at: string;
	last_run_at: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ERROR')),
	error_message TEXT,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	schedule TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_run_at TEXT,
	CHECK ((status = 'ERROR') = (error_message IS NOT NULL))
)`;

function fromRow(row: Row): StoredJob {
	const fields = {
		id: row.id,
		name: row.name,
		description: row.description,
		sessionId: row.session_id,
		cwd: row.cwd,
		schedule: row.schedule,
		createdAt: row.created_at,
		...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
	};
	return row.status === "ERROR"
		? { ...fields, status: "ERROR", errorMessage: row.error_message ?? "" }
		: { ...fields, status: row.status };
}

function afterRun(status: JobStatus, outcome: RunOutcome): { status: JobStatus; error: string | null } {
	if (status === "PAUSED") return { status, error: null };
	return "error" in outcome ? { status: "ERROR", error: outcome.error } : { status: "ACTIVE", error: null };
}

export function createJobStore(path: string, now: () => number = Date.now): JobStore {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new Database(path, { create: true, strict: true });
	chmodSync(path, 0o600);
	db.run("PRAGMA journal_mode = WAL");
	db.run(SCHEMA);
	const all = db.query<Row, []>("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC");
	const byId = db.query<Row, { id: string }>("SELECT * FROM jobs WHERE id = $id");
	const insert = db.query(
		`INSERT INTO jobs (id, name, description, status, session_id, cwd, schedule, created_at)
		 VALUES ($id, $name, $description, 'ACTIVE', $sessionId, $cwd, $schedule, $createdAt)`,
	);
	const updateStatus = db.query("UPDATE jobs SET status = $status, error_message = $error WHERE id = $id");
	const updateRun = db.query(
		`UPDATE jobs SET status = $status, error_message = $error, session_id = $sessionId, last_run_at = $at
		 WHERE id = $id`,
	);
	const remove = db.query("DELETE FROM jobs WHERE id = $id");
	const get = (id: string) => {
		const row = byId.get({ id });
		return row ? fromRow(row) : null;
	};
	return {
		list: () => all.all().map(fromRow),
		get,
		create(job) {
			const id = randomUUID();
			insert.run({ id, ...job, createdAt: new Date(now()).toISOString() });
			return get(id)!;
		},
		setStatus(id, status) {
			updateStatus.run({ id, status, error: null });
			return get(id);
		},
		recordRun(id, outcome) {
			const current = get(id);
			if (!current) return null;
			const next = afterRun(current.status, outcome);
			updateRun.run({
				id,
				...next,
				sessionId: "sessionId" in outcome ? outcome.sessionId : current.sessionId,
				at: new Date(now()).toISOString(),
			});
			return get(id);
		},
		remove: (id) => remove.run({ id }).changes > 0,
		close: () => db.close(),
	};
}
