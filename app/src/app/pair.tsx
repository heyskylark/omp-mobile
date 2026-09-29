import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { decodePairingUrl, encodePairingUrl } from "@omp-mobile/protocol";
import { OmpNative } from "../../modules/omp-native";
import { OmpApi, pair } from "../data/api";
import { useMachines } from "../data/machines";
import { Icon, PrimaryButton } from "../components/ui";

type PairState = { kind: "idle" } | { kind: "connecting" } | { kind: "failed"; message: string };

async function registerPush(api: OmpApi) {
	const push = await OmpNative.registerForPush();
	if (push) await api.registerPush(push.token, push.environment);
}

export default function PairScreen() {
	const params = useLocalSearchParams<{ url?: string; code?: string; name?: string }>();
	const [permission, requestPermission] = useCameraPermissions();
	const [link, setLink] = useState("");
	const [state, setState] = useState<PairState>({ kind: "idle" });
	const attempted = useRef<string | null>(null);
	const save = useMachines((store) => store.save);

	const connect = async (raw: string) => {
		const payload = decodePairingUrl(raw.trim());
		if (!payload) {
			setState({ kind: "failed", message: "That is not a valid OMP pairing link." });
			return;
		}
		if (attempted.current === payload.code) return;
		attempted.current = payload.code;
		setState({ kind: "connecting" });
		try {
			const normalizedUrl = payload.url.replace(/\/$/, "");
			const previous = useMachines
				.getState()
				.machines.find((machine) => machine.url.replace(/\/$/, "") === normalizedUrl);
			const response = await pair(payload.url, {
				code: payload.code,
				deviceName: "iPhone",
				...(previous ? { previousToken: previous.token } : {}),
			});
			const machine = {
				machineId: response.machineId,
				name: response.machineName || payload.name,
				url: payload.url,
				deviceId: response.deviceId,
				token: response.token,
				pushKey: response.pushKey,
				pairedAt: new Date().toISOString(),
			};
			await save(machine);
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			registerPush(new OmpApi(machine)).catch(() => undefined);
			router.replace({ pathname: "/machine/[machineId]", params: { machineId: response.machineId } });
		} catch (caught) {
			attempted.current = null;
			setState({ kind: "failed", message: caught instanceof Error ? caught.message : "Pairing failed." });
		}
	};

	useEffect(() => {
		if (params.url && params.code && params.name) {
			void connect(encodePairingUrl({ url: params.url, code: params.code, name: params.name }));
		}
	}, [params.url, params.code, params.name]);

	const onScanned = ({ data }: BarcodeScanningResult) => {
		if (state.kind !== "connecting") void connect(data);
	};

	const pasteAndConnect = async () => {
		const value = await Clipboard.getStringAsync();
		setLink(value);
		await connect(value);
	};

	return (
		<KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 bg-ink">
			<View className="mx-5 mt-5 aspect-square overflow-hidden rounded-panel border border-border bg-surface">
				{permission?.granted ? (
					<CameraView
						active={state.kind !== "connecting"}
						className="flex-1"
						barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
						onBarcodeScanned={onScanned}
					/>
				) : (
					<Pressable onPress={() => void requestPermission()} className="flex-1 items-center justify-center gap-3 px-8">
						<Icon name="qrcode.viewfinder" color="#8B93FF" size={52} />
						<Text className="text-center text-body text-secondary">
							{permission?.canAskAgain === false
								? "Camera access is off. Enable it in Settings, or paste the pairing link below."
								: "Tap to allow the camera so you can scan the pairing code."}
						</Text>
					</Pressable>
				)}
				<View pointerEvents="none" className="absolute inset-10 rounded-panel border-2 border-accent" />
			</View>
			<Text className="mx-8 mt-5 text-center text-body text-secondary">
				Scan the code shown by OMP Mobile on your Mac, or paste its pairing link.
			</Text>
			<View className="mt-auto gap-3 px-5 pb-8">
				{state.kind === "failed" ? <Text className="text-center text-caption text-danger">{state.message}</Text> : null}
				<View className="flex-row items-center rounded-card border border-border bg-surface px-3">
					<TextInput
						value={link}
						onChangeText={setLink}
						autoCapitalize="none"
						autoCorrect={false}
						placeholder="ompmobile://pair?…"
						placeholderTextColor="#6F6F77"
						className="h-12 flex-1 text-body text-primary"
					/>
					<Pressable onPress={() => void pasteAndConnect()} className="p-2">
						<Icon name="doc.on.clipboard" color="#8B93FF" />
					</Pressable>
				</View>
				<PrimaryButton
					label={state.kind === "connecting" ? "Connecting…" : "Connect"}
					disabled={state.kind === "connecting" || !link.trim()}
					onPress={() => void connect(link)}
				/>
			</View>
		</KeyboardAvoidingView>
	);
}
