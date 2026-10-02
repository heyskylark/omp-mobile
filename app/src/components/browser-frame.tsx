import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { toCssPoint, type ViewerFrame } from "../data/browser";

const TAP_SLOP = 10;
const TAP_MS = 300;
/** Holding a finger still this long starts selecting text instead of scrolling. */
const HOLD_MS = 450;
/** A tap this soon after another, this close to it, continues a double or triple click. */
const MULTI_TAP_MS = 350;
const MULTI_TAP_SLOP = 24;

type Slot = 0 | 1;

interface Gesture {
	/** Touch start in the image's unzoomed layout points. */
	x: number;
	y: number;
	startedAt: number;
	dragging: boolean;
	/** A hold started a text selection: the finger drags Chrome's held mouse button instead of scrolling. */
	selecting: boolean;
	/** A second finger joined: the native pinch owns the gesture and nothing is sent. */
	pinching: boolean;
	/** Gesture translation already accounted for, in screen points. */
	seenDx: number;
	seenDy: number;
	/** Translation not yet sent, in screen points; flushed once per animation frame. */
	queuedDx: number;
	queuedDy: number;
}

/**
 * Shows the newest frame of the watched tab. Two stacked images double-buffer the stream: the hidden one decodes
 * the next frame and becomes visible only once loaded, so the picture never blanks. Each frame is reported through
 * `onDisplayed` once it is on screen (or skipped), which is the server's cue to send the next one.
 *
 * While `controlling`, one finger taps and scrolls the page; a double or triple tap selects a word or paragraph, and
 * holding still before dragging selects text. Pinching still zooms locally. Otherwise every touch only pans and
 * zooms the picture.
 */
