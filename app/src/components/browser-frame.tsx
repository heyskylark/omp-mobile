import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, ScrollView, StyleSheet, Text, View } from "react-native";
import { toCssPoint, type ViewerFrame } from "../data/browser";

const TAP_SLOP = 10;
const TAP_MS = 300;

type Slot = 0 | 1;

interface Gesture {
	/** Touch start in the image's unzoomed layout points. */
	x: number;
	y: number;
	startedAt: number;
	dragging: boolean;
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
 * While `controlling`, one finger taps and scrolls the page; pinching still zooms locally. Otherwise every touch
 * only pans and zooms the picture.
 */
export function BrowserFrameView({
	frame,
	controlling,
	reconnecting,
	onDisplayed,
	onTap,
	onScroll,
}: {
	frame: ViewerFrame;
	controlling: boolean;
	reconnecting: boolean;
	onDisplayed(frame: ViewerFrame): void;
	onTap(x: number, y: number): void;
	onScroll(x: number, y: number, dx: number, dy: number): void;
}) {
	const [layoutWidth, setLayoutWidth] = useState(0);
	const [slots, setSlots] = useState<[ViewerFrame | null, ViewerFrame | null]>([null, null]);
	const [front, setFront] = useState<Slot>(0);
	const frontRef = useRef<Slot>(0);
	const loading = useRef<ViewerFrame | null>(null);
	const pending = useRef<ViewerFrame | null>(null);
	const callbacks = useRef({ onDisplayed, onTap, onScroll });
	useEffect(() => {
		callbacks.current = { onDisplayed, onTap, onScroll };
	}, [onDisplayed, onTap, onScroll]);

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
		const flush = () => {
			animationFrame = null;
			if (!gesture || (!gesture.queuedDx && !gesture.queuedDy)) return;
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
		return PanResponder.create({
			onStartShouldSetPanResponder: () => live.current.controlling,
			onMoveShouldSetPanResponder: () => live.current.controlling,
			onPanResponderTerminationRequest: () => false,
			onPanResponderGrant: (event) => {
				gesture = {
					x: event.nativeEvent.locationX,
					y: event.nativeEvent.locationY,
					startedAt: Date.now(),
					dragging: false,
					pinching: false,
					seenDx: 0,
					seenDy: 0,
					queuedDx: 0,
					queuedDy: 0,
				};
			},
			onPanResponderMove: (_event, state) => {
				if (!gesture || gesture.pinching) return;
				if (state.numberActiveTouches > 1) {
					gesture.pinching = true;
					cancelFlush();
					return;
				}
				if (!gesture.dragging && Math.hypot(state.dx, state.dy) < TAP_SLOP) return;
				gesture.dragging = true;
				gesture.queuedDx += state.dx - gesture.seenDx;
				gesture.queuedDy += state.dy - gesture.seenDy;
				gesture.seenDx = state.dx;
				gesture.seenDy = state.dy;
				if (animationFrame === null) animationFrame = requestAnimationFrame(flush);
			},
			onPanResponderRelease: (_event, state) => {
				const ended = gesture;
				if (!ended || ended.pinching) {
					gesture = null;
					cancelFlush();
					return;
				}
				if (ended.dragging) {
					cancelFlush();
					flush();
				} else if (Date.now() - ended.startedAt < TAP_MS && Math.hypot(state.dx, state.dy) < TAP_SLOP) {
					const { viewport: size, layoutWidth: width } = live.current;
					const point = toCssPoint(ended, width, size);
					callbacks.current.onTap(point.x, point.y);
				}
				gesture = null;
			},
			onPanResponderTerminate: () => {
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
