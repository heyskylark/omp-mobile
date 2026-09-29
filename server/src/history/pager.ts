import { createHmac, timingSafeEqual } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { TimelineItem } from "@omp-mobile/protocol";
import type { DurableTail } from "./api";
import { mapEntry, messageKey, parseLine, type RawEntry } from "./jsonl";

interface Descriptor {
	offset: number;
	length: number;
	id: string;
	parentId: string | null;
	type: string;
}

interface FileIndex {
	dev: number;
	ino: number;
	size: number;
	scannedThrough: number;
	entries: Descriptor[];
	byId: Map<string, number>;
}

interface PagePosition {
	ordinal: number;
	itemEnd?: number;
}

interface CursorPayload extends PagePosition {
	sid: string;
	dev: number;
	ino: number;
}

export class InvalidHistoryCursorError extends Error {
	readonly code = "INVALID_CURSOR";
	constructor() {
		super("Invalid or expired timeline cursor");
		this.name = "InvalidHistoryCursorError";
	}
}

function cursorPart(value: string | Buffer) {
	return Buffer.from(value).toString("base64url");
}

export class SessionPager {
	readonly #secret: Uint8Array;
	readonly #indexes = new Map<string, FileIndex>();

	constructor(secret: Uint8Array) {
		this.#secret = secret;
	}

	#sign(body: string) {
		return cursorPart(createHmac("sha256", this.#secret).update(body).digest());
	}

	#encode(payload: CursorPayload) {
		const body = cursorPart(JSON.stringify(payload));
		return `${body}.${this.#sign(body)}`;
	}

	#decode(cursor: string, sessionId: string, index: FileIndex): PagePosition {
		const parts = cursor.split(".");
		if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidHistoryCursorError();
		const actual = Buffer.from(parts[1], "base64url");
		const expected = Buffer.from(this.#sign(parts[0]), "base64url");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidHistoryCursorError();
		try {
			const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<CursorPayload>;
			if (
				value.sid !== sessionId ||
				value.dev !== index.dev ||
				value.ino !== index.ino ||
				!Number.isInteger(value.ordinal) ||
				value.ordinal! < 0 ||
				value.ordinal! > index.entries.length ||
				(value.itemEnd !== undefined && (!Number.isInteger(value.itemEnd) || value.itemEnd < 0))
			)
				throw new InvalidHistoryCursorError();
			return { ordinal: value.ordinal!, ...(value.itemEnd === undefined ? {} : { itemEnd: value.itemEnd }) };
		} catch (error) {
			if (error instanceof InvalidHistoryCursorError) throw error;
			throw new InvalidHistoryCursorError();
		}
	}

