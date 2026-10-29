import { type ComponentProps, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import {
	AGENT_NAME_PATTERN,
	type AgentDefinition,
	type AgentInput,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "@omp-mobile/protocol";
import { ErrorState, Loading, PrimaryButton, Surface } from "../../../../components/ui";
import { useToast } from "../../../../components/toast";
import { splitNames, useAgentList } from "../../../../data/agent-definitions";
import { OmpApi } from "../../../../data/api";
import { useMachine } from "../../../../data/machines";
import type { PairedMachine } from "../../../../native/types";

const MODEL_SHORTCUTS = ["@smol", "@default", "@slow"] as const;

export default function AgentEditorScreen() {
	const { machineId, name } = useLocalSearchParams<{ machineId: string; name?: string }>();
	const machine = useMachine(machineId);
	const { list, error, reload } = useAgentList(machine);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (!list)
		return error ? <ErrorState message={error} retry={() => void reload()} /> : <Loading label="Loading agent…" />;
	const existing = name ? list.items.find((item) => item.name === name) : undefined;
	if (name && !existing) return <ErrorState message={`${name} is no longer on ${machine.name}.`} />;
	return (
		<AgentForm
			machine={machine}
			existing={existing}
			tools={list.tools}
			takenNames={list.items.map((item) => item.name)}
		/>
	);
}

function AgentForm({
	machine,
	existing,
	tools: offeredTools,
	takenNames,
}: {
	machine: PairedMachine;
	existing: AgentDefinition | undefined;
	tools: string[];
	takenNames: string[];
}) {
	const navigation = useNavigation();
	const { show } = useToast();
	const [name, setName] = useState(existing?.name ?? "");
	const [description, setDescription] = useState(existing?.description ?? "");
	// Undefined keeps OMP's default tool set; a list limits the agent to exactly those tools.
	const [tools, setTools] = useState<string[] | undefined>(existing?.tools);
	const [model, setModel] = useState(existing?.model ?? "");
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>(existing?.thinkingLevel);
	const [skills, setSkills] = useState(existing?.autoloadSkills?.join(", ") ?? "");
	const [prompt, setPrompt] = useState(existing?.prompt ?? "");
	const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
	// Tools the file names that this computer's OMP no longer offers stay visible so they can be removed.
	const toolChoices = [...offeredTools, ...(existing?.tools ?? []).filter((tool) => !offeredTools.includes(tool))];
	const nameError = existing
		? null
		: name && !AGENT_NAME_PATTERN.test(name)
			? "Use lowercase letters, numbers, and dashes, starting with a letter or number."
			: takenNames.includes(name)
				? `${name} already exists on ${machine.name}.`
				: null;
	const canSave = !busy && Boolean(name) && !nameError && Boolean(description.trim());

	const save = async () => {
		if (!canSave) return;
		const trimmedModel = model.trim();
		const autoloadSkills = splitNames(skills);
		const input: AgentInput = {
			description: description.trim(),
			...(tools ? { tools } : {}),
			...(trimmedModel ? { model: trimmedModel } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(autoloadSkills.length ? { autoloadSkills } : {}),
			prompt: prompt.trim(),
		};
		setBusy("saving");
		Keyboard.dismiss();
		try {
			await new OmpApi(machine).saveAgent(name, input);
			router.back();
		} catch (caught) {
			show(caught instanceof Error ? caught.message : "Could not save the agent.", "error");
			setBusy(null);
		}
	};
	const confirmDelete = () => {
		if (!existing) return;
		Alert.alert(
			`Delete ${existing.name}?`,
			`This deletes the agent file on ${machine.name}. Sessions already started as ${existing.name} keep working.`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Delete",
					style: "destructive",
					onPress: () =>
						void (async () => {
							setBusy("deleting");
							try {
								await new OmpApi(machine).deleteAgent(existing.name);
								router.back();
							} catch (caught) {
								show(caught instanceof Error ? caught.message : "Could not delete the agent.", "error");
								setBusy(null);
							}
						})(),
				},
			],
		);
	};

	useLayoutEffect(() => {
		navigation.setOptions({
			title: existing ? existing.name : "New agent",
			headerRight: () =>
				busy === "saving" ? (
					<ActivityIndicator color="#8B93FF" />
				) : (
					<Pressable accessibilityRole="button" disabled={!canSave} onPress={() => void save()} hitSlop={8}>
						<Text className={`text-[16px] font-semibold text-accent ${canSave ? "" : "opacity-40"}`}>Save</Text>
					</Pressable>
				),
		});
		// `save` reads every field, so the header button is rebuilt whenever one changes.
	}, [navigation, existing, busy, canSave, name, description, tools, model, thinkingLevel, skills, prompt]);

	const toggleTool = (tool: string) =>
		setTools((current) =>
			current?.includes(tool) ? current.filter((item) => item !== tool) : [...(current ?? []), tool],
		);

	return (
		<KeyboardAwareScrollView
			className="flex-1 bg-ink"
			contentContainerClassName="px-4 pb-12 pt-2"
			keyboardShouldPersistTaps="handled"
			bottomOffset={24}
		>
			{existing?.structured ? (
				<Surface className="mt-3">
					<Text className="text-caption text-secondary">
						This agent returns structured results to a parent agent, so it is only used as a subagent and is not offered
						for new sessions.
					</Text>
				</Surface>
			) : null}

			<Label>NAME</Label>
			{existing ? (
				<Text className="px-1 text-body text-primary">{existing.name}</Text>
			) : (
				<>
					<Field
						accessibilityLabel="Agent name"
						value={name}
						onChangeText={(text) => setName(text.toLowerCase())}
						placeholder="e.g. writer"
						autoCapitalize="none"
						maxLength={64}
					/>
					<Hint danger={Boolean(nameError)}>
						{nameError ?? "Lowercase letters, numbers, and dashes. Saved as ~/.omp/agent/agents/<name>.md."}
					</Hint>
				</>
			)}

			<Label>DESCRIPTION</Label>
			<Field
				accessibilityLabel="Description"
				value={description}
				onChangeText={setDescription}
				placeholder="What this agent is for"
			/>
			<Hint>Shown when you pick an agent for a new session.</Hint>

			<View className="mb-2 mt-6 flex-row items-center justify-between px-1">
				<Text className="text-caption font-medium text-secondary">TOOLS</Text>
				{tools ? (
					<Pressable accessibilityRole="button" onPress={() => setTools(undefined)} hitSlop={6}>
						<Text className="text-[14px] font-medium text-accent">Use default tools</Text>
					</Pressable>
				) : null}
			</View>
			<View className="flex-row flex-wrap gap-2">
				{toolChoices.map((tool) => (
					<Chip key={tool} label={tool} selected={Boolean(tools?.includes(tool))} onPress={() => toggleTool(tool)} />
				))}
			</View>
			<Hint>
				{!tools
					? "Uses OMP's default tools. Pick tools to give the agent only those."
					: tools.length
						? `Only ${tools.length} ${tools.length === 1 ? "tool" : "tools"}, plus the tools OMP Mobile needs.`
						: "No tools selected: the agent can only reply."}
			</Hint>

			<Label>MODEL</Label>
			<Field
				accessibilityLabel="Model"
				value={model}
				onChangeText={setModel}
				placeholder="Session's model"
				autoCapitalize="none"
			/>
			<View className="mt-2 flex-row flex-wrap gap-2">
				{MODEL_SHORTCUTS.map((shortcut) => (
					<Chip
						key={shortcut}
						label={shortcut}
						selected={model.trim() === shortcut}
						onPress={() => setModel(model.trim() === shortcut ? "" : shortcut)}
					/>
				))}
			</View>
			<Hint>A model role like @slow or a model name. Empty uses the model chosen for the new session.</Hint>

			<Label>THINKING</Label>
			<View className="flex-row flex-wrap gap-2">
				<Chip label="Default" selected={!thinkingLevel} onPress={() => setThinkingLevel(undefined)} />
				{THINKING_LEVELS.map((level) => (
					<Chip key={level} label={level} selected={thinkingLevel === level} onPress={() => setThinkingLevel(level)} />
				))}
			</View>

			<Label>SKILLS</Label>
			<Field
				accessibilityLabel="Skills"
				value={skills}
				onChangeText={setSkills}
				placeholder="None"
				autoCapitalize="none"
			/>
			<Hint>Skills loaded in every session, separated by commas.</Hint>

			<Label>INSTRUCTIONS</Label>
			<TextInput
				accessibilityLabel="Instructions"
				value={prompt}
				onChangeText={setPrompt}
				placeholder="You are…"
				placeholderTextColor="#6F6F77"
				multiline
				textAlignVertical="top"
				className="min-h-40 rounded-card border border-border bg-surface px-4 py-3 text-body text-primary"
			/>
			<Hint>Added to OMP's system prompt.</Hint>

			{existing ? (
				<View className="mt-10">
					<PrimaryButton label="Delete agent" danger icon="trash" disabled={Boolean(busy)} onPress={confirmDelete} />
				</View>
			) : null}
		</KeyboardAwareScrollView>
	);
}

function Label({ children }: { children: string }) {
	return <Text className="mb-2 mt-6 px-1 text-caption font-medium text-secondary">{children}</Text>;
}

function Hint({ children, danger = false }: { children: string; danger?: boolean }) {
	return <Text className={`mt-2 px-1 text-caption ${danger ? "text-danger" : "text-secondary"}`}>{children}</Text>;
}

function Field(props: Omit<ComponentProps<typeof TextInput>, "className" | "placeholderTextColor">) {
	return (
		<TextInput
			autoCorrect={false}
			placeholderTextColor="#6F6F77"
			className="h-12 rounded-card border border-border bg-surface px-4 text-body text-primary"
			{...props}
		/>
	);
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected }}
			onPress={onPress}
			className={`rounded-full border px-3.5 py-1.5 ${selected ? "border-accent bg-surface-raised" : "border-border bg-surface"}`}
		>
			<Text className={`text-[13px] font-medium ${selected ? "text-accent" : "text-secondary"}`}>{label}</Text>
		</Pressable>
	);
}
