import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { DirectoryListing } from "@omp-mobile/protocol";

export class ProjectPathError extends Error {
	readonly code = "INVALID_PROJECT_PATH";
	constructor(message: string) {
		super(message);
		this.name = "ProjectPathError";
	}
}

function inside(path: string, root: string) {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// macOS holds any read inside these locations until the user answers a privacy
// (TCC) prompt on the Mac, so probing them while listing their parent would stall
// the request indefinitely. Folders themselves may be stat'ed; only their contents
// are guarded.
const privacyGuarded = (() => {
	if (process.platform !== "darwin") return () => false;
	const home = homedir();
	const library = join(home, "Library");
	const folders = new Set(
		["Desktop", "Documents", "Downloads", "Library/Mobile Documents"].map((name) => join(home, name)),
	);
	const parents = new Set(
		["CloudStorage", "Containers", "Group Containers"].map((name) => join(library, name)).concat("/Volumes"),
	);
	return (path: string) => folders.has(path) || parents.has(dirname(path));
})();

export class DirectoryBrowser {
	readonly #configuredRoots: string[];
	readonly #sessionCwds: () => Promise<Set<string>>;
	#rootsPromise?: Promise<string[]>;

	constructor(roots: string[], sessionCwds: () => Promise<Set<string>>) {
		this.#configuredRoots = roots;
		this.#sessionCwds = sessionCwds;
	}

	#roots() {
		this.#rootsPromise ??= Promise.all(this.#configuredRoots.map((root) => realpath(root))).then((values) => [
			...new Set(values),
		]);
		return this.#rootsPromise;
	}

	async #resolveConfined(input: string | undefined) {
		const roots = await this.#roots();
		if (!roots.length) throw new ProjectPathError("No directory roots are configured");
		const requested = input === undefined ? roots[0]! : resolve(input);
		let canonical: string;
		try {
			canonical = await realpath(requested);
		} catch {
			throw new ProjectPathError("Directory does not exist");
		}
		let info;
		try {
			info = await stat(canonical);
		} catch {
			throw new ProjectPathError("Directory does not exist");
		}
		if (!info.isDirectory()) throw new ProjectPathError("Path is not a directory");
		if (!roots.some((root) => inside(canonical, root)))
			throw new ProjectPathError("Directory is outside the allowed roots");
		return { canonical, roots };
	}

	async resolve(path: string) {
		return (await this.#resolveConfined(path)).canonical;
	}

	async list(path: string | undefined): Promise<DirectoryListing> {
		const { canonical, roots } = await this.#resolveConfined(path);
		const cwds = await this.#sessionCwds();
		const entries = [];
		for (const dirent of await readdir(canonical, { withFileTypes: true })) {
			if (dirent.name.startsWith(".")) continue;
			const candidate = join(canonical, dirent.name);
			let target: string;
			try {
				target = await realpath(candidate);
				const info = await stat(target);
				if (!info.isDirectory() || !roots.some((root) => inside(target, root))) continue;
			} catch {
				continue;
			}
			let isGitRepo = false;
			if (!privacyGuarded(target))
				try {
					await stat(join(target, ".git"));
					isGitRepo = true;
				} catch {}
			entries.push({ name: basename(candidate), path: target, isGitRepo, hasSessions: cwds.has(target) });
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		const parentPath = dirname(canonical);
		return {
			path: canonical,
			roots,
			...(parentPath !== canonical && roots.some((root) => inside(parentPath, root)) ? { parent: parentPath } : {}),
			entries,
		};
	}
}
