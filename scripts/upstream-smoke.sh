#!/usr/bin/env bash
# Install an upstream T3 Code release in a scratch directory, start it on loopback with its
# own data directory and HOME, and run the protocol-only live smoke against it.
# Usage: scripts/upstream-smoke.sh [npm-tag-or-version]   (default: latest)
# Never touches an existing T3 install or config.
set -euo pipefail

spec="${1:-latest}"
port="${T3_SMOKE_PORT:-4379}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    # `t3` is a launcher; stop its child server before the launcher itself.
    pkill -P "$server_pid" 2>/dev/null || true
    kill "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

version="$(npm view "t3@${spec}" version | tail -n 1)"
echo "Resolved t3@${spec} to ${version}"

if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:${port}/"; then
  echo "Port ${port} is already in use; set T3_SMOKE_PORT to a free port." >&2
  exit 1
fi

mkdir -p "$scratch/install" "$scratch/home" "$scratch/data" "$scratch/project"
(cd "$scratch/install" && npm init -y >/dev/null && npm install --no-audit --no-fund "t3@${version}")
t3="$scratch/install/node_modules/.bin/t3"

export HOME="$scratch/home"
"$t3" serve --host 127.0.0.1 --port "$port" --base-dir "$scratch/data" --no-browser \
  "$scratch/project" >"$scratch/serve.log" 2>&1 &
server_pid=$!

ready=""
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${port}/.well-known/t3/environment" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "T3 ${version} did not start. Server log:" >&2
  cat "$scratch/serve.log" >&2
  exit 1
fi

mkdir -p "$repo/.local"
pairing_log="$repo/.local/live-pair-${version}.log"
install -m 600 /dev/null "$pairing_log"
# The environment endpoint can answer before the pairing store is ready, so retry.
paired=""
for _ in $(seq 1 30); do
  if "$t3" pair --base-dir "$scratch/data" >"$pairing_log" 2>"$scratch/pair.err" &&
    grep -q '^Pairing URL: ' "$pairing_log"; then
    paired=1
    break
  fi
  sleep 1
done
if [ -z "$paired" ]; then
  echo "Could not create a pairing link. Last error:" >&2
  cat "$scratch/pair.err" >&2
  cat "$pairing_log" >&2
  tail -20 "$scratch/serve.log" >&2
  exit 1
fi

cd "$repo"
node scripts/live-smoke.mjs --server-version "$version" --port "$port" \
  --pairing-log "$pairing_log" --provider-reply false
