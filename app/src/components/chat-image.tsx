import type { ImageRef } from "@omp-mobile/protocol";
import { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Image,
	type ImageURISource,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PairedMachine } from "../native/types";
import { Icon } from "./ui";

const MAX_HEIGHT = 360;
/** Box shape for an image whose size the server could not read, until it loads. */
const FALLBACK_ASPECT = 4 / 3;

type ChatImageContextValue = {
	source(id: string): ImageURISource;
	open(source: ImageURISource): void;
};
const ChatImageContext = createContext<ChatImageContextValue | null>(null);

/** Lets transcript images below load from `machine` and open in a full-screen viewer. */
export function ChatImageProvider({ machine, children }: PropsWithChildren<{ machine: PairedMachine }>) {
	const [viewing, setViewing] = useState<ImageURISource | null>(null);
	const value = useMemo<ChatImageContextValue>(() => {
		const base = `${machine.url.replace(/\/$/, "")}/v1/images/`;
		const headers = { Authorization: `Bearer ${machine.token}` };
		return { source: (id) => ({ uri: base + encodeURIComponent(id), headers }), open: setViewing };
	}, [machine]);
	return (
		<ChatImageContext.Provider value={value}>
			{children}
			<ImageViewer source={viewing} onClose={() => setViewing(null)} />
		</ChatImageContext.Provider>
	);
}

function useChatImages() {
	const context = useContext(ChatImageContext);
	if (!context) throw new Error("ChatImage must be used inside ChatImageProvider");
	return context;
}

/**
 * An image from the transcript, sized to its aspect ratio before it loads. Fills the container's width up to
 * `MAX_HEIGHT` tall, or `maxWidth` when given; tapping opens it full screen.
 */
export function ChatImage({ image, label, maxWidth }: { image: ImageRef; label: string; maxWidth?: number }) {
	const { source: sourceFor, open } = useChatImages();
	const source = useMemo(() => sourceFor(image.id), [sourceFor, image.id]);
	const [loaded, setLoaded] = useState<{ width: number; height: number } | null>(null);
	const [failed, setFailed] = useState(false);
	const size = loaded ?? (image.width && image.height ? { width: image.width, height: image.height } : null);
	const aspect = size ? size.width / size.height : FALLBACK_ASPECT;
	const widest = MAX_HEIGHT * aspect;
	const box =
		maxWidth === undefined
			? { width: "100%" as const, maxWidth: widest, aspectRatio: aspect }
			: { width: Math.min(maxWidth, widest), aspectRatio: aspect };
	return (
		<Pressable
			accessibilityRole="imagebutton"
			accessibilityLabel={label}
			disabled={failed}
			onPress={() => open(source)}
			style={box}
			className="overflow-hidden rounded-card border border-border bg-surface-raised active:opacity-80"
		>
			{failed ? (
				<View className="flex-1 items-center justify-center gap-1.5 px-3">
					<Icon name="photo" size={18} color="#9A9AA2" />
					<Text className="text-caption text-secondary">Image unavailable</Text>
				</View>
			) : (
				<>
					<Image
						source={source}
						resizeMode="contain"
						style={StyleSheet.absoluteFill}
						onLoad={({ nativeEvent }) => {
							const { width, height } = nativeEvent.source;
							if (width > 0 && height > 0) setLoaded({ width, height });
						}}
						onError={() => setFailed(true)}
					/>
					{loaded ? null : (
						<View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
							<ActivityIndicator size="small" color="#9A9AA2" />
						</View>
					)}
				</>
			)}
		</Pressable>
	);
}

function ImageViewer({ source, onClose }: { source: ImageURISource | null; onClose(): void }) {
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	return (
		<Modal
			visible={source !== null}
			transparent
			animationType="fade"
			presentationStyle="overFullScreen"
			statusBarTranslucent
			onRequestClose={onClose}
		>
			<View className="flex-1 bg-black">
				{source ? (
					<ScrollView
						maximumZoomScale={4}
						minimumZoomScale={1}
						centerContent
						showsHorizontalScrollIndicator={false}
						showsVerticalScrollIndicator={false}
						contentContainerStyle={{ width, height }}
					>
						<Image source={source} resizeMode="contain" style={{ width, height }} />
					</ScrollView>
				) : null}
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Close image"
					onPress={onClose}
					hitSlop={8}
					style={{ top: insets.top + 8, left: insets.left + 16 }}
					className="absolute h-9 flex-row items-center gap-1.5 rounded-full bg-surface-raised/90 px-3.5 active:opacity-70"
				>
					<Icon name="xmark" size={13} color="#ECECEE" />
					<Text className="text-[15px] font-medium text-primary">Close</Text>
				</Pressable>
			</View>
		</Modal>
	);
}
