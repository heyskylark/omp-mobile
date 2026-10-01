import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

	test("reads the model role from the newest role entry on the active branch", async () => {
		const { history, file } = await fixture();
		expect(await history.readModelRole("session-1")).toBe("default");
		let parentId = "c1";
		const append = async (id: string, entry: Record<string, unknown>, parent = parentId) => {
			await appendFile(
				file,
				`${JSON.stringify({ id, parentId: parent, timestamp: "2026-01-01T00:00:07.000Z", ...entry })}\n`,
			);
			parentId = id;
		};
		await appendFile(file, "}\n");
		// Phone switch: OMP's default-role model_change, then the extension's role entry.
		await append("m1", { type: "model_change", model: "anthropic/opus", role: "default" });
		await append("k1", { type: "custom", customType: "omp-mobile-model-role", data: { role: "smol" } });
		expect(await history.readModelRole("session-1")).toBe("smol");
		// Retry fallback and its restore never change the role.
		await append("f1", { type: "model_change", model: "openai/gpt", role: "fallback" });
		expect(await history.readModelRole("session-1")).toBe("smol");
		// A terminal role cycle after the phone switch wins.
		await append("m2", { type: "model_change", model: "openai/gpt", role: "slow" });
		expect(await history.readModelRole("session-1")).toBe("slow");
		await append("m3", { type: "model_change", model: "openai/gpt", role: "temporary" });
		expect(await history.readModelRole("session-1")).toBeNull();
		// Branching back above the terminal switches restores the phone's role.
		await append(
			"u3",
			{ type: "message", message: { role: "user", timestamp: 1767225608000, content: "Branch" } },
			"k1",
		);
		expect(await history.readModelRole("session-1")).toBe("smol");
	});

	test("model change events carry the reasoning level OMP recorded with the switch", async () => {
		const { history, file } = await fixture();
		let parentId = "c1";
		const append = async (id: string, entry: Record<string, unknown>) => {
			await appendFile(file, `${JSON.stringify({ id, parentId, timestamp: "2026-01-01T00:00:07.000Z", ...entry })}\n`);
			parentId = id;
		};
		await appendFile(file, "}\n");
		await append("m1", { type: "model_change", model: "anthropic/opus", role: "default" });
		await append("t1", { type: "thinking_level_change", thinkingLevel: "high", configured: "high" });
		await append("m2", { type: "model_change", model: "openai/gpt" });
		await append("u3", { type: "message", message: { role: "user", timestamp: 1767225608000, content: "Hi" } });
		// A later standalone level change does not belong to m2.
		await append("t2", { type: "thinking_level_change", thinkingLevel: "low" });
		await append("m3", { type: "model_change", model: "anthropic/haiku" });
		await append("t3", { type: "thinking_level_change", thinkingLevel: "off" });
		const page = await history.readTimeline("session-1", { limit: 50 });
		const tail = await history.readTail("session-1", { afterEntryId: "c1", limit: 50 });
		for (const items of [page.items, tail.items])
			expect(
				items.flatMap((item) => (item.kind === "event" && item.text.startsWith("Model") ? [item.text] : [])),
			).toEqual([
				"Model changed to anthropic/opus · high reasoning",
				"Model changed to openai/gpt",
				"Model changed to anthropic/haiku · reasoning off",
			]);
	});

	test("shows a /skill: prompt as the text the user typed, not the expanded skill", async () => {
		const { history, file } = await fixture();
		let parentId = "c1";
		const append = async (id: string, entry: Record<string, unknown>) => {
			await appendFile(file, `${JSON.stringify({ id, parentId, timestamp: "2026-01-01T00:00:07.000Z", ...entry })}\n`);
			parentId = id;
		};
		await appendFile(file, "}\n");
		const skill = (id: string, attribution: string) =>
			append(id, {
				type: "custom_message",
				customType: "skill-prompt",
				content: '[IMPORTANT: User invoked the "review" skill; follow its instructions.]\n\n# Review\n...',
				display: true,
				details: { name: "review", args: "the auth module", prompt: "/skill:review the auth module" },
				attribution,
			});
		await skill("s1", "user");
		await skill("s2", "agent");
		const page = await history.readTimeline("session-1", { limit: 50 });
		const tail = await history.readTail("session-1", { afterEntryId: "c1", limit: 50 });
		for (const items of [page.items, tail.items]) {
			expect(items.find((item) => item.id === "e:s1")).toMatchObject({
				kind: "user",
				blocks: [{ kind: "text", text: "/skill:review the auth module" }],
			});
			expect(items.find((item) => item.id === "e:s2")).toMatchObject({ kind: "event" });
		}
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

	test("re-sends a tool call as finished when its result lands after the tail cursor", async () => {
		const { history } = await fixture();
		const tail = await history.readTail("session-1", { afterEntryId: "a1", limit: 10 });
		expect(tail.items).toEqual([
			expect.objectContaining({ id: "e:c1", kind: "event" }),
			expect.objectContaining({ id: "t:call-1", kind: "tool", state: "succeeded", output: "ok" }),
		]);
	});
});

