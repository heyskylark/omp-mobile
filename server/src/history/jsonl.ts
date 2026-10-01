import type { Block, TimelineItem } from "@omp-mobile/protocol";

export interface RawEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	cwd: string;
	timestamp?: string;
	title?: string;
}

export function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.trimStart().startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function parseHeader(prefix: string): { header: SessionHeader; slotTitle?: string } | undefined {
	let slotTitle: string | undefined;
	for (const line of prefix.split(/\r?\n/)) {
		const value = parseLine(line);
		if (!value) continue;
		if (value.type === "title") {
			if (typeof value.title === "string" && value.title.trim()) slotTitle = value.title.trim();
			continue;
		}
		if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") return undefined;
		return {
			header: {
				type: "session",
				version: typeof value.version === "number" ? value.version : undefined,
				id: value.id,
				cwd: value.cwd,
				timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
				title: typeof value.title === "string" ? value.title : undefined,
			},
			slotTitle,
		};
	}
	return undefined;
}

function iso(entry: RawEntry, message?: Record<string, unknown>): string {
	const timestamp = message?.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	if (typeof timestamp === "string") {
		const date = new Date(timestamp);
		if (!Number.isNaN(date.valueOf())) return date.toISOString();
	}
	const date = new Date(entry.timestamp ?? 0);
	return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function compact(value: unknown, max: number): { text: string; truncated: boolean } {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(0, max), truncated: true };
}

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const result: Block[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") result.push({ kind: "text", text: block.text });
		else if ((block.type === "thinking" || block.type === "reasoning") && typeof block.thinking === "string")
			result.push({ kind: "thinking", text: block.thinking, ...(block.redacted === true ? { redacted: true } : {}) });
		else if ((block.type === "thinking" || block.type === "reasoning") && typeof block.text === "string")
			result.push({ kind: "thinking", text: block.text, ...(block.redacted === true ? { redacted: true } : {}) });
		else if (block.type === "redactedThinking" || block.type === "redacted_thinking")
			result.push({ kind: "thinking", text: "Thinking redacted", redacted: true });
		else if (block.type === "image" || block.type === "image_url")
			result.push({ kind: "image", ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}) });
	}
	return result;
}

function toolTitle(tool: Record<string, unknown>): string {
	const args = tool.arguments ?? tool.input;
	if (typeof tool.intent === "string" && tool.intent) return tool.intent;
	if (args && typeof args === "object" && typeof (args as Record<string, unknown>).i === "string")
		return (args as Record<string, unknown>).i as string;
	return typeof tool.name === "string" ? tool.name : "Tool";
}

function toolInput(tool: Record<string, unknown>): string {
	const args = tool.arguments ?? tool.input;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["command", "path"]) if (typeof record[key] === "string") return compact(record[key], 2000).text;
	}
	return compact(args ?? {}, 2000).text;
}

function resultOutput(message: Record<string, unknown>): {
	output?: string;
	outputTruncated?: boolean;
	failed: boolean;
} {
	const content = message.content;
	let value: unknown = content;
	if (Array.isArray(content))
		value = content
			.map((part) =>
				typeof part === "object" && part && typeof (part as Record<string, unknown>).text === "string"
					? (part as Record<string, unknown>).text
					: part,
			)
			.join("\n");
	const out = compact(value ?? "", 4000);
	const failed = message.isError === true || message.error === true;
	return { ...(out.text ? { output: out.text } : {}), ...(out.truncated ? { outputTruncated: true } : {}), failed };
}

/** Agent ids a `task` call spawned, from its (partial) result's `details.progress`; nested ids are already dotted. */
export function taskAgentIds(result: unknown): string[] {
	if (!result || typeof result !== "object" || !("details" in result)) return [];
	const details = result.details;
	if (!details || typeof details !== "object" || !("progress" in details) || !Array.isArray(details.progress))
		return [];
	return details.progress.flatMap((progress: unknown) =>
		progress && typeof progress === "object" && "id" in progress && typeof progress.id === "string"
			? [progress.id]
			: [],
	);
}

