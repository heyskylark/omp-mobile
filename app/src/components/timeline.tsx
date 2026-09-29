import type { Block, TimelineItem } from "@omp-mobile/protocol";
import { useState, Fragment } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMarkdown } from "react-native-marked";
import { Icon } from "./ui";

const markdownTheme = {
	colors: { text: "#ECECEE", border: "#2A2A2E", link: "#8B93FF", code: "#141416" },
};

function MarkdownText({ value }: { value: string }) {
	const elements = useMarkdown(value, {
		colorScheme: "dark",
		theme: markdownTheme,
		styles: {
			text: { color: "#ECECEE", fontSize: 15, lineHeight: 23 },
			paragraph: { marginTop: 0, marginBottom: 10 },
			code: { backgroundColor: "#141416", borderColor: "#2A2A2E", borderWidth: 1, borderRadius: 10, padding: 12 },
			codeText: { color: "#ECECEE", fontFamily: "Menlo", fontSize: 13 },
			codespan: { color: "#ECECEE", backgroundColor: "#1B1B1E", fontFamily: "Menlo" },
			link: { color: "#8B93FF" },
		},
	});
	return (
		<View>
			{elements.map((element, index) => (
				<Fragment key={index}>{element}</Fragment>
			))}
		</View>
	);
}

function Thinking({ block }: { block: Extract<Block, { kind: "thinking" }> }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<Pressable
			onPress={() => setExpanded((value) => !value)}
			className={`mb-2 self-start border border-border bg-surface px-3 py-1.5 ${expanded ? "rounded-card" : "rounded-full"}`}
		>
			<View className="flex-row items-center gap-2">
				<Icon name="brain" size={14} color="#9A9AA2" />
				<Text className="text-caption font-medium text-secondary">Thought {expanded ? "▴" : "▾"}</Text>
			</View>
			{expanded ? (
				<Text className="mt-2 max-w-[320px] text-caption leading-5 text-secondary">
					{block.redacted ? "Reasoning was redacted." : block.text}
				</Text>
			) : null}
		</Pressable>
	);
}

function Blocks({ blocks, markdown }: { blocks: Block[]; markdown: boolean }) {
	return (
		<>
			{blocks.map((block, index) => {
				if (block.kind === "thinking") return <Thinking key={index} block={block} />;
				if (block.kind === "image")
					return (
						<Text key={index} className="text-caption italic text-secondary">
							Image attachment
						</Text>
					);
				return markdown ? (
					<MarkdownText key={index} value={block.text} />
				) : (
					<Text key={index} selectable className="text-body text-primary">
						{block.text}
					</Text>
				);
			})}
		</>
	);
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
	const [expanded, setExpanded] = useState(false);
	const stateIcon =
		item.state === "running" ? null : item.state === "succeeded" ? "checkmark.circle.fill" : "xmark.circle.fill";
	const stateColor = item.state === "failed" ? "#F85149" : "#3FB950";
	return (
		<Pressable
			onPress={() => setExpanded((value) => !value)}
			className="rounded-card border border-border bg-surface px-4 py-3"
		>
			<View className="flex-row items-center gap-3">
				<View className="h-8 w-8 items-center justify-center rounded-lg bg-surface-raised">
					<Icon name="wrench.and.screwdriver" size={15} color="#9A9AA2" />
				</View>
				<View className="flex-1">
					<Text numberOfLines={1} className="text-[14px] font-medium text-primary">
						{item.title || item.name}
					</Text>
					<Text className="text-[12px] text-secondary">{item.name}</Text>
				</View>
				{item.state === "running" ? (
					<ActivityIndicator size="small" color="#8B93FF" />
				) : stateIcon ? (
					<Icon name={stateIcon} size={17} color={stateColor} />
				) : null}
			</View>
			{expanded ? (
				<View className="mt-3 gap-3 border-t border-border pt-3">
					<View>
						<Text className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-secondary">Input</Text>
						<Text selectable className="font-mono text-caption text-primary">
							{item.input}
						</Text>
					</View>
					{item.output ? (
						<View>
							<Text className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-secondary">
								Output{item.outputTruncated ? " · truncated" : ""}
							</Text>
							<Text selectable className="font-mono text-caption text-primary">
								{item.output}
							</Text>
						</View>
					) : null}
				</View>
			) : null}
		</Pressable>
	);
}

export function TimelineRow({ item }: { item: TimelineItem }) {
	if (item.kind === "tool")
		return (
			<View className="mb-3 px-4">
				<ToolCard item={item} />
			</View>
		);
	if (item.kind === "event")
		return (
			<Text
				className={`mb-3 px-8 text-center text-[12px] ${item.tone === "error" ? "text-danger" : item.tone === "warning" ? "text-warning" : "text-secondary"}`}
			>
				{item.text}
			</Text>
		);
	if (item.kind === "unsupported")
		return <Text className="mb-3 px-8 text-center text-[12px] italic text-secondary">{item.label}</Text>;
	if (item.kind === "user")
		return (
			<View className="mb-4 max-w-[86%] self-end rounded-[18px] bg-surface-raised px-4 py-3">
				<Blocks blocks={item.blocks} markdown={false} />
			</View>
		);
	return (
		<View className="mb-4 w-full">
			<Blocks blocks={item.blocks} markdown />
			{item.streaming ? <ActivityIndicator className="mt-1 self-start" size="small" color="#8B93FF" /> : null}
			{item.error ? <Text className="mt-2 text-caption text-danger">{item.error}</Text> : null}
		</View>
	);
}
