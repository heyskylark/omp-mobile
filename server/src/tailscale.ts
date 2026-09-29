import { access } from "node:fs/promises";
import { z } from "zod";

const StatusSchema = z.object({
	Self: z
		.object({
			TailscaleIPs: z.array(z.string()).default([]),
			DNSName: z.string().default(""),
		})
		.optional(),
});

export interface TailscaleIdentity {
	ip: string;
	dnsName: string;
}

export type TailscaleState =
	| { kind: "available"; identity: TailscaleIdentity }
	| { kind: "unavailable"; problem: string };

const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export async function findTailscaleCli(): Promise<string | null> {
	const fromPath = Bun.which("tailscale");
	if (fromPath) return fromPath;
	try {
		await access(APP_CLI);
		return APP_CLI;
	} catch {
		return null;
	}
}

export async function inspectTailscale(cli?: string | null): Promise<TailscaleState> {
	const executable = cli === undefined ? await findTailscaleCli() : cli;
	if (!executable) return { kind: "unavailable", problem: "Tailscale CLI not found" };
	try {
		const proc = Bun.spawn([executable, "status", "--json"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0)
			return { kind: "unavailable", problem: `Tailscale unavailable: ${stderr.trim() || `exit ${exitCode}`}` };
		const status = StatusSchema.parse(JSON.parse(stdout));
		const ip = status.Self?.TailscaleIPs.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
		const dns = status.Self?.DNSName;
		if (!ip || !dns) return { kind: "unavailable", problem: "Tailscale is not connected" };
		return { kind: "available", identity: { ip, dnsName: dns.replace(/\.$/, "") } };
	} catch (error) {
		return {
			kind: "unavailable",
			problem: `Tailscale unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function watchTailscale(
	listener: (state: TailscaleState) => void | Promise<void>,
	intervalMs = 15_000,
): { check(): Promise<void>; stop(): void } {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = async () => {
		if (stopped) return;
		await listener(await inspectTailscale());
		if (!stopped) {
			timer = setTimeout(check, intervalMs);
			timer.unref();
		}
	};
	return {
		check,
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}
