import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ApiError, BrowserControl, BrowserKey, BrowserTab } from "@omp-mobile/protocol";
import { BrowserFrameView } from "../../../components/browser-frame";
import { useToast } from "../../../components/toast";
import { EmptyState, ErrorState, Icon, Loading, PrimaryButton } from "../../../components/ui";
import { useBrowserViewer, type BrowserViewerControls, type ViewerFrame } from "../../../data/browser";
import { useMachine } from "../../../data/machines";

const KEY_BUTTONS: { key: BrowserKey; label: string; accessibilityLabel: string }[] = [
	{ key: "Tab", label: "Tab", accessibilityLabel: "Tab key" },
	{ key: "Escape", label: "Esc", accessibilityLabel: "Escape key" },
	{ key: "ArrowLeft", label: "←", accessibilityLabel: "Left arrow key" },
	{ key: "ArrowRight", label: "→", accessibilityLabel: "Right arrow key" },
];

/** The host shown under a tab title; RN's URL polyfill does not implement `host`. */
function hostOf(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
}

export default function BrowserScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const machine = useMachine(machineId);
	const { show } = useToast();
	const onError = useCallback((error: ApiError) => show(error.message, "error"), [show]);
	const viewer = useBrowserViewer(machine, onError);
	const { state } = viewer;
	const [picking, setPicking] = useState(false);

	const tabs = state.kind === "ready" ? state.tabs : null;
	const watch = state.kind === "ready" ? state.watch : null;
	const watchedTab = watch && watch.kind !== "none" ? tabs?.find((tab) => tab.id === watch.tabId) : undefined;
	const title = watchedTab ? watchedTab.title || hostOf(watchedTab.url) : "Browser";
	const machineName = machine?.name ?? "your computer";

	return (
		<View className="flex-1 bg-ink">
			<Stack.Screen
				options={{
					title,
					headerTitle: () => (
						<Text numberOfLines={1} className="max-w-[220px] text-[16px] font-semibold text-primary">
							{title}
						</Text>
					),
					headerLeft: () => (
						<Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={() => router.back()}>
							<Icon name="xmark" size={17} />
						</Pressable>
					),
					headerRight: tabs?.length
						? () => (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={picking ? "Hide tabs" : "Tabs"}
									hitSlop={6}
									onPress={() => setPicking((open) => !open)}
									className="h-[30px] flex-row items-center gap-1 rounded-full bg-surface-raised px-2.5"
								>
									<Icon name="square.on.square" color="#9A9AA2" size={15} />
									<Text className="text-[13px] font-semibold text-secondary">{tabs.length}</Text>
								</Pressable>
							)
						: undefined,
				}}
			/>
			{!machine ? (
				<ErrorState message="This computer is no longer paired." />
			) : state.kind === "connecting" ? (
				<Loading label="Connecting to the browser…" />
			) : state.kind === "unavailable" ? (
				state.availability.kind === "relay_offline" ? (
					<EmptyState
						icon="safari"
						title="Browser relay isn't running"
						detail={`It starts when an OMP agent first uses the browser. To start it now, run omp browser-relay on ${machineName}.`}
					/>
				) : (
					<EmptyState
						icon="safari"
						title="Chrome isn't connected"
						detail={`Open Chrome with the OMP Browser Relay extension on ${machineName}.`}
					/>
				)
			) : !tabs ? (
				<Loading label="Connecting to the browser…" />
			) : !tabs.length ? (
				<EmptyState icon="safari" title="No tabs open" detail={`Open a tab in Chrome on ${machineName}.`} />
			) : picking || state.watch.kind === "closed" || state.watch.kind === "none" ? (
				<TabPicker
					tabs={tabs}
					currentTabId={state.watch.kind === "none" ? null : state.watch.tabId}
					notice={state.watch.kind === "closed" ? "That tab closed. Pick another one." : null}
					onPick={(tabId) => {
						setPicking(false);
						if (state.watch.kind !== "watching" || state.watch.tabId !== tabId) viewer.watch(tabId);
					}}
				/>
			) : state.watch.kind === "watching" && state.watch.frame ? (
				<LiveTab
					key={state.watch.tabId}
					frame={state.watch.frame}
					control={state.watch.control}
					drawing={state.watch.drawing}
					reconnecting={state.link === "reconnecting"}
					machineName={machineName}
					viewer={viewer}
				/>
			) : state.watch.kind === "watching" && !state.watch.drawing ? (
				<EmptyState
					icon="macwindow"
					title="Chrome isn't drawing this tab"
					detail={`Chrome draws nothing while its window is covered, the tab is asleep in the background, or the screen on ${machineName} is locked or asleep.`}
					action={<PrimaryButton label="Bring to front" icon="macwindow" onPress={viewer.bringToFront} />}
				/>
			) : (
				<Loading label="Loading tab…" />
			)}
		</View>
	);
}

