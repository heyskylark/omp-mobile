import { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

const WIDTH = 14;
const HEIGHT = 18;
/** Whole points per sprite pixel keep its edges on device pixels. */
const POINTS_PER_PIXEL = 2;
const FRAME_COUNT = 24;
const FRAME_MS = 110;

type Rgb = readonly number[];
type Layer = { color: string; d: string };

function rgb(hex: string): Rgb {
	return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
}

// The logo's gradient (app/assets/icon.svg), quantized into five flat bands.
const PINK = rgb("F352CF");
const PURPLE = rgb("A460EF");
const BLUE = rgb("77A9E6");
const RAMP = [PINK, mix(PINK, PURPLE, 0.5), PURPLE, mix(PURPLE, BLUE, 0.5), BLUE];
const WHITE = rgb("FFFFFF");
const SHADE = rgb("3A1A6A");
const EYE = rgb("1B0D2B");
const BLUSH = rgb("FF9BE0");
const GLOW = [PINK, mix(PINK, WHITE, 0.5), WHITE, mix(PINK, WHITE, 0.5)];

const key = (x: number, y: number) => y * WIDTH + x;

function fillRect(cells: Set<number>, x0: number, y0: number, x1: number, y1: number) {
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.add(key(x, y));
}

function bodyCells(swing: number): Set<number> {
	const cells = new Set<number>();
	fillRect(cells, 0, 4, 13, 11);
	for (const corner of [key(0, 4), key(13, 4), key(0, 11), key(13, 11)]) cells.delete(corner);
	// The long stem stands, toe out.
	fillRect(cells, 8, 12, 10, 17);
	cells.add(key(11, 17));
	// The short stem is raised off the ground; its lower half swings.
	fillRect(cells, 2, 12, 4, 13);
	fillRect(cells, 2 + swing, 14, 4 + swing, 15);
	cells.add(key(1 + swing, 15));
	// Antenna stalk.
	cells.add(key(3, 2));
	cells.add(key(3, 3));
	return cells;
}

/** Bands run diagonally from the head's top-left corner to the standing foot, like the logo's. */
function gradient(x: number, y: number): Rgb {
	const t = (x + y - 4) / 26;
	return RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(t * (RAMP.length - 1))))];
}

function drawFrame(i: number): Layer[] {
	const pixels = new Map<number, string>();
	const put = (x: number, y: number, color: Rgb) => pixels.set(key(x, y), `rgb(${color.join(",")})`);

	const cells = bodyCells([0, -1, -1, 0, 1, 1][i % 6]);
	for (const cell of cells) {
		const x = cell % WIDTH;
		const y = Math.floor(cell / WIDTH);
		const rightEdge = x === WIDTH - 1 || !cells.has(key(x + 1, y));
		let color = gradient(x, y);
		// Lit from above, shaded below and on the right.
		if (!cells.has(key(x, y - 1))) color = mix(color, WHITE, 0.35);
		else if (!cells.has(key(x, y + 1)) || rightEdge) color = mix(color, SHADE, 0.35);
		put(x, y, color);
	}

	const glow = GLOW[Math.floor(i / 2) % GLOW.length];
	for (const x of [2, 3]) for (const y of [0, 1]) put(x, y, glow);

	// Eyes glance up-right, then forward, then blink.
	const glancing = i < 12 || i >= 20;
	if (i === 18 || i === 19) {
		for (const x of [2, 3, 8, 9]) put(x, 8, EYE);
	} else {
		const [dx, top] = glancing ? [1, 6] : [0, 7];
		for (const left of [2 + dx, 8 + dx]) {
			for (let y = top; y < top + 3; y++) {
				put(left, y, EYE);
				put(left + 1, y, EYE);
			}
			put(left + 1, top, WHITE);
		}
	}
	const [mouthX, mouthY] = glancing ? [6, 9] : [5, 10];
	put(mouthX, mouthY, EYE);
	put(mouthX + 1, mouthY, EYE);
	put(1, 9, BLUSH);
	put(12, 9, BLUSH);

	// One path per colour, built from horizontal runs: same-coloured neighbours share no anti-aliased edge.
	const paths = new Map<string, string>();
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const color = pixels.get(key(x, y));
			if (!color || (x > 0 && pixels.get(key(x - 1, y)) === color)) continue;
			let width = 1;
			while (x + width < WIDTH && pixels.get(key(x + width, y)) === color) width++;
			paths.set(color, `${paths.get(color) ?? ""}M${x} ${y}h${width}v1h-${width}z`);
		}
	}
	return [...paths].map(([color, d]) => ({ color, d }));
}

const FRAMES = Array.from({ length: FRAME_COUNT }, (_, i) => drawFrame(i));

/**
 * An 8-bit mascot built from the OMP π mark, shown while a reply streams: the logo's bar is its head and
 * its short and long stems are legs. It glances, blinks, swings its raised leg, and pulses its antenna.
 */
export function ThinkingMascot() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setFrame((current) => (current + 1) % FRAME_COUNT), FRAME_MS);
		return () => clearInterval(timer);
	}, []);
	return (
		<View accessible accessibilityRole="progressbar" accessibilityLabel="Working">
			<Svg width={WIDTH * POINTS_PER_PIXEL} height={HEIGHT * POINTS_PER_PIXEL} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
				{FRAMES[frame].map((layer) => (
					<Path key={layer.color} d={layer.d} fill={layer.color} />
				))}
			</Svg>
		</View>
	);
}
