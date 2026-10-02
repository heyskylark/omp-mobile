import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Block, ImageRef, TimelineItem } from "@omp-mobile/protocol";

const BLOB_PREFIX = "blob:sha256:";
const HASH = /^[a-f0-9]{64}$/;
/** Enough of a file to find the size of any PNG, GIF or WebP, and of a JPEG without a huge EXIF block. */
const HEADER_BYTES = 64 * 1024;
/** Live tool images stay in memory until OMP's blob store has them; this bounds that memory. */
const LIVE_BYTES = 64 * 1024 * 1024;
const MAX_DESCRIBED = 10_000;

export interface ImageInfo {
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	width?: number;
	height?: number;
}

/** Format and pixel size from an image's leading bytes; undefined when they are not a PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (start: number, text: string) =>
		bytes.length >= start + text.length && [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
	const sized = (mimeType: ImageInfo["mimeType"], width: number, height: number): ImageInfo =>
		width > 0 && height > 0 ? { mimeType, width, height } : { mimeType };
	if (ascii(0, "\x89PNG\r\n\x1a\n")) {
		if (bytes.length < 24 || !ascii(12, "IHDR")) return { mimeType: "image/png" };
		return sized("image/png", view.getUint32(16), view.getUint32(20));
	}
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
		if (bytes.length < 10) return { mimeType: "image/gif" };
		return sized("image/gif", view.getUint16(6, true), view.getUint16(8, true));
	}
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
		if (ascii(12, "VP8 ") && bytes.length >= 30)
			return sized("image/webp", view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		if (ascii(12, "VP8L") && bytes.length >= 25) {
			const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
			return sized("image/webp", 1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)));
		}
		if (ascii(12, "VP8X") && bytes.length >= 30) {
			const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
			return sized("image/webp", 1 + u24(24), 1 + u24(27));
		}
		return { mimeType: "image/webp" };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at + 3 < bytes.length) {
			if (bytes[at] !== 0xff) break;
			const marker = bytes[at + 1]!;
			if (marker === 0xff) {
				at++;
				continue;
			}
			// Standalone markers carry no length.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
				at += 2;
				continue;
			}
			const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isFrame && at + 9 <= bytes.length) return sized("image/jpeg", view.getUint16(at + 7), view.getUint16(at + 5));
			if (marker === 0xd9 || marker === 0xda) break;
			at += 2 + view.getUint16(at + 2);
		}
		return { mimeType: "image/jpeg" };
	}
	return undefined;
}

/** Ref for an image OMP saved to its blob store (`data: "blob:sha256:<hex>"`); undefined for anything else. */
export function blobImageRef(block: Record<string, unknown>): ImageRef | undefined {
	if (typeof block.data !== "string" || !block.data.startsWith(BLOB_PREFIX)) return undefined;
	const id = block.data.slice(BLOB_PREFIX.length);
	if (!HASH.test(id)) return undefined;
	return { id, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" };
}

/** Image content blocks (`{ type: "image", data, mimeType }`) of an OMP message or tool result `content`. */
export function imageBlocks(content: unknown): Record<string, unknown>[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is Record<string, unknown> => !!part && typeof part === "object" && part.type === "image",
	);
}

/**
 * Serves transcript images by content hash. Saved transcripts reference OMP's blob store, which files each image
 * under the SHA-256 of its bytes; a running turn's tool results carry the bytes inline, so those are hashed the same
 * way and kept in memory until the turn is saved.
 */
export class ImageStore {
	readonly #blobsDir: string;
	readonly #live = new Map<string, { bytes: Uint8Array; info: ImageInfo }>();
	#liveBytes = 0;
	readonly #described = new Map<string, ImageInfo>();

	constructor(blobsDir: string) {
		this.#blobsDir = blobsDir;
	}

	/** Ref for an OMP image block, keeping inline image bytes so `read` can serve them. */
	remember(block: Record<string, unknown>): ImageRef | undefined {
		const saved = blobImageRef(block);
		if (saved) return saved;
		if (typeof block.data !== "string" || !block.data) return undefined;
		const bytes = new Uint8Array(Buffer.from(block.data, "base64"));
		const info = sniffImage(bytes);
		if (!info) return undefined;
		const id = createHash("sha256").update(bytes).digest("hex");
		if (!this.#live.has(id)) {
			this.#live.set(id, { bytes, info });
			this.#liveBytes += bytes.length;
			for (const [oldest, entry] of this.#live) {
				if (this.#liveBytes <= LIVE_BYTES || oldest === id) break;
				this.#live.delete(oldest);
				this.#liveBytes -= entry.bytes.length;
			}
		}
		return { id, ...info };
	}

	/** The image's bytes and real format, or null when the id names nothing this store can serve as an image. */
	async read(id: string): Promise<{ bytes: Uint8Array; info: ImageInfo } | null> {
		if (!HASH.test(id)) return null;
		const live = this.#live.get(id);
		if (live) return live;
		const file = Bun.file(join(this.#blobsDir, id));
		if (!(await file.exists())) return null;
		const bytes = new Uint8Array(await file.arrayBuffer());
		const info = sniffImage(bytes);
		return info ? { bytes, info } : null;
	}

	/** Items with every image ref's format and size read from the image itself; refs to missing images are dropped. */
	async describe(items: TimelineItem[]): Promise<TimelineItem[]> {
		const described: TimelineItem[] = [];
		for (const item of items) {
			if (item.kind === "tool" && item.images?.length) {
				const images = (await Promise.all(item.images.map((image) => this.#describe(image)))).filter(
					(image) => image !== undefined,
				);
				const { images: _, ...rest } = item;
				described.push(images.length ? { ...rest, images } : rest);
			} else if (
				(item.kind === "user" || item.kind === "assistant") &&
				item.blocks.some((block) => block.kind === "image" && block.image)
			) {
				const blocks = await Promise.all(
					item.blocks.map(async (block): Promise<Block> => {
						if (block.kind !== "image" || !block.image) return block;
						const image = await this.#describe(block.image);
						return image ? { kind: "image", image } : { kind: "image" };
					}),
				);
				described.push({ ...item, blocks });
			} else described.push(item);
		}
		return described;
	}

	async #describe(ref: ImageRef): Promise<ImageRef | undefined> {
		let info = this.#described.get(ref.id);
		if (!info) {
			info = this.#live.get(ref.id)?.info ?? (await this.#sniffBlob(ref.id));
			// Only found images are cached: a blob missing now may be written before the next read.
			if (info) {
				if (this.#described.size >= MAX_DESCRIBED) this.#described.clear();
				this.#described.set(ref.id, info);
			}
		}
		return info ? { id: ref.id, ...info } : undefined;
	}

	async #sniffBlob(id: string): Promise<ImageInfo | undefined> {
		try {
			const file = Bun.file(join(this.#blobsDir, id));
			return sniffImage(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
		} catch {
			return undefined;
		}
	}
}
