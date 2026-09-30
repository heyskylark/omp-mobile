/**
 * Prompt text split into plain runs and skill chips. The prompt OMP receives keeps `/skill:<name>`; the app shows each
 * command naming a known skill as a chip, `✦ <name>`, the way OMP's terminal composer does.
 */
export type SkillSegment = { kind: "text"; text: string } | { kind: "skill"; name: string };

export const SKILL_CHIP_ICON = "✦";

// OMP's token rule: `/skill:<name>` at the start of the prompt or after whitespace, ending at whitespace or the end.
const TOKEN = /(^|\s)\/skill:([^\s/]+)(?=(\s|$))/g;

/**
 * Splits `text` into segments. A command still being typed at the very end of a draft stays plain text
 * (`completeAtEnd: false`), so the composer turns it into a chip only once a space follows it.
 */
export function skillSegments(text: string, known: ReadonlySet<string>, completeAtEnd: boolean): SkillSegment[] {
	const segments: SkillSegment[] = [];
	let plainFrom = 0;
	for (const match of text.matchAll(TOKEN)) {
		const name = match[2]!;
		const commandStart = match.index + match[1]!.length;
		const commandEnd = commandStart + "/skill:".length + name.length;
		if (!known.has(name) || (!completeAtEnd && commandEnd === text.length)) continue;
		if (commandStart > plainFrom) segments.push({ kind: "text", text: text.slice(plainFrom, commandStart) });
		segments.push({ kind: "skill", name });
		plainFrom = commandEnd;
	}
	if (plainFrom < text.length) segments.push({ kind: "text", text: text.slice(plainFrom) });
	return segments;
}

function shown(segment: SkillSegment): string {
	return segment.kind === "text" ? segment.text : `${SKILL_CHIP_ICON} ${segment.name}`;
}

function sent(segment: SkillSegment): string {
	return segment.kind === "text" ? segment.text : `/skill:${segment.name}`;
}

/** The text the composer shows for `segments`. */
export function displayText(segments: readonly SkillSegment[]): string {
	return segments.map(shown).join("");
}

/** Where a caret at `sentOffset` in the prompt text sits in the displayed text. */
export function displayOffset(segments: readonly SkillSegment[], sentOffset: number): number {
	let sentAt = 0;
	let shownAt = 0;
	for (const segment of segments) {
		const sentLength = sent(segment).length;
		if (sentOffset <= sentAt + sentLength)
			return shownAt + (segment.kind === "text" ? sentOffset - sentAt : shown(segment).length);
		sentAt += sentLength;
		shownAt += shown(segment).length;
	}
	return shownAt;
}

/**
 * Applies an edit made to the displayed draft and returns the prompt text plus the caret in it. A chip is one unit:
 * an edit that touches it, or a backspace over the space that completed it, removes it whole, and typing inside it
 * lands after it.
 */
export function editDraft(segments: readonly SkillSegment[], nextShown: string): { text: string; caret: number } {
	const previous = displayText(segments);
	let start = 0;
	while (start < previous.length && start < nextShown.length && previous[start] === nextShown[start]) start++;
	let tail = 0;
	while (
		tail < previous.length - start &&
		tail < nextShown.length - start &&
		previous[previous.length - 1 - tail] === nextShown[nextShown.length - 1 - tail]
	)
		tail++;
	const inserted = nextShown.slice(start, nextShown.length - tail);
	let removeFrom = start;
	let removeTo = previous.length - tail;
	let shownAt = 0;
	for (const segment of segments) {
		const shownEnd = shownAt + shown(segment).length;
		if (segment.kind === "skill") {
			const deleting = removeFrom < removeTo;
			const eatsSeparator =
				deleting && !inserted && removeFrom === shownEnd && removeTo === shownEnd + 1 && /\s/.test(previous[shownEnd]!);
			if (eatsSeparator || (deleting && shownAt < removeTo && removeFrom < shownEnd)) {
				removeFrom = Math.min(removeFrom, shownAt);
				removeTo = Math.max(removeTo, shownEnd);
			} else if (!deleting && shownAt < removeFrom && removeFrom < shownEnd) removeFrom = removeTo = shownEnd;
		}
		shownAt = shownEnd;
	}
	const before = sentSlice(segments, 0, removeFrom);
	return { text: before + inserted + sentSlice(segments, removeTo, shownAt), caret: before.length + inserted.length };
}

/** Prompt text for the displayed range `[from, to)`, which never cuts through a chip. */
function sentSlice(segments: readonly SkillSegment[], from: number, to: number): string {
	let text = "";
	let shownAt = 0;
	for (const segment of segments) {
		const shownEnd = shownAt + shown(segment).length;
		if (shownEnd > from && shownAt < to)
			text +=
				segment.kind === "text"
					? segment.text.slice(Math.max(0, from - shownAt), Math.min(segment.text.length, to - shownAt))
					: sent(segment);
		shownAt = shownEnd;
	}
	return text;
}