function TabPicker({
	tabs,
	currentTabId,
	notice,
	onPick,
}: {
	tabs: BrowserTab[];
	currentTabId: string | null;
	notice: string | null;
	onPick(tabId: string): void;
}) {
	return (
		// Fabric reuses native scroll views, and one recycled from the zoomable frame keeps the negative offset that
		// centred its picture. Centring content that fills the view recomputes that offset to zero.
		<ScrollView centerContent contentContainerClassName="flex-grow gap-2 px-4 py-4">
			{notice ? <Text className="pb-2 text-center text-body text-secondary">{notice}</Text> : null}
			{tabs.map((tab) => {
				const host = hostOf(tab.url);
				const current = tab.id === currentTabId;
				return (
					<Pressable
						key={tab.id}
						accessibilityRole="button"
						accessibilityLabel={`${tab.title || host}, ${host}`}
						accessibilityState={{ selected: current }}
						onPress={() => onPick(tab.id)}
						className="flex-row items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 active:bg-surface-raised"
					>
						<View className="flex-1">
							<Text numberOfLines={1} className="text-[15px] font-semibold text-primary">
								{tab.title || host}
							</Text>
							<Text numberOfLines={1} className="text-caption text-secondary">
								{tab.front ? `${host} · In front` : host}
							</Text>
						</View>
						{current ? <Icon name="checkmark" color="#8B93FF" size={16} /> : null}
					</Pressable>
				);
			})}
		</ScrollView>
	);
}

