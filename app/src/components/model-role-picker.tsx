import { MODEL_ROLES, type ModelRole } from "@omp-mobile/protocol";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
	Keyboard,
	Modal,
	PanResponder,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
	type LayoutChangeEvent,
} from "react-native";
import Animated, {
	Extrapolation,
	FadeIn,
	FadeOut,
	interpolate,
	interpolateColor,
	LayoutAnimationConfig,
	useAnimatedProps,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
	withTiming,
	type SharedValue,
} from "react-native-reanimated";
import { Icon } from "./ui";

const ROLE_INFO: Record<ModelRole, { label: string; caption: string; icon: SFSymbol }> = {
	smol: { label: "Smol", caption: "Lightweight model", icon: "hare.fill" },
	default: { label: "Default", caption: "Your default model", icon: "gauge.with.dots.needle.50percent" },
	slow: { label: "Slow", caption: "Thorough reasoning", icon: "tortoise.fill" },
};
const CUSTOM = { label: "Custom", caption: "Picked outside these roles" };

const ACCENT = "#8B93FF";
const SECONDARY = "#9A9AA2";
const TRACK_HEIGHT = 44;
const INSET = TRACK_HEIGHT / 2;
const KNOB = 30;
const DOT = 6;
const LAST = MODEL_ROLES.length - 1;
// Keeps the snap overshoot visible without flinging the knob off the track ends.
const OVERSHOOT = 0.1;
const SNAP = { damping: 11, stiffness: 190, mass: 0.8 };
const FOLLOW = { damping: 26, stiffness: 700, mass: 0.6 };
const SQUISH = { damping: 12, stiffness: 320 };
const ENTER = { damping: 14, stiffness: 210, mass: 0.9 };
const DISMISS_AFTER_PICK_MS = 350;
const EXIT_MS = 180;

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

export function modelRoleLabel(role: ModelRole | null): string {
	return role ? ROLE_INFO[role].label : CUSTOM.label;
}

/** Composer button showing the session's model role; opens the role slider. */
export function ModelRoleButton({
	role,
	onChange,
	disabled,
	anchor,
	onOpenChange,
}: {
	role: ModelRole | null;
	onChange(role: ModelRole): void;
	disabled?: boolean;
	/** View the slider sits just above; defaults to the button itself. */
	anchor?: RefObject<View | null>;
	onOpenChange?(open: boolean): void;
}) {
	const button = useRef<View>(null);
	const [open, setOpen] = useState(false);
	const toggle = (next: boolean) => {
		setOpen(next);
		onOpenChange?.(next);
	};
	return (
		<>
			<Pressable
				ref={button}
				accessibilityRole="button"
				accessibilityLabel={`Model: ${modelRoleLabel(role)}`}
				disabled={disabled}
				hitSlop={6}
				onPress={() => toggle(true)}
				className="h-[34px] w-[34px] items-center justify-center rounded-full bg-surface-raised disabled:opacity-30"
			>
				<Icon
					name={role ? ROLE_INFO[role].icon : "gauge.with.dots.needle.50percent"}
					size={16}
					color={role && role !== "default" ? ACCENT : SECONDARY}
				/>
			</Pressable>
			{open ? (
				<ModelRolePicker role={role} anchor={anchor ?? button} onChange={onChange} onClose={() => toggle(false)} />
			) : null}
		</>
	);
}

function knobCenter(width: number, position: number) {
	"worklet";
	return INSET + position * ((width - 2 * INSET) / LAST);
}

