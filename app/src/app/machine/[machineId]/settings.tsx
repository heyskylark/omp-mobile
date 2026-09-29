import { Alert, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ErrorState, Icon, PrimaryButton, Surface } from "../../../components/ui";
import { OmpApi } from "../../../data/api";
import { useMachine, useMachines } from "../../../data/machines";

export default function MachineSettingsScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const machine = useMachine(machineId);
	const remove = useMachines((state) => state.remove);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
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
			<View className="mt-auto pb-8">
				<PrimaryButton label="Remove computer" danger icon="trash" onPress={confirmRemove} />
			</View>
		</View>
	);
}
