import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

// Released T3 Code 0.0.44 HTTP/Effect RPC shapes. All content is synthetic.
const stamp = '2026-10-02T16:00:00.000Z';
const thread = (id: string, title: string) => ({
  id,
  title,
  projectId: 'project-demo',
  runtimeMode: 'approval-required',
  interactionMode: 'default',
  updatedAt: stamp,
  archivedAt: null,
  latestTurn: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  branch: 'feature/browser-companion',
});
type RawMessage = {
  id: string;
  role: string;
  text: string;
  turnId: null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};
type Activity = {
  id: string;
  kind: string;
  tone: string;
  summary: string;
  payload: unknown;
  turnId: null;
  createdAt: string;
};
export async function fixtureServer() {
  let sequence = 1;
  let offline = false;
  let loseAck = false;
  let holdReceipt: Promise<void> | null = null;
  let deferResponseResolution = false;
  let protocol = 1;
  const threads = [
    thread('thread-a', 'Refine the pricing page'),
    thread('thread-b', 'Make the docs easier to follow'),
  ];
  const messages: Record<string, RawMessage[]> = {
    'thread-a': [
      {
        id: 'msg-1',
        role: 'user',
        text: 'Give the pricing page a calmer layout. Keep the comparison easy to scan.',
        turnId: null,
        streaming: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'msg-2',
        role: 'assistant',
        text: 'The layout is ready. I simplified the plan cards and moved the feature comparison below them.\n\nOne decision before I finish: should the annual price appear first?',
        turnId: null,
        streaming: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    'thread-b': [
      {
        id: 'msg-3',
        role: 'assistant',
        text: 'I grouped the setup steps into one path. The example now shows what a successful connection looks like.',
        turnId: null,
        streaming: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
  };
  const activities: Record<string, Activity[]> = { 'thread-a': [], 'thread-b': [] };
  const commands: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Array<{ id: number; tag: string }>>();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (offline) {
      res.destroy();
      return;
    }
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/.well-known/t3/environment')
      return json({
        environmentId: 'env-demo',
        label: 'Local workspace',
        serverVersion: '0.0.44',
        orchestrationProtocolVersion: protocol,
        capabilities: { environmentThemes: true },
      });
    if (path === '/oauth/token')
      return json({
        access_token: 'fixture-bearer',
        token_type: 'Bearer',
        expires_in: 36000,
        scope: 'orchestration:read orchestration:operate',
      });
    if (req.headers.authorization !== 'Bearer fixture-bearer')
      return json({ error: 'Unauthorized' }, 401);
    if (path === '/api/auth/websocket-ticket')
      return json({
        ticket: 'fixture-ticket',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    if (path === '/api/orchestration/shell')
      return json({
        snapshotSequence: sequence,
        projects: [
          { id: 'project-demo', name: 'Acme Studio', title: 'Acme Studio', cwd: '/example/acme' },
        ],
        threads,
        updatedAt: stamp,
      });
    if (path.startsWith('/api/orchestration/threads/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      const row = threads.find((t) => t.id === id);
      return row
        ? json({
            snapshotSequence: sequence,
            thread: { ...row, messages: messages[id], activities: activities[id] },
            page: { hasMore: false },
          })
        : json({}, 404);
    }
    if (path === '/api/orchestration/dispatch') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const command = JSON.parse(raw);
      commands.push(command);
      sequence++;
      const row = threads.find((t) => t.id === command.threadId);
      if (command.type === 'thread.turn.start' && row) {
        messages[row.id]!.push({
          id: command.message.messageId,
          role: 'user',
          text: command.message.text,
          turnId: null,
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        });
        messages[row.id]!.push({
          id: `reply-${sequence}`,
          role: 'assistant',
          text: 'I have your follow-up. Continuing in the same session.',
          turnId: null,
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      if (
        (command.type === 'thread.user-input.respond' ||
          command.type === 'thread.approval.respond') &&
        row &&
        !deferResponseResolution
      ) {
        activities[row.id]!.push({
          id: `resolved-${sequence}`,
          kind:
            command.type === 'thread.user-input.respond'
              ? 'user-input.resolved'
              : 'approval.resolved',
          tone: 'info',
          summary: 'Answered',
          payload: { requestId: command.requestId },
          turnId: null,
          createdAt: stamp,
        });
        row.hasPendingUserInput = false;
        row.hasPendingApprovals = false;
      }
      if (holdReceipt) {
        const pending = holdReceipt;
        holdReceipt = null;
        await pending;
      }
      // Model an upstream failure after commit, without Chromium's implicit retry of a reset socket.
      if (loseAck) {
        json({ error: 'Receipt unavailable after commit' }, 500);
        loseAck = false;
      } else json({ sequence });
      broadcast();
      return;
    }
    json({}, 404);
  });
  const ws = new WebSocketServer({ server, path: '/ws' });
  ws.on('connection', (socket) => {
    sockets.add(socket);
    subscriptions.set(socket, []);
    socket.on('close', () => {
      sockets.delete(socket);
      subscriptions.delete(socket);
    });
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request._tag === 'Ping') {
        socket.send(JSON.stringify({ _tag: 'Pong' }));
        return;
      }
      if (request._tag !== 'Request') return;
      subscriptions.get(socket)!.push({ id: request.id, tag: request.tag });
      if (request.tag === 'subscribeServerConfig')
        socket.send(
          JSON.stringify({
            _tag: 'Chunk',
            requestId: request.id,
            values: [
              {
                version: 1,
                type: 'snapshot',
                config: {
                  settings: { defaultTheme: '' },
                  environment: { capabilities: { environmentThemes: true } },
                },
              },
            ],
          }),
        );
    });
  });
  function broadcast() {
    for (const socket of sockets)
      for (const sub of subscriptions.get(socket) ?? []) {
        if (sub.tag === 'subscribeServerConfig') continue;
        socket.send(
          JSON.stringify({
            _tag: 'Chunk',
            requestId: sub.id,
            values: [
              { kind: sub.tag === 'orchestration.subscribeShell' ? 'thread-upserted' : 'event' },
            ],
          }),
        );
      }
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    commands,
    saved: {
      environmentId: 'env-demo',
      label: 'Local workspace',
      httpBaseUrl: base,
      serverVersion: '0.0.44',
      protocolVersion: 1,
      accessToken: 'fixture-bearer',
      expiresAt: new Date(Date.now() + 36000000).toISOString(),
    },
    question(id = 'thread-a', requestId = 'question-1') {
      const row = threads.find((t) => t.id === id)!;
      row.hasPendingUserInput = true;
      activities[id]!.push({
        id: `activity-${requestId}`,
        kind: 'user-input.requested',
        tone: 'info',
        summary: 'Choose a billing default',
        turnId: null,
        createdAt: stamp,
        payload: {
          requestId,
          questions: [
            {
              id: 'billing',
              header: 'Billing',
              question: 'Which price should visitors see first?',
              options: [
                {
                  label: 'Annual billing',
                  description: 'Show the lower monthly equivalent.',
                  value: 'annual',
                },
                {
                  label: 'Monthly billing',
                  description: 'Show the flexible plan first.',
                  value: 'monthly',
                },
              ],
              required: true,
              allowCustomAnswer: true,
              multiSelect: false,
            },
          ],
        },
      });
      sequence++;
      broadcast();
    },
    resolve(id = 'thread-a', requestId = 'question-1') {
      const row = threads.find((t) => t.id === id)!;
      row.hasPendingUserInput = false;
      row.hasPendingApprovals = false;
      activities[id]!.push({
        id: `resolved-${++sequence}`,
        kind: 'user-input.resolved',
        tone: 'info',
        summary: 'Answered in T3',
        payload: { requestId },
        turnId: null,
        createdAt: stamp,
      });
      broadcast();
    },
    approval(id = 'thread-a', withContext = true) {
      threads.find((t) => t.id === id)!.hasPendingApprovals = true;
      activities[id]!.push({
        id: 'approval-event',
        kind: 'approval.requested',
        tone: 'approval',
        summary: 'Run the project tests',
        turnId: null,
        createdAt: stamp,
        payload: {
          requestId: 'approval-1',
          requestKind: 'command',
          ...(withContext ? { detail: 'npm test', cwd: '/example/acme', command: 'npm test' } : {}),
          options: [
            { decision: 'accept', label: 'Allow once', warning: 'Runs on your T3 server.' },
            { decision: 'decline', label: 'Deny' },
          ],
        },
      });
      sequence++;
      broadcast();
    },
    maliciousMessage() {
      messages['thread-a']!.push({
        id: 'malicious',
        role: 'assistant',
        text: '<script>globalThis.pwned = true</script>\n\n[Bad link](javascript:alert(1))\n\n![tracking](https://example.com/tracking.png)\n\n`safe code`',
        turnId: null,
        streaming: false,
        createdAt: stamp,
        updatedAt: stamp,
      });
      sequence++;
      broadcast();
    },
    loseNextAcknowledgement() {
      loseAck = true;
    },
    loseResponseAcknowledgement() {
      loseAck = true;
      deferResponseResolution = true;
    },
    holdNextAcknowledgement() {
      let release!: () => void;
      holdReceipt = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    setOffline(value: boolean) {
      offline = value;
      if (value) for (const socket of sockets) socket.close();
    },
    setProtocol(value: number) {
      protocol = value;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => server.close(() => resolve())));
    },
  };
}