	async #index(file: string): Promise<FileIndex> {
		const info = await stat(file);
		let index = this.#indexes.get(file);
		if (!index || index.dev !== info.dev || index.ino !== info.ino || info.size < index.size) {
			index = { dev: info.dev, ino: info.ino, size: 0, scannedThrough: 0, entries: [], byId: new Map() };
			this.#indexes.set(file, index);
		}
		if (info.size === index.size) return index;
		const handle = await open(file, "r");
		try {
			const chunkSize = 64 * 1024;
			let position = index.scannedThrough;
			let pending = Buffer.alloc(0);
			let pendingOffset = position;
			while (position < info.size) {
				const buffer = Buffer.allocUnsafe(Math.min(chunkSize, info.size - position));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				const data = pending.length
					? Buffer.concat([pending, buffer.subarray(0, bytesRead)])
					: buffer.subarray(0, bytesRead);
				let start = 0;
				for (;;) {
					const newline = data.indexOf(10, start);
					if (newline < 0) break;
					const absoluteOffset = pendingOffset + start;
					const length = newline + 1 - start;
					const value = parseLine(data.subarray(start, newline).toString("utf8"));
					if (
						value &&
						value.type !== "title" &&
						value.type !== "session" &&
						typeof value.type === "string" &&
						typeof value.id === "string"
					) {
						const descriptor: Descriptor = {
							offset: absoluteOffset,
							length,
							id: value.id,
							parentId: typeof value.parentId === "string" ? value.parentId : null,
							type: value.type,
						};
						index.byId.set(descriptor.id, index.entries.length);
						index.entries.push(descriptor);
					}
					start = newline + 1;
				}
				pending = Buffer.from(data.subarray(start));
				pendingOffset += start;
				position += bytesRead;
			}
			index.scannedThrough = pendingOffset;
			index.size = info.size;
			return index;
		} finally {
			await handle.close();
		}
	}

	#active(index: FileIndex) {
		const active: number[] = [];
		const seen = new Set<string>();
		let ordinal = index.entries.length - 1;
		while (ordinal >= 0) {
			const descriptor = index.entries[ordinal];
			if (!descriptor || seen.has(descriptor.id)) break;
			seen.add(descriptor.id);
			active.push(ordinal);
			if (descriptor.parentId === null) break;
			const parent = index.byId.get(descriptor.parentId);
			if (parent === undefined) break;
			ordinal = parent;
		}
		active.reverse();
		return active;
	}

	async #readEntry(file: string, descriptor: Descriptor): Promise<RawEntry | undefined> {
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.allocUnsafe(descriptor.length);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, descriptor.offset);
			const value = parseLine(buffer.subarray(0, bytesRead).toString("utf8"));
			return value as RawEntry | undefined;
		} finally {
			await handle.close();
		}
	}

	async #toolResults(file: string, index: FileIndex, active: number[], start: number, end = active.length) {
		const results = new Map<string, Record<string, unknown>>();
		for (let activeOrdinal = start; activeOrdinal < Math.min(end, active.length); activeOrdinal++) {
			const descriptor = index.entries[active[activeOrdinal]!];
			if (!descriptor || descriptor.type !== "message") continue;
			const entry = await this.#readEntry(file, descriptor);
			if (!entry?.message || typeof entry.message !== "object") continue;
			const message = entry.message as Record<string, unknown>;
			if (message.role === "toolResult" && typeof message.toolCallId === "string")
				results.set(message.toolCallId, message);
		}
		return results;
	}

	async page(file: string, sessionId: string, before: string | undefined, limit: number) {
		const index = await this.#index(file);
		const active = this.#active(index);
		const start = before ? this.#decode(before, sessionId, index) : { ordinal: active.length };
		if (start.ordinal > active.length) throw new InvalidHistoryCursorError();
		const results = await this.#toolResults(file, index, active, start.ordinal, start.ordinal + 256);
		const selected: TimelineItem[] = [];
		let position: PagePosition = start;
		while (selected.length < limit && position.ordinal > 0) {
			const activeOrdinal = position.ordinal - 1;
			const descriptor = index.entries[active[activeOrdinal]!];
			if (!descriptor) break;
			const entry = await this.#readEntry(file, descriptor);
			if (entry?.type === "message" && entry.message && typeof entry.message === "object") {
				const message = entry.message as Record<string, unknown>;
				if (message.role === "toolResult" && typeof message.toolCallId === "string")
					results.set(message.toolCallId, message);
			}
			const mapped = entry ? mapEntry(entry, results) : [];
			const end = position.itemEnd === undefined ? mapped.length : Math.min(position.itemEnd, mapped.length);
			const take = Math.min(limit - selected.length, end);
			const begin = end - take;
			selected.unshift(...mapped.slice(begin, end));
			position = begin > 0 ? { ordinal: position.ordinal, itemEnd: begin } : { ordinal: activeOrdinal };
			if (take === 0) position = { ordinal: activeOrdinal };
		}
		return {
			items: selected,
			...(position.ordinal > 0
				? { olderCursor: this.#encode({ sid: sessionId, dev: index.dev, ino: index.ino, ...position }) }
				: {}),
		};
	}

	async tail(file: string, afterEntryId: string | undefined, limit: number): Promise<DurableTail> {
		const index = await this.#index(file);
		const active = this.#active(index);
		let start = 0;
		if (afterEntryId) {
			const descriptorOrdinal = index.byId.get(afterEntryId);
			const activeOrdinal = descriptorOrdinal === undefined ? -1 : active.indexOf(descriptorOrdinal);
			if (activeOrdinal >= 0) start = activeOrdinal + 1;
		}
		const results = await this.#toolResults(file, index, active, start);
		const items: TimelineItem[] = [];
		const messageKeys: DurableTail["messageKeys"] = [];
		for (let i = start; i < active.length; i++) {
			const descriptor = index.entries[active[i]!];
			if (!descriptor) continue;
			const entry = await this.#readEntry(file, descriptor);
			if (!entry) continue;
			const mapped = mapEntry(entry, results);
			items.push(...mapped);
			const key = messageKey(entry);
			if (key) messageKeys.push(key);
		}
		const bounded = items.length > limit ? items.slice(-limit) : items;
		const included = new Set(bounded.map((item) => item.id));
		return {
			items: bounded,
			messageKeys: messageKeys.filter((key) => included.has(key.itemId)),
			...(active.length ? { lastEntryId: index.entries[active.at(-1)!]?.id } : {}),
		};
	}
}
