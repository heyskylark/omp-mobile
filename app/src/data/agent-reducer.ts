import type {
	AgentSummary,
	AgentThreadSnapshot,
	ServerMessage,
	TimelineItem,
	TimelinePage,
} from "@omp-mobile/protocol";
import { upsert } from "./session-reducer";

export type AgentThreadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| {
			kind: "ready";
			sessionId: string;
			agentId: string;
			agents: AgentSummary[];
			items: TimelineItem[];
			olderCursor?: string;
			loadingOlder: boolean;
	  };

export type AgentThreadAction =
	| { type: "snapshot"; sessionId: string; agentId: string; snapshot: AgentThreadSnapshot }
	| { type: "older.start" }
	| { type: "older.success"; page: TimelinePage }
	| { type: "older.error" }
	| { type: "server"; message: ServerMessage }
	| { type: "error"; message: string };

export function agentThreadReducer(state: AgentThreadState, action: AgentThreadAction): AgentThreadState {
	if (action.type === "snapshot")
		return {
			kind: "ready",
			sessionId: action.sessionId,
			agentId: action.agentId,
			agents: action.snapshot.agents,
			items: upsert([], action.snapshot.items),
			olderCursor: action.snapshot.olderCursor,
			loadingOlder: false,
		};
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
			if (message.type === "session.agents" && message.sessionId === state.sessionId)
				return { ...state, agents: message.agents };
			if (
				message.type === "agent.timeline" &&
				message.sessionId === state.sessionId &&
				message.agentId === state.agentId
			)
				return { ...state, items: upsert(state.items, message.items) };
			return state;
		}
	}
}
