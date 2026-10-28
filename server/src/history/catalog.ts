import { basename, join } from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import type { RecentProject, SessionStatus } from "@omp-mobile/protocol";
import type { SessionMeta } from "./api";
import { parseHeader, parseLine, textFromContent } from "./jsonl";

/** One session file as scanned, before moved sessions are joined. */
interface ScannedSession {
	meta: SessionMeta;
	/** Header `continuationOf`: the id of the session OMP moved into this file. */
	continuationOf?: string;
	/** Time of the file's newest turn, in ms. */
	lastTurnAt: number;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	session?: ScannedSession;
}

/** Session catalog with each chain of moved files joined into one session; see `resolveMoves`. */
interface Index {
	sessions: SessionMeta[];
	byId: Map<string, SessionMeta>;
	byFile: Map<string, SessionMeta>;
}

export async function readSlices(file: string, size: number) {
	const handle = await open(file, "r");
	try {
		const prefixLength = Math.min(4096, size);
		const suffixLength = Math.min(32768, size);
		const prefix = Buffer.allocUnsafe(prefixLength);
		const suffix = Buffer.allocUnsafe(suffixLength);
		const [prefixRead, suffixRead] = await Promise.all([
			handle.read(prefix, 0, prefixLength, 0),
			handle.read(suffix, 0, suffixLength, Math.max(0, size - suffixLength)),
		]);
		return {
			prefix: prefix.subarray(0, prefixRead.bytesRead).toString("utf8"),
			suffix: suffix.subarray(0, suffixRead.bytesRead).toString("utf8"),
		};
	} finally {
		await handle.close();
	}
}

function messageText(message: Record<string, unknown>) {
	return textFromContent(message.content).replace(/\s+/g, " ").trim();
}

function statusFromSuffix(suffix: string): SessionStatus {
	const lines = suffix.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const value = parseLine(lines[index] ?? "");
		if (value?.type !== "message" || !value.message || typeof value.message !== "object") continue;
		const message = value.message as Record<string, unknown>;
		if (message.role === "assistant") {
			if (message.stopReason === "error") return "error";
			if (message.stopReason === "aborted") return "aborted";
			if (message.stopReason === "length") return "interrupted";
			if (
				Array.isArray(message.content) &&
				message.content.some(
					(block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall",
				)
			)
				return "interrupted";
			return "complete";
		}
		if (message.role === "toolResult") return "interrupted";
		if (message.role === "user") return "pending";
		return "unknown";
	}
	return "unknown";
}

function firstUserText(prefix: string) {
	for (const line of prefix.split(/\r?\n/)) {
		const value = parseLine(line);
		if (value?.type !== "message" || !value.message || typeof value.message !== "object") continue;
		const message = value.message as Record<string, unknown>;
		if (message.role === "user") {
			const text = messageText(message);
			if (text) return text;
		}
	}
	const role = /"role"\s*:\s*"user"/.exec(prefix);
	if (!role) return undefined;
	const remainder = prefix.slice(role.index + role[0].length);
	const text = /"(?:text|content)"\s*:\s*("(?:\\.|[^"\\])*")/.exec(remainder)?.[1];
	if (!text) return undefined;
	try {
		return JSON.parse(text) as string;
	} catch {
		return undefined;
	}
}

function lastAssistantText(suffix: string) {
	const lines = suffix.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const value = parseLine(lines[index] ?? "");
		if (value?.type !== "message" || !value.message || typeof value.message !== "object") continue;
		const message = value.message as Record<string, unknown>;
		if (message.role === "assistant") {
			const text = messageText(message);
			if (text) return text.slice(0, 240);
		}
	}
	return undefined;
}

/** Entries OMP counts as turns when it picks which copy of a moved session to resume. */
const TURN_ENTRIES: Record<string, true> = {
	message: true,
	custom_message: true,
	branch_summary: true,
	reset_boundary: true,
};

function lastTurnAt(suffix: string): number | undefined {
	const lines = suffix.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const value = parseLine(lines[index] ?? "");
		if (typeof value?.type !== "string" || !Object.hasOwn(TURN_ENTRIES, value.type)) continue;
		const message =
			value.message && typeof value.message === "object" ? (value.message as Record<string, unknown>) : {};
		if ((value.type === "custom_message" ? value.customType : message.customType) === "eval-state-context") continue;
		const time = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
		if (Number.isFinite(time)) return time;
	}
	return undefined;
}

/**
 * OMP moves a session it cannot keep writing in place (another omp process holds the file, or the file changed on
 * disk) to a new file with a new id whose header names the old id as `continuationOf`, after copying its entries.
 * Each chain of such files is one session here: it keeps the chain's first id, so a phone following that id keeps
 * seeing and matching its messages, and reads the copy OMP's `--resume` continues. That is the copy with the newest
 * turn, leaving out files whose turns all went into a later copy, i.e. whose last turn predates a continuation.
 */
