import { useLayoutEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type { AgentDefinition } from "@omp-mobile/protocol";
import { EmptyState, ErrorState, Icon, Loading } from "../../../../components/ui";
import { useAgentList } from "../../../../data/agent-definitions";
import { useMachine } from "../../../../data/machines";

export default function AgentsScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const navigation = useNavigation();
	const machine = useMachine(machineId);
	const { list, error, reload } = useAgentList(machine);
	const [refreshing, setRefreshing] = useState(false);
	useLayoutEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<Pressable
					accessibilityLabel="New agent"
					onPress={() => router.push({ pathname: "/machine/[machineId]/agents/edit", params: { machineId } })}
				>
					<Icon name="plus" color="#8B93FF" size={19} />
				</Pressable>
			),
		});
	}, [navigation, machineId]);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (!list)
		return error ? <ErrorState message={error} retry={() => void reload()} /> : <Loading label="Loading agents…" />;
	return (
		<FlatList
			className="flex-1 bg-ink"
			data={list.items}
			keyExtractor={(item) => item.name}
			contentContainerClassName="flex-grow pb-10"
			refreshControl={
				<RefreshControl
					refreshing={refreshing}
					tintColor="#8B93FF"
					onRefresh={() => {
						setRefreshing(true);
						void reload().finally(() => setRefreshing(false));
					}}
				/>
			}
			ListHeaderComponent={
				<Text className="px-4 pb-1 pt-4 text-caption text-secondary">
					Start a session as an agent to give it its own instructions and only the tools it needs. Agents are files in
					~/.omp/agent/agents on {machine.name}.
				</Text>
			}
			renderItem={({ item }) => (
				<AgentRow
					agent={item}
					onPress={() =>
						router.push({ pathname: "/machine/[machineId]/agents/edit", params: { machineId, name: item.name } })
					}
				/>
			)}
			ListEmptyComponent={
				<EmptyState icon="person.crop.circle" title="No agents" detail="Tap + to create an agent for this computer." />
			}
		/>
	);
}

function AgentRow({ agent, onPress }: { agent: AgentDefinition; onPress(): void }) {
	const details = [
		agent.tools ? `${agent.tools.length} ${agent.tools.length === 1 ? "tool" : "tools"}` : "Default tools",
		agent.model,
		agent.thinkingLevel ? `Thinking ${agent.thinkingLevel}` : undefined,
	].filter(Boolean);
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={[agent.name, agent.structured ? "Subagent only" : "", agent.description, details.join(" · ")]
				.filter(Boolean)
				.join(", ")}
			className="flex-row items-center gap-3 border-b border-border bg-ink px-4 py-4"
		>
			<Icon name="person.crop.circle" color={agent.structured ? "#6F6F77" : "#8B93FF"} size={22} />
			<View className="min-w-0 flex-1">
				<View className="flex-row items-center gap-2">
					<Text numberOfLines={1} className="shrink text-[16px] font-semibold text-primary">
						{agent.name}
					</Text>
					{agent.structured ? (
						<View className="rounded-full border border-border bg-surface-raised px-2 py-0.5">
							<Text className="text-[11px] font-medium text-secondary">Subagent only</Text>
						</View>
					) : null}
				</View>
				{agent.description ? (
					<Text numberOfLines={2} className="mt-1 text-caption text-secondary">
						{agent.description}
					</Text>
				) : null}
				<Text numberOfLines={1} className="mt-1 text-caption text-secondary">
					{details.join(" · ")}
				</Text>
			</View>
			<Icon name="chevron.right" color="#6F6F77" size={13} />
		</Pressable>
	);
}
