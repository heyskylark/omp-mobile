import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHistory, InvalidHistoryCursorError, ProjectPathError } from "./index";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "omp-mobile-history-"));
	temporary.push(root);
	const sessionsDir = join(root, "sessions");
	const project = join(root, "projects", "alpha");
	await mkdir(join(sessionsDir, "bucket"), { recursive: true });
	await mkdir(join(project, ".git"), { recursive: true });
	const file = join(sessionsDir, "bucket", "fixture_session-1.jsonl");
	const title = JSON.stringify({ type: "title", title: "Fixture title" }).padEnd(255, " ") + "\n";
	const records = [
		{ type: "session", version: 3, id: "session-1", cwd: project, timestamp: "2026-01-01T00:00:00.000Z" },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "user",
				timestamp: 1767225601000,
				content: [
					{ type: "text", text: "Hello" },
					{ type: "image", mimeType: "image/png" },
				],
			},
		},
		{
			type: "message",
			id: "abandoned",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				timestamp: 1767225602000,
				content: [{ type: "text", text: "Wrong branch" }],
				stopReason: "stop",
			},
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "assistant",
				timestamp: 1767225603000,
				model: "model-x",
				stopReason: "toolUse",
				content: [
					{ type: "thinking", thinking: "considering" },
					{ type: "redactedThinking" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { i: "List files", command: "ls -la" } },
				],
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false },
		},
		{ type: "compaction", id: "c1", parentId: "r1", timestamp: "2026-01-01T00:00:05.000Z", shortSummary: "summary" },
	];
	await writeFile(file, title + records.map((record) => JSON.stringify(record)).join("\n") + "\n{partial");
	const history = createHistory({
		sessionsDir,
		blobsDir: join(root, "blobs"),
		roots: [join(root, "projects")],
		cursorSecret: new TextEncoder().encode("secret"),
	});
	return { root, project, file, history };
}

describe("OMP JSONL history", () => {
	test("maps only the active branch with tool results, thinking, compaction and malformed tail", async () => {
		const { history } = await fixture();
		const page = await history.readTimeline("session-1", { limit: 20 });
		expect(page).toEqual({
			items: [
				{
					id: "e:u1",
					kind: "user",
					at: "2026-01-01T00:00:01.000Z",
					blocks: [
						{ kind: "text", text: "Hello" },
						{ kind: "image", mimeType: "image/png" },
					],
				},
				{
					id: "e:a1",
					kind: "assistant",
					at: "2026-01-01T00:00:03.000Z",
					blocks: [
						{ kind: "thinking", text: "considering" },
						{ kind: "thinking", text: "Thinking redacted", redacted: true },
					],
					streaming: false,
					model: "model-x",
					stopReason: "toolUse",
				},
				{
					id: "t:call-1",
					kind: "tool",
					at: "2026-01-01T00:00:03.000Z",
					name: "bash",
					title: "List files",
					input: "ls -la",
					state: "succeeded",
					output: "ok",
				},
				{
					id: "e:c1",
					kind: "event",
					at: "2026-01-01T00:00:05.000Z",
					tone: "info",
					text: "Conversation compacted: summary",
				},
			],
		});
	});

	test("paginates by items and rejects a tampered cursor", async () => {
		const { history } = await fixture();
		const newest = await history.readTimeline("session-1", { limit: 2 });
		expect(newest.items.map((item) => item.id)).toEqual(["t:call-1", "e:c1"]);
		expect(newest.olderCursor).toBeString();
		const older = await history.readTimeline("session-1", { before: newest.olderCursor, limit: 2 });
		expect(older.items.map((item) => item.id)).toEqual(["e:u1", "e:a1"]);
		const cursor = newest.olderCursor!;
		const middle = Math.floor(cursor.length / 2);
		const tampered = cursor.slice(0, middle) + (cursor[middle] === "A" ? "B" : "A") + cursor.slice(middle + 1);
		await expect(history.readTimeline("session-1", { before: tampered, limit: 2 })).rejects.toBeInstanceOf(
			InvalidHistoryCursorError,
		);
	});

	test("extends the byte index after append and reports durable message keys", async () => {
		const { history, file } = await fixture();
		await history.readTimeline("session-1", { limit: 20 });
		await appendFile(
			file,
			"}\n" +
				JSON.stringify({
					type: "message",
					id: "u2",
					parentId: "c1",
					timestamp: "2026-01-01T00:00:06.000Z",
					message: { role: "user", timestamp: 1767225606000, content: "Again" },
				}) +
				"\n",
		);
		const tail = await history.readTail("session-1", { afterEntryId: "c1", limit: 10 });
		expect(tail).toEqual({
			items: [{ id: "e:u2", kind: "user", at: "2026-01-01T00:00:06.000Z", blocks: [{ kind: "text", text: "Again" }] }],
			messageKeys: [{ itemId: "e:u2", role: "user", timestamp: 1767225606000 }],
			lastEntryId: "u2",
		});
	});

	test("lists metadata and confines directory browsing across symlinks", async () => {
		const { root, project, history } = await fixture();
		const list = await history.listSessions({ limit: 30 });
		expect(
			list.items.map((item) => ({
				id: item.id,
				cwd: item.cwd,
				title: item.title,
				status: item.status,
				preview: item.preview,
			})),
		).toEqual([
			{ id: "session-1", cwd: project, title: "Fixture title", status: "interrupted", preview: "Wrong branch" },
		]);
		const dirs = await history.listDirectories(join(root, "projects"));
		expect(dirs.entries).toEqual([
			{ name: "alpha", path: await realpath(project), isGitRepo: true, hasSessions: true },
		]);
		const outside = await mkdtemp(join(tmpdir(), "omp-mobile-outside-"));
		temporary.push(outside);
		await symlink(outside, join(root, "projects", "escape"));
		const refreshed = await history.listDirectories(join(root, "projects"));
		expect(refreshed.entries.map((entry) => entry.name)).toEqual(["alpha"]);
		await expect(history.resolveProjectDir(join(root, "projects", "escape"))).rejects.toBeInstanceOf(ProjectPathError);
	});
});
