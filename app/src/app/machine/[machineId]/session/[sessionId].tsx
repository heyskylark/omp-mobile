import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import * as Haptics from "expo-haptics";
import type { InteractionResponse, ServerMessage, TimelineItem } from "@omp-mobile/protocol";
import { Composer } from "../../../../components/composer";
import { InteractionPanel } from "../../../../components/interaction-panel";
import { livenessLabel } from "../../../../components/session-meta";
import { TimelineRow } from "../../../../components/timeline";
import { ErrorState, Icon, Loading } from "../../../../components/ui";
import { useToast } from "../../../../components/toast";
import { OmpApi, operationId } from "../../../../data/api";
import { acquireMachineSocket } from "../../../../data/live";
import { useMachine } from "../../../../data/machines";
import { sessionViewReducer, type SessionViewState } from "../../../../data/session-reducer";

export default function SessionScreen() {
	const { machineId, sessionId } = useLocalSearchParams<{ machineId: string; sessionId: string }>();
	const machine = useMachine(machineId);
	const navigation = useNavigation();
	const { show } = useToast();
	const api = useMemo(() => (machine ? new OmpApi(machine) : null), [machine]);
	const [view, dispatch] = useReducer(sessionViewReducer, { kind: "loading" } satisfies SessionViewState);
	const [prompt, setPrompt] = useState("");
	const [sending, setSending] = useState(false);
	const [responding, setResponding] = useState(false);
	const list = useRef<FlatList<TimelineItem>>(null);
	const loadSnapshot = useCallback(async () => {
		if (!api) return;
		try {
			dispatch({ type: "snapshot", snapshot: await api.snapshot(sessionId) });
		} catch (error) {
			dispatch({ type: "error", message: error instanceof Error ? error.message : "Could not load this session." });
		}
	}, [api, sessionId]);
	useEffect(() => {
		void loadSnapshot();
	}, [loadSnapshot]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		const unsubscribe = socket.subscribe(sessionId);
		const offMessage = socket.onMessage((message: ServerMessage) => dispatch({ type: "server", message }));
		const offEpoch = socket.onEpochChange(() => void loadSnapshot());
		return () => {
			unsubscribe();
			offMessage();
			offEpoch();
			release();
		};
	}, [machine, sessionId, loadSnapshot]);

	const handoff = useCallback(() => {
		if (!api) return;
		Alert.alert(
			"Hand off to computer?",
			"OMP will stop managing this session after the current response settles. Resume it from your terminal.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Hand off",
					onPress: () =>
						void api
							.handoff(sessionId)
							.then(() => show("Ready to resume on your computer"))
							.catch((error) => show(error instanceof Error ? error.message : "Hand off failed", "error")),
				},
			],
		);
	}, [api, sessionId, show]);
	useLayoutEffect(() => {
		if (view.kind !== "ready") return;
		const badge = livenessLabel(view.session.liveness, view.session.pendingCount);
		navigation.setOptions({
			title: view.session.title,
			headerTitle: () => (
				<View className="max-w-[220px] items-center">
					<Text numberOfLines={1} className="text-[16px] font-semibold text-primary">
						{view.session.title}
					</Text>
					<Text numberOfLines={1} className="text-[11px] text-secondary">
						{view.session.project.name}
						{badge ? ` · ${badge}` : ""}
					</Text>
				</View>
			),
			headerRight:
				view.session.liveness.kind === "server"
					? () => (
							<Pressable accessibilityLabel="Session menu" onPress={handoff}>
								<Icon name="ellipsis.circle" color="#9A9AA2" size={21} />
							</Pressable>
						)
					: undefined,
		});
	}, [view, navigation, handoff]);
	if (!machine || !api) return <ErrorState message="This computer is no longer paired." />;
	if (view.kind === "loading") return <Loading label="Loading session…" />;
	if (view.kind === "error") return <ErrorState message={view.message} retry={() => void loadSnapshot()} />;

	const loadOlder = async () => {
		if (!view.olderCursor || view.loadingOlder) return;
		dispatch({ type: "older.start" });
		try {
			dispatch({ type: "older.success", page: await api.timeline(sessionId, view.olderCursor) });
		} catch {
			dispatch({ type: "older.error" });
		}
	};
	const working =
		view.session.liveness.kind === "server" &&
		["starting", "working", "settling"].includes(view.session.liveness.phase);
	const send = async () => {
		const text = prompt.trim();
		if (!text || sending) return;
		setPrompt("");
		setSending(true);
		await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		try {
			await api.prompt(sessionId, { operationId: operationId(), text });
		} catch (error) {
			setPrompt(text);
			show(error instanceof Error ? error.message : "Message not sent", "error");
		} finally {
			setSending(false);
		}
	};
	const respond = async (interactionId: string, response: InteractionResponse) => {
		setResponding(true);
		if (response.kind === "approve") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		try {
			const receipt = await api.respond(sessionId, interactionId, { operationId: operationId(), response });
			if (receipt.state !== "applied") show(receipt.message ?? `Response ${receipt.state}`, "error");
		} catch (error) {
			show(error instanceof Error ? error.message : "Response failed", "error");
		} finally {
			setResponding(false);
		}
	};
	const stop = () =>
		void api
			.abort(sessionId)
			.catch((error) => show(error instanceof Error ? error.message : "Could not stop", "error"));

	const newestFirst = [...view.items].reverse();
	return (
		<KeyboardAvoidingView
			behavior={Platform.OS === "ios" ? "padding" : undefined}
			keyboardVerticalOffset={88}
			className="flex-1 bg-ink"
		>
			<FlatList
				ref={list}
				inverted
				data={newestFirst}
				keyExtractor={(item) => item.id}
				renderItem={({ item }) => <TimelineRow item={item} />}
				contentContainerClassName="px-4 pb-3 pt-5"
				onEndReached={() => void loadOlder()}
				onEndReachedThreshold={0.5}
				ListFooterComponent={
					view.loadingOlder ? (
						<Text className="pb-3 text-center text-caption text-secondary">Loading earlier messages…</Text>
					) : null
				}
			/>
			<View className="gap-2 border-t border-border bg-ink px-3 pb-3 pt-2">
				{view.pending[0] ? (
					<InteractionPanel
						key={view.pending[0].id}
						interaction={view.pending[0]}
						busy={responding}
						respond={(response) => void respond(view.pending[0].id, response)}
					/>
				) : null}
				<Composer
					value={prompt}
					onChangeText={setPrompt}
					onSend={() => void send()}
					working={working}
					onStop={stop}
					disabled={sending}
				/>
			</View>
		</KeyboardAvoidingView>
	);
}
