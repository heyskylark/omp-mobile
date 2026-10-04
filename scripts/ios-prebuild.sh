# Generates app/ios for scripts/simulator.sh and scripts/device.sh when it is missing or stale, and puts Node on PATH
# for the Expo CLI. Sourced, not run: callers continue in app/ with NODE set.

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

NODE=$(command -v node || true)
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
	NODE=$(bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm which default' 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
	for CANDIDATE in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
		if [ -x "$CANDIDATE" ]; then
			NODE=$CANDIDATE
			break
		fi
	done
fi
if [ -z "$NODE" ]; then
	echo "Node.js is required for Expo prebuild. Install Node.js and rerun $(basename "$0")." >&2
	exit 1
fi

PATH=$(dirname "$NODE"):$PATH
export PATH

cd "$ROOT/app"
# app/ios is generated and gitignored, so an existing copy may come from other inputs: cloned into a new worktree from
# another checkout, generated with a different OMP_BUNDLE_ID, or older than native files added since. Regenerate it
# whenever the resolved app config or the native sources it is built from differ from the ones recorded at prebuild.
STAMP=ios/.omp-prebuild-inputs
INPUTS=$({
	"$NODE" node_modules/expo/bin/cli config --type public --json
	find app.config.ts package.json ../bun.lock plugins targets modules -type f ! -name .DS_Store -print0 | sort -z | xargs -0 shasum
} | shasum | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$INPUTS" ]; then
	# Bun 1.3.14 pads Web ReadableStream input passed to fs.promises.writeFile, corrupting Expo's template extraction.
	"$NODE" node_modules/expo/bin/cli prebuild -p ios --clean --no-install
	# Run pod install here rather than inside prebuild, which reports success even when CocoaPods aborts (it does without
	# a UTF-8 locale), leaving no workspace to build.
	(cd ios && LC_ALL=en_US.UTF-8 pod install)
	echo "$INPUTS" >"$STAMP"
fi
