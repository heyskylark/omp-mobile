import { describe, expect, test } from "bun:test";
import { sniffImage } from "./images";

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const le16 = (value: number) => [value & 0xff, value >> 8];
const be16 = (value: number) => [value >> 8, value & 0xff];
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, value >> 16];

function webp(chunk: string, payload: number[]): Uint8Array {
	return new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), 0, 0, 0, 0, ...payload]);
}

describe("sniffImage", () => {
	test("reads the size of each WebP encoding", () => {
		// Lossy: frame tag and start code, then 14-bit sizes whose top two bits are scale.
		const lossy = webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(760 | 0x4000), ...le16(1024)]);
		expect(sniffImage(lossy)).toEqual({ mimeType: "image/webp", width: 760, height: 1024 });
		// Lossless: signature byte, then (width - 1) and (height - 1) packed as 14-bit fields.
		const bits = (1280 - 1) | ((720 - 1) << 14);
		const lossless = webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]);
		expect(sniffImage(lossless)).toEqual({ mimeType: "image/webp", width: 1280, height: 720 });
		const extended = webp("VP8X", [0, 0, 0, 0, ...le24(1920 - 1), ...le24(1080 - 1)]);
		expect(sniffImage(extended)).toEqual({ mimeType: "image/webp", width: 1920, height: 1080 });
	});

	test("finds a JPEG's frame header after other segments and skips restart and fill bytes", () => {
		const exif = [0xff, 0xe1, ...be16(2 + 4), 1, 2, 3, 4];
		const frame = [0xff, 0xc2, ...be16(11), 8, ...be16(480), ...be16(640), 3];
		const jpeg = new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xff, 0xd0, ...frame]);
		expect(sniffImage(jpeg)).toEqual({ mimeType: "image/jpeg", width: 640, height: 480 });
		// A Huffman table (0xC4) sits in the frame-marker range but is not a frame.
		const huffmanOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xc4, ...be16(4), 0, 0, 0xff, 0xda]);
		expect(sniffImage(huffmanOnly)).toEqual({ mimeType: "image/jpeg" });
	});

	test("reads GIF and PNG sizes and rejects data that is no image", () => {
		expect(sniffImage(new Uint8Array([...ascii("GIF89a"), ...le16(300), ...le16(200)]))).toEqual({
			mimeType: "image/gif",
			width: 300,
			height: 200,
		});
		expect(sniffImage(new Uint8Array(ascii("\x89PNG\r\n\x1a\n")))).toEqual({ mimeType: "image/png" });
		expect(sniffImage(new Uint8Array(ascii("data:image/png;base64,AAAA")))).toBeUndefined();
		expect(sniffImage(new Uint8Array())).toBeUndefined();
	});
});