export function BrowserFrameView({
	frame,
	controlling,
	reconnecting,
	onDisplayed,
	onTap,
	onScroll,
	onDrag,
}: {
	frame: ViewerFrame;
	controlling: boolean;
	reconnecting: boolean;
	onDisplayed(frame: ViewerFrame): void;
	onTap(x: number, y: number, count: number): void;
	onScroll(x: number, y: number, dx: number, dy: number): void;
	onDrag(phase: "start" | "move" | "end", x: number, y: number): void;
}) {
	const [layoutWidth, setLayoutWidth] = useState(0);
	const [slots, setSlots] = useState<[ViewerFrame | null, ViewerFrame | null]>([null, null]);
	const [front, setFront] = useState<Slot>(0);
	const frontRef = useRef<Slot>(0);
	const loading = useRef<ViewerFrame | null>(null);
	const pending = useRef<ViewerFrame | null>(null);
	const callbacks = useRef({ onDisplayed, onTap, onScroll, onDrag });
	useEffect(() => {
		callbacks.current = { onDisplayed, onTap, onScroll, onDrag };
	}, [onDisplayed, onTap, onScroll, onDrag]);

	const load = useCallback((next: ViewerFrame) => {
		loading.current = next;
		const hidden: Slot = frontRef.current === 0 ? 1 : 0;
		setSlots((current) => (hidden === 0 ? [next, current[1]] : [current[0], next]));
	}, []);

	useEffect(() => {
		if (frame === loading.current || frame === pending.current) return;
		if (!loading.current) {
			load(frame);
			return;
		}
		// Acknowledged unseen so the server, which caps unacknowledged frames, keeps the stream going.
		if (pending.current) callbacks.current.onDisplayed(pending.current);
		pending.current = frame;
	}, [frame, load]);

	const settle = (slot: Slot, settled: ViewerFrame, shown: boolean) => {
		if (loading.current !== settled) return;
		loading.current = null;
		if (shown) {
			frontRef.current = slot;
			setFront(slot);
		}
		callbacks.current.onDisplayed(settled);
		const next = pending.current;
		pending.current = null;
		if (next) load(next);
	};

	const slot0 = slots[0];
	const slot1 = slots[1];
	// One source object per frame: a new object for an unchanged frame could make the image reload.
	const source0 = useMemo(() => (slot0 ? { uri: `data:image/jpeg;base64,${slot0.jpeg}` } : null), [slot0]);
	const source1 = useMemo(() => (slot1 ? { uri: `data:image/jpeg;base64,${slot1.jpeg}` } : null), [slot1]);
	const viewport = slots[front] ?? frame;

	const live = useRef({ controlling, viewport, layoutWidth, zoom: 1 });
	useEffect(() => {
		live.current.controlling = controlling;
		live.current.viewport = viewport;
		live.current.layoutWidth = layoutWidth;
	}, [controlling, viewport, layoutWidth]);

	const responder = useMemo(() => {
		let gesture: Gesture | null = null;
		let animationFrame: number | null = null;
		let holdTimer: ReturnType<typeof setTimeout> | undefined;
		let lastTap: { at: number; x: number; y: number; count: number } | null = null;
		/** The CSS pixel under the finger, `dx`/`dy` screen points from where the gesture started. */
		const pointAt = (start: Gesture, dx: number, dy: number) => {
			const { viewport: size, layoutWidth: width, zoom } = live.current;
			return toCssPoint({ x: start.x + dx / zoom, y: start.y + dy / zoom }, width, size);
		};
		const flush = () => {
			animationFrame = null;
			if (!gesture) return;
			if (gesture.selecting) {
				const point = pointAt(gesture, gesture.seenDx, gesture.seenDy);
				callbacks.current.onDrag("move", point.x, point.y);
				return;
			}
			if (!gesture.queuedDx && !gesture.queuedDy) return;
			const { viewport: size, layoutWidth: width, zoom } = live.current;
			if (width <= 0) return;
			// Screen points → unzoomed layout points → CSS pixels. Dragging up scrolls the page down, as on a touch screen.
			const scale = size.width / width / zoom;
			const point = toCssPoint(gesture, width, size);
			callbacks.current.onScroll(point.x, point.y, -gesture.queuedDx * scale, -gesture.queuedDy * scale);
			gesture.queuedDx = 0;
			gesture.queuedDy = 0;
		};
		const cancelFlush = () => {
			if (animationFrame !== null) cancelAnimationFrame(animationFrame);
			animationFrame = null;
		};
		const endSelection = (ended: Gesture, dx: number, dy: number) => {
			cancelFlush();
			const point = pointAt(ended, dx, dy);
			callbacks.current.onDrag("end", point.x, point.y);
		};
		return PanResponder.create({
			onStartShouldSetPanResponder: () => live.current.controlling,
			onMoveShouldSetPanResponder: () => live.current.controlling,
			onPanResponderTerminationRequest: () => false,
			onPanResponderGrant: (event) => {
				const started: Gesture = {
					x: event.nativeEvent.locationX,
					y: event.nativeEvent.locationY,
					startedAt: Date.now(),
					dragging: false,
					selecting: false,
					pinching: false,
					seenDx: 0,
					seenDy: 0,
					queuedDx: 0,
					queuedDy: 0,
				};
				gesture = started;
				clearTimeout(holdTimer);
				holdTimer = setTimeout(() => {
					if (gesture !== started || started.dragging || started.pinching) return;
					started.selecting = true;
					void Haptics.selectionAsync();
					const point = pointAt(started, started.seenDx, started.seenDy);
					callbacks.current.onDrag("start", point.x, point.y);
				}, HOLD_MS);
			},
			onPanResponderMove: (_event, state) => {
				if (!gesture || gesture.pinching) return;
				if (state.numberActiveTouches > 1) {
					clearTimeout(holdTimer);
					if (gesture.selecting) endSelection(gesture, gesture.seenDx, gesture.seenDy);
					gesture.selecting = false;
					gesture.pinching = true;
					cancelFlush();
					return;
				}
				if (gesture.selecting) {
					gesture.seenDx = state.dx;
					gesture.seenDy = state.dy;
					if (animationFrame === null) animationFrame = requestAnimationFrame(flush);
					return;
				}
				if (!gesture.dragging && Math.hypot(state.dx, state.dy) < TAP_SLOP) return;
				clearTimeout(holdTimer);
				gesture.dragging = true;
				gesture.queuedDx += state.dx - gesture.seenDx;
				gesture.queuedDy += state.dy - gesture.seenDy;
				gesture.seenDx = state.dx;
				gesture.seenDy = state.dy;
				if (animationFrame === null) animationFrame = requestAnimationFrame(flush);
			},
			onPanResponderRelease: (_event, state) => {
				clearTimeout(holdTimer);
				const ended = gesture;
				if (ended?.selecting) endSelection(ended, state.dx, state.dy);
				else if (ended?.dragging && !ended.pinching) {
					cancelFlush();
					flush();
				} else if (
					ended &&
					!ended.pinching &&
					Date.now() - ended.startedAt < TAP_MS &&
					Math.hypot(state.dx, state.dy) < TAP_SLOP
				) {
					const now = Date.now();
					const count =
						lastTap &&
						now - lastTap.at < MULTI_TAP_MS &&
						Math.hypot(ended.x - lastTap.x, ended.y - lastTap.y) < MULTI_TAP_SLOP
							? Math.min(3, lastTap.count + 1)
							: 1;
					lastTap = { at: now, x: ended.x, y: ended.y, count };
					const { viewport: size, layoutWidth: width } = live.current;
					const point = toCssPoint(ended, width, size);
					callbacks.current.onTap(point.x, point.y, count);
				}
				gesture = null;
				cancelFlush();
			},
			onPanResponderTerminate: () => {
				clearTimeout(holdTimer);
				if (gesture?.selecting) endSelection(gesture, gesture.seenDx, gesture.seenDy);
				gesture = null;
				cancelFlush();
			},
		});
	}, []);

	const height = layoutWidth > 0 ? (layoutWidth * viewport.height) / Math.max(1, viewport.width) : 0;
	return (
		<View className="flex-1">
			<ScrollView
				style={styles.fill}
				onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}
				maximumZoomScale={4}
				minimumZoomScale={1}
				centerContent
				scrollEnabled={!controlling}
				scrollEventThrottle={16}
				onScroll={(event) => {
					live.current.zoom = event.nativeEvent.zoomScale || 1;
				}}
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
			>
				<View
					{...responder.panHandlers}
					style={{ width: layoutWidth, height, opacity: reconnecting ? 0.4 : 1 }}
					accessibilityLabel="Browser tab"
				>
					{/* Touches land on the container so locationX/Y are relative to the whole image. */}
					<View pointerEvents="none" style={StyleSheet.absoluteFill}>
						{/* A fresh image per frame: an image given a source equal to its last one never reports onLoad,
						    and a static page repeats frames, which would leave the next frame waiting forever. */}
						{source0 && slot0 ? (
							<Image
								key={`${slot0.epoch}:${slot0.seq}`}
								source={source0}
								resizeMode="stretch"
								style={[StyleSheet.absoluteFill, { opacity: front === 0 ? 1 : 0 }]}
								onLoad={() => settle(0, slot0, true)}
								onError={() => settle(0, slot0, false)}
							/>
						) : null}
						{source1 && slot1 ? (
							<Image
								key={`${slot1.epoch}:${slot1.seq}`}
								source={source1}
								resizeMode="stretch"
								style={[StyleSheet.absoluteFill, { opacity: front === 1 ? 1 : 0 }]}
								onLoad={() => settle(1, slot1, true)}
								onError={() => settle(1, slot1, false)}
							/>
						) : null}
					</View>
				</View>
			</ScrollView>
			{reconnecting ? (
				<View pointerEvents="none" className="absolute left-0 right-0 top-3 items-center">
					<Text className="rounded-full bg-surface-raised px-3 py-1 text-caption text-secondary">Reconnecting…</Text>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
});
