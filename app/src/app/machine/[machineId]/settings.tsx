import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { MAX_MACHINE_NAME_LENGTH } from "@omp-mobile/protocol";
import { ErrorState, Icon, PrimaryButton, Surface } from "../../../components/ui";
import { useToast } from "../../../components/toast";
import { OmpApi } from "../../../data/api";
import { useMachine, useMachines } from "../../../data/machines";

export default function MachineSettingsScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const machine = useMachine(machineId);
	const remove = useMachines((state) => state.remove);
	const applyInfo = useMachines((state) => state.applyInfo);
	const { show } = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const savedSinceMount = useRef(false);
	useEffect(() => {
		const current = useMachines.getState().machines.find((item) => item.machineId === machineId);
		if (!current) return;
		new OmpApi(current)
			.info()
			.then((info) => (savedSinceMount.current ? undefined : applyInfo(current.machineId, info)))
			.catch(() => {});
	}, [machineId, applyInfo]);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;

	const value = draft ?? machine.name;
	const name = value.trim();
	const canSave = !saving && name.length > 0 && name !== machine.name;
	const saveName = async () => {
		if (!canSave) return;
		setSaving(true);
		savedSinceMount.current = true;
		try {
			await applyInfo(machine.machineId, await new OmpApi(machine).setMachineName(name));
			setDraft(null);
			Keyboard.dismiss();
		} catch (error) {
			show(error instanceof Error ? error.message : "Could not rename the computer.", "error");
		} finally {
			setSaving(false);
		}
	};
	const confirmRemove = () =>
		Alert.alert(
			"Remove computer?",
			`OMP session data stays on ${machine.name}. This only removes this phone's access.`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Remove",
					style: "destructive",
					onPress: () =>
						void (async () => {
							try {
								await new OmpApi(machine).removeDevice();
							} catch {}
							await remove(machine.machineId);
							router.dismissAll();
							router.replace("/");
						})(),
				},
			],
		);
	return (
		<View className="flex-1 bg-ink px-4 pt-5">
			<Surface className="flex-row items-center gap-4">
				<View className="h-12 w-12 items-center justify-center rounded-xl bg-surface-raised">
					<Icon name="desktopcomputer" color="#8B93FF" size={23} />
				</View>
				<View className="flex-1">
					<Text className="text-[17px] font-semibold text-primary">{machine.name}</Text>
					<Text numberOfLines={1} className="mt-1 text-caption text-secondary">
						{machine.url}
					</Text>
				</View>
			</Surface>
			<Text className="mb-2 mt-6 px-1 text-caption font-medium text-secondary">NAME</Text>
			<View className="flex-row items-center rounded-card border border-border bg-surface pl-4 pr-2">
				<TextInput
					accessibilityLabel="Computer name"
					value={value}
					onChangeText={setDraft}
					maxLength={MAX_MACHINE_NAME_LENGTH}
					autoCorrect={false}
					returnKeyType="done"
					onSubmitEditing={() => void saveName()}
					editable={!saving}
					placeholder="Computer name"
					placeholderTextColor="#6F6F77"
					className="h-12 flex-1 text-body text-primary"
				/>
				{saving ? (
					<View className="px-2">
						<ActivityIndicator color="#8B93FF" />
					</View>
				) : canSave ? (
					<Pressable accessibilityRole="button" onPress={() => void saveName()} className="px-2 py-2">
						<Text className="text-[15px] font-semibold text-accent">Save</Text>
					</Pressable>
				) : null}
			</View>
			<Text className="mt-2 px-1 text-caption text-secondary">
				Changes the name on the computer, so every paired phone and the Mac menu bar show it.
			</Text>
			<View className="mt-auto pb-8">
				<PrimaryButton label="Remove computer" danger icon="trash" onPress={confirmRemove} />
			</View>
		</View>
	);
}
