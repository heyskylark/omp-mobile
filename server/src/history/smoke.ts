import { homedir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createHistory } from "./index";

const sessionsDir = join(homedir(), ".omp", "agent", "sessions");
const history = createHistory({
	sessionsDir,
	blobsDir: join(homedir(), ".omp", "agent", "blobs"),
	roots: [homedir()],
	cursorSecret: new TextEncoder().encode("read-only-smoke-cursor-secret"),
});

const coldStarted = performance.now();
const cold = await history.listSessions({ limit: 30 });
const coldMs = performance.now() - coldStarted;
const warmStarted = performance.now();
const warm = await history.listSessions({ limit: 30 });
const warmMs = performance.now() - warmStarted;

let sessionCount = warm.items.length;
let cursor = warm.nextCursor;
while (cursor) {
	const page = await history.listSessions({ cursor, limit: 500 });
	sessionCount += page.items.length;
	cursor = page.nextCursor;
}
const candidates = await Promise.all(
	warm.items.map(async (session) => ({ session, size: (await stat(session.file)).size })),
);
candidates.sort((left, right) => right.size - left.size);
const largest = candidates[0];

console.log(`session count: ${sessionCount}`);
console.log(`listSessions limit=30 cold: ${coldMs.toFixed(1)} ms`);
console.log(`listSessions limit=30 warm: ${warmMs.toFixed(1)} ms`);

if (largest) {
	const newestStarted = performance.now();
	const newest = await history.readTimeline(largest.session.id, { limit: 40 });
	const newestMs = performance.now() - newestStarted;
	console.log(
		`sample: ${largest.session.id} (${(largest.size / 1024 / 1024).toFixed(1)} MiB), newest ${newest.items.length} items in ${newestMs.toFixed(1)} ms`,
	);
	console.log(JSON.stringify(newest.items.slice(-3), null, 2));
	if (newest.olderCursor) {
		const olderStarted = performance.now();
		const older = await history.readTimeline(largest.session.id, { before: newest.olderCursor, limit: 40 });
		console.log(`older page: ${older.items.length} items in ${(performance.now() - olderStarted).toFixed(1)} ms`);
		console.log(JSON.stringify(older.items.slice(-3), null, 2));
	} else console.log("older page: none");
} else console.log("sample: no sessions");
