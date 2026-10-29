/** Command the tool probe (`tools.ts`) runs; it answers with an `extension_ui_request` notify frame. */
export const TOOL_PROBE_COMMAND = "omp-mobile-tools";
export const TOOL_PROBE_MARKER = "omp-mobile-tools:";

type Context = { ui: { notify(message: string, type: "info"): void } };
type Api = {
	registerCommand(
		name: string,
		options: { description: string; handler(args: string, context: Context): Promise<void> },
	): void;
	getActiveTools(): string[];
};

/** Loaded only into the server's short-lived tool probe, never into sessions. */
export default function toolProbe(api: Api): void {
	api.registerCommand(TOOL_PROBE_COMMAND, {
		description: "Report the active tools to OMP Mobile",
		handler: async (_args, context) =>
			context.ui.notify(`${TOOL_PROBE_MARKER}${JSON.stringify(api.getActiveTools())}`, "info"),
	});
}
