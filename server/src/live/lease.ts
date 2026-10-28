import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHeader } from "../history/jsonl.ts";

/**
 * OMP (18.13 and later) keeps `run/session-owners/<session id>.lock` open and OS-locked while a process has that
 * session open for writing; a second process that resumes the session cannot take the lock and moves the session to a
 * new file. The path mirrors OMP's: `$PI_TEST_SESSION_OWNERS_DIR` when set, else under `$XDG_STATE_HOME/omp` when that
 * directory exists, else under `~/.omp` (`$PI_CONFIG_DIR` renames `.omp`).
 */
export function sessionLeasePath(sessionId: string): string {
	const xdgState = process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "omp") : undefined;
	const root = xdgState && existsSync(xdgState) ? xdgState : join(homedir(), process.env.PI_CONFIG_DIR || ".omp");
	const owners = process.env.PI_TEST_SESSION_OWNERS_DIR || join(root, "run", "session-owners");
	const name = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
		? sessionId
		: `h-${Bun.hash.wyhash(sessionId).toString(16).padStart(16, "0")}`;
	return join(owners, `${name}.lock`);
}

/** The id OMP leases a session file under: its header's, which a moved session's new file changes. */
async function headerId(file: string): Promise<string | undefined> {
	try {
		const handle = await open(file, "r");
		try {
			const prefix = Buffer.alloc(64 * 1024);
			const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
			return parseHeader(prefix.toString("utf8", 0, bytesRead))?.header.id;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

const LSOF = Bun.which("lsof") ?? "/usr/sbin/lsof";

/**
 * Pid of a process other than this server and `ignore` that holds the OMP lease of the session stored in `file`, so
 * the session is open for writing there. `lsof` only lists open files and takes no lock, so asking never makes a
 * starting omp lose the lease. Undefined when nothing holds it or it cannot be told.
 */
export async function sessionHolder(file: string, ignore?: number): Promise<number | undefined> {
	const id = await headerId(file);
	if (!id) return undefined;
	try {
		const lsof = Bun.spawn([LSOF, "-t", "--", sessionLeasePath(id)], { stdout: "pipe", stderr: "ignore" });
		const output = await new Response(lsof.stdout).text();
		await lsof.exited;
		return output
			.split("\n")
			.map(Number)
			.find((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && pid !== ignore);
	} catch {
		return undefined;
	}
}