function ModelRolePicker({
	role,
	anchor,
	onChange,
	onClose,
}: {
	role: ModelRole | null;
	anchor: RefObject<View | null>;
	onChange(role: ModelRole): void;
	onClose(): void;
}) {
	const { height: windowHeight } = useWindowDimensions();
	const startIndex = MODEL_ROLES.indexOf(role ?? "default");
	const [bottom, setBottom] = useState<number | null>(null);
	const [shown, setShown] = useState<ModelRole | null>(role);
	const [trackWidth, setTrackWidth] = useState(0);
	const position = useSharedValue(startIndex);
	const width = useSharedValue(0);
	const pressed = useSharedValue(0);
	const appear = useSharedValue(0);
	const backdrop = useSharedValue(0);
	const nearest = useRef(startIndex);
	const finished = useRef(false);
	const closing = useRef(false);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	useEffect(() => {
		const measure = () => anchor.current?.measureInWindow((_x, y) => setBottom(Math.max(0, windowHeight - y + 16)));
		measure();
		// The composer moves when the keyboard comes or goes behind the overlay.
		const subscriptions = [
			Keyboard.addListener("keyboardDidShow", measure),
			Keyboard.addListener("keyboardDidHide", measure),
		];
		return () => {
			for (const subscription of subscriptions) subscription.remove();
		};
	}, [anchor, windowHeight]);
	useEffect(() => {
		backdrop.value = withTiming(1, { duration: 220 });
		const pending = timers.current;
		return () => {
			for (const timer of pending) clearTimeout(timer);
		};
	}, [backdrop]);
	const placed = bottom !== null;
	useEffect(() => {
		if (placed) appear.value = withSpring(1, ENTER);
	}, [placed, appear]);

	const dismiss = () => {
		if (closing.current) return;
		closing.current = true;
		appear.value = withTiming(0, { duration: EXIT_MS });
		backdrop.value = withTiming(0, { duration: EXIT_MS + 30 });
		timers.current.push(setTimeout(onClose, EXIT_MS + 40));
	};
	const select = (index: number) => {
		setShown(MODEL_ROLES[index]);
		if (index === nearest.current) return;
		nearest.current = index;
		void Haptics.selectionAsync();
	};
	const pick = (index: number) => {
		if (finished.current) return;
		finished.current = true;
		select(index);
		position.value = withSpring(index, SNAP);
		const picked = MODEL_ROLES[index];
		if (picked !== role) onChange(picked);
		timers.current.push(setTimeout(dismiss, DISMISS_AFTER_PICK_MS));
	};
	// The responder lives for the whole overlay; handlers reach the latest render through this ref.
	const latest = useRef({ select, pick });
	latest.current = { select, pick };

	const drag = useRef({ left: 0, moved: false });
	const indexAt = (pageX: number) => {
		const step = (width.value - 2 * INSET) / LAST;
		if (step <= 0) return nearest.current;
		return Math.min(LAST, Math.max(0, (pageX - drag.current.left - INSET) / step));
	};
	const [responder] = useState(() =>
		PanResponder.create({
			onStartShouldSetPanResponder: () => !finished.current && !closing.current,
			onMoveShouldSetPanResponder: () => !finished.current && !closing.current,
			onPanResponderTerminationRequest: () => false,
			onPanResponderGrant: (event) => {
				// Track children ignore touches, so the location is always relative to the track.
				drag.current = { left: event.nativeEvent.pageX - event.nativeEvent.locationX, moved: false };
				pressed.value = withSpring(1, SQUISH);
			},
			onPanResponderMove: (_event, gesture) => {
				if (!drag.current.moved && Math.abs(gesture.dx) < 4) return;
				drag.current.moved = true;
				const index = indexAt(gesture.moveX);
				position.value = withSpring(index, FOLLOW);
				latest.current.select(Math.round(index));
			},
			onPanResponderRelease: (_event, gesture) => {
				pressed.value = withSpring(0, SQUISH);
				latest.current.pick(Math.round(drag.current.moved ? indexAt(gesture.moveX) : indexAt(gesture.x0)));
			},
			onPanResponderTerminate: () => {
				pressed.value = withSpring(0, SQUISH);
				position.value = withSpring(nearest.current, SNAP);
			},
		}),
	);

	const onTrackLayout = (event: LayoutChangeEvent) => {
		width.value = event.nativeEvent.layout.width;
		setTrackWidth(event.nativeEvent.layout.width);
	};
	const blurProps = useAnimatedProps(() => ({ intensity: 45 * backdrop.value }));
	const dimStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
	const contentStyle = useAnimatedStyle(() => ({
		opacity: interpolate(appear.value, [0, 1], [0, 1], Extrapolation.CLAMP),
		transform: [{ translateY: (1 - appear.value) * 18 }, { scale: 0.85 + 0.15 * appear.value }],
	}));
	const fillStyle = useAnimatedStyle(() => {
		const visible = Math.min(LAST + OVERSHOOT, Math.max(-OVERSHOOT, position.value));
		return { width: width.value ? knobCenter(width.value, visible) + INSET : 0 };
	});
	const knobStyle = useAnimatedStyle(() => {
		const visible = Math.min(LAST + OVERSHOOT, Math.max(-OVERSHOOT, position.value));
		return {
			opacity: width.value ? 1 : 0,
			transform: [
				{ translateX: knobCenter(width.value, visible) - KNOB / 2 },
				{ scaleX: 1 + 0.2 * pressed.value },
				{ scaleY: 1 + 0.06 * pressed.value },
			],
		};
	});

	const info = shown ? ROLE_INFO[shown] : CUSTOM;
	return (
		<Modal
			transparent
			visible
			animationType="none"
			statusBarTranslucent
			navigationBarTranslucent
			onRequestClose={dismiss}
		>
			<LayoutAnimationConfig skipEntering>
				<AnimatedBlurView tint="dark" animatedProps={blurProps} style={StyleSheet.absoluteFill} pointerEvents="none" />
				<Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} pointerEvents="none" />
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Dismiss model picker"
					style={StyleSheet.absoluteFill}
					onPress={dismiss}
				/>
				<Animated.View
					pointerEvents="box-none"
					style={[styles.content, { bottom: bottom ?? 0 }, contentStyle, placed ? null : styles.hidden]}
				>
					<View style={styles.titleArea} pointerEvents="none">
						<Animated.View
							key={info.label}
							entering={FadeIn.duration(170)}
							exiting={FadeOut.duration(120)}
							style={styles.title}
						>
							<Text className="text-[30px] font-semibold text-primary">{info.label}</Text>
							<Text className="mt-1 text-caption text-secondary">{info.caption}</Text>
						</Animated.View>
					</View>
					<View onLayout={onTrackLayout} style={styles.track} {...responder.panHandlers}>
						<View style={styles.fillClip} pointerEvents="none">
							<Animated.View style={[styles.fill, fillStyle]} />
						</View>
						{trackWidth
							? MODEL_ROLES.map((stop, index) => (
									<Dot
										key={stop}
										index={index}
										left={knobCenter(trackWidth, index) - DOT / 2}
										position={position}
										label={ROLE_INFO[stop].label}
										onActivate={() => latest.current.pick(index)}
									/>
								))
							: null}
						<Animated.View style={[styles.knob, knobStyle]} pointerEvents="none" />
					</View>
				</Animated.View>
			</LayoutAnimationConfig>
		</Modal>
	);
}

