import type {
	ApiError,
	CreateSessionRequest,
	DirectoryListing,
	PairRequest,
	PairResponse,
	PromptRequest,
	RecentProject,
	RespondRequest,
	ResponseReceipt,
	ServerInfo,
	SessionListPage,
	SessionSnapshot,
	TimelinePage,
} from "@omp-mobile/protocol";
import type { PairedMachine } from "../native/types";

const REQUEST_TIMEOUT_MS = 12_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid ${label} response`);
	}
	return value as JsonObject;
}

function typed<T>(label: string, required: string[]) {
	return (value: unknown): T => {
		const result = object(value, label);
		for (const key of required) if (!(key in result)) throw new Error(`Invalid ${label} response: missing ${key}`);
		return result as T;
	};
}

function errorPayload(value: unknown): ApiError | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<ApiError>;
	return typeof candidate.code === "string" && typeof candidate.message === "string" ? (candidate as ApiError) : null;
}

export class OmpApiError extends Error {
	constructor(
		readonly status: number,
		readonly payload: ApiError,
	) {
		super(payload.message);
		this.name = "OmpApiError";
	}
}

export class OmpApi {
	constructor(private readonly machine: Pick<PairedMachine, "url" | "token">) {}

	private async request<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${this.machine.url.replace(/\/$/, "")}${path}`, {
				...init,
				signal: controller.signal,
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.machine.token}`,
					...(init.body ? { "content-type": "application/json" } : {}),
					...init.headers,
				},
			});
			const value: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new OmpApiError(
					response.status,
					errorPayload(value) ?? { code: "unavailable", message: `Request failed (${response.status})` },
				);
			}
			return parse(value);
		} catch (error) {
			if (error instanceof OmpApiError) throw error;
			if (controller.signal.aborted) throw new Error("The computer did not respond in time.");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	info() {
		return this.request(
			"/v1/info",
			{ method: "GET" },
			typed<ServerInfo>("server info", ["protocol", "machineId", "machineName", "capabilities"]),
		);
	}

	sessions(cursor?: string, limit = 30) {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor) query.set("cursor", cursor);
		return this.request(`/v1/sessions?${query}`, { method: "GET" }, typed<SessionListPage>("sessions", ["items"]));
	}

	snapshot(sessionId: string, limit = 40) {
		return this.request(
			`/v1/sessions/${encodeURIComponent(sessionId)}?limit=${limit}`,
			{ method: "GET" },
			typed<SessionSnapshot>("session", ["session", "items", "pending"]),
		);
	}

	timeline(sessionId: string, before: string, limit = 40) {
		const query = new URLSearchParams({ before, limit: String(limit) });
		return this.request(
			`/v1/sessions/${encodeURIComponent(sessionId)}/items?${query}`,
			{ method: "GET" },
			typed<TimelinePage>("timeline", ["items"]),
		);
	}

	create(body: CreateSessionRequest) {
		return this.request(
			"/v1/sessions",
			{ method: "POST", body: JSON.stringify(body) },
			typed<{ sessionId: string }>("created session", ["sessionId"]),
		);
	}

	prompt(sessionId: string, body: PromptRequest) {
		return this.request(
			`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`,
			{ method: "POST", body: JSON.stringify(body) },
			typed<{ state: string }>("prompt", ["state"]),
		);
	}

	abort(sessionId: string) {
		return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, () => undefined);
	}

	handoff(sessionId: string) {
		return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/handoff`, { method: "POST" }, () => undefined);
	}

	respond(sessionId: string, interactionId: string, body: RespondRequest) {
		return this.request(
			`/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
			{ method: "POST", body: JSON.stringify(body) },
			typed<ResponseReceipt>("interaction receipt", ["operationId", "state"]),
		);
	}

	recentProjects() {
		return this.request(
			"/v1/projects/recent",
			{ method: "GET" },
			(value) => typed<{ projects: RecentProject[] }>("recent projects", ["projects"])(value).projects,
		);
	}

	directories(path?: string) {
		const query = path ? `?path=${encodeURIComponent(path)}` : "";
		return this.request(
			`/v1/fs/dirs${query}`,
			{ method: "GET" },
			typed<DirectoryListing>("directory listing", ["path", "roots", "entries"]),
		);
	}

	registerPush(token: string, environment: "sandbox" | "production") {
		return this.request(
			"/v1/devices/me/push",
			{ method: "PUT", body: JSON.stringify({ token, environment }) },
			() => undefined,
		);
	}

	removeDevice() {
		return this.request("/v1/devices/me", { method: "DELETE" }, () => undefined);
	}
}

export async function pair(url: string, body: PairRequest): Promise<PairResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${url.replace(/\/$/, "")}/v1/pair`, {
			method: "POST",
			signal: controller.signal,
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const value: unknown = await response.json().catch(() => null);
		if (!response.ok)
			throw new OmpApiError(
				response.status,
				errorPayload(value) ?? { code: "unavailable", message: `Pairing failed (${response.status})` },
			);
		return typed<PairResponse>("pairing", ["machineId", "machineName", "deviceId", "token", "pushKey"])(value);
	} finally {
		clearTimeout(timeout);
	}
}

export function operationId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
