import { MAX_PROMPT_IMAGES, type ModelRole } from "@omp-mobile/protocol";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, {
	FadeIn,
	FadeInDown,
	FadeOut,
	FadeOutDown,
	LayoutAnimationConfig,
	LinearTransition,
	ZoomIn,
	ZoomOut,
} from "react-native-reanimated";
import { OmpNative } from "../../modules/omp-native";
import { pickFromLibrary, prepareImage, type PickedImage } from "../data/attachments";
import type { PastedImage } from "../native/types";
import { ModelRoleButton } from "./model-role-picker";
import { useToast } from "./toast";
import { Icon } from "./ui";

// Same springs as the model picker: 400 ms perceptual (600 ms total) with one small bounce.
const MORPH = LinearTransition.springify(400).dampingRatio(0.75);
const BUTTON_IN = ZoomIn.springify(400).dampingRatio(0.75);
const BUTTON_OUT = ZoomOut.duration(120);
const TOOLBAR_IN = FadeInDown.springify(400).dampingRatio(0.75);
const TOOLBAR_OUT = FadeOutDown.duration(120);

const TONES = {
	subtle: { className: "bg-surface-raised", color: "#9A9AA2" },
	send: { className: "bg-accent", color: "#ECECEE" },
	steer: { className: "border-[1.5px] border-accent", color: "#8B93FF" },
	stop: { className: "bg-danger", color: "#ECECEE" },
};

/** Composer attachment state shared by the screens that send prompts. */
export function useImageAttachments() {
	const { show } = useToast();
	const [images, setImages] = useState<PickedImage[]>([]);
	const add = async (load: () => Promise<PickedImage[]>) => {
		try {
			const added = await load();
			setImages((current) => [...current, ...added].slice(0, MAX_PROMPT_IMAGES));
		} catch (error) {
			show(error instanceof Error ? error.message : "Could not attach the image.", "error");
		}
	};
	return {
		images,
		setImages,
		attach: () => void add(() => pickFromLibrary(MAX_PROMPT_IMAGES - images.length)),
		paste: (pasted: PastedImage[]) => void add(() => Promise.all(pasted.map(prepareImage))),
		remove: (index: number) => setImages((current) => current.filter((_, i) => i !== index)),
	};
}

function useKeyboardVisible() {
	const [visible, setVisible] = useState(() => Keyboard.isVisible());
	useEffect(() => {
		// iOS announces the keyboard before it moves, so the composer morphs alongside it. The "did" events also
		// land, which settles a composer that mounted mid-animation (e.g. while the previous screen's keyboard hid).
		const subscriptions = [
			Keyboard.addListener("keyboardDidShow", () => setVisible(true)),
			Keyboard.addListener("keyboardDidHide", () => setVisible(false)),
		];
		if (Platform.OS === "ios")
			subscriptions.push(
				Keyboard.addListener("keyboardWillShow", () => setVisible(true)),
				Keyboard.addListener("keyboardWillHide", () => setVisible(false)),
			);
		// The keyboard may have finished moving between the first render and this subscription.
		setVisible(Keyboard.isVisible());
		return () => {
			for (const subscription of subscriptions) subscription.remove();
		};
	}, []);
	return visible;
}

function ActionButton({
	label,
	icon,
	iconSize = 15,
	tone,
	disabled,
	onPress,
}: {
	label: string;
	icon: SFSymbol;
	iconSize?: number;
	tone: keyof typeof TONES;
	disabled?: boolean;
	onPress(): void;
}) {
	return (
		<Animated.View entering={BUTTON_IN} exiting={BUTTON_OUT} layout={MORPH}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={label}
				disabled={disabled}
				onPress={onPress}
				hitSlop={6}
				className={`h-[34px] w-[34px] items-center justify-center rounded-full ${TONES[tone].className} disabled:opacity-30`}
			>
				<Icon name={icon} size={iconSize} color={TONES[tone].color} />
			</Pressable>
		</Animated.View>
	);
}

