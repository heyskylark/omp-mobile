import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	await chmod(temp, 0o600);
	await rename(temp, path);
}
