import { MAX_PROMPT_IMAGES } from "@omp-mobile/protocol";
import { useState } from "react";
import { ActionSheetIOS, Alert, Image, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { pasteImage, pickFromLibrary, type PickedImage } from "../data/attachments";
import { useToast } from "./toast";
import { Icon } from "./ui";

/** Composer attachment state shared by the screens that send prompts. */
export function useImageAttachments() {
	const { show } = useToast();
	const [images, setImages] = useState<PickedImage[]>([]);
	const add = async (source: "library" | "clipboard") => {
		try {
			const picked =
				source === "library" ? await pickFromLibrary(MAX_PROMPT_IMAGES - images.length) : [await pasteImage()];
			if (picked[0] === null) show("There is no image on the clipboard.", "error");
			else
				setImages((current) => [...current, ...picked.filter((image) => image !== null)].slice(0, MAX_PROMPT_IMAGES));
		} catch (error) {
			show(error instanceof Error ? error.message : "Could not attach the image.", "error");
		}
	};
	const attach = () => {
		if (Platform.OS === "ios")
			ActionSheetIOS.showActionSheetWithOptions(
				{ options: ["Photo Library", "Paste Image", "Cancel"], cancelButtonIndex: 2 },
				(index) => {
					if (index === 0) void add("library");
					else if (index === 1) void add("clipboard");
				},
			);
		else
			Alert.alert("Attach an image", undefined, [
				{ text: "Photo Library", onPress: () => void add("library") },
				{ text: "Paste Image", onPress: () => void add("clipboard") },
				{ text: "Cancel", style: "cancel" },
			]);
	};
	return {
		images,
		setImages,
		attach,
		remove: (index: number) => setImages((current) => current.filter((_, i) => i !== index)),
	};
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
	onRemoveImage,
}: {
	value: string;
	onChangeText(value: string): void;
	onSend(): void;
	working: boolean;
	onStop(): void;
	disabled?: boolean;
	images: PickedImage[];
	onAttach(): void;
	onRemoveImage(index: number): void;
}) {
	const hasContent = Boolean(value.trim()) || images.length > 0;
	return (
		<View className="gap-2 rounded-panel border border-border bg-surface px-3 py-2">
			{images.length ? (
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
			) : null}
			<View className="flex-row items-end gap-2">
				{images.length < MAX_PROMPT_IMAGES ? (
					<Pressable
						accessibilityLabel="Attach image"
						disabled={disabled}
						onPress={onAttach}
						className="mb-0.5 h-10 w-10 items-center justify-center rounded-full bg-surface-raised disabled:opacity-30"
					>
						<Icon name="photo.on.rectangle" size={17} color="#9A9AA2" />
					</Pressable>
				) : null}
				<TextInput
					value={value}
					onChangeText={onChangeText}
					placeholder="Message OMP"
					placeholderTextColor="#6F6F77"
					multiline
					maxLength={20_000}
					className="max-h-32 min-h-10 flex-1 px-1 py-2 text-[16px] leading-5 text-primary"
				/>
				{!working || hasContent ? (
					<Pressable
						accessibilityLabel={working ? "Steer" : "Send"}
						disabled={disabled || !hasContent}
						onPress={onSend}
						className="mb-0.5 h-10 w-10 items-center justify-center rounded-full bg-accent disabled:opacity-30"
					>
						<Icon name="arrow.up" size={17} />
					</Pressable>
				) : null}
				{working ? (
					<Pressable
						accessibilityLabel="Stop"
						onPress={onStop}
						className="mb-0.5 h-10 w-10 items-center justify-center rounded-full bg-danger"
					>
						<Icon name="stop.fill" size={14} />
					</Pressable>
				) : null}
			</View>
		</View>
	);
}
