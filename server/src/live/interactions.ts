import type { InteractionResponse, PendingInteraction, ResponseReceipt } from "@omp-mobile/protocol";

export interface UiRequest {
	id: string;
	method: "select" | "editor" | "input" | "confirm";
	title: string;
	options?: string[];
}

export interface CollabUiRequest {
	reqId: number;
	kind: "select" | "editor" | "input" | "confirm";
	title: string;
	options?: Array<string | { label?: string; description?: string }>;
}

export interface InteractionSource {
	transport: "rpc" | "collab";
	requestId: string | number;
	request: UiRequest;
}

export interface InteractionRecord {
	pending: PendingInteraction;
	source: InteractionSource;
	otherEditor?: { requestId: string | number; resolve: (request: UiRequest) => void; reject: (error: Error) => void };
	closed?: { cancelled: boolean };
}

const OTHER = "Other (type your own)";
const CHAT = "Chat about this";

export function normalizeRpcUiRequest(frame: Record<string, unknown>): UiRequest | null {
	if (frame.type !== "extension_ui_request" || typeof frame.id !== "string" || typeof frame.title !== "string")
		return null;
	if (frame.method !== "select" && frame.method !== "editor" && frame.method !== "input" && frame.method !== "confirm")
		return null;
	return {
		id: frame.id,
		method: frame.method,
		title: frame.title,
		options: Array.isArray(frame.options) ? frame.options.filter((x): x is string => typeof x === "string") : undefined,
	};
}

export function normalizeCollabUiRequest(frame: Record<string, unknown>): UiRequest | null {
	if (frame.t !== "ui-request" || !frame.request || typeof frame.request !== "object") return null;
	const request = frame.request as Record<string, unknown>;
	if (typeof request.reqId !== "number" || typeof request.title !== "string") return null;
	if (request.kind !== "select" && request.kind !== "editor" && request.kind !== "input" && request.kind !== "confirm")
		return null;
	const options = Array.isArray(request.options)
		? request.options
				.map((option) =>
					typeof option === "string"
						? option
						: option && typeof option === "object" && typeof (option as { label?: unknown }).label === "string"
							? (option as { label: string }).label
							: "",
				)
				.filter(Boolean)
		: undefined;
	return { id: String(request.reqId), method: request.kind, title: request.title, options };
}

export function requestToPending(
	sessionId: string,
	request: UiRequest,
	createdAt = new Date().toISOString(),
): PendingInteraction {
	if (request.method === "select") {
		const options = request.options ?? [];
		if (options.length === 2 && options[0] === "Approve" && options[1] === "Deny") {
			const [title = "Approval required", ...detail] = request.title.split("\n");
			return { id: request.id, sessionId, createdAt, kind: "approval", title, detail: detail.join("\n") };
		}
		return {
			id: request.id,
			sessionId,
			createdAt,
			kind: "question",
			title: request.title,
			options: options.filter((label) => label !== OTHER && label !== CHAT).map((label) => ({ label })),
			allowOther: options.includes(OTHER),
		};
	}
	if (request.method === "confirm")
		return {
			id: request.id,
			sessionId,
			createdAt,
			kind: "question",
			title: request.title,
			options: [{ label: "Yes" }, { label: "No" }],
			allowOther: false,
		};
	return { id: request.id, sessionId, createdAt, kind: "text", title: request.title };
}

export type ResponsePlan =
	| { kind: "send"; value?: string; confirmed?: boolean; cancelled?: true }
	| { kind: "other"; selector: typeof OTHER; text: string };

export function planResponse(
	record: InteractionRecord,
	response: InteractionResponse,
): ResponsePlan | ResponseReceipt["state"] {
	if (record.closed) return "closed";
	if (response.kind === "cancel") return { kind: "send", cancelled: true };
	const pending = record.pending;
	if (response.kind === "approve")
		return pending.kind === "approval" ? { kind: "send", value: "Approve" } : "superseded";
	if (response.kind === "deny") return pending.kind === "approval" ? { kind: "send", value: "Deny" } : "superseded";
	if (response.kind === "choice") {
		if (pending.kind !== "question") return "superseded";
		if (record.source.request.method === "confirm")
			return response.label === "Yes"
				? { kind: "send", confirmed: true }
				: response.label === "No"
					? { kind: "send", confirmed: false }
					: "superseded";
		return pending.options.some((option) => option.label === response.label)
			? { kind: "send", value: response.label }
			: "superseded";
	}
	if (pending.kind === "text") return { kind: "send", value: response.text };
	if (pending.kind === "question" && pending.allowOther) return { kind: "other", selector: OTHER, text: response.text };
	return "superseded";
}

export function receipt(operationId: string, state: ResponseReceipt["state"], message?: string): ResponseReceipt {
	return { operationId, state, ...(message ? { message } : {}) };
}

export class ReceiptLedger {
	#receipts = new Map<string, ResponseReceipt>();
	get(operationId: string): ResponseReceipt | undefined {
		return this.#receipts.get(operationId);
	}
	record(value: ResponseReceipt): ResponseReceipt {
		const existing = this.#receipts.get(value.operationId);
		if (existing) return existing;
		this.#receipts.set(value.operationId, value);
		return value;
	}
}
