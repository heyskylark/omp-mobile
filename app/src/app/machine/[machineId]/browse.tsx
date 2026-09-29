import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { DirectoryListing } from "@omp-mobile/protocol";
import { ErrorState, Icon, Loading, PrimaryButton } from "../../../components/ui";
import { OmpApi } from "../../../data/api";
import { useMachine } from "../../../data/machines";

export default function BrowseScreen() {
	const { machineId, path } = useLocalSearchParams<{ machineId: string; path?: string }>();
	const machine = useMachine(machineId);
	const [listing, setListing] = useState<DirectoryListing | null>(null);
	const [error, setError] = useState("");

	const load = useCallback(
		async (nextPath?: string) => {
			if (!machine) return;
			setListing(null);
			setError("");
			try {
				setListing(await new OmpApi(machine).directories(nextPath));
			} catch (caught) {
				setError(caught instanceof Error ? caught.message : "Could not browse this folder.");
			}
		},
		[machine],
	);

	useEffect(() => {
		void load(path);
	}, [path, load]);

	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (error) return <ErrorState message={error} retry={() => void load(path)} />;
	if (!listing) return <Loading label="Loading folders…" />;

	const parts = listing.path.split("/").filter(Boolean);
	const choose = () =>
		router.dismissTo({ pathname: "/machine/[machineId]/new", params: { machineId, cwd: listing.path } });

	return (
		<View className="flex-1 bg-ink">
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				className="max-h-12 border-b border-border"
				contentContainerClassName="items-center gap-1 px-4"
			>
				<Pressable onPress={() => void load(listing.roots[0])}>
					<Icon name="externaldrive" color="#9A9AA2" size={15} />
				</Pressable>
				{parts.map((part, index) => (
					<View key={`${part}-${index}`} className="flex-row items-center gap-1">
						<Text className="text-secondary">/</Text>
						<Pressable onPress={() => void load(`/${parts.slice(0, index + 1).join("/")}`)}>
							<Text className="text-[13px] text-secondary">{part}</Text>
						</Pressable>
					</View>
				))}
			</ScrollView>
			<ScrollView contentContainerClassName="px-4 pb-8">
				{listing.parent ? (
					<Pressable
						onPress={() => void load(listing.parent)}
						className="flex-row items-center gap-3 border-b border-border py-4"
					>
						<Icon name="arrow.turn.up.left" color="#9A9AA2" />
						<Text className="text-body text-secondary">Parent folder</Text>
					</Pressable>
				) : null}
				{listing.entries.map((entry) => (
					<Pressable
						key={entry.path}
						onPress={() => void load(entry.path)}
						className="flex-row items-center gap-3 border-b border-border py-4"
					>
						<Icon name="folder.fill" color="#8B93FF" />
						<Text className="min-w-0 flex-1 text-body text-primary">{entry.name}</Text>
						{entry.isGitRepo ? (
							<View className="rounded-full bg-surface-raised px-2 py-1">
								<Text className="text-[11px] font-medium text-success">Git</Text>
							</View>
						) : null}
						{entry.hasSessions ? <View className="h-2 w-2 rounded-full bg-accent" /> : null}
						<Icon name="chevron.right" color="#6F6F77" size={13} />
					</Pressable>
				))}
			</ScrollView>
			<View className="px-4 pb-5">
				<PrimaryButton label="Use this folder" icon="checkmark" onPress={choose} />
			</View>
		</View>
	);
}
