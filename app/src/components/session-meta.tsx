import type { Liveness, SessionSummary } from "@omp-mobile/protocol";
import { Text, View } from "react-native";

export function livenessLabel(liveness: Liveness, pendingCount = 0): string | null {
	if (pendingCount > 0) return "Needs you";
	switch (liveness.kind) {
		case "terminal":
			return "In terminal";
		case "server":
			return liveness.phase === "working" || liveness.phase === "settling" ? "Running" : null;
		case "conflict":
			return "Conflict";
		case "unavailable":
			return "Unavailable";
		case "idle":
			return null;
	}
}

export function LivenessBadge({ session }: { session: SessionSummary }) {
	const label = livenessLabel(session.liveness, session.pendingCount);
	if (!label) return null;
	const tone =
		label === "Needs you"
			? "text-warning"
			: label === "Conflict" || label === "Unavailable"
				? "text-danger"
				: label === "Running"
					? "text-success"
					: "text-secondary";
	return (
		<View className="rounded-full border border-border bg-surface-raised px-2.5 py-1">
			<Text className={`text-[12px] font-medium ${tone}`}>{label}</Text>
		</View>
	);
}

export function relativeTime(value: string): string {
	const elapsed = Date.now() - new Date(value).getTime();
	const minutes = Math.max(0, Math.floor(elapsed / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export type SessionSection = { title: "Today" | "Yesterday" | "Earlier"; data: SessionSummary[] };

export function groupSessions(items: SessionSummary[]): SessionSection[] {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const yesterday = new Date(start);
	yesterday.setDate(yesterday.getDate() - 1);
	const groups: Record<SessionSection["title"], SessionSummary[]> = { Today: [], Yesterday: [], Earlier: [] };
	for (const item of items) {
		const updated = new Date(item.updatedAt);
		groups[updated >= start ? "Today" : updated >= yesterday ? "Yesterday" : "Earlier"].push(item);
	}
	return (["Today", "Yesterday", "Earlier"] as const).flatMap((title) =>
		groups[title].length ? [{ title, data: groups[title] }] : [],
	);
}
