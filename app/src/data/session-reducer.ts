import type {
	PendingInteraction,
	ServerMessage,
	SessionSnapshot,
	SessionSummary,
	TimelineItem,
	TimelinePage,
} from "@omp-mobile/protocol";

export type SessionViewState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| {
			kind: "ready";
			session: SessionSummary;
			items: TimelineItem[];
			olderCursor?: string;
			pending: PendingInteraction[];
			loadingOlder: boolean;
	  };

export type SessionAction =
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "older.start" }
	| { type: "older.success"; page: TimelinePage }
	| { type: "older.error" }
	| { type: "server"; message: ServerMessage }
	| { type: "error"; message: string };

function upsert(current: TimelineItem[], additions: TimelineItem[]): TimelineItem[] {
	const byId = new Map(current.map((item) => [item.id, item]));
	for (const item of additions) byId.set(item.id, item);
	return [...byId.values()].sort((left, right) => left.at.localeCompare(right.at));
}

export function sessionViewReducer(state: SessionViewState, action: SessionAction): SessionViewState {
	if (action.type === "snapshot") {
		return { kind: "ready", ...action.snapshot, loadingOlder: false };
	}
	if (action.type === "error") return { kind: "error", message: action.message };
	if (state.kind !== "ready") return state;

	switch (action.type) {
		case "older.start":
			return { ...state, loadingOlder: true };
		case "older.error":
			return { ...state, loadingOlder: false };
		case "older.success":
			return {
				...state,
				items: upsert(action.page.items, state.items),
				olderCursor: action.page.olderCursor,
				loadingOlder: false,
			};
		case "server": {
			const message = action.message;
			if (!("sessionId" in message) || message.sessionId !== state.session.id) return state;
			switch (message.type) {
				case "session.snapshot":
					return { kind: "ready", ...message.snapshot, loadingOlder: false };
				case "timeline.upsert":
					return { ...state, items: upsert(state.items, message.items) };
				case "timeline.retire": {
					const retired = new Set(message.ids);
					return { ...state, items: state.items.filter((item) => !retired.has(item.id)) };
				}
				case "session.update":
					return { ...state, session: message.session, pending: message.pending };
				default:
					return state;
			}
		}
	}
}
