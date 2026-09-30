import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router } from "expo-router";
import type { PairedMachine } from "../native/types";
import { OmpApi } from "../data/api";
import { useMachines } from "../data/machines";
import { EmptyState, ErrorState, Icon, Loading, PrimaryButton, Surface } from "../components/ui";

export default function MachinesScreen() {
	const machines = useMachines((state) => state.machines);
	const loadState = useMachines((state) => state.loadState);
	const load = useMachines((state) => state.load);
	const applyInfo = useMachines((state) => state.applyInfo);
	const [online, setOnline] = useState<Record<string, boolean>>({});
	const [refreshing, setRefreshing] = useState(false);
	const checkOnline = useCallback(
		async (current: PairedMachine[]) => {
			const results = await Promise.all(
				current.map(async (machine) => {
					try {
						const info = await new OmpApi(machine).info();
						await applyInfo(machine.machineId, info);
						return [machine.machineId, true] as const;
					} catch {
						return [machine.machineId, false] as const;
					}
				}),
			);
			setOnline(Object.fromEntries(results));
		},
		[applyInfo],
	);
	const refresh = useCallback(async () => {
		setRefreshing(true);
		await load();
		await checkOnline(useMachines.getState().machines);
		setRefreshing(false);
	}, [load, checkOnline]);
	useEffect(() => {
		if (loadState.kind === "ready") void checkOnline(machines);
	}, [loadState.kind, machines, checkOnline]);

	if (loadState.kind === "loading" && machines.length === 0) return <Loading label="Loading computers…" />;
	if (loadState.kind === "error" && machines.length === 0)
		return <ErrorState message={loadState.message} retry={() => void load()} />;
	if (machines.length === 0)
		return (
			<View className="flex-1 bg-ink">
				<EmptyState
					icon="desktopcomputer"
					title="Your computers, anywhere"
					detail="Pair a computer running OMP to continue its coding sessions from your phone."
					action={<PrimaryButton label="Add computer" icon="plus" onPress={() => router.push("/pair")} />}
				/>
			</View>
		);

	const renderMachine = ({ item }: { item: PairedMachine }) => (
		<Pressable onPress={() => router.push({ pathname: "/machine/[machineId]", params: { machineId: item.machineId } })}>
			<Surface className="mb-3 flex-row items-center gap-4">
				<View className="h-11 w-11 items-center justify-center rounded-xl bg-surface-raised">
					<Icon name="desktopcomputer" color="#8B93FF" size={21} />
				</View>
				<View className="flex-1">
					<Text className="text-[16px] font-semibold text-primary">{item.name}</Text>
					<View className="mt-1 flex-row items-center gap-2">
						<View className={`h-2 w-2 rounded-full ${online[item.machineId] ? "bg-success" : "bg-secondary"}`} />
						<Text className="text-caption text-secondary">{online[item.machineId] ? "Online" : "Offline"}</Text>
					</View>
				</View>
				<Icon name="chevron.right" color="#6F6F77" size={14} />
			</Surface>
		</Pressable>
	);
	return (
		<FlatList
			className="flex-1 bg-ink"
			contentContainerClassName="px-4 pb-8 pt-3"
			data={machines}
			keyExtractor={(item) => item.machineId}
			renderItem={renderMachine}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#8B93FF" />}
			ListFooterComponent={
				<Pressable
					onPress={() => router.push("/pair")}
					className="mt-2 flex-row items-center justify-center gap-2 py-4"
				>
					<Icon name="plus.circle" color="#8B93FF" />
					<Text className="text-[15px] font-medium text-accent">Add computer</Text>
				</Pressable>
			}
		/>
	);
}
