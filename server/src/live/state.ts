import type { Liveness } from "@omp-mobile/protocol";

export type OwnershipState =
	| { kind: "idle" }
	| { kind: "server"; phase: "starting" | "ready" | "working" | "settling"; pid?: number }
	| { kind: "terminal"; attached: boolean; pid: number; shutdownSeen: boolean; pidGone: boolean }
	| {
			kind: "conflict";
			message: string;
			serverPid?: number;
			terminalPid: number;
			shutdownSeen: boolean;
			pidGone: boolean;
	  }
	| { kind: "unavailable"; reason: string };

export type OwnershipEvent =
	| { type: "server.starting"; pid?: number }
	| { type: "server.ready"; pid?: number }
	| { type: "server.working" }
	| { type: "server.settling" }
	| { type: "server.closed" }
	| { type: "server.crashed"; reason?: string }
	| { type: "terminal.started"; pid: number }
	| { type: "terminal.attached" }
	| { type: "terminal.detached" }
	| { type: "terminal.shutdown"; pid: number }
	| { type: "terminal.pidGone"; pid: number }
	| { type: "unavailable"; reason: string };

export function reduceOwnership(state: OwnershipState, event: OwnershipEvent): OwnershipState {
	switch (event.type) {
		case "server.starting":
			return state.kind === "terminal" || state.kind === "conflict"
				? state
				: { kind: "server", phase: "starting", pid: event.pid };
		case "server.ready":
			return state.kind === "server" ? { ...state, phase: "ready", pid: event.pid ?? state.pid } : state;
		case "server.working":
			return state.kind === "server" ? { ...state, phase: "working" } : state;
		case "server.settling":
			return state.kind === "server" ? { ...state, phase: "settling" } : state;
		case "server.closed":
		case "server.crashed":
			if (state.kind === "server") return { kind: "idle" };
			if (state.kind !== "conflict") return state;
			if (state.shutdownSeen && state.pidGone) return { kind: "idle" };
			return {
				kind: "terminal",
				attached: false,
				pid: state.terminalPid,
				shutdownSeen: state.shutdownSeen,
				pidGone: state.pidGone,
			};
		case "terminal.started":
			if (state.kind === "server")
				return {
					kind: "conflict",
					message: "Session is also open in a terminal",
					serverPid: state.pid,
					terminalPid: event.pid,
					shutdownSeen: false,
					pidGone: false,
				};
			if (state.kind === "conflict") return state;
			return { kind: "terminal", attached: false, pid: event.pid, shutdownSeen: false, pidGone: false };
		case "terminal.attached":
			return state.kind === "terminal" ? { ...state, attached: true } : state;
		case "terminal.detached":
			return state.kind === "terminal" ? { ...state, attached: false } : state;
		case "terminal.shutdown":
			if (state.kind === "conflict" && state.terminalPid === event.pid) return { ...state, shutdownSeen: true };
			if (state.kind !== "terminal" || state.pid !== event.pid) return state;
			return state.pidGone ? { kind: "idle" } : { ...state, attached: false, shutdownSeen: true };
		case "terminal.pidGone":
			if (state.kind === "conflict" && state.terminalPid === event.pid) return { ...state, pidGone: true };
			if (state.kind !== "terminal" || state.pid !== event.pid) return state;
			return state.shutdownSeen ? { kind: "idle" } : { ...state, attached: false, pidGone: true };
		case "unavailable":
			return { kind: "unavailable", reason: event.reason };
	}
}

export function publicLiveness(state: OwnershipState): Liveness {
	switch (state.kind) {
		case "idle":
			return state;
		case "server":
			return { kind: "server", phase: state.phase };
		case "terminal":
			return { kind: "terminal", attached: state.attached };
		case "conflict":
			return { kind: "conflict", message: state.message };
		case "unavailable":
			return { kind: "unavailable", reason: state.reason };
	}
}