function Dot({
	index,
	left,
	position,
	label,
	onActivate,
}: {
	index: number;
	left: number;
	position: SharedValue<number>;
	label: string;
	onActivate(): void;
}) {
	const style = useAnimatedStyle(() => ({
		backgroundColor: interpolateColor(position.value, [index - 0.2, index], ["#4A4A52", "#BDBDC4"]),
	}));
	return (
		<Animated.View
			accessible
			accessibilityRole="button"
			accessibilityLabel={`Model role ${label}`}
			onAccessibilityTap={onActivate}
			pointerEvents="none"
			style={[styles.dot, { left }, style]}
		/>
	);
}

const styles = StyleSheet.create({
	dim: { backgroundColor: "rgba(0, 0, 0, 0.35)" },
	hidden: { opacity: 0 },
	content: { position: "absolute", left: 24, right: 24, gap: 20 },
	titleArea: { height: 64 },
	title: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "flex-end" },
	track: {
		height: TRACK_HEIGHT,
		borderRadius: INSET,
		backgroundColor: "#141416",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "#2A2A2E",
		justifyContent: "center",
	},
	fillClip: { ...StyleSheet.absoluteFillObject, borderRadius: INSET, overflow: "hidden" },
	fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: INSET, backgroundColor: "#F4F4F6" },
	dot: { position: "absolute", width: DOT, height: DOT, borderRadius: DOT / 2 },
	knob: {
		position: "absolute",
		left: 0,
		width: KNOB,
		height: KNOB,
		borderRadius: KNOB / 2,
		backgroundColor: "#0B0B0C",
		borderWidth: 3,
		borderColor: "#FFFFFF",
		shadowColor: "#000000",
		shadowOpacity: 0.35,
		shadowRadius: 6,
		shadowOffset: { width: 0, height: 2 },
	},
});
