# Live upstream smoke

This check runs the companion's `T3Client` against official T3 Code 0.0.44 or 0.0.45 and orchestration protocol 1. It pairs through T3's normal token exchange, creates a sacrificial project and thread under `.local/smoke-project`, sends one harmless nonce request through the configured `codex` provider, checks the exact assistant reply, then reconnects and checks persistence. It does not use the user's existing T3 projects or local T3 database.

Prerequisites: Node 22.12 or newer, `npm install` in this repository, and one of the isolated server installations below already running. The installed native Codex provider must have access to `gpt-6-sol` or `gpt-6.1-sol`. The test refuses any server origin other than `127.0.0.1`, any protocol other than 1, any model other than the two above, and any workspace root other than `.local/smoke-project`. Port 4377 is the default for 0.0.44 and 4378 for 0.0.45; other versions default to 4379. T3 pairing credentials are single use; mint a fresh one for every run. Keep `.local` private and ignored.

For T3 0.0.44, running on `127.0.0.1:4377` with `.local/t3-data`:

```sh
install -m 600 /dev/null .local/live-pair-0.0.44.log
.local/t3-server/node_modules/.bin/t3 pair --base-dir .local/t3-data > .local/live-pair-0.0.44.log
node scripts/live-smoke.mjs --server-version 0.0.44 --port 4377 --pairing-log .local/live-pair-0.0.44.log
```

For T3 0.0.45, running on `127.0.0.1:4378` with `.local/t3-v2-data`:

```sh
install -m 600 /dev/null .local/live-pair-0.0.45.log
.local/t3-v2/node_modules/.bin/t3 pair --base-dir .local/t3-v2-data > .local/live-pair-0.0.45.log
node scripts/live-smoke.mjs --server-version 0.0.45 --port 4378 --pairing-log .local/live-pair-0.0.45.log
```

### Protocol-only run without a provider

`--provider-reply false` skips the model reply. It checks pairing, the authenticated shell, thread detail, an accepted send, the persisted user message, and persistence after reconnect. It needs no provider login, so it runs on a clean machine or in CI.

`scripts/upstream-smoke.sh [npm-tag-or-version]` does all of it in a scratch directory: it installs `t3` there (default tag `latest`), starts it on `127.0.0.1:4379` with its own `HOME` and data directory, mints a pairing link, runs the protocol-only smoke, and stops the server. It never reads or changes an existing T3 install. The weekly [Upstream compatibility workflow](../.github/workflows/upstream-compat.yml) runs it against the latest published release and opens or updates a GitHub issue labeled `upstream-drift` when it fails.

`SERVER_VERSION`, `PORT`, `PAIRING_LOG`, `MODEL`, and `TIMEOUT_MS` environment variables can replace the corresponding flags. `--model gpt-6.1-sol` selects the other allowed model. The script prints stage names and short outcomes without credentials or model output. Its private `.local/live-smoke-<version>-result.json` records the result and sacrificial IDs; a nonzero exit means an assertion failed. Every run uses a fresh child directory so T3's one-active-project-per-workspace rule does not cause a collision.

An optional `--interrupt true` starts a second harmless, bounded turn and calls `T3Client.stop()`. Its command receipt alone is **not** proof that the provider stopped; check `interruptResult` and `interrupt-observed` in the result. This check can race with fast completion or a still-running provider. Do not treat a receipt as successful interruption.

## Observed on the isolated server

On 2026-10-02, the default smoke passed against T3 0.0.44/protocol 1 with `gpt-6-sol`: pairing, authenticated shell, thread detail, accepted send, persisted user message, exact nonce assistant reply, and reply visibility after reconnect. The server's unauthenticated shell returned HTTP 401. An attempted repeat using the same project workspace received an upstream invariant error; the per-run child directory fixed that replay issue.

The same default smoke passed against the separate T3 0.0.45/protocol 1 server on `127.0.0.1:4378` with `gpt-6-sol`. The 0.0.44 and 0.0.45 commands both exited 0 after showing the exact nonce reply and reconnect persistence; their private receipts remain in separate versioned files.

The optional interruption exercise on 0.0.44 returned an accepted stop receipt. One run completed before interruption could be observed; another still showed `latestTurn=running` and `session=running` after 30 seconds. Interruption therefore remains unverified on that provider/server combination. The script reports this as a failed optional check rather than claiming the stop worked. Interruption was not retested on 0.0.45.

On 2026-10-10, `scripts/upstream-smoke.sh latest` passed against T3 0.0.45/protocol 1 in protocol-only mode (no provider reply).

On 2026-10-10, the same script failed against `t3@0.0.46-preview.20261010.2909` at the first stage: its environment descriptor reports `orchestrationProtocolVersion: 2`, which Outrigger rejects by design. Probing that server showed protocol 2 is a different contract, not a version bump: HTTP requests need an `x-t3-orchestration-protocol` header (without it the shell endpoint returns 400); the shell snapshot has a new shape (`schemaVersion: 2`, a separate `archivedThreads` list, no top-level `updatedAt`); `/api/orchestration/dispatch` returns 404 because commands moved to the WebSocket method `orchestration.dispatchCommand` with a new command schema; and thread data comes from `orchestration.getThreadProjection`. Supporting it needs a separate adapter. The npm `latest` tag was still 0.0.45 when checked; 0.0.46 existed only as preview and nightly builds. Re-run the script when 0.0.46 is published.

These results establish only the checked adapter protocol paths and model replies. Packaged extension interaction and other T3 versions require their own checks.

After testing, stop the isolated servers before deleting their `.local/t3-data`, `.local/t3-v2-data`, and `.local/smoke-project` directories. The generated versioned `.local/live-pair-*`, `.local/live-client-*`, and `.local/live-smoke-*-result.json` files can then be removed. Keep any other `.local` files that belong to concurrent work.