describe("task agents", () => {
	const jsonl = (...records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
	const header = (id: string, minute: number) => ({
		type: "session",
		version: 3,
		id,
		cwd: "/tmp/project",
		timestamp: `2026-01-01T00:0${minute}:00.000Z`,
	});
	const user = (id: string) => ({ type: "message", id, parentId: null, message: { role: "user", content: "Do it" } });
	const yielded = (id: string, status: string, extra: { type?: string[]; isError?: boolean } = {}) => ({
		type: "message",
		id,
		parentId: null,
		message: {
			role: "toolResult",
			toolCallId: `${id}-call`,
			toolName: "yield",
			details: { status, ...(extra.type ? { type: extra.type } : {}) },
			content: [],
			...(extra.isError ? { isError: true } : {}),
		},
	});
	const assistant = (id: string, stopReason: string) => ({
		type: "message",
		id,
		parentId: null,
		message: { role: "assistant", stopReason, content: [{ type: "text", text: "..." }] },
	});

	async function agentFixture() {
		const { root, history } = await fixture();
		const parent = join(root, "sessions", "bucket", "parent.jsonl");
		const dir = parent.slice(0, -".jsonl".length);
		await mkdir(join(dir, "Alpha"), { recursive: true });
		await writeFile(
			parent,
			jsonl(
				header("parent", 0),
				{
					type: "message",
					id: "spawn",
					parentId: null,
					message: {
						role: "assistant",
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "task-1", name: "task", arguments: { i: "Spawn" } }],
					},
				},
				{
					type: "message",
					id: "spawned",
					parentId: "spawn",
					message: {
						role: "toolResult",
						toolCallId: "task-1",
						toolName: "task",
						content: [{ type: "text", text: "Spawned" }],
						details: { async: { state: "running" }, progress: [{ id: "Alpha" }, { id: "Beta" }] },
					},
				},
				{
					type: "custom_message",
					customType: "async-result",
					id: "delivered",
					parentId: "spawned",
					content: "<system-notice>Background job Alpha has completed…</system-notice>",
					details: { jobs: [{ jobId: "Alpha", type: "task", label: "Alpha", durationMs: 1000 }] },
				},
			),
		);
		await writeFile(
			join(dir, "Alpha.jsonl"),
			jsonl(header("alpha", 1), user("a1"), yielded("a2", "success"), {
				type: "custom",
				customType: "session_exit",
				id: "a3",
				parentId: "a2",
			}),
		);
		await writeFile(join(dir, "Beta.jsonl"), jsonl(header("beta", 2), user("b1"), assistant("b2", "toolUse")));
		await writeFile(
			join(dir, "Woken.jsonl"),
			jsonl(header("woken", 3), user("w1"), yielded("w2", "success"), user("w3")),
		);
		await writeFile(
			join(dir, "Alpha", "Alpha.Gamma.jsonl"),
			jsonl(header("gamma", 4), user("g1"), assistant("g2", "aborted")),
		);
		await writeFile(
			join(dir, "Partial.jsonl"),
			jsonl(
				header("partial", 5),
				user("p1"),
				yielded("p2", "success", { type: ["findings"] }),
				yielded("p3", "error", { isError: true }),
			),
		);
		await writeFile(
			join(dir, "Superseded.jsonl"),
			jsonl(header("superseded", 6), user("s1"), yielded("s2", "success"), {
				type: "custom_message",
				customType: "async-result",
				id: "s3",
				parentId: "s2",
				content: "job done",
			}),
		);
		await writeFile(join(dir, "__advisor.jsonl"), jsonl(header("advisor", 7)));
		await writeFile(join(dir, "__advisor.review.jsonl"), jsonl(header("named-advisor", 7)));
		await writeFile(join(dir, "Alpha", "__advisor.jsonl"), jsonl(header("alpha-advisor", 7)));
		await writeFile(join(dir, ".Alpha.jsonl.lock.os"), "");
		await writeFile(join(dir, "Alpha.md"), "Alpha's output");
		return { history, parent, dir };
	}

	test("finds agents nested under their session with how each one's latest run ended", async () => {
		const { history, parent } = await agentFixture();
		expect(
			(await history.listAgents(parent)).map(({ agentId, parentId, outcome }) => ({ agentId, parentId, outcome })),
		).toEqual([
			{ agentId: "Alpha", parentId: undefined, outcome: "completed" },
			{ agentId: "Beta", parentId: undefined, outcome: undefined },
			{ agentId: "Woken", parentId: undefined, outcome: undefined },
			{ agentId: "Alpha.Gamma", parentId: "Alpha", outcome: "aborted" },
			{ agentId: "Partial", parentId: undefined, outcome: undefined },
			{ agentId: "Superseded", parentId: undefined, outcome: undefined },
		]);
		expect((await history.listSessions({ limit: 10 })).items.map((session) => session.id).sort()).toEqual([
			"parent",
			"session-1",
		]);
	});

	test("tells an agent's transcript from a session's", async () => {
		const { history, parent, dir } = await agentFixture();
		expect(await history.locateAgent(parent)).toBeNull();
		expect(await history.locateAgent(join(dir, "Beta.jsonl"))).toEqual({ rootFile: parent, agentId: "Beta" });
		expect(await history.locateAgent(join(dir, "Alpha", "Alpha.Gamma.jsonl"))).toEqual({
			rootFile: parent,
			agentId: "Alpha.Gamma",
			parentId: "Alpha",
		});
	});

	test("links a task call to the agents it spawned and shows a delivered result as who finished", async () => {
		const { history } = await agentFixture();
		const page = await history.readTimeline("parent", { limit: 10 });
		expect(page.items.find((item) => item.id === "t:task-1")).toEqual(
			expect.objectContaining({ state: "succeeded", agentIds: ["Alpha", "Beta"] }),
		);
		expect(page.items.find((item) => item.id === "e:delivered")).toEqual(
			expect.objectContaining({ kind: "event", text: "Alpha finished", agentIds: ["Alpha"] }),
		);
	});
});

