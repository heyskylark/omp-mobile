#!/usr/bin/env bun
// Prints the selectable text of a Maestro view hierarchy, indented, with bounds.
// Usage: maestro --device <udid> hierarchy | texts.ts        or        texts.ts <screen-hierarchy.json>
export type ViewNode = { attributes?: Record<string, string | undefined>; children?: ViewNode[] };

const raw = process.argv[2] ? await Bun.file(process.argv[2]).text() : await Bun.stdin.text();
// `maestro hierarchy` may print status lines before the JSON document.
const root = JSON.parse(raw.slice(raw.indexOf("{"))) as ViewNode;
const walk = (node: ViewNode, depth: number): void => {
	const a = node.attributes ?? {};
	const label = [a.text, a.accessibilityText, a["resource-id"], a.hintText].filter(Boolean).join(" | ");
	if (label) console.log(`${"  ".repeat(depth)}${label}  ${a.bounds ?? ""}`);
	for (const child of node.children ?? []) walk(child, depth + 1);
};
walk(root, 0);
