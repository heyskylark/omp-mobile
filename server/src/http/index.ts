import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import {
	MAX_PROMPT_IMAGES,
	MODEL_ROLES,
	PROTOCOL_VERSION,
	type ModelRoleResponse,
	encodePairingUrl,
	type ApiError,
	type AdminStatus,
	type ClientMessage,
	type ServerInfo,
	type ServerMessage,
	type SessionSummary,
} from "@omp-mobile/protocol";
import type { ServerConfig } from "../config.ts";
import type { History, SessionMeta } from "../history/api.ts";
import { ProjectPathError } from "../history/directories.ts";
import type { ExtensionEvent, LiveHub } from "../live/api.ts";
import type { DeviceStore, StoredDevice } from "../store/devices.ts";
import { watchTailscale, type TailscaleState } from "../tailscale.ts";

const PairSchema = z.object({
	code: z.string().length(8),
	deviceName: z.string().trim().min(1).max(200),
	previousToken: z.string().min(1).optional(),
	push: z.object({ token: z.string().min(1), environment: z.enum(["sandbox", "production"]) }).optional(),
});
const PushSchema = z.object({ token: z.string().min(1), environment: z.enum(["sandbox", "production"]) });
// 12M base64 characters is about 9 MB of image data; the app sends downscaled JPEGs well under that.
const ImagesSchema = z
	.array(
		z.object({
			data: z.base64().max(12_000_000),
			mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
		}),
	)
	.max(MAX_PROMPT_IMAGES)
	.optional();
const CreateSessionSchema = z.object({
	operationId: z.string().min(1),
	cwd: z.string().min(1),
	prompt: z.string(),
	images: ImagesSchema,
	modelRole: z.enum(MODEL_ROLES).optional(),
});
const PromptSchema = z.object({ operationId: z.string().min(1), text: z.string(), images: ImagesSchema });
const ModelRoleSchema = z.object({ role: z.enum(MODEL_ROLES) });
const ResponseSchema = z.object({
	operationId: z.string().min(1),
	response: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("approve") }),
		z.object({ kind: z.literal("deny") }),
		z.object({ kind: z.literal("choice"), label: z.string() }),
		z.object({ kind: z.literal("text"), text: z.string() }),
		z.object({ kind: z.literal("cancel") }),
	]),
});
const ExtensionSchema = z.object({
	event: z.enum([
		"session_start",
		"session_shutdown",
		"agent_start",
		"agent_end",
		"tool_execution_start",
		"tool_approval_requested",
		"tool_approval_resolved",
	]),
	sessionId: z.string().min(1),
	sessionFile: z.string().optional(),
	cwd: z.string().optional(),
	pid: z.number().int(),
	mode: z.string(),
	toolName: z.string().optional(),
	args: z.unknown().optional(),
	approved: z.boolean().optional(),
});
const ClientMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("subscribe"), sessionId: z.string().min(1) }),
	z.object({ type: z.literal("unsubscribe"), sessionId: z.string().min(1) }),
	z.object({ type: z.literal("ping") }),
]);
const PathParamSchema = z.string().min(1).max(500);

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiError["code"],
		message: string,
	) {
		super(message);
	}
}

export interface HttpOptions {
	config: ServerConfig;
	machineId: string;
	ompVersion: string | null;
	devices: DeviceStore;
	history: History;
	hub: LiveHub;
	adminToken: string;
	extensionToken: string;
	serverVersion?: string;
}

interface SocketData {
	token: string;
	deviceId: string;
	unsubscribers: Map<string, () => void>;
	unsubscribeBroadcast?: () => void;
}

export interface HttpService {
	readonly url: string;
	readonly tailscale: TailscaleState;
	stop(): Promise<void>;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function errorResponse(error: unknown): Response {
	if (error instanceof HttpError)
		return json({ code: error.code, message: error.message } satisfies ApiError, error.status);
	if (error instanceof z.ZodError)
		return json(
			{ code: "bad_request", message: error.issues[0]?.message ?? "Invalid request" } satisfies ApiError,
			400,
		);
	if (error instanceof ProjectPathError)
		return json({ code: "forbidden", message: error.message } satisfies ApiError, 403);
	console.error(error);
	return json(
		{
			code: "unavailable",
			message: error instanceof Error ? error.message : "Internal server error",
		} satisfies ApiError,
		503,
	);
}

async function body(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new HttpError(400, "bad_request", "Expected a JSON request body");
	}
}