/** `thinkingLevel` is the reasoning level OMP recorded right after a `model_change` (its child `thinking_level_change`). */
export function mapEntry(
	entry: RawEntry,
	toolResults: ReadonlyMap<string, Record<string, unknown>>,
	thinkingLevel?: string,
): TimelineItem[] {
	const at = iso(entry);
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const message = entry.message as Record<string, unknown>;
		const messageAt = iso(entry, message);
		if (message.role === "user")
			return [{ id: `e:${entry.id}`, kind: "user", at: messageAt, blocks: blocks(message.content) }];
		if (message.role === "assistant") {
			const items: TimelineItem[] = [
				{
					id: `e:${entry.id}`,
					kind: "assistant",
					at: messageAt,
					blocks: blocks(message.content),
					streaming: false,
					...(typeof message.model === "string" ? { model: message.model } : {}),
					...(["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason))
						? { stopReason: message.stopReason as "stop" | "length" | "toolUse" | "error" | "aborted" }
						: {}),
					...(typeof message.error === "string" ? { error: message.error } : {}),
				},
			];
			for (const raw of Array.isArray(message.content) ? message.content : []) {
				if (!raw || typeof raw !== "object") continue;
				const call = raw as Record<string, unknown>;
				if (call.type !== "toolCall" || typeof call.id !== "string") continue;
				const result = toolResults.get(call.id);
				const output = result ? resultOutput(result) : undefined;
				const agentIds = call.name === "task" ? taskAgentIds(result) : [];
				items.push({
					id: `t:${call.id}`,
					kind: "tool",
					at: messageAt,
					name: typeof call.name === "string" ? call.name : "tool",
					title: toolTitle(call),
					input: toolInput(call),
					state: output ? (output.failed ? "failed" : "succeeded") : "running",
					...(output?.output ? { output: output.output } : {}),
					...(output?.outputTruncated ? { outputTruncated: true } : {}),
					...(agentIds.length ? { agentIds } : {}),
				});
			}
			return items;
		}
		if (
			message.role === "developer" ||
			message.role === "toolResult" ||
			message.role === "fileMention" ||
			message.role === "hookMessage"
		)
			return [];
		return [
			{
				id: `e:${entry.id}`,
				kind: "unsupported",
				at: messageAt,
				label: `message:${String(message.role ?? "unknown")}`,
			},
		];
	}
	if (entry.type === "custom_message") {
		if (entry.customType === "collab-prompt")
			return [{ id: `e:${entry.id}`, kind: "user", at, blocks: blocks(entry.content) }];
		// `/skill:<name>` typed by the user: show what they typed, not the expanded SKILL.md body OMP sends the model.
		if (entry.customType === "skill-prompt" && entry.attribution === "user") {
			const details = (entry.details ?? {}) as Record<string, unknown>;
			if (typeof details.prompt === "string")
				return [{ id: `e:${entry.id}`, kind: "user", at, blocks: [{ kind: "text", text: details.prompt }] }];
		}
		// OMP hands a finished background agent's whole result to the model; the thread shows only who finished.
		if (entry.customType === "async-result") {
			const details = entry.details;
			const jobs = details && typeof details === "object" && "jobs" in details ? details.jobs : undefined;
			const agentIds = (Array.isArray(jobs) ? jobs : []).flatMap((job: unknown) =>
				job &&
				typeof job === "object" &&
				"type" in job &&
				job.type === "task" &&
				"jobId" in job &&
				typeof job.jobId === "string"
					? [job.jobId]
					: [],
			);
			if (agentIds.length)
				return [
					{
						id: `e:${entry.id}`,
						kind: "event",
						at,
						tone: "info",
						text: `${agentIds.map((id) => id.slice(id.lastIndexOf(".") + 1)).join(", ")} finished`,
						agentIds,
					},
				];
		}
		if (entry.display === false) return [];
		return [
			{
				id: `e:${entry.id}`,
				kind: "event",
				at,
				tone: "info",
				text: compact(entry.content ?? entry.customType ?? "Extension message", 4000).text,
			},
		];
	}
	if (entry.type === "compaction")
		return [
			{
				id: `e:${entry.id}`,
				kind: "event",
				at,
				tone: "info",
				text:
					typeof entry.shortSummary === "string"
						? `Conversation compacted: ${entry.shortSummary}`
						: "Conversation compacted",
			},
		];
	if (entry.type === "branch_summary")
		return [
			{
				id: `e:${entry.id}`,
				kind: "event",
				at,
				tone: "info",
				text: typeof entry.summary === "string" ? `Branch summary: ${entry.summary}` : "Branch changed",
			},
		];
	if (entry.type === "model_change") {
		const reasoning =
			thinkingLevel === undefined ? "" : thinkingLevel === "off" ? " · reasoning off" : ` · ${thinkingLevel} reasoning`;
		return [
			{
				id: `e:${entry.id}`,
				kind: "event",
				at,
				tone: "info",
				text: `Model changed to ${String(entry.model ?? "unknown")}${reasoning}`,
			},
		];
	}
	if (entry.type === "reset_boundary")
		return [{ id: `e:${entry.id}`, kind: "event", at, tone: "warning", text: "Conversation cleared" }];
	if (entry.type === "notice")
		return [
			{
				id: `e:${entry.id}`,
				kind: "event",
				at,
				tone: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
				text: compact(entry.message ?? entry.text ?? "Notice", 4000).text,
			},
		];
	if (
		[
			"thinking_level_change",
			"service_tier_change",
			"title_change",
			"label",
			"ttsr_injection",
			"credential_pin",
			"session_init",
			"mode_change",
			"custom",
		].includes(entry.type)
	)
		return [];
	return [{ id: `e:${entry.id}`, kind: "unsupported", at, label: entry.type }];
}

export function messageKey(
	entry: RawEntry,
): { itemId: string; role: "user" | "assistant"; timestamp: number } | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp ?? "");
	if (!Number.isFinite(timestamp)) return undefined;
	return { itemId: `e:${entry.id}`, role: message.role, timestamp };
}

export function textFromContent(content: unknown): string {
	return blocks(content)
		.filter((block): block is { kind: "text"; text: string } => block.kind === "text")
		.map((block) => block.text)
		.join(" ")
		.trim();
}
