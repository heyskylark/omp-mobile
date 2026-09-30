import Fuse, { type IFuseOptions } from "fuse.js";

/** Normalized session list filter: `project` is an exact cwd; `query` is trimmed and never empty. */
export interface SessionFilter {
	project?: string;
	query?: string;
}

// Bitap scoring per title, independent of the rest of the collection, so a page-1 subset
// re-filtered together with live sessions keeps the same relative order as the full list.
// `ignoreLocation` lets a word match anywhere in a long title. 0.3 still accepts about one typo
// per 3–4 query characters ("calbration", "sesion") but, unlike 0.4, keeps short queries such as
// "pen" from also matching "Parens" or "sesion" from matching "Version".
const FUSE_OPTIONS = {
	keys: ["title"],
	includeScore: true,
	ignoreLocation: true,
	threshold: 0.3,
	shouldSort: false,
} satisfies IFuseOptions<{ title: string }>;

export function sessionFilter(project: string | undefined, query: string | undefined): SessionFilter {
	const trimmed = query?.trim();
	return { ...(project ? { project } : {}), ...(trimmed ? { query: trimmed } : {}) };
}

function newestFirst(left: { updatedAt: string }, right: { updatedAt: string }) {
	return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Sessions in `project` whose title fuzzily matches `query`, best match first (newest first on ties);
 * newest first when there is no query.
 */
export function filterSessions<T extends { title: string; updatedAt: string }>(
	items: readonly T[],
	filter: SessionFilter,
	cwd: (item: T) => string,
): T[] {
	const scoped = filter.project === undefined ? [...items] : items.filter((item) => cwd(item) === filter.project);
	if (!filter.query) return scoped.sort(newestFirst);
	return new Fuse(scoped, FUSE_OPTIONS)
		.search(filter.query)
		.sort((left, right) => left.score! - right.score! || newestFirst(left.item, right.item))
		.map((result) => result.item);
}
