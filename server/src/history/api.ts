import type {
	DirectoryListing,
	ModelRole,
	RecentProject,
	SessionStatus,
	TimelineItem,
	TimelinePage,
} from "@omp-mobile/protocol";
import type { AgentFile, AgentLocation } from "./agents";
import type { ImageStore } from "./images";

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
	/** Transcript images, from OMP's blob store or a running turn. */
	readonly images: ImageStore;
	/**
	 * Sessions filtered to an exact `project` cwd and a fuzzy title `query` (trimmed; empty means none),
	 * then paged. A cursor is only valid for the filter it was issued with.
	 */
	listSessions(opts: { cursor?: string; limit: number; project?: string; query?: string }): Promise<SessionMetaPage>;
	getSession(id: string): Promise<SessionMeta | null>;
	/** Newest page when `before` is absent; items ascending within the page. */
	readTimeline(id: string, opts: { before?: string; limit: number }): Promise<TimelinePage>;
	/** Items on the active chain after `afterEntryId` (all items when absent, bounded by `limit`). */
	readTail(id: string, opts: { afterEntryId?: string; limit: number }): Promise<DurableTail>;
	/** Active model role on the session's current branch; null when it runs a model picked outside those roles. */
	readModelRole(id: string): Promise<ModelRole | null>;
	/** Whether the phone last left OMP's advisor on for the session's current branch. */
	readAdvisor(id: string): Promise<boolean>;
	/** Null unless `file` is a task agent's transcript, per OMP's layout. */
	locateAgent(file: string): Promise<AgentLocation | null>;
	getSessionByFile(file: string): Promise<SessionMeta | null>;
	/** Task agents of the session stored at `rootFile`, nested ones included, oldest first. */
	listAgents(rootFile: string): Promise<AgentFile[]>;
	/** Like `readTimeline`, for an agent's thread; its cursors are valid only for that agent. */
	readAgentTimeline(agent: AgentFile, opts: { before?: string; limit: number }): Promise<TimelinePage>;
	readAgentTail(agent: AgentFile, opts: { afterEntryId?: string; limit: number }): Promise<DurableTail>;
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
