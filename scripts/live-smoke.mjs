#!/usr/bin/env node
/** Exercise the browser companion against an isolated, paired T3 server. */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const local = resolve(root, '.local');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) {
    throw new Error(
      'Use --server-version VERSION --port PORT --pairing-log PATH [--model MODEL] [--timeout-ms NUMBER].',
    );
  }
  args.set(key, value);
}
const option = (key, fallback) =>
  args.get(key) ?? process.env[key.slice(2).toUpperCase().replaceAll('-', '_')] ?? fallback;
const serverVersion = option('--server-version', '0.0.44');
const supportedPorts = new Map([
  ['0.0.44', 4377],
  ['0.0.45', 4378],
]);
const expectedPort = supportedPorts.get(serverVersion);
const port = Number(option('--port', String(expectedPort)));
if (expectedPort === undefined || port !== expectedPort) {
  throw new Error('Select exactly T3 0.0.44 on port 4377 or T3 0.0.45 on port 4378.');
}
const pairingLog = option('--pairing-log', resolve(local, `live-pair-${serverVersion}.log`));
const resultPath = resolve(local, `live-smoke-${serverVersion}-result.json`);
const workspace = resolve(option('--workspace', resolve(local, 'smoke-project')));
const model = option('--model', 'gpt-6-sol');
const timeoutMs = Number(option('--timeout-ms', '180000'));
const interrupt = option('--interrupt', 'false') === 'true';
if (
  !/^gpt-6(?:\.1)?-sol$/.test(model) ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  timeoutMs > 600000
) {
  throw new Error('Choose gpt-6-sol or gpt-6.1-sol and a timeout from 1000 to 600000 ms.');
}
if (workspace !== resolve(local, 'smoke-project')) {
  throw new Error('This smoke only operates on the isolated .local/smoke-project workspace.');
}

let stage = 'startup';
let client;
let resumed;
const report = {
  upstreamVersion: null,
  protocolVersion: null,
  model,
  stages: [],
  projectId: null,
  threadId: null,
};
const mark = (name, detail) => {
  stage = name;
  report.stages.push({ name, ...(detail ? { detail } : {}) });
  console.log(`${name}${detail ? `: ${detail}` : ''}`);
};
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const waitUntil = async (predicate, timeout, label) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};
const dispatch = async (base, token, command) => {
  const response = await fetch(new URL('/api/orchestration/dispatch', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok)
    throw new Error(`Upstream rejected ${command.type} with HTTP ${response.status}.`);
  const receipt = await response.json();
  if (!Number.isInteger(receipt.sequence))
    throw new Error(`Upstream returned an invalid ${command.type} receipt.`);
};
const readDetail = async (base, token, threadId) => {
  const response = await fetch(
    new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, base),
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) throw new Error(`Upstream thread detail failed with HTTP ${response.status}.`);
  return response.json();
};

