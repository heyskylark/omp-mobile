import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type { AgentSummary, ServerMessage } from "@omp-mobile/protocol";
import { AgentsButton } from "../../../../../../components/agent-menu";
import { ChatList } from "../../../../../../components/chat-list";
import { TimelineRow } from "../../../../../../components/timeline";
import { ErrorState, Loading } from "../../../../../../components/ui";
import { agentThreadReducer, type AgentThreadState } from "../../../../../../data/agent-reducer";
import { agentName, statusLabel } from "../../../../../../data/agents";
import { OmpApi } from "../../../../../../data/api";
import { acquireMachineSocket } from "../../../../../../data/live";
import { useMachine } from "../../../../../../data/machines";

const NO_AGENTS: AgentSummary[] = [];

export default function AgentScreen() {
	const { machineId, sessionId, agentId } = useLocalSearchParams<{
		machineId: string;
		sessionId: string;
		agentId: string;
	}>();
	const machine = useMachine(machineId);
	const navigation = useNavigation();
	const api = useMemo(() => (machine ? new OmpApi(machine) : null), [machine]);
	const [view, dispatch] = useReducer(agentThreadReducer, { kind: "loading" } satisfies AgentThreadState);
	const agents = view.kind === "ready" ? view.agents : NO_AGENTS;
	const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
	const agent = agentsById.get(agentId);
	const openAgent = useCallback(
		(nestedId: string) =>
			router.push({
				pathname: "/machine/[machineId]/session/[sessionId]/agent/[agentId]",
				params: { machineId, sessionId, agentId: nestedId },
			}),
		[machineId, sessionId],
	);
	const loadSnapshot = useCallback(async () => {
		if (!api) return;
		try {
			dispatch({ type: "snapshot", sessionId, agentId, snapshot: await api.agentSnapshot(sessionId, agentId) });
		} catch (error) {
			dispatch({ type: "error", message: error instanceof Error ? error.message : "Could not load this agent." });
		}
	}, [api, sessionId, agentId]);
	useEffect(() => {
		void loadSnapshot();
	}, [loadSnapshot]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		// Roster updates only reach session subscribers; the session screen below usually holds this one already.
		const unsubscribeSession = socket.subscribe(sessionId);
		const unsubscribeAgent = socket.subscribeAgent(sessionId, agentId);
		const offMessage = socket.onMessage((message: ServerMessage) => dispatch({ type: "server", message }));
		const offResync = socket.onResync(() => void loadSnapshot());
		return () => {
			unsubscribeAgent();
			unsubscribeSession();
			offMessage();
			offResync();
			release();
		};
	}, [machine, sessionId, agentId, loadSnapshot]);

	useLayoutEffect(() => {
		const name = agentName(agentId);
		const status = agent
			? `${statusLabel(agent.status)}${agent.status === "running" && agent.activity ? ` · ${agent.activity}` : ""}`
			: "";
		navigation.setOptions({
			title: name,
			headerTitle: () => (
				<View className="max-w-[220px] items-center">
					<Text numberOfLines={1} className="text-[16px] font-semibold text-primary">
						{name}
					</Text>
					{status ? (
						<Text numberOfLines={1} className="text-[11px] text-secondary">
							{status}
						</Text>
					) : null}
				</View>
			),
			// An empty headerRight still draws an empty button background.
			headerRight: agents.some((nested) => nested.parentId === agentId)
				? () => <AgentsButton agents={agents} under={agentId} onOpen={openAgent} />
				: undefined,
		});
	}, [navigation, agentId, agent, agents, openAgent]);
	if (!machine || !api) return <ErrorState message="This computer is no longer paired." />;
	if (view.kind === "loading") return <Loading label="Loading agent…" />;
	if (view.kind === "error") return <ErrorState message={view.message} retry={() => void loadSnapshot()} />;

	const loadOlder = async () => {
		if (!view.olderCursor || view.loadingOlder) return;
		dispatch({ type: "older.start" });
		try {
			dispatch({ type: "older.success", page: await api.agentTimeline(sessionId, agentId, view.olderCursor) });
		} catch {
			dispatch({ type: "older.error" });
		}
	};
	const newestFirst = [...view.items].reverse();
	return (
		<View className="flex-1 bg-ink">
			<ChatList
				data={newestFirst}
				extraData={agentsById}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) => <TimelineRow item={item} agents={agentsById} onOpenAgent={openAgent} />}
				contentContainerClassName="px-4 pb-3 pt-5"
				onEndReached={() => void loadOlder()}
				onEndReachedThreshold={0.5}
				ListFooterComponent={
					view.loadingOlder ? (
						<Text className="pb-3 text-center text-caption text-secondary">Loading earlier messages…</Text>
					) : null
				}
			/>
		</View>
	);
}
