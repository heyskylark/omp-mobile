import type { UsageAccount, UsageLimit, UsageResponse } from "@omp-mobile/protocol";
import { z } from "zod";

// Uncached reports query every signed-in provider; the phone gives up a little later than this.
const TIMEOUT_MS = 20_000;

const AmountSchema = z.object({
	used: z.number().optional(),
	limit: z.number().optional(),
	usedFraction: z.number().optional(),
	remainingFraction: z.number().optional(),
	unit: z.string(),
});

const ReportSchema = z.object({
	provider: z.string(),
	fetchedAt: z.number(),
	limits: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			window: z.object({ resetsAt: z.number().optional() }).optional(),
			amount: AmountSchema,
			status: z.enum(["ok", "warning", "exhausted", "unknown"]).optional(),
		}),
	),
	resetCredits: z.object({ availableCount: z.number() }).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const OutputSchema = z.object({ generatedAt: z.number(), reports: z.array(ReportSchema) });
type UsageOutput = z.infer<typeof OutputSchema>;

export async function readUsage(ompPath: string): Promise<UsageResponse> {
	const child = Bun.spawn([ompPath, "usage", "--json"], { stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (child.signalCode) throw new Error("OMP took too long to report usage.");
	if (code !== 0) throw new Error(stderr.trim() || `omp usage exited with code ${code}`);
	let output: unknown;
	try {
		output = JSON.parse(stdout);
	} catch {
		throw new Error("OMP returned usage that is not JSON.");
	}
	const parsed = OutputSchema.safeParse(output);
	if (!parsed.success) throw new Error(`OMP returned usage in an unexpected shape: ${parsed.error.issues[0]?.message}`);
	return toUsage(parsed.data);
}

function toUsage(output: UsageOutput): UsageResponse {
	return {
		fetchedAt: Math.min(output.generatedAt, ...output.reports.map((report) => report.fetchedAt)),
		accounts: output.reports.map((report): UsageAccount => {
			const metadata = report.metadata ?? {};
			const account = text(metadata.email) ?? text(metadata.accountId) ?? text(metadata.projectId);
			const org = text(metadata.orgName) ?? text(metadata.orgId);
			const plan = text(metadata.planType);
			const savedResets = report.resetCredits?.availableCount;
			return {
				provider: report.provider,
				...(account ? { account } : {}),
				...(org && org !== account && org !== plan ? { org } : {}),
				...(plan ? { plan } : {}),
				...(savedResets ? { savedResets } : {}),
				limits: report.limits.map((limit): UsageLimit => {
					const usedFraction = resolveUsedFraction(limit.amount);
					const resetsAt = limit.window?.resetsAt;
					return {
						id: limit.id,
						label: limit.label,
						...(usedFraction === undefined ? {} : { usedFraction }),
						...(resetsAt === undefined ? {} : { resetsAt }),
						status: limit.status ?? "unknown",
					};
				}),
			};
		}),
	};
}

/** Same precedence as OMP's `resolveUsedFraction`, so the phone shows the share OMP's `/usage` prints. */
function resolveUsedFraction(amount: z.infer<typeof AmountSchema>): number | undefined {
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}
