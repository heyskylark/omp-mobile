import type { useNavigationContainerRef } from "expo-router";
import type { NotificationOpen } from "./native/types";

type ContainerRef = ReturnType<typeof useNavigationContainerRef>;
type NestedState = NonNullable<NonNullable<ReturnType<ContainerRef["getRootState"]>>["routes"][number]["state"]>;
type StackState = Extract<NestedState, { stale: false }>;
type StackRoute = StackState["routes"][number];

const COMPUTERS = "index";
const SESSIONS = "machine/[machineId]/index";
const SESSION = "machine/[machineId]/session/[sessionId]/index";

const param = (route: StackRoute, name: "machineId" | "sessionId") =>
	(route.params as Partial<Record<typeof name, string>> | undefined)?.[name];

function rootStack(navigation: ContainerRef): StackState | undefined {
	let state: NestedState | undefined = navigation.getRootState();
	while (state?.stale === false) {
		if (state.routeNames.includes(SESSION)) return state;
		state = state.routes[state.index]?.state;
	}
	return undefined;
}

/**
 * Shows a notification's session directly above its computer's session list, so back always lands on the
 * session browser. Screens already in the stack are reused, and an already visible session stays untouched.
 */
export function openNotificationSession(navigation: ContainerRef, open: NotificationOpen) {
	const stack = rootStack(navigation);
	if (!stack) return;
	const isTarget = (route: StackRoute) =>
		route.name === SESSION &&
		param(route, "machineId") === open.machineId &&
		param(route, "sessionId") === open.sessionId;
	if (isTarget(stack.routes[stack.index])) return;
	const machine = { machineId: open.machineId };
	const routes = [
		stack.routes.find((route) => route.name === COMPUTERS) ?? { name: COMPUTERS },
		stack.routes.find((route) => route.name === SESSIONS && param(route, "machineId") === open.machineId) ?? {
			name: SESSIONS,
			params: machine,
		},
		stack.routes.find(isTarget) ?? { name: SESSION, params: { ...machine, sessionId: open.sessionId } },
	];
	navigation.dispatch({ type: "RESET", payload: { ...stack, index: routes.length - 1, routes }, target: stack.key });
}
