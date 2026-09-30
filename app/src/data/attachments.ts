import type { ImageAttachment } from "@omp-mobile/protocol";
import * as Clipboard from "expo-clipboard";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** An attachment ready to send, plus a local file URI for the composer preview. */
export interface PickedImage extends ImageAttachment {
	uri: string;
}

// Keeps screenshots legible while bounding the upload to a few hundred KB per image.
const MAX_EDGE = 2048;

async function prepare(source: string, width: number, height: number): Promise<PickedImage> {
	const context = ImageManipulator.manipulate(source);
	if (Math.max(width, height) > MAX_EDGE) context.resize(width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE });
	const image = await context.renderAsync();
	try {
		const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
		if (!saved.base64) throw new Error("Could not read the image.");
		return { uri: saved.uri, data: saved.base64, mimeType: "image/jpeg" };
	} finally {
		image.release();
		context.release();
	}
}

export async function pickFromLibrary(limit: number): Promise<PickedImage[]> {
	const result = await ImagePicker.launchImageLibraryAsync({
		mediaTypes: ["images"],
		allowsMultipleSelection: limit > 1,
		selectionLimit: limit,
		quality: 1,
	});
	if (result.canceled) return [];
	return Promise.all(result.assets.slice(0, limit).map((asset) => prepare(asset.uri, asset.width, asset.height)));
}

/** Resolves null when the clipboard holds no image. */
export async function pasteImage(): Promise<PickedImage | null> {
	const image = await Clipboard.getImageAsync({ format: "png" });
	return image ? prepare(image.data, image.size.width, image.size.height) : null;
}
