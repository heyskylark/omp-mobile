import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import * as Haptics from "expo-haptics";
import { KeyboardGestureArea, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AgentSummary, InteractionResponse, ModelRole, ServerMessage } from "@omp-mobile/protocol";
import { AgentsButton } from "../../../../../components/agent-menu";
import { ChatList } from "../../../../../components/chat-list";
import { Composer, useComposerDraft } from "../../../../../components/composer";
import { InteractionPanel } from "../../../../../components/interaction-panel";
import { livenessLabel } from "../../../../../components/session-meta";
import { TimelineRow } from "../../../../../components/timeline";
import { ErrorState, Icon, Loading } from "../../../../../components/ui";
import { useToast } from "../../../../../components/toast";
import { runningCount } from "../../../../../data/agents";
import { OmpApi, operationId } from "../../../../../data/api";
import { acquireMachineSocket } from "../../../../../data/live";
import { useMachine } from "../../../../../data/machines";
import { sessionViewReducer, type SessionViewState } from "../../../../../data/session-reducer";
import { useSkills } from "../../../../../data/skills";

const NO_AGENTS: AgentSummary[] = [];
/** Space between the floating composer and the top of the keyboard. */
const KEYBOARD_GAP = 8;

export default function SessionScreen() {
	const { machineId, sessionId } = useLocalSearchParams<{ machineId: string; sessionId: string }>();
	const machine = useMachine(machineId);
	const navigation = useNavigation();
	const insets = useSafeAreaInsets();
	const { show } = useToast();
	const api = useMemo(() => (machine ? new OmpApi(machine) : null), [machine]);
	const [view, dispatch] = useReducer(sessionViewReducer, { kind: "loading" } satisfies SessionViewState);
	const draft = useComposerDraft(`${machineId}/${sessionId}`);
	const [sending, setSending] = useState(false);
	const [responding, setResponding] = useState(false);
	const [changingRole, setChangingRole] = useState(false);
	// The composer floats over the transcript and rides the keyboard, following it during an interactive dismiss.
	const keyboard = useReanimatedKeyboardAnimation();
	const restingBottom = Math.max(insets.bottom, KEYBOARD_GAP);
	const composerHeight = useSharedValue(0);
	const [gestureOffset, setGestureOffset] = useState(0);
	const [inputNativeID, setInputNativeID] = useState<string>();
	// Rides exactly on the keyboard (same speed, 8 pt above it) until the keyboard drops below the resting place.
	const keyboardOffset = restingBottom - KEYBOARD_GAP;
	const floatingStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: -Math.max(0, -keyboard.height.value - keyboardOffset) }],
	}));
	const skills = useSkills(machine, view.kind === "ready" ? view.session.project.path : undefined);
	const skillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);
	const agents = view.kind === "ready" ? view.agents : NO_AGENTS;
	const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
	const openAgent = useCallback(
		(agentId: string) =>
			router.push({
				pathname: "/machine/[machineId]/session/[sessionId]/agent/[agentId]",
				params: { machineId, sessionId, agentId },
			}),
		[machineId, sessionId],
	);
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
		const offResync = socket.onResync(() => void loadSnapshot());
		return () => {
			unsubscribe();
			offMessage();
			offResync();
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
		const running = runningCount(view.agents);
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
						{running ? ` · ${running} ${running === 1 ? "agent" : "agents"} running` : ""}
					</Text>
				</View>
			),
			// An empty headerRight still draws an empty button background.
			headerRight:
				view.agents.length || view.session.liveness.kind === "server"
					? () => (
							<View className="flex-row items-center gap-3">
								<AgentsButton agents={view.agents} onOpen={openAgent} />
								{view.session.liveness.kind === "server" ? (
									<Pressable accessibilityLabel="Session menu" onPress={handoff}>
										<Icon name="ellipsis.circle" color="#9A9AA2" size={21} />
									</Pressable>
								) : null}
							</View>
						)
					: undefined,
		});
	}, [view, navigation, handoff, openAgent]);
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
		const text = draft.text.trim();
		const images = draft.images;
		if ((!text && !images.length) || sending) return;
		draft.setText("");
		draft.setImages([]);
		setSending(true);
		await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		try {
			await api.prompt(sessionId, {
				operationId: operationId(),
				text,
				...(images.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
			});
		} catch (error) {
			draft.setText(text);
			draft.setImages(images);
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
	const changeModelRole = async (role: ModelRole) => {
		const previous = view.modelRole;
		dispatch({ type: "modelRole", modelRole: role });
		setChangingRole(true);
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		try {
			const result = await api.setModelRole(sessionId, role);
			dispatch({ type: "modelRole", modelRole: result.modelRole });
		} catch (error) {
			dispatch({ type: "modelRole", modelRole: previous });
			show(error instanceof Error ? error.message : "Could not change the model", "error");
		} finally {
			setChangingRole(false);
		}
	};
	// The server refuses role changes for sessions it cannot drive.
	const roleLocked = ["terminal", "conflict", "unavailable"].includes(view.session.liveness.kind);

	// While a turn runs, its unfinished tool calls stay at the bottom in start order; tools that finish later
	// (and their results) are timestamped after them and would otherwise push them up the transcript.
	const running = working ? view.items.filter((item) => item.kind === "tool" && item.state === "running") : [];
	const newestFirst = [...view.items.filter((item) => !running.includes(item)), ...running].reverse();
	return (
		<View className="flex-1 bg-ink">
			{/* Swiping down through the composer drags the keyboard closed; the offset starts that at the composer's top. */}
			<KeyboardGestureArea
				interpolator="ios"
				offset={gestureOffset}
				textInputNativeID={inputNativeID}
				style={styles.fill}
			>
				<ChatList
					data={newestFirst}
					extraData={[skillNames, agentsById]}
					keyExtractor={(item) => item.id}
					renderItem={({ item }) => (
						<TimelineRow item={item} skills={skillNames} agents={agentsById} onOpenAgent={openAgent} />
					)}
					contentContainerClassName="px-4 pb-3 pt-3"
					keyboardShouldPersistTaps="always"
					keyboardDismissMode="interactive"
					composer={{ height: composerHeight, keyboardOffset }}
					onEndReached={() => void loadOlder()}
					onEndReachedThreshold={0.5}
					ListFooterComponent={
						view.loadingOlder ? (
							<Text className="pb-3 text-center text-caption text-secondary">Loading earlier messages…</Text>
						) : null
					}
				/>
			</KeyboardGestureArea>
			<Animated.View
				pointerEvents="box-none"
				onLayout={(event) => {
					const { height } = event.nativeEvent.layout;
					composerHeight.value = height;
					setGestureOffset(Math.round(height - restingBottom + KEYBOARD_GAP));
				}}
				style={[styles.floating, { paddingBottom: restingBottom }, floatingStyle]}
			>
				{view.pending[0] ? (
					<InteractionPanel
						key={view.pending[0].id}
						interaction={view.pending[0]}
						busy={responding}
						respond={(response) => void respond(view.pending[0].id, response)}
					/>
				) : null}
				<Composer
					machineId={machineId}
					value={draft.text}
					onChangeText={draft.setText}
					onSend={() => void send()}
					working={working}
					onStop={stop}
					disabled={sending}
					images={draft.images}
					onAttach={draft.attach}
					onPasteImages={draft.paste}
					onRemoveImage={draft.remove}
					modelRole={view.modelRole}
					onModelRoleChange={(role) => void changeModelRole(role)}
					modelRoleDisabled={changingRole || roleLocked}
					skills={skills}
					onInputNativeIDChange={setInputNativeID}
				/>
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	floating: { position: "absolute", left: 0, right: 0, bottom: 0, gap: 8, paddingHorizontal: 12 },
});