function bearer(req: Request): string | null {
	const header = req.headers.get("authorization");
	return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function summary(meta: SessionMeta, hub: LiveHub): SessionSummary {
	const overlay = hub.overlay(meta.id);
	return {
		id: meta.id,
		title: meta.title,
		project: { path: meta.cwd, name: basename(meta.cwd) || meta.cwd },
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		status: overlay.liveness.kind === "server" && overlay.liveness.phase === "working" ? "working" : meta.status,
		liveness: overlay.liveness,
		...(meta.preview ? { preview: meta.preview } : {}),
		pendingCount: overlay.pendingCount,
	};
}

function serverInfo(options: HttpOptions): ServerInfo {
	const capabilities: ServerInfo["capabilities"] = ["history"];
	if (options.config.ompPath) capabilities.push("rpc", "collab");
	if (options.config.apns) capabilities.push("push");
	return {
		protocol: PROTOCOL_VERSION,
		machineId: options.machineId,
		machineName: options.config.machineName,
		serverVersion: options.serverVersion ?? "0.1.0",
		ompVersion: options.ompVersion,
		capabilities,
	};
}

async function requireDevice(req: Request, devices: DeviceStore): Promise<StoredDevice> {
	const token = bearer(req);
	const device = token ? await devices.authenticate(token) : null;
	if (!device) throw new HttpError(401, "unauthorized", "A valid device bearer token is required");
	return device;
}

function parseLimit(url: URL, fallback: number, maximum: number): number {
	const value = url.searchParams.get("limit");
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)
		throw new HttpError(400, "bad_request", `limit must be between 1 and ${maximum}`);
	return parsed;
}

function parsePathParam(value: string): string {
	try {
		return PathParamSchema.parse(decodeURIComponent(value));
	} catch (error) {
		if (error instanceof z.ZodError) throw error;
		throw new HttpError(400, "bad_request", "Invalid URL path parameter");
	}
}

