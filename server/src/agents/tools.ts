import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcSupervisor } from "../live/rpc.ts";
import { TOOL_PROBE_COMMAND, TOOL_PROBE_MARKER } from "./tool-probe-extension.ts";

const PROBE_TIMEOUT_MS = 20_000;
// Tools change only when OMP, its settings, or an extension changes; a new extension tool shows up within minutes.
const FRESH_MS = 5 * 60_000;
// Doubles as the probe's cwd and as an `OMP_MOBILE_HOME` without `server.json`, so a globally installed OMP Mobile
// extension does not report the throwaway session to the phone.
const PROBE_DIR = join(tmpdir(), "omp-mobile-tool-probe");
const PROBE_EXTENSION = join(import.meta.dir, "tool-probe-extension.ts");
/** Tools `extension/omp-mobile.ts` registers; every agent session keeps them, so the editor never offers them. */
const OMP_MOBILE_TOOLS: Record<string, true> = { schedule_job: true };

/**
 * Names of the tools a default OMP session on this computer starts with (built-in, extension, and xd:// device tools,
 * after the user's settings), read from a short-lived `omp --mode rpc` child.
 */
export class ToolCatalog {
	readonly #ompPath: string;
	#entry?: { at: number; tools: Promise<string[]> };

	constructor(ompPath: string) {
		this.#ompPath = ompPath;
	}

	list(): Promise<string[]> {
		if (this.#entry && Date.now() - this.#entry.at < FRESH_MS) return this.#entry.tools;
		const entry = { at: Date.now(), tools: this.#probe() };
		this.#entry = entry;
		entry.tools.catch(() => {
			if (this.#entry === entry) this.#entry = undefined;
		});
		return entry.tools;
	}

	async #probe(): Promise<string[]> {
		await mkdir(PROBE_DIR, { recursive: true });
		const rpc = new RpcSupervisor(
			[this.#ompPath, "--mode", "rpc", "--no-session", "--no-title", "--cwd", PROBE_DIR, "-e", PROBE_EXTENSION],
			PROBE_DIR,
			{ OMP_MOBILE_HOME: PROBE_DIR },
		);
		const exited = rpc.exited.then((code) => {
			throw new Error(`omp exited with code ${code} before listing tools`);
		});
		try {
			return await Promise.race([
				(async () => {
					await rpc.ready();
					// Without the command OMP would send the prompt below to the model.
					const commands = await rpc.command({ id: "omp-mobile-commands", type: "get_available_commands" });
					const data = commands.data as { commands?: Array<{ name?: unknown }> } | undefined;
					if (!data?.commands?.some((command) => command.name === TOOL_PROBE_COMMAND))
						throw new Error("OMP did not load the tool probe extension");
					const report = rpc.waitFor(
						(frame) =>
							frame.type === "extension_ui_request" &&
							typeof frame.message === "string" &&
							frame.message.startsWith(TOOL_PROBE_MARKER),
						PROBE_TIMEOUT_MS,
					);
					report.catch(() => undefined);
					const response = await rpc.command(
						{ id: "omp-mobile-tools", type: "prompt", message: `/${TOOL_PROBE_COMMAND}` },
						PROBE_TIMEOUT_MS,
					);
					if (response.success !== true)
						throw new Error(`OMP could not list tools: ${String(response.error ?? "unknown error")}`);
					const names: unknown = JSON.parse(String((await report).message).slice(TOOL_PROBE_MARKER.length));
					if (!Array.isArray(names)) throw new Error("OMP reported tools in an unexpected shape");
					return [
						...new Set(
							names.filter(
								(name): name is string => typeof name === "string" && !Object.hasOwn(OMP_MOBILE_TOOLS, name),
							),
						),
					].sort();
				})(),
				exited,
			]);
		} finally {
			await rpc.close().catch(() => undefined);
		}
	}
}
