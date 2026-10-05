import type {
	AgentThreadSnapshot,
	CreateSessionRequest,
	Liveness,
	ModelRole,
	PendingInteraction,
	PromptRequest,
	PushCategory,
	RespondRequest,
	ResponseReceipt,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
	SkillCommand,
	TimelinePage,
	UsageResponse,
} from "@omp-mobile/protocol";
import type { History } from "../history/api.ts";
import type { AgentSignal } from "./agents.ts";

/** Something the push layer should tell paired phones about. */
export interface LiveNotification {
	sessionId: string;
	category: PushCategory;
	title: string;
	body: string;
	interaction?: PendingInteraction;
	/** Stable id; repeated notifications with the same key replace each other (APNs collapse id). */
	collapseKey: string;
}

/** Event POSTed by the OMP extension (`extension/omp-mobile.ts`) to the loopback listener. */
export interface ExtensionEvent {
	event:
		| "session_start"
		| "session_shutdown"
		| "agent_start"
		| "agent_end"
		| "tool_execution_start"
		| "tool_approval_requested"
		| "tool_approval_resolved"
		| "session_title";
	sessionId: string;
	sessionFile?: string;
	cwd?: string;
	pid: number;
	/** "tui" for interactive terminal sessions, "rpc" for rpc/rpc-ui children, etc. */
	mode: string;
	toolName?: string;
	args?: unknown;
	approved?: boolean;
	/** Generated title for `session_title`, already persisted to the session file by the extension. */
	title?: string;
}

/** Task agent reports the extension batches from OMP's `task:subagent:*` event channels. */
export interface AgentReport {
	/** OMP process the agents run in. */
	pid: number;
	agents: AgentSignal[];
}

export interface LiveOverlay {
	liveness: Liveness;
	pendingCount: number;
}

export interface LiveStatus {
	server: number;
	terminal: number;
	pending: number;
	collabRelayUrl: string;
	problems: string[];
}

export interface LiveHub {
	start(): Promise<void>;
	stop(): Promise<void>;
	overlay(sessionId: string): LiveOverlay;
	/** Active sessions not yet discoverable through history. */
	activeSummaries(): SessionSummary[];
	snapshot(sessionId: string, limit: number): Promise<SessionSnapshot | null>;
	/** Subscribes a phone connection to one session; returns unsubscribe. Leaving never stops a running turn. */
	subscribe(sessionId: string, send: (msg: ServerMessage) => void): () => void;
	/** Global listener for list invalidation (`sessions.changed`) and other connection-wide messages. */
	onBroadcast(send: (msg: ServerMessage) => void): () => void;
	createSession(req: CreateSessionRequest): Promise<{ sessionId: string }>;
	prompt(sessionId: string, req: PromptRequest): Promise<{ state: "accepted" | "duplicate" }>;
	abort(sessionId: string): Promise<void>;
	/** Switches the session's OMP model role, starting a server-owned rpc child when it is idle. */
	setModelRole(sessionId: string, role: ModelRole): Promise<void>;
	/** Turns OMP's advisor on or off for the session, starting a server-owned rpc child when it is idle. */
	setAdvisor(sessionId: string, enabled: boolean): Promise<void>;
	/** Stops the server-owned rpc child (abort if working, wait settled, close stdin) so the terminal can resume. */
	handoff(sessionId: string): Promise<void>;
	respond(sessionId: string, interactionId: string, req: RespondRequest): Promise<ResponseReceipt>;
	ingest(event: ExtensionEvent): void;
	/** Agents are routed to their root session by their transcript's location; others are dropped. */
	ingestAgents(report: AgentReport): void;
	/** Null when the session or agent is unknown. */
	agentSnapshot(sessionId: string, agentId: string, limit: number): Promise<AgentThreadSnapshot | null>;
	/** Newest page when `before` is absent. */
	agentTimeline(
		sessionId: string,
		agentId: string,
		before: string | undefined,
		limit: number,
	): Promise<TimelinePage | null>;
	/** Read-only steps of one agent's thread; returns unsubscribe. Never keeps OMP running. */
	subscribeAgent(sessionId: string, agentId: string, send: (msg: ServerMessage) => void): () => void;
	onNotify(listener: (n: LiveNotification) => void): () => void;
	/** The `/skill:<name>` commands OMP offers in `cwd`, an already validated project directory. */
	skills(cwd: string): Promise<SkillCommand[]>;
	usage(): Promise<UsageResponse>;
	status(): LiveStatus;
}

export interface LiveOptions {
	history: History;
	/** Absolute path to the `omp` executable. */
	ompPath: string;
	/** Loopback port for the content-blind Collab relay. */
	relayPort: number;
	/** Absolute path to the OMP extension file passed with `-e` to rpc-ui children. */
	extensionPath: string;
	/** Extra CLI arguments appended to rpc-ui children (models, approval mode, config overlays). */
	rpcArgs?: string[];
	/** Grace period before closing a settled, unsubscribed rpc child. Default 30 seconds. */
	settleGraceMs?: number;
}

export type CreateLiveHub = (opts: LiveOptions) => LiveHub;
