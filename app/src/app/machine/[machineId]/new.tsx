import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import type { ModelRole, RecentProject } from "@omp-mobile/protocol";
import * as Haptics from "expo-haptics";
import { Composer, useComposerDraft } from "../../../components/composer";
import { ErrorState, Icon, Loading, Surface } from "../../../components/ui";
import { OmpApi, operationId } from "../../../data/api";
import { useMachine } from "../../../data/machines";
import { sessionOutbox } from "../../../data/outbox";
import { useSkills } from "../../../data/skills";

export default function NewSessionScreen() {
	const { machineId, cwd } = useLocalSearchParams<{ machineId: string; cwd?: string }>();
	const machine = useMachine(machineId);
	const headerHeight = useHeaderHeight();
	const [projects, setProjects] = useState<RecentProject[]>([]);
	const [selected, setSelected] = useState(cwd ?? "");
	const [modelRole, setModelRole] = useState<ModelRole>("default");
	const [state, setState] = useState<"loading" | "ready" | "error" | "creating">("loading");
	const [error, setError] = useState("");
	const draft = useComposerDraft(`${machineId}/new`);
	const skills = useSkills(machine, selected || undefined);
	useEffect(() => {
		if (cwd) setSelected(cwd);
	}, [cwd]);
	useEffect(() => {
		if (!machine) return;
		void new OmpApi(machine)
			.recentProjects()
			.then((items) => {
				setProjects(items);
				if (!selected && items[0]) setSelected(items[0].path);
				setState("ready");
			})
			.catch((caught) => {
				setError(caught instanceof Error ? caught.message : "Could not load projects.");
				setState("error");
			});
	}, [machine]);
	if (!machine) return <ErrorState message="This computer is no longer paired." />;
	if (state === "loading") return <Loading label="Loading projects…" />;
	const create = async () => {
		const prompt = draft.text;
		const images = draft.images;
		if (!selected || (!prompt.trim() && !images.length) || state === "creating") return;
		setState("creating");
		try {
			const created = await new OmpApi(machine).create({
				operationId: operationId(),
				cwd: selected,
				prompt: prompt.trim(),
				...(images.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
				...(modelRole === "default" ? {} : { modelRole }),
			});
			await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
			sessionOutbox(machineId, created.sessionId).created(prompt.trim(), images);
			draft.clear();
			router.replace({
				pathname: "/machine/[machineId]/session/[sessionId]",
				params: { machineId, sessionId: created.sessionId },
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not create the session.");
			setState("ready");
		}
	};
	return (
		<KeyboardAvoidingView
			behavior={Platform.OS === "ios" ? "padding" : undefined}
			keyboardVerticalOffset={headerHeight}
			className="flex-1 bg-ink"
		>
			<ScrollView
				className="flex-1"
				contentContainerClassName="gap-3 px-4 py-5"
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode="on-drag"
			>
				<View className="mb-1 flex-row items-center justify-between">
					<Text className="text-[13px] font-semibold uppercase tracking-wider text-secondary">Project</Text>
					<Pressable
						onPress={() => router.push({ pathname: "/machine/[machineId]/browse", params: { machineId } })}
						className="flex-row items-center gap-1"
					>
						<Icon name="folder" color="#8B93FF" size={15} />
						<Text className="text-[14px] font-medium text-accent">Browse</Text>
					</Pressable>
				</View>
				{cwd && !projects.some((project) => project.path === cwd) ? (
					<Pressable onPress={() => setSelected(cwd)}>
						<Surface className={`flex-row items-center gap-3 ${selected === cwd ? "border-accent" : ""}`}>
							<Icon name="folder.fill" color="#8B93FF" />
							<Text numberOfLines={1} className="flex-1 text-body text-primary">
								{cwd.split("/").pop()}
							</Text>
						</Surface>
					</Pressable>
				) : null}
				{projects.map((project) => (
					<Pressable key={project.path} onPress={() => setSelected(project.path)}>
						<Surface
							className={`flex-row items-center gap-3 ${selected === project.path ? "border-accent bg-surface-raised" : ""}`}
						>
							<Icon name="folder.fill" color={selected === project.path ? "#8B93FF" : "#9A9AA2"} />
							<View className="flex-1">
								<Text className="text-body font-medium text-primary">{project.name}</Text>
								<Text numberOfLines={1} className="text-caption text-secondary">
									{project.path}
								</Text>
							</View>
							<Text className="text-caption text-secondary">{project.sessionCount}</Text>
						</Surface>
					</Pressable>
				))}
				{state === "error" ? <Text className="text-caption text-danger">{error}</Text> : null}
			</ScrollView>
			{error && state !== "error" ? (
				<Text className="px-5 pb-2 text-center text-caption text-danger">{error}</Text>
			) : null}
			<View className="px-4 pb-4">
				<Composer
					machineId={machineId}
					value={draft.text}
					onChangeText={draft.setText}
					onSend={() => void create()}
					onStop={() => {}}
					working={false}
					disabled={!selected || state === "creating"}
					images={draft.images}
					onAttach={draft.attach}
					onPasteImages={draft.paste}
					onRemoveImage={draft.remove}
					modelRole={modelRole}
					onModelRoleChange={setModelRole}
					skills={skills}
				/>
			</View>
		</KeyboardAvoidingView>
	);
}
