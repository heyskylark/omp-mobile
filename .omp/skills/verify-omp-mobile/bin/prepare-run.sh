#!/bin/bash
# Creates the isolated scratch state and evidence root for one verification run.
# Usage: prepare-run.sh <run-id> [port]   (relay port is port+1; default 28787/28788)
set -euo pipefail

RUN_ID=${1:?usage: prepare-run.sh <run-id> [port]}
PORT=${2:-28787}
RELAY_PORT=$((PORT + 1))
REPO=$(cd -- "$(dirname -- "$0")/../../../.." && pwd)
SCRATCH="$HOME/.cache/omp-mobile-verify/$RUN_ID"
EVIDENCE="$REPO/.verify-evidence/$RUN_ID"

if [ -e "$SCRATCH" ]; then
	echo "Scratch already exists: $SCRATCH. Pick a new run id or run cleanup.sh $RUN_ID." >&2
	exit 1
fi
for p in "$PORT" "$RELAY_PORT"; do
	if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
		echo "Port $p is already listening. Pass another base port." >&2
		exit 1
	fi
done
OMP=$(command -v omp) || { echo "omp is not on PATH" >&2; exit 1; }

mkdir -p -m 700 "$SCRATCH/home"
mkdir -p "$SCRATCH/work/project" "$EVIDENCE"
git -C "$SCRATCH/work/project" init -q
printf '# omp-mobile verification scratch project\n' >"$SCRATCH/work/project/README.md"

PORT=$PORT RELAY_PORT=$RELAY_PORT RUN_ID=$RUN_ID OMP=$OMP WORK="$SCRATCH/work" bun -e '
const e = process.env;
const config = {
	port: Number(e.PORT),
	relayPort: Number(e.RELAY_PORT),
	machineName: `omp-verify-${e.RUN_ID}`,
	roots: [e.WORK],
	ompPath: e.OMP,
	rpcArgs: ["--approval-mode", "always-ask", "--model", "openai-codex/gpt-5.6-terra:medium", "--no-lsp", "--no-title"],
};
await Bun.write(`${e.WORK}/../home/config.json`, JSON.stringify(config, null, 2) + "\n");
'
printf 'collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:%s\n' "$RELAY_PORT" >"$SCRATCH/collab.yml"

cat >"$SCRATCH/run.env" <<EOF
RUN_ID=$RUN_ID
REPO=$REPO
PORT=$PORT
RELAY_PORT=$RELAY_PORT
SCRATCH=$SCRATCH
OMP_MOBILE_HOME=$SCRATCH/home
WORK=$SCRATCH/work
PROJECT=$SCRATCH/work/project
EVIDENCE=$EVIDENCE
MACHINE_NAME=omp-verify-$RUN_ID
EOF
cat "$SCRATCH/run.env"
