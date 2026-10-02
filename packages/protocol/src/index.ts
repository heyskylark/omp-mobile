export const PROTOCOL_VERSION = 1 as const;

export type ISODate = string;

export type Capability = "history" | "rpc" | "collab" | "push";

export interface ServerInfo {
	protocol: typeof PROTOCOL_VERSION;
	machineId: string;
	machineName: string;
	serverVersion: string;
	ompVersion: string | null;
	capabilities: Capability[];
}

export const MAX_MACHINE_NAME_LENGTH = 64;

/** Body of `PUT /v1/machine/name`; the response is the updated `ServerInfo`. */
export interface MachineNameRequest {
	machineName: string;
}

export type Liveness =
	| { kind: "idle" }
	| { kind: "server"; phase: "starting" | "ready" | "working" | "settling" }
	| { kind: "terminal"; attached: boolean }
	| { kind: "conflict"; message: string }
	| { kind: "unavailable"; reason: string };

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "working" | "unknown";

export interface Project {
	path: string;
	name: string;
}

export interface SessionSummary {
	id: string;
	title: string;
	project: Project;
	createdAt: ISODate;
	updatedAt: ISODate;
	status: SessionStatus;
	liveness: Liveness;
	preview?: string;
	pendingCount: number;
}

export interface SessionListPage {
	items: SessionSummary[];
	nextCursor?: string;
}

export type Block =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; redacted?: boolean }
	| { kind: "image"; mimeType?: string };

export type ToolState = "running" | "succeeded" | "failed";

export type AgentStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";

/** An OMP `task` subagent of a session. Its work lives in its own thread, never in the session's timeline. */
export interface AgentSummary {
	/** OMP agent id, unique within the session; nested agents are dotted ("Alpha.Gamma"). */
	id: string;
	/** Id of the agent that spawned this one; absent when the session itself spawned it. */
	parentId?: string;
	/** "interrupted": unfinished, and no running OMP process vouches for it. */
	status: AgentStatus;
	/** OMP's one-line summary of the assignment, once it has one. */
	description?: string;
	/** Latest intent or tool while running. */
	activity?: string;
	startedAt: ISODate;
	updatedAt: ISODate;
}

export type TimelineItem =
	| { id: string; kind: "user"; at: ISODate; blocks: Block[] }
	| {
			id: string;
			kind: "assistant";
			at: ISODate;
			blocks: Block[];
			streaming: boolean;
			model?: string;
			stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
			error?: string;
	  }
	| {
			id: string;
			kind: "tool";
			at: ISODate;
			name: string;
			title: string;
			input: string;
			state: ToolState;
			output?: string;
			outputTruncated?: boolean;
			/** Agents this `task` call spawned; the call is still working while any of them runs. */
			agentIds?: string[];
	  }
	| {
			id: string;
			kind: "event";
			at: ISODate;
			tone: "info" | "warning" | "error";
			text: string;
			/** Agents whose finished work this event delivered to the thread. */
			agentIds?: string[];
	  }
	| { id: string; kind: "unsupported"; at: ISODate; label: string };

export interface TimelinePage {
	items: TimelineItem[];
	olderCursor?: string;
}

export interface ChoiceOption {
	label: string;
	description?: string;
}

export type PendingInteraction = {
	id: string;
	sessionId: string;
	createdAt: ISODate;
} & (
	| { kind: "approval"; title: string; detail: string }
	| { kind: "question"; title: string; options: ChoiceOption[]; allowOther: boolean }
	| { kind: "text"; title: string }
);

export type InteractionResponse =
	| { kind: "approve" }
	| { kind: "deny" }
	| { kind: "choice"; label: string }
	| { kind: "text"; text: string }
	| { kind: "cancel" };

export type ReceiptState = "applied" | "closed" | "superseded" | "unavailable" | "conflict";

export interface ResponseReceipt {
	operationId: string;
	state: ReceiptState;
	message?: string;
}

