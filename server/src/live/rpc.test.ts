import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcSupervisor } from "./rpc.ts";

test("reassembles a frame OMP split into rpc_chunk lines, whatever order the chunks arrive in", async () => {
	const frame = { type: "message_update", text: "é".repeat(5_000) };
	const bytes = Buffer.from(JSON.stringify(frame), "utf8");
	const size = Math.ceil(bytes.byteLength / 4);
	const chunks = [0, 1, 2, 3].map((index) => ({
		type: "rpc_chunk",
		chunkId: "rpc-1",
		index,
		count: 4,
		byteLength: bytes.byteLength,
		data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
	}));
	const lines = [chunks[2], chunks[0], chunks[3], chunks[1]].map((chunk) => JSON.stringify(chunk)).join("\n");
	const dir = await mkdtemp(join(tmpdir(), "omp-mobile-rpc-"));
	const script = join(dir, "omp.ts");
	await writeFile(script, `process.stdout.write(${JSON.stringify(`${lines}\n`)});\n`);
	try {
		const rpc = new RpcSupervisor([process.execPath, script], dir);
		const received: Record<string, unknown>[] = [];
		rpc.onFrame((candidate) => {
			received.push(candidate);
		});
		expect(await rpc.close()).toBe(0);
		expect(received).toEqual([frame]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
