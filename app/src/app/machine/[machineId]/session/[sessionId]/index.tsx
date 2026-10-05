import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import * as Haptics from "expo-haptics";
import { KeyboardGestureArea, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
	type AgentSummary,
	type InteractionResponse,
	MAX_PROMPT_IMAGES,
	type ModelRole,
	type ServerMessage,
} from "@omp-mobile/protocol";
import { AgentsButton } from "../../../../../components/agent-menu";
import { ChatImageProvider } from "../../../../../components/chat-image";
import { ChatList, type ChatListHandle } from "../../../../../components/chat-list";
import { Composer, useComposerDraft } from "../../../../../components/composer";
import { InteractionPanel } from "../../../../../components/interaction-panel";
import { livenessLabel } from "../../../../../components/session-meta";
import { OutgoingRow, TimelineRow } from "../../../../../components/timeline";
import { ErrorState, Icon, Loading } from "../../../../../components/ui";
import { useToast } from "../../../../../components/toast";
import { runningCount } from "../../../../../data/agents";
import { OmpApi, operationId } from "../../../../../data/api";
import { acquireMachineSocket } from "../../../../../data/live";
import { useMachine } from "../../../../../data/machines";
import {
	chatRows,
	type OutgoingMessage,
	sessionOutbox,
	UNDELIVERED_AFTER_MS,
	useOutgoing,
} from "../../../../../data/outbox";
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
	const outbox = useMemo(() => sessionOutbox(machineId, sessionId), [machineId, sessionId]);
	const outgoing = useOutgoing(outbox);
	const [responding, setResponding] = useState(false);
	const [changingRole, setChangingRole] = useState(false);
	const [changingAdvisor, setChangingAdvisor] = useState(false);
	const [browserAvailable, setBrowserAvailable] = useState(false);
	// The composer floats over the transcript and rides the keyboard, following it during an interactive dismiss.
	const keyboard = useReanimatedKeyboardAnimation();
	const restingBottom = Math.max(insets.bottom, KEYBOARD_GAP);
	const composerHeight = useSharedValue(0);
	const chat = useRef<ChatListHandle>(null);
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
	const openBrowser = useCallback(
		() => router.push({ pathname: "/machine/[machineId]/browser", params: { machineId } }),
		[machineId],
	);
	const loadSnapshot = useCallback(async () => {
		if (!api) return;
		try {
			dispatch({ type: "snapshot", snapshot: await api.snapshot(sessionId) });
		} catch (error) {
			dispatch({ type: "error", message: error instanceof Error ? error.message : "Could not load this session." });
		}
	}, [api, sessionId]);
	// The browser button is optional chrome: a failed check just hides it.
	const loadBrowserStatus = useCallback(async () => {
		if (!api) return;
		try {
			const { availability } = await api.browserStatus();
			setBrowserAvailable(availability.kind !== "relay_offline");
		} catch {
			setBrowserAvailable(false);
		}
	}, [api]);
	useEffect(() => {
		void loadSnapshot();
	}, [loadSnapshot]);
	useEffect(() => {
		void loadBrowserStatus();
	}, [loadBrowserStatus]);
	useEffect(() => {
		if (!machine) return;
		const { socket, release } = acquireMachineSocket(machine);
		const unsubscribe = socket.subscribe(sessionId);
		const offMessage = socket.onMessage((message: ServerMessage) => dispatch({ type: "server", message }));
		const offResync = socket.onResync(() => {
			void loadSnapshot();
			void loadBrowserStatus();
		});
		return () => {
			unsubscribe();
			offMessage();
			offResync();
			release();
		};
	}, [machine, sessionId, loadSnapshot, loadBrowserStatus]);
	const transcript = view.kind === "ready" ? view.items : null;
	const complete = view.kind === "ready" && !view.olderCursor;
	// Before paint, so a message never shows both as sent and in the transcript.
	useLayoutEffect(() => {
		if (transcript) outbox.reconcile(transcript, complete);
	}, [outbox, transcript, complete]);
	const loaded = view.kind === "ready";
	const working =
		view.kind === "ready" &&
		view.session.liveness.kind === "server" &&
		["starting", "working", "settling"].includes(view.session.liveness.phase);
	useEffect(() => {
		if (!loaded) return;
		outbox.observeTurn(working);
		if (working) return;
		const timer = setTimeout(() => outbox.expireUndelivered(), UNDELIVERED_AFTER_MS);
		return () => clearTimeout(timer);
	}, [outbox, loaded, working]);

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
				view.agents.length || view.session.liveness.kind === "server" || browserAvailable
					? () => (
							<View className="flex-row items-center gap-3">
								{browserAvailable ? (
									<Pressable accessibilityRole="button" accessibilityLabel="Browser" hitSlop={6} onPress={openBrowser}>
										<Icon name="safari" color="#9A9AA2" size={21} />
									</Pressable>
								) : null}
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
	}, [view, navigation, handoff, openAgent, browserAvailable, openBrowser]);
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
	const send = async () => {
		const text = draft.text.trim();
		const images = draft.images;
		if (!text && !images.length) return;
		draft.setText("");
		draft.setImages([]);
		outbox.send(api, text, images, view.items);
		chat.current?.scrollToNewest();
		await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
	};
	const resolveFailed = (message: OutgoingMessage) => {
		if (message.status.kind !== "failed") return;
		Alert.alert(message.status.reason === "undelivered" ? "Not delivered" : "Not sent", message.status.error, [
			{ text: "Try Again", onPress: () => outbox.retry(api, message.operationId, view.items) },
			{
				text: "Edit",
				onPress: () => {
					if (!outbox.remove(message.operationId)) return;
					draft.setText((current) => (current ? `${current}\n${message.text}` : message.text));
					draft.setImages((current) => [...current, ...message.images].slice(0, MAX_PROMPT_IMAGES));
				},
			},
			{ text: "Delete", style: "destructive", onPress: () => outbox.remove(message.operationId) },
			{ text: "Cancel", style: "cancel" },
		]);
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
	const changeAdvisor = async (enabled: boolean) => {
		const previous = view.advisor;
		dispatch({ type: "advisor", advisor: enabled });
		setChangingAdvisor(true);
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		try {
			const result = await api.setAdvisor(sessionId, enabled);
			dispatch({ type: "advisor", advisor: result.advisor });
		} catch (error) {
			dispatch({ type: "advisor", advisor: previous });
			show(error instanceof Error ? error.message : "Could not change the advisor", "error");
		} finally {
			setChangingAdvisor(false);
		}
	};
	// The server refuses role and advisor changes for sessions it cannot drive.
	const locked = ["terminal", "conflict", "unavailable"].includes(view.session.liveness.kind);

	// While a turn runs, its unfinished tool calls stay at the bottom in start order; tools that finish later
	// (and their results) are timestamped after them and would otherwise push them up the transcript.
	const running = working ? view.items.filter((item) => item.kind === "tool" && item.state === "running") : [];
	const newestFirst = chatRows(
		[...view.items.filter((item) => !running.includes(item)), ...running],
		outgoing,
	).reverse();
	return (
		<ChatImageProvider machine={machine}>
			<View className="flex-1 bg-ink">
				{/* Swiping down through the composer drags the keyboard closed; the offset starts that at the composer's top. */}
				<KeyboardGestureArea
					interpolator="ios"
					offset={gestureOffset}
					textInputNativeID={inputNativeID}
					style={styles.fill}
				>
					<ChatList
						ref={chat}
						data={newestFirst}
						extraData={[skillNames, agentsById]}
						keyExtractor={(row) => (row.kind === "item" ? row.item.id : row.message.operationId)}
						renderItem={({ item: row }) =>
							row.kind === "item" ? (
								<TimelineRow item={row.item} skills={skillNames} agents={agentsById} onOpenAgent={openAgent} />
							) : (
								<OutgoingRow
									message={row.message}
									skills={skillNames}
									onPressFailed={() => resolveFailed(row.message)}
								/>
							)
						}
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
							onOpenBrowser={browserAvailable ? openBrowser : undefined}
						/>
					) : null}
					<Composer
						machineId={machineId}
						value={draft.text}
						onChangeText={draft.setText}
						onSend={() => void send()}
						working={working}
						onStop={stop}
						disabled={outgoing.some((message) => message.status.kind === "sending")}
						images={draft.images}
						onAttach={draft.attach}
						onPasteImages={draft.paste}
						onRemoveImage={draft.remove}
						modelRole={view.modelRole}
						onModelRoleChange={(role) => void changeModelRole(role)}
						modelRoleDisabled={changingRole || locked}
						advisor={view.advisor}
						onAdvisorChange={(enabled) => void changeAdvisor(enabled)}
						advisorDisabled={changingAdvisor || locked}
						skills={skills}
						onInputNativeIDChange={setInputNativeID}
					/>
				</Animated.View>
			</View>
		</ChatImageProvider>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	floating: { position: "absolute", left: 0, right: 0, bottom: 0, gap: 8, paddingHorizontal: 12 },
});