function resolveMoves(scanned: ScannedSession[]): Index {
	const byOwnId = new Map(scanned.map((session) => [session.meta.id, session]));
	const continuations = new Map<string, ScannedSession[]>();
	const chains = new Map<string, ScannedSession[]>();
	for (const session of scanned) {
		if (session.continuationOf)
			continuations.set(session.continuationOf, [...(continuations.get(session.continuationOf) ?? []), session]);
		let root = session.meta.id;
		const seen = new Set([root]);
		for (let from = session.continuationOf; from && !seen.has(from); from = byOwnId.get(root)?.continuationOf) {
			seen.add(from);
			root = from;
		}
		chains.set(root, [...(chains.get(root) ?? []), session]);
	}
	const index: Index = { sessions: [], byId: new Map(), byFile: new Map() };
	for (const [root, members] of chains) {
		const live = members.filter(
			(member) =>
				!continuations.get(member.meta.id)?.some((copy) => Date.parse(copy.meta.createdAt) >= member.lastTurnAt),
		);
		const current = (live.length ? live : members).reduce((newest, member) =>
			member.lastTurnAt > newest.lastTurnAt ? member : newest,
		);
		const first = byOwnId.get(root) ?? current;
		const meta =
			current.meta.id === root ? current.meta : { ...current.meta, id: root, createdAt: first.meta.createdAt };
		index.sessions.push(meta);
		index.byId.set(root, meta);
		for (const member of members) {
			index.byId.set(member.meta.id, meta);
			index.byFile.set(member.meta.file, meta);
		}
	}
	index.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return index;
}

export class SessionCatalog {
	readonly #sessionsDir: string;
	readonly #cache = new Map<string, CacheEntry>();

	constructor(sessionsDir: string) {
		this.#sessionsDir = sessionsDir;
	}

	async files() {
		let buckets;
		try {
			buckets = await readdir(this.#sessionsDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const files: string[] = [];
		await Promise.all(
			buckets
				.filter((bucket) => bucket.isDirectory() && !bucket.name.startsWith("."))
				.map(async (bucket) => {
					let entries;
					try {
						entries = await readdir(join(this.#sessionsDir, bucket.name), { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of entries)
						if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith("."))
							files.push(join(this.#sessionsDir, bucket.name, entry.name));
				}),
		);
		return files;
	}

	async #scan(file: string) {
		let info;
		try {
			info = await stat(file);
		} catch {
			return undefined;
		}
		const cached = this.#cache.get(file);
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.session;
		let session: ScannedSession | undefined;
		try {
			const slices = await readSlices(file, info.size);
			const parsed = parseHeader(slices.prefix);
			if (parsed) {
				const first = firstUserText(slices.prefix);
				const explicit = parsed.slotTitle || parsed.header.title?.trim();
				const title = (explicit || first || "Untitled").replace(/\s+/g, " ").slice(0, 80);
				const created = new Date(parsed.header.timestamp ?? (info.birthtimeMs || info.mtimeMs));
				const preview = lastAssistantText(slices.suffix);
				session = {
					meta: {
						id: parsed.header.id,
						file,
						cwd: parsed.header.cwd,
						title,
						createdAt: created.toISOString(),
						updatedAt: info.mtime.toISOString(),
						status: statusFromSuffix(slices.suffix),
						...(preview ? { preview } : {}),
					},
					continuationOf: parsed.header.continuationOf,
					lastTurnAt: lastTurnAt(slices.suffix) ?? created.getTime(),
				};
			}
		} catch {}
		this.#cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, session });
		return session;
	}

	async #index(): Promise<Index> {
		const files = await this.files();
		const results: ScannedSession[] = [];
		let next = 0;
		const workers = Array.from({ length: Math.min(16, Math.max(1, Math.ceil(files.length / 64))) }, async () => {
			for (;;) {
				const index = next++;
				const file = files[index];
				if (!file) break;
				const session = await this.#scan(file);
				if (session) results.push(session);
			}
		});
		await Promise.all(workers);
		return resolveMoves(results);
	}

	/** Newest first; a moved session appears once, under its first id. */
	async all() {
		return (await this.#index()).sessions;
	}

	/** Any id of a moved session finds it under its first id, stored in the file OMP resumes. */
	async find(id: string) {
		return (await this.#index()).byId.get(id) ?? null;
	}

	/** Like `find`, for any file of a moved session. */
	async findByFile(file: string) {
		return (await this.#index()).byFile.get(file) ?? null;
	}

	async recentProjects(limit: number): Promise<RecentProject[]> {
		const all = await this.all();
		const projects = new Map<string, RecentProject>();
		for (const meta of all) {
			const existing = projects.get(meta.cwd);
			if (existing) existing.sessionCount++;
			else
				projects.set(meta.cwd, {
					path: meta.cwd,
					name: basename(meta.cwd) || meta.cwd,
					lastUsedAt: meta.updatedAt,
					sessionCount: 1,
				});
		}
		return [...projects.values()].slice(0, limit);
	}
}
