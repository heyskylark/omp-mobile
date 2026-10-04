import type { TimelineItem } from "@omp-mobile/protocol";
import { useSyncExternalStore } from "react";
import { type OmpApi, operationId as newOperationId } from "./api";
import type { PickedImage } from "./attachments";

/**
 * How long a session stays idle after a turn before a sent message it never showed counts as undelivered. The
 * transcript trails the turn: OMP writes a new session's first prompt to history only with the reply.
 */
export const UNDELIVERED_AFTER_MS = 4_000;

export type OutgoingStatus =
	| { kind: "sending" }
	/** `turnSeen`: the session ran a turn after taking the message, so ending idle without it means OMP dropped it. */
	| { kind: "sent"; turnSeen: boolean }
	/**
	 * "unsent": the request failed and may not have reached the computer. "undelivered": the computer took the
	 * message but OMP never added it to the transcript, e.g. a steer still queued when the turn was stopped.
	 */
	| { kind: "failed"; reason: "unsent" | "undelivered"; error: string };

/** A message the phone sent that the session's transcript does not show yet. */
export interface OutgoingMessage {
	/** Kept when retrying a request that may have reached the computer, so the server ignores a second copy. */
	operationId: string;
	text: string;
	images: PickedImage[];
	status: OutgoingStatus;
	/** Time of the newest transcript item when it was sent. Only a user message recorded later can be this one. */
	sentAfter: string;
	/** Time of the newest transcript item when it was last sent or retried; the bubble shows after those items. */
	shownAfter: string;
}

/**
 * Messages sent to one session until its transcript shows them. A user message that appears after a send stands in
 * for the oldest pending message with the same text; failing that, for the oldest one not failed, since OMP can
 * rewrite what it records (prompt templates, for one).
 */
export class SessionOutbox {
	messages: OutgoingMessage[] = [];
	/** User messages already matched to a sent one. */
	#matched = new Set<string>();
	#working = false;
	#listeners = new Set<() => void>();

	constructor(readonly sessionId: string) {}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/** Adds a message and sends it. `transcript` is what the screen shows now. */
	send(api: OmpApi, text: string, images: PickedImage[], transcript: TimelineItem[]): void {
		const message = this.#add({ operationId: newOperationId(), text, images, status: { kind: "sending" } }, transcript);
		void this.#post(api, message);
	}

	/** Records the prompt a new session was created with; the server has already taken it. */
	created(text: string, images: PickedImage[]): void {
		this.#add({ operationId: newOperationId(), text, images, status: { kind: "sent", turnSeen: true } }, []);
	}

	/** `transcript` is what the screen shows now. */
	retry(api: OmpApi, operationId: string, transcript: TimelineItem[]): void {
		const failed = this.messages.find((message) => message.operationId === operationId);
		if (failed?.status.kind !== "failed") return;
		// The server remembers an operation it took, so an undelivered message goes out as a new one. An unsent one
		// keeps its operation and baseline: its first request may have landed after all. Either moves to the bottom.
		const shownAfter = newestAt(transcript);
		const message: OutgoingMessage =
			failed.status.reason === "undelivered"
				? {
						...failed,
						operationId: newOperationId(),
						status: { kind: "sending" },
						sentAfter: shownAfter,
						shownAfter,
					}
				: { ...failed, status: { kind: "sending" }, shownAfter };
		this.#replace(operationId, message);
		void this.#post(api, message);
	}

	/** Returns whether the message was still pending. */
	remove(operationId: string): boolean {
		const remaining = this.messages.filter((message) => message.operationId !== operationId);
		const removed = remaining.length < this.messages.length;
		this.#update(remaining);
		return removed;
	}

	/**
	 * Drops every pending message that a user message in `items` accounts for. `complete`: no older page exists.
	 * When the oldest loaded item is newer than a sent message (a fresh snapshot after a long turn), that message may
	 * sit in the unloaded gap, so it is dropped rather than later reported undelivered.
	 */
	reconcile(items: TimelineItem[], complete: boolean): void {
		const loadedFrom = complete || !items.length ? "" : items[0].at;
		let remaining = this.messages.filter(
			(message) => message.status.kind !== "sent" || message.sentAfter >= loadedFrom,
		);
		for (const item of items) {
			if (!remaining.length) break;
			if (item.kind !== "user" || this.#matched.has(item.id)) continue;
			const candidates = remaining.filter((message) => item.at > message.sentAfter);
			if (!candidates.length) continue;
			this.#matched.add(item.id);
			const text = item.blocks
				.flatMap((block) => (block.kind === "text" ? [block.text] : []))
				.join("\n")
				.trim();
			const match =
				candidates.find((message) => message.text.trim() === text) ??
				candidates.find((message) => message.status.kind !== "failed");
			if (match) remaining = remaining.filter((message) => message !== match);
		}
		this.#update(remaining);
	}

	/** Follows whether the session is running a turn; sent messages count from the next turn on. */
	observeTurn(working: boolean): void {
		this.#working = working;
		if (!working) return;
		this.#update(
			this.messages.map((message) =>
				message.status.kind === "sent" && !message.status.turnSeen
					? { ...message, status: { kind: "sent", turnSeen: true } }
					: message,
			),
		);
	}

