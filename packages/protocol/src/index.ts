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
	  }
	| { id: string; kind: "event"; at: ISODate; tone: "info" | "warning" | "error"; text: string }
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
	| { type: "ping" };

export type ServerMessage =
	| { type: "hello"; epoch: string; info: ServerInfo }
	| { type: "session.snapshot"; sessionId: string; snapshot: SessionSnapshot }
	| { type: "timeline.upsert"; sessionId: string; items: TimelineItem[] }
	| { type: "timeline.retire"; sessionId: string; ids: string[] }
	| { type: "session.update"; sessionId: string; session: SessionSummary; pending: PendingInteraction[] }
	| { type: "session.modelRole"; sessionId: string; modelRole: ModelRole | null }
	| { type: "sessions.changed" }
	| { type: "pong" }
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
