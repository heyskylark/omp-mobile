import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState, type RefObject } from "react";
import { BackHandler, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useOverlay } from "./overlay";
import { Icon } from "./ui";

const ENTER = { duration: 350, dampingRatio: 0.8 };
const EXIT_MS = 150;

export type ComposerMenuItem = {
	label: string;
	icon: SFSymbol;
	disabled?: boolean;
	onSelect(): void;
};

/** The composer's `+` button; opens a menu of `items` just above `anchor`, keeping the keyboard up. */
export function ComposerMenuButton({
	items,
	anchor,
	onOpenChange,
}: {
	items: ComposerMenuItem[];
	anchor: RefObject<View | null>;
	onOpenChange?(open: boolean): void;
}) {
	const overlay = useOverlay();
	const hide = useRef<(() => void) | null>(null);
	// A button that unmounts with its menu open (e.g. navigating away) takes the menu with it.
	useEffect(() => () => hide.current?.(), []);
	const close = () => {
		hide.current?.();
		hide.current = null;
		onOpenChange?.(false);
	};
	const open = () => {
		void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		onOpenChange?.(true);
		hide.current = overlay.present(<ComposerMenu items={items} anchor={anchor} onClose={close} />);
	};
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel="Composer menu"
			hitSlop={6}
			onPress={open}
			className="h-[34px] w-[34px] items-center justify-center rounded-full bg-surface-raised"
		>
			<Icon name="plus" size={17} color="#ECECEE" />
		</Pressable>
	);
}

function ComposerMenu({
	items,
	anchor,
	onClose,
}: {
	items: ComposerMenuItem[];
	anchor: RefObject<View | null>;
	onClose(): void;
}) {
	const [frame, setFrame] = useState<{ left: number; top: number } | null>(null);
	const [menuHeight, setMenuHeight] = useState(0);
	const appear = useSharedValue(0);
	const closing = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		const measure = () => anchor.current?.measureInWindow((x, y) => setFrame({ left: x, top: y }));
		measure();
		// The composer moves when the keyboard comes or goes behind the overlay.
		const subscriptions = [
			Keyboard.addListener("keyboardDidShow", measure),
			Keyboard.addListener("keyboardDidHide", measure),
		];
		return () => {
			for (const subscription of subscriptions) subscription.remove();
			clearTimeout(timer.current);
		};
	}, [anchor]);
	const placed = frame !== null && menuHeight > 0;
	useEffect(() => {
		if (placed) appear.value = withSpring(1, ENTER);
	}, [placed, appear]);

	const dismiss = (then?: () => void) => {
		if (closing.current) return;
		closing.current = true;
		appear.value = withTiming(0, { duration: EXIT_MS });
		timer.current = setTimeout(() => {
			onClose();
			then?.();
		}, EXIT_MS);
	};
	const latestDismiss = useRef(dismiss);
	latestDismiss.current = dismiss;
	useEffect(() => {
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
			latestDismiss.current();
			return true;
		});
		return () => subscription.remove();
	}, []);

	const style = useAnimatedStyle(() => ({
		opacity: appear.value,
		transform: [{ translateY: (1 - appear.value) * 12 }, { scale: 0.9 + 0.1 * appear.value }],
	}));
	return (
		<View style={StyleSheet.absoluteFill}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Close menu"
				style={StyleSheet.absoluteFill}
				onPress={() => dismiss()}
			/>
			<Animated.View
				onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
				style={[
					styles.menu,
					frame ? { left: frame.left, top: frame.top - menuHeight - 10 } : null,
					style,
					placed ? null : styles.hidden,
				]}
			>
				<BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} />
				<View style={[StyleSheet.absoluteFill, styles.tint]} />
				{items.map((item) => (
					<Pressable
						key={item.label}
						accessibilityRole="button"
						accessibilityLabel={item.label}
						disabled={item.disabled}
						onPress={() => {
							void Haptics.selectionAsync();
							dismiss(item.onSelect);
						}}
						className="flex-row items-center gap-4 rounded-[20px] px-2 py-2 active:bg-white/10 disabled:opacity-35"
					>
						<View style={styles.iconWell}>
							<Icon name={item.icon} size={19} color="#ECECEE" />
						</View>
						<Text className="text-[17px] text-primary">{item.label}</Text>
					</Pressable>
				))}
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	hidden: { opacity: 0 },
	menu: {
		position: "absolute",
		minWidth: 220,
		padding: 8,
		gap: 4,
		borderRadius: 28,
		overflow: "hidden",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(255, 255, 255, 0.16)",
		transformOrigin: "left bottom",
	},
	// The blur must see the transcript, so the tint sits above it instead of being the menu's own background.
	tint: { backgroundColor: "rgba(30, 30, 33, 0.5)" },
	iconWell: {
		width: 44,
		height: 44,
		borderRadius: 22,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(255, 255, 255, 0.08)",
	},
});
