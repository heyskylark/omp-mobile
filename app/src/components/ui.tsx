import type { PropsWithChildren, ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";

export function Icon({ name, color = "#ECECEE", size = 18 }: { name: SFSymbol; color?: string; size?: number }) {
	return <SymbolView name={name} tintColor={color} style={{ width: size, height: size }} />;
}

export function PrimaryButton({
	label,
	onPress,
	disabled,
	icon,
	danger = false,
}: {
	label: string;
	onPress(): void;
	disabled?: boolean;
	icon?: SFSymbol;
	danger?: boolean;
}) {
	return (
		<Pressable
			disabled={disabled}
			onPress={onPress}
			className={`min-h-12 flex-row items-center justify-center gap-2 rounded-card px-5 ${danger ? "bg-danger" : "bg-accent"} ${disabled ? "opacity-40" : "active:opacity-80"}`}
		>
			{icon ? <Icon name={icon} size={17} /> : null}
			<Text className="text-[16px] font-semibold text-primary">{label}</Text>
		</Pressable>
	);
}

export function Surface({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
	return <View className={`rounded-card border border-border bg-surface px-4 py-4 ${className}`}>{children}</View>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
	return (
		<View className="flex-1 items-center justify-center gap-3 bg-ink px-8">
			<ActivityIndicator color="#8B93FF" />
			<Text className="text-body text-secondary">{label}</Text>
		</View>
	);
}

export function EmptyState({
	icon,
	title,
	detail,
	action,
}: {
	icon: SFSymbol;
	title: string;
	detail: string;
	action?: ReactNode;
}) {
	return (
		<View className="flex-1 items-center justify-center px-9">
			<View className="mb-5 h-14 w-14 items-center justify-center rounded-full bg-surface-raised">
				<Icon name={icon} color="#8B93FF" size={25} />
			</View>
			<Text className="text-center text-xl font-semibold text-primary">{title}</Text>
			<Text className="mb-6 mt-2 text-center text-body text-secondary">{detail}</Text>
			{action}
		</View>
	);
}

export function ErrorState({ message, retry }: { message: string; retry?(): void }) {
	return (
		<EmptyState
			icon="exclamationmark.triangle"
			title="Something went wrong"
			detail={message}
			action={retry ? <PrimaryButton label="Try again" onPress={retry} /> : undefined}
		/>
	);
}