/** OMP model roles selectable from the phone, in slider order (lightest first). */
export const MODEL_ROLES = ["smol", "default", "slow"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export interface SessionSnapshot {
	session: SessionSummary;
	items: TimelineItem[];
	olderCursor?: string;
	pending: PendingInteraction[];
	/** Active OMP model role; null when the session runs a model chosen outside these roles. */
	modelRole: ModelRole | null;
	/** Every agent of the session, nested ones included. */
	agents: AgentSummary[];
}

/** Response of `GET /v1/sessions/:id/agents/:agentId`: one agent's read-only thread plus the session's agents. */
export interface AgentThreadSnapshot {
	agents: AgentSummary[];
	items: TimelineItem[];
	olderCursor?: string;
}

export interface RecentProject extends Project {
	lastUsedAt: ISODate;
	sessionCount: number;
}

export interface DirectoryEntry {
	name: string;
	path: string;
	isGitRepo: boolean;
	hasSessions: boolean;
}

export interface DirectoryListing {
	path: string;
	parent?: string;
	roots: string[];
	entries: DirectoryEntry[];
}

export type PushEnvironment = "sandbox" | "production";

export interface PairRequest {
	code: string;
	deviceName: string;
	/** Existing bearer token for this server. When valid, pairing replaces that device registration. */
	previousToken?: string;
	push?: { token: string; environment: PushEnvironment };
}

export interface PairResponse {
	machineId: string;
	machineName: string;
	deviceId: string;
	token: string;
	/** base64 AES-256-GCM key used to encrypt this device's push payloads. */
	pushKey: string;
}

/** An image sent with a prompt; forwarded to OMP as an image content block. */
export interface ImageAttachment {
	/** Base64 image data without a data: URI prefix. */
	data: string;
	mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export const MAX_PROMPT_IMAGES = 4;

export interface CreateSessionRequest {
	operationId: string;
	cwd: string;
	prompt: string;
	images?: ImageAttachment[];
	/** Model role for the first turn. Omitted means OMP's default role. */
	modelRole?: ModelRole;
}

export interface PromptRequest {
	operationId: string;
	text: string;
	images?: ImageAttachment[];
}

/** Body of `POST /v1/sessions/:id/model-role`; the response is `ModelRoleResponse`. */
export interface ModelRoleRequest {
	role: ModelRole;
}

export interface ModelRoleResponse {
	modelRole: ModelRole;
}

/** A skill OMP runs when a prompt contains `/skill:<name>`; user-level and project-level skills alike. */
export interface SkillCommand {
	name: string;
	description?: string;
}

/** Response of `GET /v1/skills?cwd=<project>`: the skills an OMP session started in that project can invoke. */
export interface SkillListResponse {
	skills: SkillCommand[];
}

/** How close a usage limit is to running out, as OMP judges it. */
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** One limit window of a provider account, such as Claude's 5-hour or Codex's weekly limit. */
export interface UsageLimit {
	id: string;
	label: string;
	/** Share of the limit used: 0 to 1, above 1 past the limit. Absent when the provider reported no amount. */
	usedFraction?: number;
	/** Epoch milliseconds when the window resets. */
	resetsAt?: number;
	status: UsageStatus;
}

/** The limits OMP reports for one signed-in provider account. */
export interface UsageAccount {
	/** OMP provider id, such as `anthropic` or `openai-codex`. */
	provider: string;
	/** Email or account id the provider reported. */
	account?: string;
	/** Organization of the account; tells apart subscriptions that share one login. */
	org?: string;
	plan?: string;
	/** Saved limit resets the account can still redeem. */
	savedResets?: number;
	limits: UsageLimit[];
}

/** Response of `GET /v1/usage`: what `omp usage` reports for every account signed in on the computer. */
export interface UsageResponse {
	/** Epoch milliseconds of the oldest report; OMP serves cached reports for a short while. */
	fetchedAt: number;
	accounts: UsageAccount[];
}

export interface RespondRequest {
	operationId: string;
	response: InteractionResponse;
}

export interface ApiError {
	code:
		| "unauthorized"
		| "not_found"
		| "bad_request"
		| "invalid_cursor"
		| "conflict"
		| "unavailable"
		| "protocol_mismatch"
		| "forbidden";
	message: string;
}

export type ClientMessage =
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	| { type: "agent.subscribe"; sessionId: string; agentId: string }
	| { type: "agent.unsubscribe"; sessionId: string; agentId: string }
	| { type: "ping" };

export type ServerMessage =
	| { type: "hello"; epoch: string; info: ServerInfo }
	| { type: "session.snapshot"; sessionId: string; snapshot: SessionSnapshot }
	| { type: "timeline.upsert"; sessionId: string; items: TimelineItem[] }
	| { type: "timeline.retire"; sessionId: string; ids: string[] }
	| { type: "session.update"; sessionId: string; session: SessionSummary; pending: PendingInteraction[] }
	| { type: "session.modelRole"; sessionId: string; modelRole: ModelRole | null }
	/** Replaces the session's agents; sent to session subscribers. */
	| { type: "session.agents"; sessionId: string; agents: AgentSummary[] }
	/** Upserts items of one agent's thread; sent only to that agent's subscribers. */
	| { type: "agent.timeline"; sessionId: string; agentId: string; items: TimelineItem[] }
	| { type: "sessions.changed" }
	| { type: "pong" }
	| { type: "error"; error: ApiError };

/** Whether the computer's OMP Browser Relay can be used. */
export type BrowserAvailability =
	| { kind: "ready" }
	/** Nothing answers at the relay address: no agent has used the relay since login, or it was stopped. */
	| { kind: "relay_offline" }
	/** The relay runs, but no Chrome window with the OMP Browser Relay extension is connected to it. */
	| { kind: "extension_disconnected" };

/** Response of `GET /v1/browser`. */
export interface BrowserStatusResponse {
	availability: BrowserAvailability;
}

/** A Chrome tab the relay can attach to. */
export interface BrowserTab {
	id: string;
	title: string;
	url: string;
	/** Epoch milliseconds of the tab's last creation, navigation, or title change the server saw. */
	lastActivityAt: number;
	/** Chrome shows this tab in its window. Tabs Chrome put to sleep in the background are never front. */
	front: boolean;
}

export interface BrowserFrame {
	/** Increases with every frame sent on one viewer socket; acknowledge it with `frame.ack`. */
	seq: number;
	/** Base64 JPEG exactly as Chrome produced it. */
	jpeg: string;
	/** The tab's viewport in CSS pixels. Input coordinates are in this space, not the JPEG's pixels. */
	width: number;
	height: number;
	/** `live` comes from Chrome's screencast; `snapshot` is a still of a background tab, refreshed every few seconds. */
	mode: "live" | "snapshot";
}

/** Who may send input to the watched tab, from the receiving viewer's point of view. */
export type BrowserControl = { kind: "none" } | { kind: "you" } | { kind: "other"; deviceName: string };

export const BROWSER_KEYS = [
	"Backspace",
	"Enter",
	"Tab",
	"Escape",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
] as const;

export type BrowserKey = (typeof BROWSER_KEYS)[number];

/** Messages a viewer sends on `WS /v1/browser/stream`. Input always targets the watched tab. */
export type BrowserClientMessage =
	/** Watch a tab, leaving any previous one. `maxWidth` caps frame width in pixels. */
	| { type: "watch"; tabId: string; maxWidth: number }
	| { type: "unwatch" }
	/** The frame is on screen; the server sends the newest frame next and never a superseded one. */
	| { type: "frame.ack"; seq: number }
	/** Bring the watched tab to the front of its Chrome window. */
	| { type: "tab.activate" }
	/** Take control of the watched tab from anyone else, bringing it to the front. Repeating it is harmless. */
	| { type: "control.take" }
	| { type: "control.release" }
	/** `count` 2 or 3 continues a double or triple click at the same spot, which selects a word or a paragraph. */
	| { type: "input.tap"; x: number; y: number; count?: number }
	| { type: "input.scroll"; x: number; y: number; dx: number; dy: number }
	| { type: "input.text"; text: string }
	| { type: "input.key"; key: BrowserKey }
	/** A held mouse button moving from `start` to `end`, which selects text. */
	| { type: "input.drag"; phase: "start" | "move" | "end"; x: number; y: number }
	/** Read the text selected in the watched tab; answered with `clipboard` to this viewer only. Needs control. */
	| { type: "clipboard.copy" }
	| { type: "ping" };

/** Messages the server sends on `WS /v1/browser/stream`. */
export type BrowserServerMessage =
	| { type: "state"; availability: BrowserAvailability }
	/** Every attachable tab, most recently active first. */
	| { type: "tabs"; tabs: BrowserTab[] }
	| { type: "watching"; tabId: string; control: BrowserControl }
	/**
	 * Whether Chrome is drawing the watched tab. Chrome draws nothing while the Mac's screen is locked, and may stop
	 * drawing a tab whose window is covered; the last frame stays current until Chrome draws again. Sent on watch when
	 * false, then on every change.
	 */
	| { type: "drawing"; drawing: boolean }
	/** The watched tab closed. */
	| { type: "unwatched"; tabId: string }
	| { type: "control"; control: BrowserControl }
	| { type: "frame"; frame: BrowserFrame }
	| { type: "pong" }
	/** The selected text a `clipboard.copy` asked for. */
	| { type: "clipboard"; text: string }
	| { type: "error"; error: ApiError };

export type PushCategory = "OMP_APPROVAL" | "OMP_QUESTION" | "OMP_INFO";

/** Plaintext sealed inside the APNs payload; decrypted by the Notification Service Extension. */
export interface PushPlaintext {
	v: 1;
	machineId: string;
	sessionId: string;
	interactionId?: string;
	category: PushCategory;
	title: string;
	body: string;
}

export const PAIR_URL_SCHEME = "ompmobile";

export interface PairingPayload {
	url: string;
	code: string;
	name: string;
}

export function encodePairingUrl(p: PairingPayload): string {
	const q = new URLSearchParams({ v: String(PROTOCOL_VERSION), url: p.url, code: p.code, name: p.name });
	return `${PAIR_URL_SCHEME}://pair?${q.toString()}`;
}

export function decodePairingUrl(raw: string): PairingPayload | null {
	const prefix = `${PAIR_URL_SCHEME}://pair?`;
	if (!raw.startsWith(prefix)) return null;
	const q = new URLSearchParams(raw.slice(prefix.length));
	const url = q.get("url");
	const code = q.get("code");
	const name = q.get("name");
	if (q.get("v") !== String(PROTOCOL_VERSION) || !url || !code || !name) return null;
	return { url, code, name };
}

export interface AdminStatus {
	machineName: string;
	url: string;
	ompVersion: string | null;
	apnsConfigured: boolean;
	devices: Array<{ id: string; name: string; pairedAt: ISODate; lastSeenAt?: ISODate }>;
	pairings: Array<{
		id: string;
		expiresAt: ISODate;
		consumedBy?: { deviceId: string; name: string; pairedAt: ISODate };
	}>;
	live: { server: number; terminal: number; pending: number };
	problems: string[];
}

export interface AdminPairing {
	id: string;
	code: string;
	expiresAt: ISODate;
	pairingUrl: string;
}