export function createHttpHandler(
	options: HttpOptions,
	surface: "app" | "loopback",
	currentUrl: () => string,
	currentProblems: () => string[] = () => [],
) {
	return async (req: Request): Promise<Response> => {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			if (surface === "app" && (path.startsWith("/admin/") || path.startsWith("/internal/"))) {
				throw new HttpError(404, "not_found", "Route not found");
			}
			if (surface === "loopback" && path === "/internal/extension" && req.method === "POST") {
				if (req.headers.get("x-omp-mobile-token") !== options.extensionToken)
					throw new HttpError(401, "unauthorized", "Invalid extension token");
				options.hub.ingest(ExtensionSchema.parse(await body(req)) as ExtensionEvent);
				return new Response(null, { status: 204 });
			}
			if (surface === "loopback" && path.startsWith("/admin/")) {
				if (bearer(req) !== options.adminToken) throw new HttpError(401, "unauthorized", "Invalid admin token");
				if (path === "/admin/status" && req.method === "GET") {
					const live = options.hub.status();
					const status: AdminStatus = {
						machineName: options.config.machineName,
						url: currentUrl(),
						ompVersion: options.ompVersion,
						apnsConfigured: Boolean(options.config.apns),
						devices: options.devices.list().map(({ id, name, pairedAt, lastSeenAt }) => ({
							id,
							name,
							pairedAt,
							...(lastSeenAt ? { lastSeenAt } : {}),
						})),
						pairings: options.devices.listPairings(),
						live: { server: live.server, terminal: live.terminal, pending: live.pending },
						problems: [...live.problems, ...currentProblems()],
					};
					return json(status);
				}
				if (path === "/admin/pairing" && req.method === "POST") {
					const pairing = options.devices.createPairing();
					return json({
						...pairing,
						pairingUrl: encodePairingUrl({ url: currentUrl(), code: pairing.code, name: options.config.machineName }),
					});
				}
				const match = path.match(/^\/admin\/devices\/([^/]+)$/);
				if (match && req.method === "DELETE") {
					if (!(await options.devices.remove(parsePathParam(match[1]!))))
						throw new HttpError(404, "not_found", "Device not found");
					return new Response(null, { status: 204 });
				}
				throw new HttpError(404, "not_found", "Admin route not found");
			}
			if (path === "/v1/pair" && req.method === "POST") {
				const request = PairSchema.parse(await body(req));
				const paired = await options.devices.pair(
					request.code,
					request.deviceName,
					request.push,
					request.previousToken,
				);
				if (!paired) throw new HttpError(400, "bad_request", "Pairing code is invalid or expired");
				return json({
					machineId: options.machineId,
					machineName: options.config.machineName,
					deviceId: paired.device.id,
					token: paired.token,
					pushKey: paired.device.pushKey,
				});
			}
			const device = await requireDevice(req, options.devices);
			if (path === "/v1/info" && req.method === "GET") return json(serverInfo(options));
			if (path === "/v1/devices/me/push" && req.method === "PUT") {
				await options.devices.setPush(device.id, PushSchema.parse(await body(req)));
				return new Response(null, { status: 204 });
			}
			if (path === "/v1/devices/me" && req.method === "DELETE") {
				await options.devices.remove(device.id);
				return new Response(null, { status: 204 });
			}
			if (path === "/v1/sessions" && req.method === "GET") {
				const cursor = url.searchParams.get("cursor") ?? undefined;
				const page = await options.history.listSessions({ cursor, limit: parseLimit(url, 40, 100) });
				const historyItems = page.items.map((item) => summary(item, options.hub));
				const historyIds = new Set(historyItems.map((item) => item.id));
				const items = cursor
					? historyItems
					: [...historyItems, ...options.hub.activeSummaries().filter((item) => !historyIds.has(item.id))].sort(
							(left, right) => right.updatedAt.localeCompare(left.updatedAt),
						);
				return json({ items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
			}
			if (path === "/v1/sessions" && req.method === "POST") {
				const request = CreateSessionSchema.parse(await body(req));
				request.cwd = await options.history.resolveProjectDir(request.cwd);
				return json(await options.hub.createSession(request), 201);
			}
			if (path === "/v1/projects/recent" && req.method === "GET")
				return json({ projects: await options.history.recentProjects(50) });
			if (path === "/v1/fs/dirs" && req.method === "GET")
				return json(await options.history.listDirectories(url.searchParams.get("path") ?? undefined));
			const itemsMatch = path.match(/^\/v1\/sessions\/([^/]+)\/items$/);
			if (itemsMatch && req.method === "GET") {
				return json(
					await options.history.readTimeline(parsePathParam(itemsMatch[1]!), {
						before: url.searchParams.get("before") ?? undefined,
						limit: parseLimit(url, 40, 100),
					}),
				);
			}
			const actionMatch = path.match(/^\/v1\/sessions\/([^/]+)\/(prompt|abort|handoff)$/);
			if (actionMatch && req.method === "POST") {
				const sessionId = parsePathParam(actionMatch[1]!);
				if (actionMatch[2] === "prompt")
					return json(await options.hub.prompt(sessionId, PromptSchema.parse(await body(req))));
				if (actionMatch[2] === "abort") await options.hub.abort(sessionId);
				else await options.hub.handoff(sessionId);
				return new Response(null, { status: 204 });
			}
			const modelRoleMatch = path.match(/^\/v1\/sessions\/([^/]+)\/model-role$/);
			if (modelRoleMatch && req.method === "POST") {
				const { role } = ModelRoleSchema.parse(await body(req));
				await options.hub.setModelRole(parsePathParam(modelRoleMatch[1]!), role);
				return json({ modelRole: role } satisfies ModelRoleResponse);
			}
			const respondMatch = path.match(/^\/v1\/sessions\/([^/]+)\/interactions\/([^/]+)\/respond$/);
			if (respondMatch && req.method === "POST")
				return json(
					await options.hub.respond(
						parsePathParam(respondMatch[1]!),
						parsePathParam(respondMatch[2]!),
						ResponseSchema.parse(await body(req)),
					),
				);
			const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
			if (sessionMatch && req.method === "GET") {
				const sessionId = parsePathParam(sessionMatch[1]!);
				const snapshot = await options.hub.snapshot(sessionId, parseLimit(url, 40, 100));
				if (!snapshot) throw new HttpError(404, "not_found", "Session not found");
				return json(snapshot);
			}
			throw new HttpError(404, "not_found", "Route not found");
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export async function startHttp(options: HttpOptions): Promise<HttpService> {
	let tailscale: TailscaleState = { kind: "unavailable", problem: "Tailscale status has not been checked" };
	let appServer: Bun.Server<SocketData> | undefined;
	let appIp: string | undefined;
	const epoch = randomBytes(16).toString("base64url");
	const currentUrl = () =>
		tailscale.kind === "available"
			? `http://${tailscale.identity.dnsName}:${options.config.port}`
			: `http://127.0.0.1:${options.config.port}`;
	const websocket = {
		open(ws: Bun.ServerWebSocket<SocketData>) {
			ws.data.unsubscribeBroadcast = options.hub.onBroadcast((message) => ws.send(JSON.stringify(message)));
			ws.send(JSON.stringify({ type: "hello", epoch, info: serverInfo(options) } satisfies ServerMessage));
		},
		message(ws: Bun.ServerWebSocket<SocketData>, raw: string | Buffer) {
			try {
				const message: ClientMessage = ClientMessageSchema.parse(JSON.parse(String(raw)));
				if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies ServerMessage));
				else if (message.type === "subscribe" && !ws.data.unsubscribers.has(message.sessionId)) {
					ws.data.unsubscribers.set(
						message.sessionId,
						options.hub.subscribe(message.sessionId, (out) => ws.send(JSON.stringify(out))),
					);
				} else if (message.type === "unsubscribe") {
					ws.data.unsubscribers.get(message.sessionId)?.();
					ws.data.unsubscribers.delete(message.sessionId);
				}
			} catch (error) {
				ws.send(
					JSON.stringify({
						type: "error",
						error: { code: "bad_request", message: error instanceof Error ? error.message : "Invalid message" },
					} satisfies ServerMessage),
				);
			}
		},
		close(ws: Bun.ServerWebSocket<SocketData>) {
			for (const unsubscribe of ws.data.unsubscribers.values()) unsubscribe();
			ws.data.unsubscribeBroadcast?.();
		},
	};
	const createServer = (hostname: string, surface: "app" | "loopback") => {
		const handler = createHttpHandler(options, surface, currentUrl, () =>
			tailscale.kind === "unavailable" ? [tailscale.problem] : [],
		);
		return Bun.serve<SocketData>({
			hostname,
			port: options.config.port,
			websocket,
			async fetch(req, server) {
				const url = new URL(req.url);
				if (url.pathname === "/v1/stream") {
					const token = bearer(req);
					const device = token ? await options.devices.authenticate(token) : null;
					if (!token || !device)
						return errorResponse(new HttpError(401, "unauthorized", "A valid device bearer token is required"));
					if (server.upgrade(req, { data: { token, deviceId: device.id, unsubscribers: new Map() } })) return;
					return errorResponse(new HttpError(503, "unavailable", "WebSocket upgrade failed"));
				}
				return handler(req);
			},
		});
	};
	const loopback = createServer("127.0.0.1", "loopback");
	const monitor = watchTailscale(async (next) => {
		tailscale = next;
		if (next.kind !== "available") {
			appServer?.stop(true);
			appServer = undefined;
			appIp = undefined;
			return;
		}
		if (appIp === next.identity.ip) return;
		appServer?.stop(true);
		try {
			appServer = createServer(next.identity.ip, "app");
			appIp = next.identity.ip;
		} catch (error) {
			tailscale = {
				kind: "unavailable",
				problem: `Cannot bind Tailscale listener: ${error instanceof Error ? error.message : String(error)}`,
			};
			appServer = undefined;
			appIp = undefined;
		}
	});
	await monitor.check();
	return {
		get url() {
			return currentUrl();
		},
		get tailscale() {
			return tailscale;
		},
		async stop() {
			monitor.stop();
			appServer?.stop(true);
			loopback.stop(true);
		},
	};
}
