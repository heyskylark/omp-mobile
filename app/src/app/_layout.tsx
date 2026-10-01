import "../../global.css";
import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { OmpNative } from "../../modules/omp-native";
import { OverlayProvider } from "../components/overlay";
import { ToastProvider, useToast } from "../components/toast";
import { useMachines } from "../data/machines";
import type { NotificationOpen } from "../native/types";

function NotificationBridge() {
	const { show } = useToast();
	useEffect(() => {
		const open = (notification: NotificationOpen) =>
			router.push({
				pathname: "/machine/[machineId]/session/[sessionId]",
				params: { machineId: notification.machineId, sessionId: notification.sessionId },
			});
		void OmpNative.consumeLaunchNotification().then((notification) => {
			if (notification) open(notification);
		});
		const openSubscription = OmpNative.addNotificationOpenListener(open);
		const actionSubscription = OmpNative.addActionResultListener((result) =>
			show(
				result.message ?? (result.ok ? "Response sent" : "Response could not be sent"),
				result.ok ? "info" : "error",
			),
		);
		return () => {
			openSubscription.remove();
			actionSubscription.remove();
		};
	}, [show]);
	return null;
}

export default function RootLayout() {
	const load = useMachines((state) => state.load);
	useEffect(() => {
		void load();
	}, [load]);
	return (
		<KeyboardProvider>
			<ToastProvider>
				<OverlayProvider>
					<StatusBar style="light" />
					<NotificationBridge />
					<Stack
						screenOptions={{
							headerStyle: { backgroundColor: "#0B0B0C" },
							headerTintColor: "#ECECEE",
							headerShadowVisible: false,
							contentStyle: { backgroundColor: "#0B0B0C" },
							headerBackButtonDisplayMode: "minimal",
						}}
					>
						<Stack.Screen name="index" options={{ title: "Computers" }} />
						<Stack.Screen name="pair" options={{ title: "Add computer", presentation: "modal" }} />
						<Stack.Screen name="machine/[machineId]/index" options={{ title: "Sessions" }} />
						<Stack.Screen name="machine/[machineId]/new" options={{ title: "New session" }} />
						<Stack.Screen name="machine/[machineId]/browse" options={{ title: "Choose folder" }} />
						<Stack.Screen name="machine/[machineId]/session/[sessionId]/index" options={{ title: "Session" }} />
						<Stack.Screen name="machine/[machineId]/session/[sessionId]/agent/[agentId]" options={{ title: "Agent" }} />
						<Stack.Screen name="machine/[machineId]/settings" options={{ title: "Computer" }} />
						<Stack.Screen name="machine/[machineId]/usage" options={{ title: "Usage", presentation: "modal" }} />
						<Stack.Screen
							name="machine/[machineId]/browser"
							options={{ title: "Browser", presentation: "fullScreenModal" }}
						/>
					</Stack>
				</OverlayProvider>
			</ToastProvider>
		</KeyboardProvider>
	);
}
