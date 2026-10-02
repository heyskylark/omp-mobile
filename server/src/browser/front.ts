/** Chromium browsers the relay extension can run in, the most likely first. */
const BROWSER_BUNDLE_IDS = [
	"com.google.Chrome",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"company.thebrowser.Browser",
	"com.vivaldi.Vivaldi",
	"com.operasoftware.Opera",
	"com.google.Chrome.beta",
	"com.google.Chrome.canary",
	"com.google.chrome.for.testing",
];

/**
 * Brings the running Chromium browser in front of other apps. macOS does not let a background app raise its own
 * window, so the extension's own focus request leaves Chrome covered, and a covered Chrome neither draws nor
 * answers input. `open -b` activates an app without the Automation permission that AppleScript would need.
 */
export async function raiseBrowser(): Promise<void> {
	const list = Bun.spawn(["lsappinfo", "list"], { stdout: "pipe", stderr: "ignore" });
	const output = await new Response(list.stdout).text();
	const running = new Set(Array.from(output.matchAll(/bundleID="([^"]+)"/g), (match) => match[1]));
	const bundleId = BROWSER_BUNDLE_IDS.find((id) => running.has(id));
	if (bundleId) await Bun.spawn(["open", "-b", bundleId], { stdout: "ignore", stderr: "ignore" }).exited;
}