function LiveTab({
	frame,
	control,
	drawing,
	reconnecting,
	machineName,
	viewer,
}: {
	frame: ViewerFrame;
	control: BrowserControl;
	drawing: boolean;
	reconnecting: boolean;
	machineName: string;
	viewer: BrowserViewerControls;
}) {
	const insets = useSafeAreaInsets();
	const input = useRef<TextInput>(null);
	/** What the hidden field holds: iOS reports its whole text on every change, and the page needs only what is new. */
	const typed = useRef("");
	const [typing, setTyping] = useState(false);
	const keyboard = useReanimatedKeyboardAnimation();
	const keyboardSpace = useAnimatedStyle(() => ({ height: Math.max(0, -keyboard.height.value) }));
	const controlling = control.kind === "you";

	useEffect(() => {
		if (!controlling) input.current?.blur();
	}, [controlling]);

	const takeControl = () => {
		const take = () => {
			void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
			viewer.takeControl();
		};
		if (control.kind !== "other") {
			take();
			return;
		}
		Alert.alert(`Take over from ${control.deviceName}?`, "They will only be able to watch.", [
			{ text: "Cancel", style: "cancel" },
			{ text: "Take over", onPress: take },
		]);
	};

	return (
		<View style={{ flex: 1 }}>
			{frame.mode === "snapshot" ? (
				<View className="flex-row items-center gap-3 border-b border-border bg-surface px-4 py-2">
					<Text className="flex-1 text-caption text-secondary">Background tab · updates every few seconds</Text>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Bring to front"
						disabled={reconnecting}
						onPress={viewer.bringToFront}
						className="rounded-full bg-surface-raised px-3 py-1.5 active:opacity-70"
					>
						<Text className="text-[13px] font-semibold text-primary">Bring to front</Text>
					</Pressable>
				</View>
			) : null}
			{drawing ? null : (
				<View className="border-b border-border bg-surface px-4 py-2">
					<Text className="text-caption text-secondary">
						Not updating. Bring Chrome to the front on {machineName}, or unlock its screen.
					</Text>
				</View>
			)}
			{control.kind === "other" ? (
				<View className="border-b border-border bg-surface px-4 py-2">
					<Text className="text-caption text-secondary">{control.deviceName} is in control</Text>
				</View>
			) : null}
			{controlling ? (
				<View className="border-b border-border bg-surface px-4 py-2">
					<Text className="text-caption text-secondary">You're in control of this tab.</Text>
				</View>
			) : null}
			<BrowserFrameView
				frame={frame}
				controlling={controlling}
				reconnecting={reconnecting}
				onDisplayed={viewer.ack}
				onTap={viewer.tap}
				onScroll={viewer.scroll}
			/>
			<View
				className="gap-2 border-t border-border bg-ink px-4 pt-3"
				style={{ paddingBottom: typing ? 8 : Math.max(insets.bottom, 12) }}
			>
				{controlling ? (
					<View className="flex-row items-center gap-2">
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Keyboard"
							accessibilityState={{ selected: typing }}
							onPress={() => (typing ? input.current?.blur() : input.current?.focus())}
							className={`h-10 w-12 items-center justify-center rounded-xl ${typing ? "bg-accent" : "bg-surface-raised"} active:opacity-70`}
						>
							<Icon name="keyboard" size={18} />
						</Pressable>
						{KEY_BUTTONS.map(({ key, label, accessibilityLabel }) => (
							<Pressable
								key={key}
								accessibilityRole="button"
								accessibilityLabel={accessibilityLabel}
								onPress={() => viewer.key(key)}
								className="h-10 flex-1 items-center justify-center rounded-xl bg-surface-raised active:opacity-70"
							>
								<Text className="text-[14px] font-semibold text-primary">{label}</Text>
							</Pressable>
						))}
						{/* Off-screen field that turns the iOS keyboard into keystrokes for the page. */}
						<TextInput
							ref={input}
							defaultValue=""
							autoCorrect={false}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							submitBehavior="submit"
							returnKeyType="default"
							onFocus={() => setTyping(true)}
							onBlur={() => {
								setTyping(false);
								input.current?.clear();
								typed.current = "";
							}}
							onChangeText={(text) => {
								// Deletions arrive as Backspace key presses below.
								if (text.length > typed.current.length && text.startsWith(typed.current))
									viewer.type(text.slice(typed.current.length));
								typed.current = text;
							}}
							onKeyPress={(event) => {
								if (event.nativeEvent.key === "Backspace") viewer.key("Backspace");
							}}
							onSubmitEditing={() => viewer.key("Enter")}
							accessibilityElementsHidden
							importantForAccessibility="no-hide-descendants"
							className="absolute h-px w-px opacity-0"
						/>
					</View>
				) : null}
				{controlling ? (
					<PrimaryButton
						label="Hand back"
						icon="hand.raised"
						disabled={reconnecting}
						onPress={() => {
							input.current?.blur();
							viewer.release();
						}}
					/>
				) : (
					<>
						<PrimaryButton
							label="Take control"
							icon="hand.point.up.left"
							disabled={reconnecting}
							onPress={takeControl}
						/>
						<Text className="text-center text-caption text-secondary">
							Brings this tab to the front on {machineName}
						</Text>
					</>
				)}
			</View>
			<Animated.View style={keyboardSpace} />
		</View>
	);
}
