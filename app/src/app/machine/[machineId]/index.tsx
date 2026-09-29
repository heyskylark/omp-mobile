import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type { ServerMessage, SessionSummary } from "@omp-mobile/protocol";
import { ErrorState, Icon, Loading } from "../../../components/ui";
import { groupSessions, LivenessBadge, relativeTime } from "../../../components/session-meta";
import { OmpApi } from "../../../data/api";
import { acquireMachineSocket } from "../../../data/live";
import { useMachine } from "../../../data/machines";

export default function SessionsScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const navigation = useNavigation();
	const machine = useMachine(machineId);
	const [items, setItems] = useState<SessionSummary[]>([]);
	const [cursor, setCursor] = useState<string | undefined>();
	const cursorRef = useRef<string | undefined>(undefined);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [refreshing, setRefreshing] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [message, setMessage] = useState("");
	const load = useCallback(
		async (append = false) => {
			if (!machine) return;
			try {
				const page = await new OmpApi(machine).sessions(append ? cursorRef.current : undefined);
				setItems((current) =>
					append
						? [...current, ...page.items.filter((next) => !current.some((item) => item.id === next.id))]
						: page.items,
				);
				cursorRef.current = page.nextCursor;
				setCursor(page.nextCursor);
				setState("ready");
			} catch (error) {
				setMessage(error instanceof Error ? error.message : "Could not load sessions.");
				setState("error");
			} finally {
				setRefreshing(false);
				setLoadingMore(false);
			}
		},
		[machine],
	);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		const refresh = (event: ServerMessage) => {
			if (event.type === "sessions.changed") void load();
		};
		const offMessage = socket.onMessage(refresh);
		const offEpoch = socket.onEpochChange(() => void load());
		return () => {
			offMessage();
			offEpoch();
			release();
		};
	}, [machine, load]);
	useLayoutEffect(() => {
		navigation.setOptions({
			title: machine?.name ?? "Sessions",
			headerRight: () => (
				<View className="flex-row gap-4">
					<Pressable onPress={() => router.push({ pathname: "/machine/[machineId]/new", params: { machineId } })}>
						<Icon name="plus" color="#8B93FF" size={19} />
					</Pressable>
					<Pressable onPress={() => router.push({ pathname: "/machine/[machineId]/settings", params: { machineId } })}>
						<Icon name="ellipsis.circle" color="#9A9AA2" size={20} />
					</Pressable>
				</View>
			),
		});
	}, [navigation, machine, machineId]);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (state === "loading") return <Loading label="Loading sessions…" />;
	if (state === "error" && items.length === 0) return <ErrorState message={message} retry={() => void load()} />;
	const open = (session: SessionSummary) =>
		router.push({ pathname: "/machine/[machineId]/session/[sessionId]", params: { machineId, sessionId: session.id } });
	return (
		<SectionList
			className="flex-1 bg-ink"
			sections={groupSessions(items)}
			keyExtractor={(item) => item.id}
			stickySectionHeadersEnabled={false}
			contentContainerClassName="px-4 pb-10"
			refreshControl={
				<RefreshControl
					refreshing={refreshing}
					tintColor="#8B93FF"
					onRefresh={() => {
						setRefreshing(true);
						void load();
					}}
				/>
			}
			onEndReached={() => {
				if (cursor && !loadingMore) {
					setLoadingMore(true);
					void load(true);
				}
			}}
			onEndReachedThreshold={0.4}
			renderSectionHeader={({ section }) => (
				<Text className="pb-2 pt-5 text-[12px] font-semibold uppercase tracking-widest text-secondary">
					{section.title}
				</Text>
			)}
			renderItem={({ item }) => (
				<Pressable onPress={() => open(item)} className="border-b border-border py-4">
					<View className="flex-row items-start gap-3">
						<View className="min-w-0 flex-1">
							<Text numberOfLines={1} className="text-[16px] font-medium text-primary">
								{item.title}
							</Text>
							<View className="mt-1 flex-row items-center gap-2">
								<Text numberOfLines={1} className="max-w-[70%] text-caption text-secondary">
									{item.project.name}
								</Text>
								<Text className="text-caption text-secondary">· {relativeTime(item.updatedAt)}</Text>
							</View>
							{item.preview ? (
								<Text numberOfLines={1} className="mt-1.5 text-caption text-secondary">
									{item.preview}
								</Text>
							) : null}
						</View>
						<LivenessBadge session={item} />
					</View>
				</Pressable>
			)}
			ListEmptyComponent={
				<View className="items-center py-24">
					<Icon name="bubble.left.and.bubble.right" color="#6F6F77" size={34} />
					<Text className="mt-4 text-body text-secondary">No sessions yet</Text>
				</View>
			}
			ListFooterComponent={loadingMore ? <ActivityIndicator className="py-5" color="#8B93FF" /> : null}
		/>
	);
}
