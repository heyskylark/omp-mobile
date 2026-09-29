import { basename, join } from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import type { RecentProject, SessionStatus } from "@omp-mobile/protocol";
import type { SessionMeta } from "./api";
import { parseHeader, parseLine, textFromContent } from "./jsonl";

interface CacheEntry {
	mtimeMs: number;
	size: number;
	meta?: SessionMeta;
}

async function readSlices(file: string, size: number) {
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
		if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.meta;
		let meta: SessionMeta | undefined;
		try {
			const slices = await readSlices(file, info.size);
			const parsed = parseHeader(slices.prefix);
			if (parsed) {
				const first = firstUserText(slices.prefix);
				const explicit = parsed.slotTitle || parsed.header.title?.trim();
				const title = (explicit || first || "Untitled").replace(/\s+/g, " ").slice(0, 80);
				const created = new Date(parsed.header.timestamp ?? (info.birthtimeMs || info.mtimeMs));
				const preview = lastAssistantText(slices.suffix);
				meta = {
					id: parsed.header.id,
					file,
					cwd: parsed.header.cwd,
					title,
					createdAt: created.toISOString(),
					updatedAt: info.mtime.toISOString(),
					status: statusFromSuffix(slices.suffix),
					...(preview ? { preview } : {}),
				};
			}
		} catch {}
		this.#cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, meta });
		return meta;
	}

	async all() {
		const files = await this.files();
		const results: SessionMeta[] = [];
		let next = 0;
		const workers = Array.from({ length: Math.min(16, Math.max(1, Math.ceil(files.length / 64))) }, async () => {
			for (;;) {
				const index = next++;
				const file = files[index];
				if (!file) break;
				const meta = await this.#scan(file);
				if (meta) results.push(meta);
			}
		});
		await Promise.all(workers);
		results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		return results;
	}

	async find(id: string) {
		const all = await this.all();
		return all.find((meta) => meta.id === id) ?? null;
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
