import type {
	AgentSummary,
	ModelRole,
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
			agents: AgentSummary[];
			olderCursor?: string;
			pending: PendingInteraction[];
			modelRole: ModelRole | null;
			loadingOlder: boolean;
	  };

export type SessionAction =
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "older.start" }
	| { type: "older.success"; page: TimelinePage }
	| { type: "older.error" }
	| { type: "server"; message: ServerMessage }
	| { type: "modelRole"; modelRole: ModelRole | null }
	| { type: "error"; message: string };

export function upsert(current: TimelineItem[], additions: TimelineItem[]): TimelineItem[] {
	const byId = new Map(current.map((item) => [item.id, item]));
	for (const item of additions) {
		const existing = byId.get(item.id);
		// The server's history tail can report a tool call as running after its live end event already arrived
		// (the call is saved before its result); a finished tool never runs again.
		if (item.kind === "tool" && item.state === "running" && existing?.kind === "tool" && existing.state !== "running")
			continue;
		byId.set(item.id, item);
	}
	return [...byId.values()].sort((left, right) => left.at.localeCompare(right.at));
}

function ready(snapshot: SessionSnapshot): SessionViewState {
	// Servers older than the model-role or agents fields omit them.
	return {
		kind: "ready",
		...snapshot,
		modelRole: snapshot.modelRole ?? null,
		agents: snapshot.agents ?? [],
		loadingOlder: false,
	};
}

export function sessionViewReducer(state: SessionViewState, action: SessionAction): SessionViewState {
	if (action.type === "snapshot") return ready(action.snapshot);
	if (action.type === "error") return { kind: "error", message: action.message };
	if (state.kind !== "ready") return state;

	switch (action.type) {
		case "older.start":
			return { ...state, loadingOlder: true };
		case "older.error":
			return { ...state, loadingOlder: false };
		case "modelRole":
			return { ...state, modelRole: action.modelRole };
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
					return ready(message.snapshot);
				case "timeline.upsert":
					return { ...state, items: upsert(state.items, message.items) };
				case "timeline.retire": {
					const retired = new Set(message.ids);
					return { ...state, items: state.items.filter((item) => !retired.has(item.id)) };
				}
				case "session.update":
					return { ...state, session: message.session, pending: message.pending };
				case "session.modelRole":
					return { ...state, modelRole: message.modelRole };
				case "session.agents":
					return { ...state, agents: message.agents };
				default:
					return state;
			}
		}
	}
}
