import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import type { Job, JobStatus, ServerMessage } from "@omp-mobile/protocol";
import { EmptyState, ErrorState, Icon, Loading } from "../../../components/ui";
import { useToast } from "../../../components/toast";
import { OmpApi } from "../../../data/api";
import { acquireMachineSocket } from "../../../data/live";
import { useMachine } from "../../../data/machines";

const STATUS_TEXT: Record<JobStatus, string> = { ACTIVE: "Active", PAUSED: "Paused", ERROR: "Error" };

function nextRunLabel(value: string): string {
	const date = new Date(value);
	if (date.toDateString() === new Date().toDateString())
		return `Today ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
	return date.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export default function JobsScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const machine = useMachine(machineId);
	const { show } = useToast();
	const [items, setItems] = useState<Job[]>([]);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [refreshing, setRefreshing] = useState(false);
	const [message, setMessage] = useState("");
	const generationRef = useRef(0);
	const openRow = useRef<SwipeableMethods | null>(null);
	const load = useCallback(async () => {
		if (!machine) return;
		const generation = ++generationRef.current;
		try {
			const response = await new OmpApi(machine).jobs();
			if (generation !== generationRef.current) return;
			setItems(response.items);
			setState("ready");
		} catch (error) {
			if (generation !== generationRef.current) return;
			setMessage(error instanceof Error ? error.message : "Could not load jobs.");
			setState("error");
		} finally {
			if (generation === generationRef.current) setRefreshing(false);
		}
	}, [machine]);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		const refresh = (event: ServerMessage) => {
			if (event.type === "jobs.changed") void load();
		};
		const offMessage = socket.onMessage(refresh);
		const offResync = socket.onResync(() => void load());
		return () => {
			offMessage();
			offResync();
			release();
		};
	}, [machine, load]);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (state === "loading") return <Loading label="Loading jobs…" />;
	if (state === "error" && items.length === 0) return <ErrorState message={message} retry={() => void load()} />;
	const api = new OmpApi(machine);
	const toggle = async (job: Job) => {
		try {
			const updated = await api.setJobStatus(job.id, job.status === "PAUSED" ? "ACTIVE" : "PAUSED");
			setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
		} catch (error) {
			show(error instanceof Error ? error.message : "Could not update the job.", "error");
		}
	};
	const remove = async (job: Job) => {
		try {
			await api.deleteJob(job.id);
			setItems((current) => current.filter((item) => item.id !== job.id));
		} catch (error) {
			show(error instanceof Error ? error.message : "Could not delete the job.", "error");
		}
	};
	return (
		<FlatList
			className="flex-1 bg-ink"
			data={items}
			// A swipeable row whose status flipped ignores its next swipe; a fresh row per status does not.
			keyExtractor={(item) => `${item.id}:${item.status}`}
			contentContainerClassName="flex-grow pb-10"
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
			renderItem={({ item }) => (
				<JobRow
					job={item}
					onOpen={(swipeable) => {
						if (openRow.current && openRow.current !== swipeable) openRow.current.close();
						openRow.current = swipeable;
					}}
					onPress={() =>
						router.push({
							pathname: "/machine/[machineId]/session/[sessionId]",
							params: { machineId, sessionId: item.sessionId },
						})
					}
					onToggle={() => toggle(item)}
					onDelete={() => remove(item)}
				/>
			)}
			ListEmptyComponent={
				<EmptyState icon="clock" title="No jobs" detail="Ask OMP in any session to run something on a schedule." />
			}
		/>
	);
}

function JobRow({
	job,
	onOpen,
	onPress,
	onToggle,
	onDelete,
}: {
	job: Job;
	onOpen(swipeable: SwipeableMethods): void;
	onPress(): void;
	onToggle(): Promise<void>;
	onDelete(): Promise<void>;
}) {
	const swipeable = useRef<SwipeableMethods | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async (action: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	const paused = job.status === "PAUSED";
	return (
		<ReanimatedSwipeable
			ref={swipeable}
			friction={2}
			rightThreshold={40}
			overshootRight={false}
			onSwipeableWillOpen={() => {
				if (swipeable.current) onOpen(swipeable.current);
			}}
			renderRightActions={(_progress, _translation, methods) => (
				<View className="flex-row">
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={paused ? "Resume" : "Pause"}
						disabled={busy}
						onPress={() => {
							methods.close();
							void run(onToggle);
						}}
						className={`w-20 items-center justify-center gap-1 ${paused ? "bg-success" : "bg-warning"}`}
					>
						<Icon name={paused ? "play.fill" : "pause.fill"} color="#FFFFFF" size={18} />
						<Text className="text-[12px] font-semibold text-white">{paused ? "Resume" : "Pause"}</Text>
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Delete"
						disabled={busy}
						onPress={() => void run(onDelete)}
						className="w-20 items-center justify-center gap-1 bg-danger"
					>
						<Icon name="trash.fill" color="#FFFFFF" size={18} />
						<Text className="text-[12px] font-semibold text-white">Delete</Text>
					</Pressable>
				</View>
			)}
		>
			<Pressable
				onPress={onPress}
				accessibilityRole="button"
				accessibilityLabel={`${job.name}, ${STATUS_TEXT[job.status]}`}
				className="flex-row items-start gap-3 border-b border-border bg-ink px-4 py-4"
			>
				<View className={`mt-[7px] h-2.5 w-2.5 rounded-full ${job.status === "ACTIVE" ? "bg-success" : "bg-danger"}`} />
				<View className="min-w-0 flex-1">
					<Text numberOfLines={1} className="text-[16px] font-semibold text-primary">
						{job.name}
					</Text>
					<Text numberOfLines={1} className="mt-1 text-caption text-secondary">
						<Text className="font-mono">{job.schedule}</Text>
						{paused ? " · Paused" : job.nextRunAt ? ` · Next ${nextRunLabel(job.nextRunAt)}` : ""}
					</Text>
					{job.status === "ERROR" ? (
						<Text numberOfLines={2} className="mt-1 text-caption text-danger">
							{job.errorMessage}
						</Text>
					) : null}
				</View>
			</Pressable>
		</ReanimatedSwipeable>
	);
}