	/** Fails sent messages a finished turn left out of the transcript. Call once the session has idled for a while. */
	expireUndelivered(): void {
		this.#update(
			this.messages.map((message) =>
				message.status.kind === "sent" && message.status.turnSeen
					? {
							...message,
							status: { kind: "failed", reason: "undelivered", error: "OMP did not add this message to the session." },
						}
					: message,
			),
		);
	}

	#add(message: Omit<OutgoingMessage, "sentAfter" | "shownAfter">, transcript: TimelineItem[]): OutgoingMessage {
		if (!this.messages.length) this.#matched.clear();
		const sentAfter = newestAt(transcript);
		const added = { ...message, sentAfter, shownAfter: sentAfter };
		this.#update([...this.messages, added]);
		return added;
	}

	async #post(api: OmpApi, message: OutgoingMessage): Promise<void> {
		let status: OutgoingStatus;
		try {
			await api.prompt(this.sessionId, {
				operationId: message.operationId,
				text: message.text,
				...(message.images.length ? { images: message.images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
			});
			status = { kind: "sent", turnSeen: this.#working };
		} catch (error) {
			status = {
				kind: "failed",
				reason: "unsent",
				error: error instanceof Error ? error.message : "Message not sent",
			};
		}
		// The transcript may already show the message, or the user removed it while the request ran.
		const current = this.messages.find((pending) => pending.operationId === message.operationId);
		if (current?.status.kind === "sending") this.#replace(message.operationId, { ...current, status });
	}

	#replace(operationId: string, next: OutgoingMessage): void {
		this.#update(this.messages.map((message) => (message.operationId === operationId ? next : message)));
	}

	#update(messages: OutgoingMessage[]): void {
		if (
			messages.length === this.messages.length &&
			messages.every((message, index) => message === this.messages[index])
		)
			return;
		this.messages = messages;
		for (const listener of this.#listeners) listener();
	}
}

/** Outboxes by `machineId/sessionId`, kept while the app runs so a reply in flight survives leaving the screen. */
const outboxes = new Map<string, SessionOutbox>();

export function sessionOutbox(machineId: string, sessionId: string): SessionOutbox {
	const key = `${machineId}/${sessionId}`;
	let outbox = outboxes.get(key);
	if (!outbox) {
		outbox = new SessionOutbox(sessionId);
		outboxes.set(key, outbox);
	}
	return outbox;
}

export type ChatRow = { kind: "item"; item: TimelineItem } | { kind: "outgoing"; message: OutgoingMessage };

/**
 * The transcript (oldest first) with each outgoing message after the items it was sent after, so a reply that
 * reaches the transcript before its prompt (a new session's first turn) still shows below that prompt. OMP records
 * user messages in the order it takes them, so a pending one also follows every recorded user message.
 */
export function chatRows(items: TimelineItem[], outgoing: OutgoingMessage[]): ChatRow[] {
	const lastUser = items.findLastIndex((item) => item.kind === "user");
	// Index of the item each message follows; -1 puts it before the whole transcript.
	const follows = outgoing.map((message) =>
		Math.max(
			lastUser,
			items.findLastIndex((item) => item.at <= message.shownAfter),
		),
	);
	const rows: ChatRow[] = [];
	const pushOutgoing = (index: number) => {
		for (const [i, message] of outgoing.entries()) if (follows[i] === index) rows.push({ kind: "outgoing", message });
	};
	pushOutgoing(-1);
	items.forEach((item, index) => {
		rows.push({ kind: "item", item });
		pushOutgoing(index);
	});
	return rows;
}

function newestAt(items: TimelineItem[]): string {
	return items.reduce((newest, item) => (item.at > newest ? item.at : newest), "");
}

export function useOutgoing(outbox: SessionOutbox): OutgoingMessage[] {
	return useSyncExternalStore(outbox.subscribe, () => outbox.messages);
}