try {
  await mkdir(local, { recursive: true });
  const log = await readFile(pairingLog, 'utf8');
  const pairingUrl = log.match(/^Pairing URL: (\S+)/m)?.[1];
  if (!pairingUrl) throw new Error('No pairing URL found in the private server log.');
  const target = new URL(pairingUrl);
  if (target.origin !== `http://127.0.0.1:${port}`)
    throw new Error('Pairing URL is outside the selected isolated test server.');
  mark('pairing');
  const bundlePath = resolve(local, `live-client-${serverVersion}.mjs`);
  await build({
    entryPoints: [resolve(root, 'src/t3/client.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const { T3Client } = await import(`${new URL(`file://${bundlePath}`).href}?run=${randomUUID()}`);
  client = await T3Client.pair(pairingUrl);
  const saved = client.getSavedConnection();
  report.upstreamVersion = saved.serverVersion;
  report.protocolVersion = saved.protocolVersion;
  if (saved.serverVersion !== serverVersion || saved.protocolVersion !== 1)
    throw new Error('Unexpected upstream version or protocol.');
  mark('paired', `protocol 1, T3 ${serverVersion}`);

  const base = saved.httpBaseUrl;
  const token = saved.accessToken;
  const projectId = `smoke-${randomUUID()}`;
  const threadId = `smoke-${randomUUID()}`;
  const projectRoot = resolve(workspace, projectId);
  await mkdir(projectRoot, { recursive: true });
  report.projectId = projectId;
  report.threadId = threadId;
  const selection = { instanceId: 'codex', model };
  await dispatch(base, token, {
    type: 'project.create',
    commandId: randomUUID(),
    projectId,
    title: 'Browser Companion Live Smoke',
    workspaceRoot: projectRoot,
    createdAt: new Date().toISOString(),
  });
  mark('project-created');
  await dispatch(base, token, {
    type: 'thread.create',
    commandId: randomUUID(),
    threadId,
    projectId,
    title: 'Harmless nonce reply',
    modelSelection: selection,
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    branch: null,
    worktreePath: projectRoot,
    createdAt: new Date().toISOString(),
  });
  mark('thread-created');

  // The adapter's initial shell is a real authenticated upstream projection.
  client.disconnect();
  client = await T3Client.resume(saved);
  const listed = client
    .getThreads()
    .some((thread) => thread.id === threadId && thread.projectId === projectId);
  if (!listed) throw new Error('The adapter shell did not list the created thread.');
  mark('shell-listed-thread');
  let latest = null;
  const unsubscribe = client.onThread(threadId, (detail) => {
    latest = detail;
  });
  await waitUntil(() => latest?.thread.id === threadId, 10000, 'initial adapter detail');
  mark('thread-detail-loaded');

  const nonce = `SMOKE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const send = await client.send({
    threadId,
    text: `Reply with exactly ${nonce}. Do not use tools, read files, or perform any other action.`,
  });
  if (send.status !== 'accepted') throw new Error(`Adapter send result was ${send.status}.`);
  mark('turn-accepted');
  await waitUntil(
    () =>
      latest?.messages.some((message) => message.role === 'user' && message.text.includes(nonce)),
    10000,
    'persisted user message',
  );
  mark('user-message-observed');
  await waitUntil(
    () =>
      latest?.messages.some(
        (message) =>
          message.role === 'assistant' && !message.streaming && message.text.trim() === nonce,
      ),
    timeoutMs,
    'exact assistant nonce reply',
  );
  mark('assistant-replied', 'exact nonce matched');

  unsubscribe();
  client.disconnect();
  resumed = await T3Client.resume(saved);
  if (!resumed.getThreads().some((thread) => thread.id === threadId))
    throw new Error('Thread was missing after reconnect.');
  let restored = null;
  const unsubscribeRestored = resumed.onThread(threadId, (detail) => {
    restored = detail;
  });
  await waitUntil(
    () =>
      restored?.messages.some(
        (message) =>
          message.role === 'assistant' && !message.streaming && message.text.trim() === nonce,
      ),
    10000,
    'persisted assistant reply after reconnect',
  );
  unsubscribeRestored();
  mark('reconnect-persisted', 'reply and thread visible');
  if (interrupt) {
    const firstTurnId = (await readDetail(base, token, threadId)).thread?.latestTurn?.turnId;
    const interruptPrompt =
      'Write a numbered list of 1000 common English nouns, one per line. Do not use tools or read files.';
    const second = await resumed.send({ threadId, text: interruptPrompt });
    if (second.status !== 'accepted')
      throw new Error(`Second adapter send result was ${second.status}.`);
    mark('interrupt-turn-accepted');
    const stopped = await resumed.stop({ threadId });
    if (stopped.status !== 'accepted')
      throw new Error(`Adapter interrupt result was ${stopped.status}.`);
    mark('interrupt-command-accepted');
    const observed = await waitUntil(
      async () => {
        const detail = await readDetail(base, token, threadId);
        const latestTurn = detail.thread?.latestTurn;
        if (
          !detail.thread?.messages?.some((message) => message.id === second.messageId) ||
          latestTurn?.turnId === firstTurnId
        )
          return null;
        const state = latestTurn?.state;
        return state === 'interrupted' || state === 'completed' || state === 'error' ? state : null;
      },
      30000,
      'upstream interrupted turn state',
    );
    report.interruptResult = observed;
    mark('interrupt-observed', `upstream latest turn ${observed}`);
  }
  report.result = 'pass';
} catch (error) {
  report.result = 'fail';
  report.failedStage = stage;
  report.error =
    error instanceof Error
      ? error.message.replace(/([#?&]token=)[^\s&#]+/gi, '$1[REDACTED]')
      : 'Unknown failure';
  console.error(
    `Live smoke failed after ${stage}; details in .local/live-smoke-${serverVersion}-result.json.`,
  );
  process.exitCode = 1;
} finally {
  client?.disconnect();
  resumed?.disconnect();
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
