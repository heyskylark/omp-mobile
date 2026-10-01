import { BlurView } from "expo-blur";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, View, type FlatListProps } from "react-native";
import { KeyboardChatScrollView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { Icon } from "./ui";

/** Distance from the newest message, in points, past which the jump-to-bottom button shows. */
const JUMP_THRESHOLD = 160;

/** A view's top edge relative to the top of the list's viewport, and its height. */
type Frame = { top: number; height: number };

type Anchoring = {
	measure(view: View): Frame;
	restore(view: View, before: Frame, collapsed: boolean): void;
};

const AnchoringContext = createContext<Anchoring | null>(null);

// Fabric calls measureInWindow back synchronously with the committed layout, so a layout effect
// can read a resized view and scroll before the frame is drawn.
function windowFrame(view: View): Frame {
	let frame: Frame = { top: 0, height: 0 };
	view.measureInWindow((_x, y, _width, height) => {
		frame = { top: y, height };
	});
	return frame;
}

/** A composer floating over the bottom of the list and riding the keyboard. */
export type FloatingComposer = {
	/** Height the composer covers above the bottom of the screen while the keyboard is closed. */
	height: SharedValue<number>;
	/** How much of the keyboard's height the composer's resting place already clears. */
	keyboardOffset: number;
};

/**
 * An inverted chat transcript. Rows that expand in place through `useAnchoredToggle` keep their top edge
 * still, and a button returns to the newest message once the reader has scrolled away from it.
 * With a `composer`, the newest message stays above it and the keyboard: the space is a content inset, so
 * dragging the keyboard closed moves the transcript only with the finger, never twice as fast.
 */
export function ChatList<T>({
	composer,
	...props
}: Omit<FlatListProps<T>, "inverted" | "onScroll" | "onContentSizeChange" | "renderScrollComponent"> & {
	composer?: FloatingComposer;
}) {
	const list = useRef<FlatList<T>>(null);
	const viewport = useRef<View>(null);
	const offset = useRef(0);
	const contentHeight = useRef(0);
	// The newest end of an inverted list with a content inset sits at offset `-inset`, not 0.
	const newestOffset = useRef(0);
	const [away, setAway] = useState(false);
	const keyboard = useReanimatedKeyboardAnimation();
	const noComposer = useSharedValue(0);
	const composerHeight = composer?.height ?? noComposer;
	const keyboardOffset = composer?.keyboardOffset ?? 0;
	const jumpStyle = useAnimatedStyle(() => ({
		transform: [
			{
				translateY: -(composerHeight.value + (composer ? Math.max(0, -keyboard.height.value - keyboardOffset) : 0)),
			},
		],
	}));
	const anchoring = useMemo<Anchoring>(
		() => ({
			measure(view) {
				const frame = windowFrame(view);
				return { top: frame.top - (viewport.current ? windowFrame(viewport.current).top : 0), height: frame.height };
			},
			restore(view, before, collapsed) {
				if (!viewport.current) return;
				const port = windowFrame(viewport.current);
				const after = windowFrame(view);
				// Opening keeps the header where it was tapped; closing brings a header that scrolled off the top
				// back to the top edge instead of leaving the collapsed row out of sight.
				const target = collapsed ? Math.max(before.top, 0) : before.top;
				// Inverted: a larger offset reveals older rows and moves everything on screen down by the same amount.
				const content = contentHeight.current + after.height - before.height;
				const next = Math.min(
					Math.max(offset.current + target - (after.top - port.top), newestOffset.current),
					Math.max(content - port.height, 0),
				);
				if (Math.abs(next - offset.current) < 0.5) return;
				offset.current = next;
				list.current?.scrollToOffset({ offset: next, animated: false });
			},
		}),
		[],
	);
	return (
		<AnchoringContext value={anchoring}>
			<View ref={viewport} style={styles.viewport}>
				<FlatList
					{...props}
					ref={list}
					inverted
					renderScrollComponent={
						composer
							? (scrollProps) => (
									<KeyboardChatScrollView
										{...scrollProps}
										inverted
										offset={keyboardOffset}
										extraContentPadding={composerHeight}
										onContentInsetChange={(insets) => {
											newestOffset.current = -insets.top;
										}}
									/>
								)
							: undefined
					}
					onScroll={(event) => {
						offset.current = event.nativeEvent.contentOffset.y;
						setAway(offset.current - newestOffset.current > JUMP_THRESHOLD);
					}}
					onContentSizeChange={(_width, height) => {
						contentHeight.current = height;
					}}
				/>
				{away ? (
					<Animated.View
						entering={FadeIn.duration(150)}
						exiting={FadeOut.duration(120)}
						style={[styles.jumpSlot, jumpStyle]}
						pointerEvents="box-none"
					>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Scroll to bottom"
							onPress={() => list.current?.scrollToOffset({ offset: newestOffset.current, animated: true })}
							style={styles.jump}
							className="active:opacity-80"
						>
							<BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} />
							<Icon name="arrow.down" size={17} />
						</Pressable>
					</Animated.View>
				) : null}
			</View>
		</AnchoringContext>
	);
}

/**
 * Expanded state for a row inside a `ChatList`. Attach `ref` to the view that changes height and
 * call `toggle` to open or close it without the row's header jumping away from the reader.
 */
export function useAnchoredToggle() {
	const anchoring = useContext(AnchoringContext);
	const ref = useRef<View>(null);
	const before = useRef<Frame | null>(null);
	const [expanded, setExpanded] = useState(false);
	useLayoutEffect(() => {
		const frame = before.current;
		before.current = null;
		if (frame && anchoring && ref.current) anchoring.restore(ref.current, frame, !expanded);
	}, [anchoring, expanded]);
	const toggle = () => {
		if (anchoring && ref.current) before.current = anchoring.measure(ref.current);
		setExpanded((value) => !value);
	};
	return { ref, expanded, toggle };
}

const styles = StyleSheet.create({
	viewport: { flex: 1 },
	jumpSlot: {
		position: "absolute",
		bottom: 12,
		alignSelf: "center",
		shadowColor: "#000000",
		shadowOpacity: 0.4,
		shadowRadius: 10,
		shadowOffset: { width: 0, height: 4 },
	},
	jump: {
		width: 40,
		height: 40,
		borderRadius: 20,
		overflow: "hidden",
		alignItems: "center",
		justifyContent: "center",
		borderWidth: 1,
		borderColor: "rgba(255, 255, 255, 0.14)",
		backgroundColor: "rgba(27, 27, 30, 0.7)",
	},
});
