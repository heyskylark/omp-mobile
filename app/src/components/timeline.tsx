import type { AgentSummary, Block, TimelineItem } from "@omp-mobile/protocol";
import { Fragment } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { useMarkdown } from "react-native-marked";
import { agentName, statusLabel, toolIsWorking } from "../data/agents";
import type { OutgoingMessage } from "../data/outbox";
import { skillSegments } from "../data/skill-draft";
import { AgentStatusIcon } from "./agent-menu";
import { useAnchoredToggle } from "./chat-list";
import { ChatImage } from "./chat-image";
import { SkillSegmentsText } from "./skill-text";
import { ThinkingMascot } from "./thinking-mascot";
import { Icon } from "./ui";

const NO_AGENTS: ReadonlyMap<string, AgentSummary> = new Map();

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
	const { ref, expanded, toggle } = useAnchoredToggle();
	return (
		<Pressable
			ref={ref}
			onPress={toggle}
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

function Blocks({ blocks, markdown, skills }: { blocks: Block[]; markdown: boolean; skills?: ReadonlySet<string> }) {
	return (
		<>
			{blocks.map((block, index) => {
				if (block.kind === "thinking") return <Thinking key={index} block={block} />;
				if (block.kind === "image")
					return block.image ? (
						<View key={index} className="my-1">
							<ChatImage key={block.image.id} image={block.image} label="Image" maxWidth={markdown ? undefined : 220} />
						</View>
					) : (
						<Text key={index} className="text-caption italic text-secondary">
							Image attachment
						</Text>
					);
				return markdown ? (
					<MarkdownText key={index} value={block.text} />
				) : (
					<Text key={index} selectable className="text-body text-primary">
						{skills ? <SkillSegmentsText segments={skillSegments(block.text, skills, true)} /> : block.text}
					</Text>
				);
			})}
		</>
	);
}

type AgentProps = {
	agents?: ReadonlyMap<string, AgentSummary>;
	onOpenAgent?(agentId: string): void;
};

function ToolCard({
	item,
	agents = NO_AGENTS,
	onOpenAgent,
}: { item: Extract<TimelineItem, { kind: "tool" }> } & AgentProps) {
	const { ref, expanded, toggle } = useAnchoredToggle();
	const working = toolIsWorking(item, agents);
	const stateIcon = item.state === "failed" ? "xmark.circle.fill" : "checkmark.circle.fill";
	const stateColor = item.state === "failed" ? "#F85149" : "#3FB950";
	// Chips sit outside the card's pressables: iOS folds a pressable's children into one accessibility element.
	return (
		<View ref={ref} className="rounded-card border border-border bg-surface px-4 py-3">
			<Pressable onPress={toggle} className="flex-row items-center gap-3">
				<View className="h-8 w-8 items-center justify-center rounded-lg bg-surface-raised">
					<Icon name="wrench.and.screwdriver" size={15} color="#9A9AA2" />
				</View>
				<View className="flex-1">
					<Text numberOfLines={1} className="text-[14px] font-medium text-primary">
						{item.title || item.name}
					</Text>
					<Text className="text-[12px] text-secondary">{item.name}</Text>
				</View>
				{working ? (
					<ActivityIndicator size="small" color="#8B93FF" />
				) : (
					<Icon name={stateIcon} size={17} color={stateColor} />
				)}
			</Pressable>
			{item.images?.length ? (
				<View className="mt-3 gap-2">
					{item.images.map((image, index) => (
						<ChatImage key={`${index}:${image.id}`} image={image} label={`Image from ${item.name}`} />
					))}
				</View>
			) : null}
			{item.agentIds?.length ? (
				<AgentChips agentIds={item.agentIds} agents={agents} onOpenAgent={onOpenAgent} className="mt-3" />
			) : null}
			{expanded ? (
				<Pressable onPress={toggle} className="mt-3 gap-3 border-t border-border pt-3">
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
				</Pressable>
			) : null}
		</View>
	);
}

function AgentChips({
	agentIds,
	agents = NO_AGENTS,
	onOpenAgent,
	className = "",
}: { agentIds: string[]; className?: string } & AgentProps) {
	return (
		<View className={`flex-row flex-wrap gap-2 ${className}`}>
			{agentIds.map((agentId) => {
				// The roster can trail the item that announced the agent.
				const status = agents.get(agentId)?.status ?? "running";
				return (
					<Pressable
						key={agentId}
						accessibilityRole="button"
						accessibilityLabel={`${agentName(agentId)}, ${statusLabel(status)}`}
						disabled={!onOpenAgent}
						onPress={() => onOpenAgent?.(agentId)}
						className="h-[30px] flex-row items-center gap-1.5 rounded-full border border-border bg-surface-raised pl-2 pr-3 active:opacity-70"
					>
						<View className="h-4 w-4 items-center justify-center">
							<AgentStatusIcon status={status} size={13} />
						</View>
						<Text numberOfLines={1} className="max-w-[180px] text-[13px] font-medium text-primary">
							{agentName(agentId)}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/** `skills` are the names shown as chips in the user's messages. */
export function TimelineRow({
	item,
	skills,
	agents,
	onOpenAgent,
}: { item: TimelineItem; skills?: ReadonlySet<string> } & AgentProps) {
	if (item.kind === "tool")
		return (
			<View className="mb-3 px-4">
				<ToolCard item={item} agents={agents} onOpenAgent={onOpenAgent} />
			</View>
		);
	if (item.kind === "event" && item.agentIds?.length)
		return (
			<View className="mb-3 flex-row flex-wrap items-center justify-center gap-2 px-8">
				<Text className="text-[12px] text-secondary">Finished</Text>
				<AgentChips agentIds={item.agentIds} agents={agents} onOpenAgent={onOpenAgent} />
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
				<Blocks blocks={item.blocks} markdown={false} skills={skills} />
			</View>
		);
	return (
		<View className="mb-4 w-full">
			<Blocks blocks={item.blocks} markdown />
			{item.streaming ? (
				<View className="mt-2 self-center">
					<ThinkingMascot />
				</View>
			) : null}
			{item.error ? <Text className="mt-2 text-caption text-danger">{item.error}</Text> : null}
		</View>
	);
}

const OUTGOING_LABELS = {
	sending: "Sending…",
	sent: "Sent",
	unsent: "Not sent. Tap to retry.",
	undelivered: "Not delivered. Tap to retry.",
};

/** A message the user sent that the transcript does not show yet; `onPressFailed` offers retrying a failed one. */
export function OutgoingRow({
	message,
	skills,
	onPressFailed,
}: {
	message: OutgoingMessage;
	skills?: ReadonlySet<string>;
	onPressFailed(): void;
}) {
	const failed = message.status.kind === "failed";
	const label = OUTGOING_LABELS[message.status.kind === "failed" ? message.status.reason : message.status.kind];
	return (
		<Pressable
			disabled={!failed}
			onPress={onPressFailed}
			accessibilityRole={failed ? "button" : undefined}
			className="mb-4 max-w-[86%] items-end self-end active:opacity-80"
		>
			<View
				className={`rounded-[18px] bg-surface-raised px-4 py-3 ${message.status.kind === "sending" ? "opacity-60" : ""} ${failed ? "border border-danger" : ""}`}
			>
				{message.text ? (
					<Blocks blocks={[{ kind: "text", text: message.text }]} markdown={false} skills={skills} />
				) : null}
				{message.images.map((image) => (
					<Image key={image.uri} source={{ uri: image.uri }} className="my-1 h-[160px] w-[160px] rounded-card" />
				))}
			</View>
			<Text className={`mt-1 text-[11px] ${failed ? "text-danger" : "text-secondary"}`}>{label}</Text>
		</Pressable>
	);
}