describe("filtered session listing", () => {
	const sessions = [
		{ id: "login", project: "alpha", title: "Fix login redirect bug", minutesAgo: 1 },
		{ id: "add-search", project: "alpha", title: "Add session search", minutesAgo: 2 },
		{ id: "push", project: "alpha", title: "Refactor push notifications", minutesAgo: 3 },
		{ id: "ordering", project: "beta", title: "Session search results ordering", minutesAgo: 4 },
		{ id: "readme", project: "beta", title: "Update README", minutesAgo: 5 },
		{ id: "catalog", project: "beta", title: "Searching the catalog", minutesAgo: 6 },
		{ id: "version", project: "gamma", title: "Investigate outdated database version", minutesAgo: 7 },
	];

	async function catalog() {
		const root = await mkdtemp(join(tmpdir(), "omp-mobile-filter-"));
		temporary.push(root);
		const sessionsDir = join(root, "sessions");
		await mkdir(join(sessionsDir, "bucket"), { recursive: true });
		const cwd = (project: string) => join(root, "projects", project);
		const files: Record<string, string> = {};
		for (const session of sessions) {
			const file = join(sessionsDir, "bucket", `${session.id}.jsonl`);
			files[session.id] = file;
			const header = { type: "session", version: 3, id: session.id, cwd: cwd(session.project), title: session.title };
			await writeFile(file, JSON.stringify(header) + "\n");
			const updated = new Date(Date.UTC(2026, 0, 1, 12, 0) - session.minutesAgo * 60_000);
			await utimes(file, updated, updated);
		}
		const history = createHistory({
			sessionsDir,
			blobsDir: join(root, "blobs"),
			roots: [join(root, "projects")],
			cursorSecret: new TextEncoder().encode("secret"),
		});
		return { history, cwd, files };
	}

	test("keeps newest-first order and narrows to an exact project cwd", async () => {
		const { history, cwd } = await catalog();
		const ids = async (opts: { project?: string; query?: string }) =>
			(await history.listSessions({ limit: 30, ...opts })).items.map((item) => item.id);
		expect(await ids({})).toEqual(["login", "add-search", "push", "ordering", "readme", "catalog", "version"]);
		expect(await ids({ project: cwd("beta") })).toEqual(["ordering", "readme", "catalog"]);
		expect(await ids({ project: `${cwd("beta")}/` })).toEqual([]);
		expect(await ids({ project: cwd("beta"), query: "   " })).toEqual(["ordering", "readme", "catalog"]);
	});

	test("ranks fuzzy title matches by relevance before recency and drops misses", async () => {
		const { history, cwd } = await catalog();
		const titles = async (opts: { project?: string; query?: string }) =>
			(await history.listSessions({ limit: 30, ...opts })).items.map((item) => item.title);
		// Equal scores fall back to newest first; the weaker match stays last even though it is newer.
		expect(await titles({ query: "search" })).toEqual([
			"Add session search",
			"Searching the catalog",
			"Session search results ordering",
		]);
		// A one-letter typo still matches; "sesion" is also one edit from "version" but that is not a close match.
		expect(await titles({ query: "  sesion " })).toEqual(["Add session search", "Session search results ordering"]);
		expect(await titles({ query: "readme", project: cwd("alpha") })).toEqual([]);
		expect(await titles({ query: "kubernetes" })).toEqual([]);
	});

	test("pages through filtered results with cursors bound to the filter", async () => {
		const { history, cwd } = await catalog();
		const project = cwd("alpha");
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await history.listSessions({ limit: 1, project, query: "search", cursor });
			seen.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor;
		} while (cursor);
		expect(seen).toEqual(["add-search"]);

		const first = await history.listSessions({ limit: 2, query: "search" });
		expect(first.items.map((item) => item.id)).toEqual(["add-search", "catalog"]);
		const second = await history.listSessions({ limit: 2, query: " search ", cursor: first.nextCursor });
		expect(second).toEqual({ items: [expect.objectContaining({ id: "ordering" })] });

		const valid = first.nextCursor!;
		const tampered = valid.slice(0, 4) + (valid[4] === "A" ? "B" : "A") + valid.slice(5);
		const rejected = [
			{ query: "searc", cursor: valid },
			{ cursor: valid },
			{ query: "search", project, cursor: valid },
			{ query: "search", cursor: tampered },
			{ query: "search", cursor: "not-a-cursor" },
		];
		for (const opts of rejected)
			await expect(history.listSessions({ limit: 2, ...opts })).rejects.toBeInstanceOf(InvalidHistoryCursorError);
	});

	test("rejects a cursor whose offset is past the end of the filtered list", async () => {
		const { history, files } = await catalog();
		const first = await history.listSessions({ limit: 1, query: "sesion" });
		expect(first.nextCursor).toBeString();
		await rm(files["add-search"]!);
		await rm(files["ordering"]!);
		await expect(history.listSessions({ limit: 1, query: "sesion", cursor: first.nextCursor })).rejects.toBeInstanceOf(
			InvalidHistoryCursorError,
		);
	});
});
