import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { UsageAccount, UsageLimit, UsageResponse, UsageStatus } from "@omp-mobile/protocol";
import { relativeTime } from "../../../components/session-meta";
import { EmptyState, ErrorState, Icon, Loading, Surface } from "../../../components/ui";
import { OmpApi } from "../../../data/api";
import { useMachine } from "../../../data/machines";

type UsageState = { kind: "loading" } | { kind: "ready"; usage: UsageResponse } | { kind: "error"; message: string };

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	"openai-codex": "OpenAI Codex",
	"github-copilot": "GitHub Copilot",
};

const STATUS_COLORS: Record<UsageStatus, string> = {
	ok: "#8B93FF",
	warning: "#D29922",
	exhausted: "#F85149",
	unknown: "#8B93FF",
};

function countdown(until: number): string {
	const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days) return `${days}d ${hours}h`;
	if (hours) return `${hours}h ${minutes % 60}m`;
	return `${minutes}m`;
}

export default function UsageScreen() {
	const { machineId } = useLocalSearchParams<{ machineId: string }>();
	const machine = useMachine(machineId);
	const [state, setState] = useState<UsageState>({ kind: "loading" });
	const load = useCallback(() => {
		if (!machine) return;
		setState({ kind: "loading" });
		new OmpApi(machine)
			.usage()
			.then((usage) => setState({ kind: "ready", usage }))
			.catch((error: unknown) =>
				setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load usage." }),
			);
	}, [machine]);
	useEffect(load, [load]);

	return (
		<View className="flex-1 bg-ink">
			<Stack.Screen
				options={{
					headerLeft: () => (
						<Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={() => router.back()}>
							<Icon name="xmark" size={17} />
						</Pressable>
					),
				}}
			/>
			{!machine ? (
				<ErrorState message="This computer is no longer paired." />
			) : state.kind === "loading" ? (
				<Loading label="Checking usage…" />
			) : state.kind === "error" ? (
				<ErrorState message={state.message} retry={load} />
			) : state.usage.accounts.length ? (
				<UsageReport usage={state.usage} />
			) : (
				<EmptyState
					icon="gauge.with.dots.needle.33percent"
					title="No usage data"
					detail="Sign in to a subscription provider in OMP on this computer to see its limits here."
				/>
			)}
		</View>
	);
}

function UsageReport({ usage }: { usage: UsageResponse }) {
	const providers = new Map<string, UsageAccount[]>();
	for (const account of usage.accounts)
		providers.set(account.provider, [...(providers.get(account.provider) ?? []), account]);
	const age = relativeTime(new Date(usage.fetchedAt).toISOString());
	return (
		<ScrollView contentContainerClassName="gap-6 px-4 pb-10 pt-4">
			{[...providers].map(([provider, accounts]) => (
				<View key={provider} className="gap-3">
					<Text className="text-[13px] font-semibold uppercase tracking-wider text-secondary">
						{PROVIDER_NAMES[provider] ??
							provider
								.split("-")
								.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
								.join(" ")}
					</Text>
					{accounts.map((account, index) => (
						<AccountCard key={index} account={account} />
					))}
				</View>
			))}
			<Text className="text-center text-caption text-secondary">
				{age === "now" ? "Updated just now" : `Updated ${age} ago`}
			</Text>
		</ScrollView>
	);
}

function AccountCard({ account }: { account: UsageAccount }) {
	const saved = account.savedResets
		? `${account.savedResets} saved reset${account.savedResets === 1 ? "" : "s"}`
		: undefined;
	const detail = [account.org, saved].filter(Boolean).join(" · ");
	return (
		<Surface className="gap-5">
			{account.account || account.plan || detail ? (
				<View className="gap-1">
					<View className="flex-row items-center gap-2">
						<Text numberOfLines={1} className="flex-1 text-body font-medium text-primary">
							{account.account ?? "Account"}
						</Text>
						{account.plan ? (
							<Text className="rounded-full bg-surface-raised px-2 py-0.5 text-[12px] font-semibold uppercase text-secondary">
								{account.plan}
							</Text>
						) : null}
					</View>
					{detail ? <Text className="text-caption text-secondary">{detail}</Text> : null}
				</View>
			) : null}
			{account.limits.map((limit) => (
				<LimitRow key={limit.id} limit={limit} />
			))}
		</Surface>
	);
}

function LimitRow({ limit }: { limit: UsageLimit }) {
	const fraction = limit.usedFraction;
	const used = fraction === undefined ? "No data" : `${Math.round(fraction * 100)}% used`;
	return (
		<View className="gap-2" accessible accessibilityLabel={`${limit.label}, ${used}`}>
			<View className="flex-row items-baseline justify-between gap-3">
				<Text numberOfLines={1} className="flex-1 text-body text-primary">
					{limit.label}
				</Text>
				<Text className="text-caption text-secondary" style={{ fontVariant: ["tabular-nums"] }}>
					{used}
				</Text>
			</View>
			<View className="h-1.5 overflow-hidden rounded-full bg-border">
				<View
					className="h-full rounded-full"
					style={{ width: `${Math.min(1, fraction ?? 0) * 100}%`, backgroundColor: STATUS_COLORS[limit.status] }}
				/>
			</View>
			{limit.resetsAt && limit.resetsAt > Date.now() ? (
				<Text className="text-caption text-secondary">Resets in {countdown(limit.resetsAt)}</Text>
			) : null}
		</View>
	);
}
