import type {
	DirectoryListing,
	ModelRole,
	RecentProject,
	SessionStatus,
	TimelineItem,
	TimelinePage,
} from "@omp-mobile/protocol";

/** Everything the server knows about a session from its JSONL file alone. */
export interface SessionMeta {
	id: string;
	file: string;
	cwd: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: SessionStatus;
	preview?: string;
}

export interface SessionMetaPage {
	items: SessionMeta[];
	nextCursor?: string;
}

/** Durable timeline items appended after a known entry, used to reconcile live items. */
export interface DurableTail {
	items: TimelineItem[];
	/** Entry id of the newest durable entry on the active chain; pass back as `afterEntryId`. */
	lastEntryId?: string;
	/** Durable user/assistant message identities (role + message timestamp ms) present in `items`. */
	messageKeys: Array<{ itemId: string; role: "user" | "assistant"; timestamp: number }>;
}

export interface History {
	listSessions(opts: { cursor?: string; limit: number }): Promise<SessionMetaPage>;
	getSession(id: string): Promise<SessionMeta | null>;
	/** Newest page when `before` is absent; items ascending within the page. */
	readTimeline(id: string, opts: { before?: string; limit: number }): Promise<TimelinePage>;
	/** Items on the active chain after `afterEntryId` (all items when absent, bounded by `limit`). */
	readTail(id: string, opts: { afterEntryId?: string; limit: number }): Promise<DurableTail>;
	/** Active model role on the session's current branch; null when it runs a model picked outside those roles. */
	readModelRole(id: string): Promise<ModelRole | null>;
	recentProjects(limit: number): Promise<RecentProject[]>;
	listDirectories(path: string | undefined): Promise<DirectoryListing>;
	/** Resolve and validate a cwd for a new session: must be an existing directory inside the allowed roots. */
	resolveProjectDir(path: string): Promise<string>;
}

export interface HistoryOptions {
	/** Default `~/.omp/agent/sessions`. */
	sessionsDir: string;
	/** Default `~/.omp/agent/blobs`. */
	blobsDir: string;
	/** Allowed browse roots, realpath'd. Default [$HOME]. */
	roots: string[];
	/** Secret for HMAC'd cursors. */
	cursorSecret: Uint8Array;
}

export type CreateHistory = (opts: HistoryOptions) => History;
