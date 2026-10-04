import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	RefreshControl,
	ScrollView,
	SectionList,
	Text,
	TextInput,
	View,
} from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import type { RecentProject, ServerMessage, SessionSummary } from "@omp-mobile/protocol";
import { ErrorState, Icon, Loading } from "../../../components/ui";
import { groupSessions, LivenessBadge, relativeTime } from "../../../components/session-meta";
import { OmpApi, OmpApiError } from "../../../data/api";
import { acquireMachineSocket } from "../../../data/live";
import { useMachine } from "../../../data/machines";

/** Server-side list filter: `project` is an exact cwd, `query` a trimmed fuzzy title search ("" = none). */
interface SessionFilter {
	project?: string;
	query: string;
}

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
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [project, setProject] = useState<string | undefined>();
	const [projects, setProjects] = useState<RecentProject[]>([]);
	const [filtering, setFiltering] = useState(false);
	// The filter the rendered `items` were loaded with, which lags the controls while a reload is in flight.
	const [listFilter, setListFilter] = useState<SessionFilter>({ query: "" });
	const filterRef = useRef<SessionFilter>({ query: "" });
	// Bumped by every page-1 load; responses from an older generation are stale and dropped.
	const generationRef = useRef(0);
	const load = useCallback(
		async (append = false) => {
			if (!machine) return;
			const filter = filterRef.current;
			const generation = append ? generationRef.current : ++generationRef.current;
			try {
				const page = await new OmpApi(machine).sessions({
					cursor: append ? cursorRef.current : undefined,
					project: filter.project,
					query: filter.query,
				});
				if (generation !== generationRef.current) return;
				setItems((current) =>
					append
						? [...current, ...page.items.filter((next) => !current.some((item) => item.id === next.id))]
						: page.items,
				);
				if (!append) setListFilter(filter);
				cursorRef.current = page.nextCursor;
				setCursor(page.nextCursor);
				setState("ready");
			} catch (error) {
				if (generation !== generationRef.current) return;
				if (append && error instanceof OmpApiError && error.payload.code === "invalid_cursor") {
					void load();
					return;
				}
				setMessage(error instanceof Error ? error.message : "Could not load sessions.");
				setState("error");
			} finally {
				if (append) setLoadingMore(false);
				else if (generation === generationRef.current) {
					setRefreshing(false);
					setFiltering(false);
				}
			}
		},
		[machine],
	);
	const loadProjects = useCallback(async () => {
		if (!machine) return;
		try {
			setProjects(await new OmpApi(machine).recentProjects());
		} catch {
			// The chips are a shortcut; keep the last list when the refresh fails.
		}
	}, [machine]);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(search.trim()), 250);
		return () => clearTimeout(timer);
	}, [search]);
	useEffect(() => {
		filterRef.current = { project, query };
		cursorRef.current = undefined;
		setCursor(undefined);
		setFiltering(true);
		void load();
	}, [load, project, query]);
	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		const refresh = (event: ServerMessage) => {
			if (event.type === "sessions.changed") void load();
		};
		const offMessage = socket.onMessage(refresh);
		const offResync = socket.onResync(() => void load());
		return () => {
			offMessage();
			offResync();
			release();
		};
	}, [machine, load]);
	useLayoutEffect(() => {
		navigation.setOptions({
			title: machine?.name ?? "Sessions",
			headerRight: () => (
				<View className="flex-row gap-4">
					<Pressable
						accessibilityLabel="Jobs"
						onPress={() => router.push({ pathname: "/machine/[machineId]/jobs", params: { machineId } })}
					>
						<Icon name="clock" color="#9A9AA2" size={19} />
					</Pressable>
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
	const filtered = Boolean(listFilter.query || listFilter.project);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (state === "loading") return <Loading label="Loading sessions…" />;
	if (state === "error" && items.length === 0 && !filtered && !search && !project)
		return <ErrorState message={message} retry={() => void load()} />;
	const open = (session: SessionSummary) =>
		router.push({ pathname: "/machine/[machineId]/session/[sessionId]", params: { machineId, sessionId: session.id } });
	// Keep a selected project visible even after it drops out of the recent list.
	const chips =
		project && !projects.some((candidate) => candidate.path === project)
			? [{ path: project, name: project.split("/").pop() || project }, ...projects]
			: projects;
	// A search lists results in the server's relevance order; otherwise sessions are grouped by day.
	const sections: { title: string; data: SessionSummary[] }[] = listFilter.query
		? items.length
			? [{ title: "", data: items }]
			: []
		: groupSessions(items);
	return (
		<View className="flex-1 bg-ink">
			<View className="gap-2.5 border-b border-border pb-3 pt-1">
				<View className="mx-4 h-10 flex-row items-center gap-2 rounded-xl border border-border bg-surface pl-3 pr-2">
					<Icon name="magnifyingglass" color="#6F6F77" size={15} />
					<TextInput
						value={search}
						onChangeText={setSearch}
						placeholder="Search sessions"
						placeholderTextColor="#6F6F77"
						autoCapitalize="none"
						autoCorrect={false}
						returnKeyType="search"
						clearButtonMode="while-editing"
						accessibilityLabel="Search sessions"
						className="h-10 flex-1 text-body text-primary"
					/>
					{filtering ? <ActivityIndicator size="small" color="#8B93FF" /> : null}
				</View>
				{chips.length ? (
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						keyboardShouldPersistTaps="handled"
						contentContainerClassName="gap-2 px-4"
					>
						{[{ path: undefined, name: "All" }, ...chips].map((chip) => {
							const selected = chip.path === project;
							return (
								<Pressable
									key={chip.path ?? ""}
									onPress={() => setProject(chip.path)}
									accessibilityRole="button"
									accessibilityState={{ selected }}
									className={`rounded-full border px-3.5 py-1.5 ${selected ? "border-accent bg-surface-raised" : "border-border bg-surface"}`}
								>
									<Text
										numberOfLines={1}
										className={`max-w-[180px] text-[13px] font-medium ${selected ? "text-accent" : "text-secondary"}`}
									>
										{chip.name}
									</Text>
								</Pressable>
							);
						})}
					</ScrollView>
				) : null}
			</View>
			<SectionList
				className="flex-1 bg-ink"
				sections={sections}
				keyExtractor={(item) => item.id}
				stickySectionHeadersEnabled={false}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
				contentContainerClassName="px-4 pb-10"
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						tintColor="#8B93FF"
						onRefresh={() => {
							setRefreshing(true);
							void load();
							void loadProjects();
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
				renderSectionHeader={({ section }) =>
					section.title ? (
						<Text className="pb-2 pt-5 text-[12px] font-semibold uppercase tracking-widest text-secondary">
							{section.title}
						</Text>
					) : null
				}
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
					state === "error" ? (
						<View className="items-center py-24">
							<Icon name="exclamationmark.triangle" color="#6F6F77" size={34} />
							<Text className="mt-4 text-center text-body text-secondary">{message}</Text>
							<Pressable onPress={() => void load()} className="mt-3 p-2">
								<Text className="text-[14px] font-medium text-accent">Try again</Text>
							</Pressable>
						</View>
					) : filtering ? null : filtered ? (
						<View className="items-center py-24">
							<Icon name="magnifyingglass" color="#6F6F77" size={34} />
							<Text className="mt-4 text-body text-secondary">No matching sessions</Text>
							<Text className="mt-1 text-caption text-secondary">Try another search or project.</Text>
						</View>
					) : (
						<View className="items-center py-24">
							<Icon name="bubble.left.and.bubble.right" color="#6F6F77" size={34} />
							<Text className="mt-4 text-body text-secondary">No sessions yet</Text>
						</View>
					)
				}
				ListFooterComponent={loadingMore ? <ActivityIndicator className="py-5" color="#8B93FF" /> : null}
			/>
		</View>
	);
}
