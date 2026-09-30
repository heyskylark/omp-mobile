import { createHmac, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { History, HistoryOptions, SessionMetaPage } from "./api";
import { SessionCatalog } from "./catalog";
import { DirectoryBrowser, ProjectPathError, privacyGuarded } from "./directories";
import { filterSessions, sessionFilter, type SessionFilter } from "./filter";
import { InvalidHistoryCursorError, SessionPager } from "./pager";

function encodeListCursor(offset: number, filter: SessionFilter, secret: Uint8Array) {
	const body = Buffer.from(JSON.stringify({ offset, ...filter })).toString("base64url");
	const signature = createHmac("sha256", secret).update(body).digest("base64url");
	return `${body}.${signature}`;
}

/** Offset of a cursor issued for exactly `filter`; any other filter, forgery or garbage is rejected. */
function decodeListCursor(cursor: string, filter: SessionFilter, secret: Uint8Array) {
	const [body, signature, extra] = cursor.split(".");
	if (!body || !signature || extra) throw new InvalidHistoryCursorError();
	const actual = Buffer.from(signature, "base64url");
	const expected = createHmac("sha256", secret).update(body).digest();
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidHistoryCursorError();
	let value: { offset?: unknown; project?: unknown; query?: unknown };
	try {
		value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		throw new InvalidHistoryCursorError();
	}
	if (!Number.isInteger(value.offset) || (value.offset as number) < 0) throw new InvalidHistoryCursorError();
	if (value.project !== filter.project || value.query !== filter.query) throw new InvalidHistoryCursorError();
	return value.offset as number;
}

export { InvalidHistoryCursorError, ProjectPathError };
export type { History, HistoryOptions, SessionMeta, SessionMetaPage, DurableTail } from "./api";

export function createHistory(options: HistoryOptions): History {
	const catalog = new SessionCatalog(options.sessionsDir);
	const pager = new SessionPager(options.cursorSecret);
	const directories = new DirectoryBrowser(options.roots, async () => {
		const paths = await Promise.all(
			(await catalog.all()).map(async (meta) => {
				if (privacyGuarded(meta.cwd)) return meta.cwd;
				try {
					return await realpath(meta.cwd);
				} catch {
					return meta.cwd;
				}
			}),
		);
		return new Set(paths);
	});

	return {
		async listSessions({ cursor, limit, project, query }): Promise<SessionMetaPage> {
			const filter = sessionFilter(project, query);
			const offset = cursor ? decodeListCursor(cursor, filter, options.cursorSecret) : 0;
			const all = filterSessions(await catalog.all(), filter, (meta) => meta.cwd);
			if (offset > all.length) throw new InvalidHistoryCursorError();
			const items = all.slice(offset, offset + limit);
			const nextOffset = offset + items.length;
			return {
				items,
				...(nextOffset < all.length ? { nextCursor: encodeListCursor(nextOffset, filter, options.cursorSecret) } : {}),
			};
		},
		getSession(id) {
			return catalog.find(id);
		},
		async readTimeline(id, opts) {
			const session = await catalog.find(id);
			if (!session) return { items: [] };
			return pager.page(session.file, id, opts.before, opts.limit);
		},
		async readTail(id, opts) {
			const session = await catalog.find(id);
			if (!session) return { items: [], messageKeys: [] };
			return pager.tail(session.file, opts.afterEntryId, opts.limit);
		},
		async recentProjects(limit) {
			const usable = [];
			for (const project of await catalog.recentProjects(Number.MAX_SAFE_INTEGER)) {
				if (usable.length === limit) break;
				const path = await directories.resolve(project.path).catch(() => null);
				if (path) usable.push({ ...project, path });
			}
			return usable;
		},
		listDirectories(path) {
			return directories.list(path);
		},
		resolveProjectDir(path) {
			return directories.resolve(path);
		},
	};
}
