import { z } from 'zod';
import { draftSchema, responseKey, type DraftWrite } from './core/drafts';
import { T3Client, T3AdapterError } from './t3/client';
import type { SavedConnection } from './t3/types';
import { initialState, type PanelState } from './core/state';
import { decideNotifications, type NotificationLedger } from './core/notifications';

const request = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }),
  z.object({
    type: z.literal('draft'),
    key: z.string().startsWith('draft:').max(1000),
    value: draftSchema.nullable(),
    expectedRevision: z.string().uuid().nullable().optional(),
  }),
  z.object({ type: z.literal('pair'), url: z.string().max(12000) }),
  z.object({ type: z.literal('select'), threadId: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('send'),
    threadId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(100000),
    commandId: z.string().uuid(),
    messageId: z.string().uuid(),
  }),
  z.object({ type: z.literal('stop'), threadId: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('respond'),
    threadId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    decision: z
      .enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'])
      .optional(),
    answers: z
      .record(
        z.string().max(200),
        z.union([z.string().max(16000), z.array(z.string().max(2000)).max(50)]),
      )
      .optional(),
  }),
  z.object({ type: z.literal('silent'), value: z.boolean() }),
  z.object({ type: z.literal('watch'), threadId: z.string().min(1).max(200), value: z.boolean() }),
  z.object({
    type: z.literal('theme'),
    value: z.object({
      id: z.string().max(200),
      appearance: z.enum(['system', 'light', 'dark']),
      imported: z
        .object({
          id: z.string().max(200),
          name: z.string().max(100),
          appearance: z.enum(['light', 'dark']),
          colors: z.record(z.string().max(80), z.string().max(100)),
          variants: z
            .object({
              light: z.record(z.string().max(80), z.string().max(100)).optional(),
              dark: z.record(z.string().max(80), z.string().max(100)).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  }),
  z.object({ type: z.literal('reconnect') }),
  z.object({ type: z.literal('disconnect') }),
]);

let state: PanelState = structuredClone(initialState);
let client: T3Client | null = null;
let saved: SavedConnection | null = null;
let ledger: NotificationLedger = { seen: [] };
let unsubscribeDetail: (() => void) | null = null;
let teardown: Array<() => void> = [];
const ports = new Set<chrome.runtime.Port>();
const visibleChatPorts = new Set<chrome.runtime.Port>();
const inFlight = new Set<string>();
let connectionGeneration = 0;
let firstShell = true;

function broadcast() {
  for (const port of ports) {
    try {
      port.postMessage(state);
    } catch {
      ports.delete(port);
    }
  }
}
function failure(error: unknown): string {
  return error instanceof T3AdapterError
    ? error.message
    : 'That action could not complete. Check the connection and try again.';
}
async function persistPreferences() {
  await chrome.storage.local.set({ preferences: state.preferences });
}
function clearClient() {
  unsubscribeDetail?.();
  unsubscribeDetail = null;
  for (const dispose of teardown) dispose();
  teardown = [];
  client?.disconnect();
  client = null;
}
function select(threadId: string) {
  if (!client || !state.threads.some((t) => t.id === threadId && !t.archived))
    throw new Error('Unknown session');
  unsubscribeDetail?.();
  state = { ...state, selectedId: threadId, detail: null, error: null };
  void chrome.storage.local.set({ selectedId: threadId });
  unsubscribeDetail = client.onThread(threadId, (detail) => {
    if (state.selectedId !== detail.thread.id) return;
    const responses = { ...state.responses };
    for (const key of Object.keys(responses)) {
      const [environmentId, threadId, requestId] = JSON.parse(key);
      if (
        environmentId === state.connection?.environmentId &&
        threadId === detail.thread.id &&
        !detail.requests.some((item) => item.id === requestId)
      )
        delete responses[key];
    }
    state = { ...state, detail, responses };
    void chrome.storage.local.set({ responses });
    broadcast();
  });
  broadcast();
}
// All draft writes pass through one queue so checking a revision and replacing it is atomic across extension views.
let draftQueue: Promise<unknown> = Promise.resolve();
function writeDraft(data: {
  key: string;
  value: z.infer<typeof draftSchema> | null;
  expectedRevision?: string | null;
}): Promise<DraftWrite> {
  const result = draftQueue.then(async () => {
    const storage = await chrome.storage.local.get(data.key);
    const current = draftSchema.safeParse(storage[data.key]).data ?? null;
    if (
      data.expectedRevision !== undefined &&
      (current?.revision ?? null) !== data.expectedRevision
    )
      return { applied: false, value: current };
    if (data.value) await chrome.storage.local.set({ [data.key]: data.value });
    else await chrome.storage.local.remove(data.key);
    return { applied: true, value: data.value };
  });
  draftQueue = result.catch(() => {});
  return result;
}
let attentionQueue: Promise<void> = Promise.resolve();
async function attention(suppressNewNotifications = false) {
  const activeClient = client,
    generation = connectionGeneration;
  if (!activeClient) return;
  const pending = [];
  for (const thread of state.threads.filter(
    (t) =>
      !t.archived &&
      state.preferences.watched.includes(t.id) &&
      (t.hasPendingApproval || t.hasPendingQuestion),
  )) {
    const detail = await activeClient.readThread(thread.id);
    for (const item of detail.requests) pending.push({ threadId: thread.id, requestId: item.id });
  }
  if (generation !== connectionGeneration) return;
  const result = decideNotifications(ledger, pending, {
    silent: state.preferences.silent,
    baseline: firstShell || suppressNewNotifications,
    watched: state.preferences.watched,
    ...(visibleChatPorts.size && state.selectedId ? { activeThreadId: state.selectedId } : {}),
  });
  firstShell = false;
  ledger = result.ledger;
  await chrome.storage.local.set({ notificationLedger: ledger });
  const count = pending.filter((t) => state.preferences.watched.includes(t.threadId)).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b46b32' });
  if (!(await chrome.permissions.contains({ permissions: ['notifications'] }))) return;
  const notices = await chrome.notifications.getAll();
  const activeNotices = new Set(pending.map((item) => `attention:${item.threadId}`));
  await Promise.all(
    Object.keys(notices)
      .filter((id) => !activeNotices.has(id) || state.preferences.silent)
      .map((id) => chrome.notifications.clear(id)),
  );
  if (state.preferences.silent) return;
  for (const item of result.notify) {
    // Deliberately keep private conversation text off the OS lock screen.
    if (state.preferences.silent) break;
    await chrome.notifications.create(`attention:${item.threadId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Outrigger · Your input is needed',
      message: 'A watched T3 Code session is waiting for you.',
      silent: true,
    });
  }
}
function attach(next: T3Client) {
  client = next;
  firstShell = true;
  state = {
    ...state,
    connection: next.getConnection(),
    status: next.getStatus(),
    error: null,
    themes: next.getThemes(),
  };
  teardown = [
    next.onStatus((status) => {
      state = { ...state, status };
      broadcast();
    }),
    next.onTheme((themes) => {
      state = { ...state, themes };
      broadcast();
    }),
    next.onThreads((threads) => {
      state = { ...state, threads };
      const selected = threads.find((t) => t.id === state.selectedId && !t.archived);
      if (!selected && state.selectedId) {
        unsubscribeDetail?.();
        unsubscribeDetail = null;
        state = { ...state, selectedId: null, detail: null };
      }
      broadcast();
      attentionQueue = attentionQueue
        .then(() => attention())
        .catch(() => {
          /* Retry on the next authoritative snapshot. */
        });
    }),
  ];
  state = { ...state, threads: next.getThreads() };
  if (state.selectedId && state.threads.some((t) => t.id === state.selectedId && !t.archived))
    select(state.selectedId);
  broadcast();
}
async function connect(pairingUrl?: string) {
  const generation = ++connectionGeneration;
  clearClient();
  state = { ...state, status: { state: 'connecting' }, detail: null, error: null };
  broadcast();
  try {
    const next = pairingUrl
      ? await T3Client.pair(pairingUrl)
      : saved
        ? await T3Client.resume(saved)
        : null;
    if (generation !== connectionGeneration) {
      next?.disconnect();
      return;
    }
    if (!next) {
      state = structuredClone(initialState);
      broadcast();
      return;
    }
    const credential = next.getSavedConnection();
    if (state.connection?.environmentId !== credential.environmentId) {
      state = {
        ...state,
        selectedId: null,
        threads: [],
        preferences: { ...state.preferences, watched: [] },
      };
      ledger = { seen: [] };
    }
    saved = credential;
    await chrome.storage.local.set({ connection: credential, preferences: state.preferences });
    attach(next);
  } catch (error) {
    if (generation !== connectionGeneration) return;
    state = {
      ...state,
      status: {
        state:
          error instanceof T3AdapterError && error.kind === 'unsupported'
            ? 'unsupported'
            : 'disconnected',
        message: failure(error),
      },
    };
    broadcast();
    throw error;
  }
}

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  const storage = await chrome.storage.local.get([
    'connection',
    'preferences',
    'selectedId',
    'notificationLedger',
    'responses',
  ]);
  if (storage.preferences)
    state.preferences = { ...initialState.preferences, ...storage.preferences };
  if (typeof storage.selectedId === 'string') state.selectedId = storage.selectedId;
  const storedResponses = z
    .record(z.string(), z.enum(['unknown', 'accepted']))
    .safeParse(storage.responses);
  if (storedResponses.success)
    state.responses = Object.fromEntries(
      Object.entries(storedResponses.data).filter(([key]) => {
        try {
          return z.array(z.string()).length(3).safeParse(JSON.parse(key)).success;
        } catch {
          return false;
        }
      }),
    );
  const parsedLedger = z
    .object({ seen: z.array(z.string()).max(2000) })
    .safeParse(storage.notificationLedger);
  if (parsedLedger.success) ledger = parsedLedger.data;
  const parsedConnection = z
    .object({
      environmentId: z.string().min(1),
      label: z.string(),
      httpBaseUrl: z.string().url(),
      serverVersion: z.string(),
      protocolVersion: z.number(),
      accessToken: z.string().min(1),
      expiresAt: z.string(),
    })
    .safeParse(storage.connection);
  if (parsedConnection.success) {
    saved = parsedConnection.data;
    state.connection = {
      environmentId: saved!.environmentId,
      label: saved!.label,
      httpBaseUrl: saved!.httpBaseUrl,
      serverVersion: saved!.serverVersion,
      protocolVersion: saved!.protocolVersion,
    };
    await connect().catch(() => {});
  }
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
})();

// Handle the action explicitly so Chrome grants activeTab before opening the panel.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined)
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== 'panel' ||
    port.sender?.id !== chrome.runtime.id ||
    !port.sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return;
  ports.add(port);
  port.onMessage.addListener((message: unknown) => {
    const parsed = z
      .object({ type: z.literal('visibility'), active: z.boolean() })
      .safeParse(message);
    if (parsed.success) {
      parsed.data.active ? visibleChatPorts.add(port) : visibleChatPorts.delete(port);
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    visibleChatPorts.delete(port);
  });
  void ready.then(() => port.postMessage(state));
});
chrome.runtime.onMessage.addListener((input: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
    return false;
  void (async () => {
    await ready;
    const parsed = request.safeParse(input);
    if (!parsed.success) throw new Error('Invalid request');
    const data = parsed.data;
    if (data.type === 'snapshot') return state;
    if (data.type === 'draft') {
      if (!state.connection) throw new Error('No connection for this draft');
      return writeDraft(data);
    }
    if (data.type === 'pair') {
      await connect(data.url);
      return state;
    }
    if (data.type === 'reconnect') {
      await connect();
      return state;
    }
    if (data.type === 'disconnect') {
      ++connectionGeneration;
      clearClient();
      saved = null;
      ledger = { seen: [] };
      state = { ...state, connection: null };
      await draftQueue;
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((key) => key !== 'preferences'));
      state = {
        ...structuredClone(initialState),
        preferences: { ...state.preferences, watched: [] },
      };
      await persistPreferences();
      await chrome.action.setBadgeText({ text: '' });
      if (await chrome.permissions.contains({ permissions: ['notifications'] })) {
        const notices = await chrome.notifications.getAll();
        await Promise.all(Object.keys(notices).map((id) => chrome.notifications.clear(id)));
      }
      broadcast();
      return state;
    }
    if (data.type === 'select') {
      select(data.threadId);
      return state;
    }
    if (data.type === 'theme') {
      state = { ...state, preferences: { ...state.preferences, theme: data.value } };
      await persistPreferences();
      broadcast();
      return state;
    }
    if (data.type === 'silent') {
      state = { ...state, preferences: { ...state.preferences, silent: data.value } };
      await persistPreferences();
      if (data.value && (await chrome.permissions.contains({ permissions: ['notifications'] }))) {
        const notices = await chrome.notifications.getAll();
        await Promise.all(Object.keys(notices).map((id) => chrome.notifications.clear(id)));
      }
      broadcast();
      return state;
    }
    if (data.type === 'watch') {
      const watched = new Set(state.preferences.watched);
      data.value ? watched.add(data.threadId) : watched.delete(data.threadId);
      state = { ...state, preferences: { ...state.preferences, watched: [...watched] } };
      await persistPreferences();
      broadcast();
      attentionQueue = attentionQueue.then(() => attention(true)).catch(() => {});
      await attentionQueue;
      return state;
    }
    if (!client || state.status.state !== 'connected') throw new Error('Disconnected');
    const key = data.threadId;
    if (inFlight.has(key))
      throw new Error('An action for this session is still being acknowledged.');
    inFlight.add(key);
    state = { ...state, pending: true };
    broadcast();
    try {
      if (data.type === 'send') return await client.send(data);
      if (data.type === 'stop') return await client.stop(data);
      if (data.type === 'respond') {
        const key = responseKey(state.connection!.environmentId, data.threadId, data.requestId);
        if (state.responses[key])
          return {
            status: 'unknown',
            commandId: '',
            message: 'A response was already submitted. Review this request in T3 Code.',
          };
        state = { ...state, responses: { ...state.responses, [key]: 'unknown' } };
        await chrome.storage.local.set({ responses: state.responses });
        broadcast();
        const result = await client.respond(data);
        const responses = { ...state.responses };
        if (result.status === 'rejected') delete responses[key];
        else if (result.status === 'accepted' && key in responses) responses[key] = 'accepted';
        state = { ...state, responses };
        await chrome.storage.local.set({ responses });
        broadcast();
        return result;
      }
    } finally {
      inFlight.delete(key);
      state = { ...state, pending: inFlight.size > 0 };
      broadcast();
    }
  })().then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: failure(error) }),
  );
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect')
    void ready.then(() => {
      if (saved && state.status.state === 'disconnected') return connect().catch(() => {});
    });
});
let notificationListenerRegistered = false;
function registerNotificationListener() {
  if (notificationListenerRegistered || !chrome.notifications) return;
  notificationListenerRegistered = true;
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith('attention:')) return;
    void ready.then(async () => {
      const threadId = id.slice(10);
      if (state.threads.some((t) => t.id === threadId && !t.archived)) select(threadId);
      // Notification clicks do not consistently grant the sidePanel.open user gesture.
      // A dedicated extension tab is the reliable answer surface.
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL('sidepanel.html')}?thread=${encodeURIComponent(threadId)}`,
      });
      await chrome.notifications.clear(id);
    });
  });
}
registerNotificationListener();
chrome.permissions.onAdded.addListener(registerNotificationListener);
