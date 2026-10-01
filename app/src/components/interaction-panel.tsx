import type { InteractionResponse, PendingInteraction } from "@omp-mobile/protocol";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Icon, PrimaryButton, Surface } from "./ui";

export function InteractionPanel({
	interaction,
	busy,
	respond,
	onOpenBrowser,
}: {
	interaction: PendingInteraction;
	busy: boolean;
	respond(response: InteractionResponse): void;
	/** Shown on questions and text prompts, which is where an agent asks the user to act in the browser. */
	onOpenBrowser?(): void;
}) {
	const [other, setOther] = useState("");
	if (interaction.kind === "approval") {
		return (
			<Surface className="gap-3">
				<Text className="text-[16px] font-semibold text-primary">{interaction.title}</Text>
				<Text className="text-body text-secondary">{interaction.detail}</Text>
				<View className="flex-row gap-3">
					<View className="flex-1">
						<PrimaryButton label="Deny" danger disabled={busy} onPress={() => respond({ kind: "deny" })} />
					</View>
					<View className="flex-1">
						<PrimaryButton label="Approve" disabled={busy} onPress={() => respond({ kind: "approve" })} />
					</View>
				</View>
			</Surface>
		);
	}
	return (
		<Surface className="gap-3">
			<View className="flex-row items-start gap-3">
				<Text className="flex-1 text-[16px] font-semibold text-primary">{interaction.title}</Text>
				{onOpenBrowser ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Open browser"
						hitSlop={6}
						onPress={onOpenBrowser}
						className="flex-row items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1.5 active:opacity-70"
					>
						<Icon name="safari" color="#9A9AA2" size={14} />
						<Text className="text-[13px] text-primary">Open browser</Text>
					</Pressable>
				) : null}
			</View>
			{interaction.kind === "question" ? (
				<View className="flex-row flex-wrap gap-2">
					{interaction.options.map((option) => (
						<Pressable
							key={option.label}
							disabled={busy}
							onPress={() => respond({ kind: "choice", label: option.label })}
							className="rounded-full border border-border bg-surface-raised px-4 py-2"
						>
							<Text className="text-[14px] text-primary">{option.label}</Text>
							{option.description ? <Text className="text-[11px] text-secondary">{option.description}</Text> : null}
						</Pressable>
					))}
				</View>
			) : null}
			{interaction.kind === "text" || interaction.allowOther ? (
				<View className="flex-row items-end gap-2">
					<TextInput
						value={other}
						onChangeText={setOther}
						placeholder={interaction.kind === "text" ? "Your response" : "Other…"}
						placeholderTextColor="#6F6F77"
						multiline
						className="min-h-11 flex-1 rounded-xl border border-border bg-surface-raised px-3 py-2 text-body text-primary"
					/>
					<Pressable
						disabled={busy || !other.trim()}
						onPress={() => respond({ kind: "text", text: other.trim() })}
						className="rounded-xl bg-accent px-4 py-3 disabled:opacity-40"
					>
						<Text className="font-semibold text-primary">Send</Text>
					</Pressable>
				</View>
			) : null}
		</Surface>
	);
}
