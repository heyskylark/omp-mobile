import { readFile } from "node:fs/promises";
import { MAX_PINNED_SESSIONS } from "@omp-mobile/protocol";
import { z } from "zod";
import { writePrivateJson } from "../private-json.ts";

const PinFileSchema = z.object({
	pins: z.array(z.object({ sessionId: z.string().min(1), pinnedAt: z.iso.datetime() })),
});

export interface Pin {
	sessionId: string;
	pinnedAt: string;
}

export class PinLimitError extends Error {
	constructor() {
		super(`You can pin up to ${MAX_PINNED_SESSIONS} sessions. Unpin one first.`);
	}
}

/** Sessions pinned to the top of this computer's list, kept in `pins.json` so every phone sees the same pins. */
export interface PinStore {
	load(): Promise<void>;
	/** Earliest pinned first. */
	list(): Pin[];
	/** Pinning a pinned session keeps its original time; a new pin beyond the limit throws `PinLimitError`. */
	pin(sessionId: string): Promise<Pin>;
	/** Unpinning a session that is not pinned does nothing. */
	unpin(sessionIds: readonly string[]): Promise<void>;
	/** Called after every change is saved. */
	onChange(listener: () => void): () => void;
}

export function createPinStore(path: string, now: () => number = Date.now): PinStore {
	// Insertion order is pin order: a pin is only ever appended, never re-timed.
	const pins = new Map<string, string>();
	const listeners = new Set<() => void>();
	let writeQueue = Promise.resolve();

	const persist = async () => {
		const snapshot = { pins: [...pins].map(([sessionId, pinnedAt]) => ({ sessionId, pinnedAt })) };
		const write = writeQueue.then(() => writePrivateJson(path, snapshot));
		writeQueue = write.catch(() => {});
		await write;
		for (const listener of listeners) listener();
	};

	return {
		async load() {
			try {
				const parsed = PinFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
				pins.clear();
				for (const pin of parsed.pins.sort((left, right) => left.pinnedAt.localeCompare(right.pinnedAt)))
					pins.set(pin.sessionId, pin.pinnedAt);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		},
		list() {
			return [...pins].map(([sessionId, pinnedAt]) => ({ sessionId, pinnedAt }));
		},
		async pin(sessionId) {
			const existing = pins.get(sessionId);
			if (existing) return { sessionId, pinnedAt: existing };
			if (pins.size >= MAX_PINNED_SESSIONS) throw new PinLimitError();
			const pinnedAt = new Date(now()).toISOString();
			pins.set(sessionId, pinnedAt);
			await persist();
			return { sessionId, pinnedAt };
		},
		async unpin(sessionIds) {
			let changed = false;
			for (const sessionId of sessionIds) changed = pins.delete(sessionId) || changed;
			if (changed) await persist();
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
