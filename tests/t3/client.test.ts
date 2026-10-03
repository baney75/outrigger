import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T3Client, T3AdapterError, pairingOrigin } from '../../src/t3/client';

// Field names and request tags match pingdotgg/t3code v0.0.44 contracts:
// orchestration.ts, environmentHttp.ts, auth.ts, and rpc.ts at tag v0.0.44.
const time = '2026-10-02T12:00:00.000Z';
const thread = {
  id: 'thread-local',
  projectId: 'project-local',
  title: 'A real thread',
  branch: 'feature/browser',
  worktreePath: '/tmp/browser-worktree',
  runtimeMode: 'full-access',
  interactionMode: 'default',
  updatedAt: time,
  archivedAt: null,
  latestTurn: null,
  session: { status: 'running', activeTurnId: 'turn-1' },
  hasPendingApprovals: true,
  hasPendingUserInput: true,
};
const shell = {
  snapshotSequence: 12,
  projects: [
    {
      id: 'project-local',
      title: 'Browser project',
      workspaceRoot: '/tmp/browser-project',
      defaultModelSelection: null,
      scripts: [],
      createdAt: time,
      updatedAt: time,
    },
  ],
  threads: [thread],
  updatedAt: time,
};
const activity = (id: string, kind: string, payload: unknown) => ({
  id,
  kind,
  tone: 'approval',
  summary: kind,
  payload,
  turnId: null,
  createdAt: time,
});
const detail = {
  snapshotSequence: 12,
  thread: {
    ...thread,
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        text: 'Hello',
        turnId: 'turn-1',
        streaming: false,
        createdAt: time,
        updatedAt: time,
      },
      {
        id: 'msg-reasoning',
        role: 'reasoning',
        text: 'Private reasoning',
        turnId: 'turn-1',
        streaming: false,
        createdAt: time,
        updatedAt: time,
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        text: 'Hi',
        turnId: 'turn-1',
        streaming: false,
        createdAt: time,
        updatedAt: time,
      },
    ],
    activities: [
      activity('event-a', 'approval.requested', {
        requestId: 'approval-1',
        requestKind: 'command',
        detail: 'bun run lint',
        command: 'bun run lint',
        cwd: '/tmp/browser-worktree',
        options: [
          { decision: 'accept', label: 'Approve once', warning: 'Runs code' },
          { decision: 'acceptAlways', label: 'Always allow' },
          { decision: 'decline', label: 'Decline' },
        ],
      }),
      activity('event-file', 'approval.requested', {
        requestId: 'file-1',
        requestKind: 'file-change',
        detail: 'src/app.ts',
      }),
      activity('event-b', 'user-input.requested', {
        requestId: 'question-1',
        questions: [
          {
            id: 'q',
            header: 'Pick',
            question: 'Which?',
            options: [{ label: 'A', description: 'First', value: 'a' }],
          },
        ],
      }),
      activity('event-c', 'approval.requested', {
        requestId: 'auth-1',
        requestType: 'auth_tokens_refresh',
      }),
      activity('event-d', 'approval.resolved', { requestId: 'closed-1' }),
      activity('event-e', 'approval.requested', { requestId: 'closed-1' }),
    ],
  },
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
  open() {
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const calls: Array<{ url: string; init: RequestInit }> = [];
let dispatchResponse: () => Response;
let detailResponse: unknown;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  FakeWebSocket.instances.length = 0;
  detailResponse = detail;
  dispatchResponse = () => response({ sequence: 13 });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/.well-known/t3/environment'))
        return response({
          environmentId: 'env-local',
          label: 'Test T3',
          serverVersion: '0.0.44',
          orchestrationProtocolVersion: 1,
        });
      if (url.endsWith('/oauth/token'))
        return response({
          access_token: 'bearer-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'orchestration:read orchestration:operate',
        });
      if (url.endsWith('/api/orchestration/shell')) return response(shell);
      if (url.endsWith('/api/orchestration/threads/thread-local')) return response(detailResponse);
      if (url.endsWith('/api/auth/websocket-ticket'))
        return response({ ticket: 'short-ticket', expiresAt: time });
      if (url.endsWith('/api/orchestration/dispatch')) return dispatchResponse();
      throw new Error(`Unexpected test URL: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('T3 0.0.44 adapter', () => {
  it('exchanges an explicit pairing token for scoped bearer auth and uses a short-lived WS ticket', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    await tick();
    expect(client.getThreads()).toMatchObject([
      {
        id: 'thread-local',
        projectTitle: 'Browser project',
        branch: 'feature/browser',
        worktreePath: '/tmp/browser-worktree',
        status: 'running',
        activeRunId: 'turn-1',
        hasPendingApproval: true,
        hasPendingQuestion: true,
      },
    ]);
    const tokenCall = calls.find((call) => call.url.endsWith('/oauth/token'))!;
    expect(String(tokenCall.init.body)).toContain('subject_token=pair-secret');
    expect(String(tokenCall.init.body)).toContain(
      'scope=orchestration%3Aread+orchestration%3Aoperate',
    );
    expect(
      calls.filter(
        (call) => call.url.includes('pair-secret') || call.url.includes('bearer-secret'),
      ),
    ).toHaveLength(0);
    expect(FakeWebSocket.instances[0]?.url).toContain(
      'orchestrationProtocol=1&wsTicket=short-ticket',
    );
    expect(FakeWebSocket.instances[0]?.url).not.toContain('bearer-secret');
    expect(client.getConnection()).not.toHaveProperty('accessToken');
    expect(client.getSavedConnection().accessToken).toBe('bearer-secret');
    client.disconnect();
  });

  it('uses upstream RPC Request/Chunk frames and validates selected thread requests', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    await tick();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(first.sent).toEqual([
      {
        _tag: 'Request',
        id: 1,
        tag: 'orchestration.subscribeShell',
        payload: { afterSequence: 12 },
      },
      {
        _tag: 'Request',
        id: 2,
        tag: 'subscribeServerConfig',
        payload: { environmentThemes: true },
      },
    ]);
    let seen = client.getThread();
    const unsubscribe = client.onThread('thread-local', (value) => {
      seen = value;
    });
    await tick();
    await tick();
    expect(seen?.messages).toMatchObject([
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi' },
    ]);
    expect(seen?.requests).toMatchObject([
      {
        id: 'approval-1',
        kind: 'approval',
        requestKind: 'command',
        detail: 'bun run lint',
        command: 'bun run lint',
        cwd: '/tmp/browser-worktree',
        choices: ['accept', 'decline'],
        options: [
          { decision: 'accept', label: 'Approve once', warning: 'Runs code' },
          { decision: 'decline', label: 'Decline' },
        ],
      },
      { id: 'file-1', kind: 'approval', requestKind: 'file-change', detail: 'src/app.ts' },
      {
        id: 'question-1',
        kind: 'question',
        questions: [{ id: 'q', options: [{ label: 'A', value: 'a' }] }],
      },
    ]);
    expect(seen?.requests).toHaveLength(3);
    expect(seen?.requests.find((request) => request.id === 'file-1')).not.toHaveProperty('command');
    expect(seen?.thread).toMatchObject({
      projectTitle: 'Browser project',
      branch: 'feature/browser',
      status: 'running',
    });
    const latest = FakeWebSocket.instances.at(-1)!;
    latest.open();
    expect(latest.sent).toContainEqual({
      _tag: 'Request',
      id: 4,
      tag: 'orchestration.subscribeThread',
      payload: { threadId: 'thread-local', afterSequence: 12 },
    });
    const rejected = await client.respond({
      threadId: 'thread-local',
      requestId: 'auth-1',
      decision: 'accept',
    });
    expect(rejected.status).toBe('rejected');
    expect(
      (
        await client.respond({
          threadId: 'thread-local',
          requestId: 'approval-1',
          decision: 'acceptAlways',
        })
      ).status,
    ).toBe('rejected');
    unsubscribe();
    client.disconnect();
  });

  it('dispatches approval, question, and interrupt with their distinct v1 command shapes', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    const unsubscribe = client.onThread('thread-local', () => {});
    await tick();
    await tick();
    expect(
      await client.respond({
        threadId: 'thread-local',
        requestId: 'approval-1',
        decision: 'decline',
        commandId: 'decision-1',
      }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await client.respond({
        threadId: 'thread-local',
        requestId: 'question-1',
        answers: { q: 'a' },
        commandId: 'answer-1',
      }),
    ).toMatchObject({ status: 'accepted' });
    expect(await client.stop({ threadId: 'thread-local', commandId: 'stop-1' })).toMatchObject({
      status: 'accepted',
    });
    const commands = calls
      .filter((call) => call.url.endsWith('/api/orchestration/dispatch'))
      .map((call) => JSON.parse(String(call.init.body)));
    expect(commands).toMatchObject([
      {
        type: 'thread.approval.respond',
        commandId: 'decision-1',
        requestId: 'approval-1',
        decision: 'decline',
      },
      {
        type: 'thread.user-input.respond',
        commandId: 'answer-1',
        requestId: 'question-1',
        answers: { q: 'a' },
      },
      { type: 'thread.turn.interrupt', commandId: 'stop-1', threadId: 'thread-local' },
    ]);
    unsubscribe();
    client.disconnect();
  });

  it('joins multi-select answers only for message-mode questions', async () => {
    detailResponse = {
      ...detail,
      thread: {
        ...detail.thread,
        activities: [
          activity('message-question', 'user-input.requested', {
            requestId: 'message-1',
            responseMode: 'message',
            questions: [
              {
                id: 'areas',
                header: 'Areas',
                question: 'Which areas?',
                multiSelect: true,
                options: [
                  { label: 'Server', value: 'Server' },
                  { label: 'Web', value: 'Web' },
                ],
              },
            ],
          }),
          activity('live-question', 'user-input.requested', {
            requestId: 'live-1',
            responseMode: 'live',
            questions: [
              {
                id: 'areas',
                header: 'Areas',
                question: 'Which areas?',
                multiSelect: true,
                options: [
                  { label: 'Server', value: 'Server' },
                  { label: 'Web', value: 'Web' },
                ],
              },
            ],
          }),
        ],
      },
    };
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    const unsubscribe = client.onThread('thread-local', () => {});
    await tick();
    await tick();
    expect(
      await client.respond({
        threadId: 'thread-local',
        requestId: 'message-1',
        answers: { areas: ['Server', 'Web'] },
        commandId: 'message-answer',
      }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await client.respond({
        threadId: 'thread-local',
        requestId: 'live-1',
        answers: { areas: ['Server', 'Web'] },
        commandId: 'live-answer',
      }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await client.respond({
        threadId: 'thread-local',
        requestId: 'message-1',
        answers: { areas: [] },
        commandId: 'empty-answer',
      }),
    ).toMatchObject({ status: 'rejected' });
    const commands = calls
      .filter((call) => call.url.endsWith('/api/orchestration/dispatch'))
      .map((call) => JSON.parse(String(call.init.body)));
    expect(commands).toMatchObject([
      {
        type: 'thread.user-input.respond',
        commandId: 'message-answer',
        answers: { areas: 'Server, Web' },
      },
      {
        type: 'thread.user-input.respond',
        commandId: 'live-answer',
        answers: { areas: ['Server', 'Web'] },
      },
    ]);
    expect(commands).toHaveLength(2);
    unsubscribe();
    client.disconnect();
  });

  it('removes a request after a live resolved event and keeps a prior terminal event final', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    const unsubscribe = client.onThread('thread-local', () => {});
    await tick();
    await tick();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    expect(client.getThread()?.requests.map((request) => request.id)).toContain('approval-1');
    detailResponse = {
      ...detail,
      snapshotSequence: 13,
      thread: {
        ...detail.thread,
        activities: [
          ...detail.thread.activities,
          activity('event-resolved', 'approval.resolved', { requestId: 'approval-1' }),
          activity('event-stale-order', 'approval.requested', {
            requestId: 'approval-1',
            requestKind: 'command',
            detail: 'stale',
          }),
        ],
      },
    };
    socket.receive({
      _tag: 'Chunk',
      requestId: 2,
      values: [{ kind: 'event', event: { type: 'thread.approval-response-requested' } }],
    });
    await tick();
    await tick();
    expect(client.getThread()?.requests.map((request) => request.id)).not.toContain('approval-1');
    unsubscribe();
    client.disconnect();
  });

  it('sends Effect RPC Ping frames, accepts Pong, and reconnects after missed replies', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    await tick();
    const socket = FakeWebSocket.instances[0]!;
    vi.useFakeTimers();
    socket.open();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.at(-1)).toEqual({ _tag: 'Ping' });
    socket.receive({ _tag: 'Pong' });
    socket.receive({ _tag: 'Ping' });
    expect(socket.sent.at(-1)).toEqual({ _tag: 'Pong' });
    expect(client.getStatus().state).toBe('connected');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(socket.closed).toBe(true);
    expect(client.getStatus().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('opens one socket when selection races the first ticket request', async () => {
    const originalFetch = globalThis.fetch;
    let releaseTicket: ((value: Response) => void) | undefined;
    const ticket = new Promise<Response>((resolve) => {
      releaseTicket = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/api/auth/websocket-ticket') ? ticket : originalFetch(input, init),
      ),
    );
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    const unsubscribe = client.onThread('thread-local', () => {});
    await tick();
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(0);
    releaseTicket?.(response({ ticket: 'short-ticket', expiresAt: time }));
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
    client.disconnect();
  });

  it('sends a v1 continuation once with stable IDs and treats a lost acknowledgement as unknown', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    const accepted = await client.send({
      threadId: 'thread-local',
      text: 'Continue',
      commandId: 'command-keep',
      messageId: 'message-keep',
    });
    expect(accepted).toEqual({
      commandId: 'command-keep',
      messageId: 'message-keep',
      status: 'accepted',
    });
    const request = calls.find((call) => call.url.endsWith('/api/orchestration/dispatch'))!;
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      type: 'thread.turn.start',
      commandId: 'command-keep',
      threadId: 'thread-local',
      message: { messageId: 'message-keep', role: 'user', text: 'Continue', attachments: [] },
      runtimeMode: 'full-access',
      interactionMode: 'default',
    });
    dispatchResponse = () => {
      throw new TypeError('transport closed');
    };
    const unknown = await client.send({
      threadId: 'thread-local',
      text: 'Second',
      commandId: 'command-ambiguous',
      messageId: 'message-ambiguous',
    });
    expect(unknown).toMatchObject({
      commandId: 'command-ambiguous',
      messageId: 'message-ambiguous',
      status: 'unknown',
    });
    expect(calls.filter((call) => call.url.endsWith('/api/orchestration/dispatch'))).toHaveLength(
      2,
    );
    client.disconnect();
  });

  it.each([401, 403])('disconnects and asks for re-pair after dispatch HTTP %i', async (status) => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    await tick();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(client.getStatus().state).toBe('connected');
    const statuses: string[] = [];
    client.onStatus((value) => {
      statuses.push(value.state);
    });
    dispatchResponse = () => response({ error: 'unauthorized' }, status);
    const result = await client.send({
      threadId: 'thread-local',
      text: 'Keep draft',
      commandId: `expired-${status}`,
      messageId: `draft-${status}`,
    });
    expect(result).toMatchObject({
      status: 'rejected',
      commandId: `expired-${status}`,
      messageId: `draft-${status}`,
    });
    expect(client.getStatus()).toMatchObject({
      state: 'disconnected',
      message: expect.stringContaining('Pair again'),
    });
    expect(statuses).toEqual(['connected', 'disconnected']);
    expect(socket.closed).toBe(true);
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith('/api/orchestration/dispatch'))).toHaveLength(
      1,
    );
  });

  it('uses published data themes and imports a client-only exported palette without CSS', async () => {
    const client = await T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret');
    await tick();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.receive({
      _tag: 'Chunk',
      requestId: 2,
      values: [
        {
          version: 1,
          type: 'snapshot',
          config: {
            environment: { capabilities: { environmentThemes: true } },
            settings: { defaultTheme: 'maroon' },
          },
        },
      ],
    });
    socket.receive({
      _tag: 'Chunk',
      requestId: 2,
      values: [
        {
          version: 1,
          type: 'environmentThemesUpdated',
          payload: {
            themes: [
              {
                id: 'maroon',
                name: 'Maroon',
                appearance: 'dark',
                canvas: '#18131a',
                accent: '#b58556',
              },
            ],
          },
        },
      ],
    });
    expect(client.getThemes()).toMatchObject({
      environmentDefaultId: 'maroon',
      themes: [
        { id: 'maroon', source: 'environment', colors: { canvas: '#18131a', accent: '#b58556' } },
      ],
    });
    const imported = client.importTheme({
      version: 1,
      name: 'Personal Cream',
      appearance: 'light',
      colors: { background: '#fff6e8' },
    });
    client.selectTheme(imported.id);
    expect(client.getThemes().selectedId).toBe('client-personal-cream');
    expect(() =>
      client.importTheme({
        name: 'Bad',
        appearance: 'light',
        colors: { background: 'red;url(https://evil.test)' },
      }),
    ).toThrow();
    client.disconnect();
  });

  it('gates newer protocols and refuses credentials over non-loopback HTTP', async () => {
    expect(() => pairingOrigin('http://example.com/pair#token=secret')).toThrow(T3AdapterError);
    expect(
      pairingOrigin('https://app.t3.codes/pair?host=%2F%2Fremote.example.com#token=secret'),
    ).toBe('https://remote.example.com');
    expect(pairingOrigin('https://app.t3.codes/pair?host=remote.example.com#token=secret')).toBe(
      'https://remote.example.com',
    );
    expect(pairingOrigin('wss://remote.example.com/pair#token=secret')).toBe(
      'https://remote.example.com',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          environmentId: 'env-local',
          label: 'Test T3',
          serverVersion: '0.0.45',
          orchestrationProtocolVersion: 2,
        }),
      ),
    );
    await expect(
      T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret'),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('fails closed on missing or malformed protocol descriptors during pair and resume', async () => {
    const saved = {
      environmentId: 'env-local',
      label: 'Test T3',
      serverVersion: '0.0.44',
      protocolVersion: 1,
      httpBaseUrl: 'http://127.0.0.1:4377',
      accessToken: 'bearer-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const orchestrationProtocolVersion of [undefined, '1', 2]) {
      const body = {
        environmentId: 'env-local',
        label: 'Test T3',
        serverVersion: '0.0.44',
        orchestrationProtocolVersion,
      };
      const fetchDescriptor = vi.fn(async () => response(body));
      vi.stubGlobal('fetch', fetchDescriptor);
      const kind = orchestrationProtocolVersion === 2 ? 'unsupported' : 'invalid';
      await expect(
        T3Client.pair('http://127.0.0.1:4377/pair#token=pair-secret'),
      ).rejects.toMatchObject({ kind });
      await expect(T3Client.resume(saved)).rejects.toMatchObject({ kind });
      expect(fetchDescriptor.mock.calls).toHaveLength(2);
    }
  });
});
