import type { AgentStatus, AgentSummary } from "@omp-mobile/protocol";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef } from "react";
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentName, agentRows, runningCount, statusLabel } from "../data/agents";
import { useOverlay } from "./overlay";
import { Icon } from "./ui";

const STATUS_ICON: Record<Exclude<AgentStatus, "running">, { name: SFSymbol; color: string }> = {
	completed: { name: "checkmark.circle.fill", color: "#3FB950" },
	failed: { name: "xmark.circle.fill", color: "#F85149" },
	aborted: { name: "stop.circle.fill", color: "#9A9AA2" },
	interrupted: { name: "exclamationmark.circle.fill", color: "#D29922" },
};

export function AgentStatusIcon({ status, size = 15 }: { status: AgentStatus; size?: number }) {
	if (status === "running") return <ActivityIndicator size="small" color="#8B93FF" />;
	const icon = STATUS_ICON[status];
	return <Icon name={icon.name} size={size} color={icon.color} />;
}

/** Header button listing the agents below `under` (the session when undefined); hidden while there are none. */
export function AgentsButton({
	agents,
	under,
	onOpen,
}: {
	agents: readonly AgentSummary[];
	under?: string;
	onOpen(agentId: string): void;
}) {
	const overlay = useOverlay();
	const hide = useRef<(() => void) | null>(null);
	const rows = agentRows(agents, under);
	const close = () => {
		hide.current?.();
		hide.current = null;
	};
	const present = () => {
		hide.current = overlay.present(
			<AgentMenu
				agents={agents}
				under={under}
				onClose={close}
				onOpen={(agentId) => {
					close();
					onOpen(agentId);
				}}
			/>,
		);
	};
	// The overlay holds a copy of the element, so an open menu is re-presented with each roster update.
	const latestPresent = useRef(present);
	latestPresent.current = present;
	useEffect(() => {
		if (hide.current) latestPresent.current();
	}, [agents, under]);
	useEffect(() => () => hide.current?.(), []);
	if (!rows.length) return null;
	const running = runningCount(agents, under);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={running ? `Agents, ${running} running` : "Agents"}
			hitSlop={6}
			onPress={present}
			className="h-[30px] flex-row items-center gap-1 rounded-full bg-surface-raised px-2"
		>
			<Icon name="person.2" size={16} color={running ? "#8B93FF" : "#9A9AA2"} />
			{running ? <Text className="text-[13px] font-semibold text-accent">{running}</Text> : null}
		</Pressable>
	);
}

function AgentMenu({
	agents,
	under,
	onOpen,
	onClose,
}: {
	agents: readonly AgentSummary[];
	under?: string;
	onOpen(agentId: string): void;
	onClose(): void;
}) {
	const insets = useSafeAreaInsets();
	const latestClose = useRef(onClose);
	latestClose.current = onClose;
	useEffect(() => {
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
			latestClose.current();
			return true;
		});
		return () => subscription.remove();
	}, []);
	const rows = agentRows(agents, under);
	const running = runningCount(agents, under);
	return (
		<View style={StyleSheet.absoluteFill}>
			<Animated.View
				entering={FadeIn.duration(160)}
				exiting={FadeOut.duration(120)}
				style={[StyleSheet.absoluteFill, styles.dim]}
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Dismiss agents"
					style={StyleSheet.absoluteFill}
					onPress={onClose}
				/>
			</Animated.View>
			<Animated.View
				entering={FadeIn.duration(180)}
				exiting={FadeOut.duration(120)}
				style={[styles.panel, { top: insets.top + 52 }]}
			>
				<View className="flex-row items-center justify-between border-b border-border px-4 py-3">
					<Text className="text-[15px] font-semibold text-primary">Agents</Text>
					<Text className="text-caption text-secondary">{running ? `${running} running` : "None running"}</Text>
				</View>
				<ScrollView contentContainerClassName="py-1">
					{rows.map(({ agent, depth }) => (
						<Pressable
							key={agent.id}
							accessibilityRole="button"
							accessibilityLabel={`${agentName(agent.id)}, ${statusLabel(agent.status)}`}
							onPress={() => onOpen(agent.id)}
							style={{ paddingLeft: 16 + depth * 18 }}
							className="flex-row items-center gap-3 py-2.5 pr-4 active:bg-surface-raised"
						>
							<View className="h-5 w-5 items-center justify-center">
								<AgentStatusIcon status={agent.status} />
							</View>
							<View className="flex-1">
								<Text numberOfLines={1} className="text-[15px] font-medium text-primary">
									{agentName(agent.id)}
								</Text>
								<Text numberOfLines={1} className="text-caption text-secondary">
									{(agent.status === "running" ? agent.activity : undefined) ??
										agent.description ??
										statusLabel(agent.status)}
								</Text>
							</View>
							<Icon name="chevron.right" size={12} color="#9A9AA2" />
						</Pressable>
					))}
				</ScrollView>
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	dim: { backgroundColor: "rgba(0, 0, 0, 0.45)" },
	panel: {
		position: "absolute",
		left: 16,
		right: 16,
		maxHeight: "65%",
		overflow: "hidden",
		borderRadius: 20,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "#2A2A2E",
		backgroundColor: "#141416",
	},
});
