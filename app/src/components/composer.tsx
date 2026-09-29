import { Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "./ui";

export function Composer({
	value,
	onChangeText,
	onSend,
	working,
	onStop,
	disabled,
}: {
	value: string;
	onChangeText(value: string): void;
	onSend(): void;
	working: boolean;
	onStop(): void;
	disabled?: boolean;
}) {
	return (
		<View className="flex-row items-end gap-2 rounded-panel border border-border bg-surface px-3 py-2">
			<TextInput
				value={value}
				onChangeText={onChangeText}
				placeholder="Message OMP"
				placeholderTextColor="#6F6F77"
				multiline
				maxLength={20_000}
				className="max-h-32 min-h-10 flex-1 px-1 py-2 text-[16px] leading-5 text-primary"
			/>
			{working ? (
				<Pressable
					accessibilityLabel="Stop"
					onPress={onStop}
					className="mb-0.5 h-10 w-10 items-center justify-center rounded-full bg-danger"
				>
					<Icon name="stop.fill" size={14} />
				</Pressable>
			) : (
				<Pressable
					accessibilityLabel="Send"
					disabled={disabled || !value.trim()}
					onPress={onSend}
					className="mb-0.5 h-10 w-10 items-center justify-center rounded-full bg-accent disabled:opacity-30"
				>
					<Icon name="arrow.up" size={17} />
				</Pressable>
			)}
		</View>
	);
}