export function Composer({
	value,
	onChangeText,
	onSend,
	working,
	onStop,
	disabled,
	images,
	onAttach,
	onPasteImages,
	onRemoveImage,
	modelRole,
	onModelRoleChange,
	modelRoleDisabled,
}: {
	value: string;
	onChangeText(value: string): void;
	onSend(): void;
	working: boolean;
	onStop(): void;
	disabled?: boolean;
	images: PickedImage[];
	onAttach(): void;
	onPasteImages(images: PastedImage[]): void;
	onRemoveImage(index: number): void;
	modelRole: ModelRole | null;
	onModelRoleChange(role: ModelRole): void;
	modelRoleDisabled?: boolean;
}) {
	const input = useRef<TextInput>(null);
	const panel = useRef<View>(null);
	const pasteHandler = useRef(onPasteImages);
	pasteHandler.current = onPasteImages;
	useEffect(() => {
		// Paste reaches whichever text view is focused; only that composer takes the images.
		const subscription = OmpNative.addPasteImagesListener(({ images: pasted }) => {
			if (input.current?.isFocused()) pasteHandler.current(pasted);
		});
		return () => subscription.remove();
	}, []);
	// Fabric measures a multiline TextInput from the last text the native view reported, so a field emptied from JS
	// (after sending) keeps its old height until the input re-renders. Re-render it once with a new `nativeID`.
	const [clears, setClears] = useState(0);
	const hadText = useRef(Boolean(value));
	useEffect(() => {
		if (!value && hadText.current) setClears((count) => count + 1);
		hadText.current = Boolean(value);
	}, [value]);
	const keyboardVisible = useKeyboardVisible();
	// The open slider anchors to the panel, so the panel holds its shape until it closes.
	const [pickerOpen, setPickerOpen] = useState(false);
	const hasContent = Boolean(value.trim()) || images.length > 0;
	const compact = !keyboardVisible && !value && !images.length && !pickerOpen;

	const attach =
		images.length < MAX_PROMPT_IMAGES ? (
			<ActionButton
				key="attach"
				label="Attach image"
				icon="photo.on.rectangle"
				tone="subtle"
				disabled={disabled}
				onPress={onAttach}
			/>
		) : null;
	const sendOrSteer =
		!working || hasContent ? (
			<ActionButton
				key={working ? "steer" : "send"}
				label={working ? "Steer" : "Send"}
				icon={working ? "arrow.turn.down.right" : "arrow.up"}
				tone={working ? "steer" : "send"}
				disabled={disabled || !hasContent}
				onPress={onSend}
			/>
		) : null;
	const stop = working ? (
		<ActionButton key="stop" label="Stop" icon="stop.fill" iconSize={12} tone="stop" onPress={onStop} />
	) : null;

	// Every child sits in a fixed slot so the TextInput keeps its identity (and the keyboard) across the morph.
	return (
		<LayoutAnimationConfig skipEntering>
			<View ref={panel} collapsable={false}>
				<Animated.View layout={MORPH} style={[styles.shell, compact ? styles.pill : styles.panel]}>
					{images.length ? (
						<Animated.View entering={FadeIn.springify()} exiting={FadeOut.duration(120)} layout={MORPH}>
							<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 pt-1">
								{images.map((image, index) => (
									<View key={image.uri}>
										<Image source={{ uri: image.uri }} className="h-16 w-16 rounded-xl bg-surface-raised" />
										<Pressable
											accessibilityLabel="Remove image"
											onPress={() => onRemoveImage(index)}
											hitSlop={8}
											className="absolute right-1 top-1 h-5 w-5 items-center justify-center rounded-full bg-ink/80"
										>
											<Icon name="xmark" size={9} />
										</Pressable>
									</View>
								))}
							</ScrollView>
						</Animated.View>
					) : null}
					<Animated.View layout={MORPH} style={styles.inputRow}>
						{compact ? attach : null}
						<Animated.View layout={MORPH} style={styles.inputSlot}>
							<TextInput
								ref={input}
								value={value}
								onChangeText={onChangeText}
								nativeID={`composer-input-${clears}`}
								placeholder="Message OMP"
								placeholderTextColor="#6F6F77"
								multiline
								maxLength={20_000}
								className="max-h-32 min-h-9 px-2 py-2 text-[16px] leading-5 text-primary"
							/>
						</Animated.View>
						{compact ? sendOrSteer : null}
						{compact ? stop : null}
					</Animated.View>
					{compact ? null : (
						<Animated.View entering={TOOLBAR_IN} exiting={TOOLBAR_OUT} layout={MORPH} style={styles.toolbar}>
							{attach}
							<View style={styles.spacer} />
							<Animated.View entering={BUTTON_IN} exiting={BUTTON_OUT} layout={MORPH}>
								<ModelRoleButton
									role={modelRole}
									onChange={onModelRoleChange}
									disabled={modelRoleDisabled}
									anchor={panel}
									onOpenChange={setPickerOpen}
								/>
							</Animated.View>
							{sendOrSteer}
							{stop}
						</Animated.View>
					)}
				</Animated.View>
			</View>
		</LayoutAnimationConfig>
	);
}

const styles = StyleSheet.create({
	shell: { borderRadius: 25, borderWidth: 1, borderColor: "#2A2A2E", backgroundColor: "#141416" },
	pill: { padding: 6 },
	panel: { padding: 8, gap: 6 },
	inputRow: { flexDirection: "row", alignItems: "center", gap: 4 },
	inputSlot: { flex: 1 },
	toolbar: { flexDirection: "row", alignItems: "center", gap: 8 },
	spacer: { flex: 1 },
});
