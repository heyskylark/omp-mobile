import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsage } from "./usage.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function fakeOmp(script: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-mobile-usage-"));
	dirs.push(dir);
	const path = join(dir, "omp");
	await writeFile(path, `#!/bin/sh\n[ "$1 $2" = "usage --json" ] || exit 64\n${script}\n`, { mode: 0o755 });
	return path;
}

function printing(output: unknown): Promise<string> {
	return fakeOmp(`cat <<'JSON'\n${JSON.stringify(output)}\nJSON`);
}

test("maps OMP usage reports to accounts with the share used", async () => {
	const omp = await printing({
		generatedAt: 5_000,
		reports: [
			{
				provider: "openai-codex",
				fetchedAt: 4_000,
				limits: [
					{
						id: "openai-codex:primary",
						label: "7 days",
						scope: { provider: "openai-codex" },
						window: { id: "7d", label: "7 days", resetsAt: 9_000 },
						amount: { used: 16, limit: 100, usedFraction: 0.16, unit: "percent" },
						status: "ok",
					},
				],
				resetCredits: { availableCount: 4, credits: [] },
				metadata: {
					planType: "pro",
					email: "me@example.com",
					accountId: "acct-1",
					orgName: "pro",
					orgId: "acct-1",
				},
			},
			{
				provider: "anthropic",
				fetchedAt: 3_000,
				limits: [
					{ id: "a:ratio", label: "Ratio", amount: { used: 30, limit: 120, unit: "tokens" }, status: "warning" },
					{ id: "a:percent", label: "Percent", amount: { used: 45, unit: "percent" } },
					{ id: "a:remaining", label: "Remaining", amount: { remainingFraction: 0.25, unit: "unknown" } },
					{ id: "a:none", label: "None", amount: { unit: "usd" }, status: "exhausted" },
				],
				resetCredits: { availableCount: 0 },
				metadata: { accountId: "acct-2", orgName: "Acme" },
			},
		],
		accountsWithoutUsage: [],
	});

	expect(await readUsage(omp)).toEqual({
		fetchedAt: 3_000,
		accounts: [
			{
				provider: "openai-codex",
				account: "me@example.com",
				plan: "pro",
				savedResets: 4,
				limits: [{ id: "openai-codex:primary", label: "7 days", usedFraction: 0.16, resetsAt: 9_000, status: "ok" }],
			},
			{
				provider: "anthropic",
				account: "acct-2",
				org: "Acme",
				limits: [
					{ id: "a:ratio", label: "Ratio", usedFraction: 0.25, status: "warning" },
					{ id: "a:percent", label: "Percent", usedFraction: 0.45, status: "unknown" },
					{ id: "a:remaining", label: "Remaining", usedFraction: 0.75, status: "unknown" },
					{ id: "a:none", label: "None", status: "exhausted" },
				],
			},
		],
	});
});

test("no signed-in accounts is an empty report, not an error", async () => {
	const omp = await printing({ generatedAt: 7_000, reports: [] });
	expect(await readUsage(omp)).toEqual({ fetchedAt: 7_000, accounts: [] });
});

test("a failing omp surfaces its own message", async () => {
	const omp = await fakeOmp(`echo "auth broker unreachable" >&2\nexit 1`);
	await expect(readUsage(omp)).rejects.toThrow("auth broker unreachable");
});

test("output OMP changed shape on is a plain error rather than a request validation error", async () => {
	const omp = await printing({ generatedAt: 1, reports: [{ provider: "anthropic" }] });
	const error = await readUsage(omp).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).constructor).toBe(Error);
	expect((error as Error).message).toStartWith("OMP returned usage in an unexpected shape");
});
