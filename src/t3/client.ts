import { z } from 'zod';
import type {
  ApprovalDecision,
  CommandResult,
  ConnectionInfo,
  ConnectionStatus,
  DetailListener,
  Message,
  RuntimeRequest,
  SavedConnection,
  SendResult,
  StatusListener,
  Theme,
  ThemeListener,
  ThemeState,
  ThreadDetail,
  ThreadListener,
  ThreadSummary,
} from './types';

// The installed Alpha 0.0.44 uses orchestration protocol 1. A version 2
// descriptor is deliberately rejected until its different projection and
// command contracts have a separate adapter.
const PROTOCOL = 1;
const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const BOOTSTRAP_TOKEN = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const SCOPE = 'orchestration:read orchestration:operate';
// T3's branded entity IDs are trimmed nonempty strings, not UUIDs.
const id = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());
// v1's IsoDateTime contract is a string, including legacy imported timestamps.
const date = z.string().min(1);
const nonNegative = z.number().int().nonnegative();
const latestTurn = z.object({ turnId: id, state: z.string() }).nullable();
const session = z.object({ status: z.string(), activeTurnId: id.nullable() }).nullable();
const shellThread = z.object({
  id,
  projectId: id,
  title: z.string(),
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']),
  updatedAt: date,
  archivedAt: date.nullish(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  latestTurn,
  session,
  hasPendingApprovals: z.boolean().optional(),
  hasPendingUserInput: z.boolean().optional(),
});
const project = z.object({ id, title: z.string().min(1) });
const shell = z.object({
  snapshotSequence: nonNegative,
  threads: z.array(shellThread),
  projects: z.array(project),
  updatedAt: date,
});
const message = z.object({
  id,
  role: z.enum(['user', 'assistant', 'system', 'reasoning']),
  text: z.string(),
  turnId: id.nullable(),
  streaming: z.boolean(),
  createdAt: date,
  updatedAt: date,
});
const activity = z.object({
  id,
  kind: z.string(),
  tone: z.string(),
  summary: z.string(),
  payload: z.unknown(),
  createdAt: date,
});
const detail = z.object({
  snapshotSequence: nonNegative,
  thread: shellThread.extend({ messages: z.array(message), activities: z.array(activity) }),
  page: z.object({ hasMore: z.boolean() }).optional(),
});
const descriptor = z.object({
  environmentId: id,
  label: z.string().min(1),
  serverVersion: z.string().min(1),
  orchestrationProtocolVersion: z.number().int(),
});
const tokenResult = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().positive(),
  scope: z.string(),
});
const ticketResult = z.object({ ticket: z.string().min(1), expiresAt: date });
const commandReceipt = z.object({ sequence: nonNegative });
const decision = z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']);
const approvalOption = z.object({
  decision,
  label: z.string().min(1),
  warning: z.string().optional(),
});
const requestKind = z.enum([
  'command',
  'file-read',
  'file-change',
  'mcp-elicitation',
  'permission',
]);
const questionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  value: z.string().optional(),
});
const question = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(questionOption),
  multiSelect: z.boolean().optional(),
  allowCustomAnswer: z.boolean().optional(),
  required: z.boolean().optional(),
});
const color = z
  .string()
  .max(64)
  .regex(/^(?:#[0-9a-fA-F]{3,8}|(?:oklch|hsl|rgb)a?\([^;{}]*\))$/);
const themeColors = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), color);
const publishedTheme = z.object({
  id: z.string().regex(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
  name: z.string().min(1).max(48),
  appearance: z.enum(['light', 'dark']),
  canvas: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .optional(),
  accent: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .optional(),
  colors: themeColors.optional(),
  variants: z.object({ light: themeColors.optional(), dark: themeColors.optional() }).optional(),
});
const importedTheme = publishedTheme
  .omit({ id: true })
  .extend({ id: publishedTheme.shape.id.optional() });
const rpcFrame = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Chunk'), requestId: nonNegative, values: z.array(z.unknown()) }),
  z.object({ _tag: z.literal('Exit'), requestId: nonNegative, exit: z.unknown() }),
  z.object({ _tag: z.literal('Defect'), defect: z.unknown() }),
  z.object({ _tag: z.literal('Ping') }),
  z.object({ _tag: z.literal('Pong') }),
]);

function normalizeQuestionAnswers(
  request: RuntimeRequest,
  answers: Record<string, unknown>,
): Record<string, unknown> | null {
  if (request.responseMode !== 'message') return answers;
  const normalized = { ...answers };
  for (const question of request.questions ?? []) {
    const value = answers[question.id];
    if (
      question.multiSelect &&
      Array.isArray(value) &&
      value.every((answer) => typeof answer === 'string')
    ) {
      // T3 v0.0.44 displays multi-select answers with comma separation, but its
      // message-mode decider accepts only strings for each question.
      normalized[question.id] = value.join(', ');
    }
    const answer = normalized[question.id];
    if (typeof answer !== 'string' || !answer.trim()) return null;
  }
  return normalized;
}

export class T3AdapterError extends Error {
  constructor(
    readonly kind: 'invalid' | 'unauthorized' | 'unavailable' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'T3AdapterError';
  }
}

function decode<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new T3AdapterError('invalid', `T3 returned invalid ${label}.`);
  return parsed.data;
}

function endpoint(base: string, path: string): string {
  return new URL(path, `${base}/`).toString();
}

function parsePairingUrl(value: string): { base: string; credential: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new T3AdapterError('invalid', 'Enter a valid T3 pairing URL.');
  }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password) {
    throw new T3AdapterError('invalid', 'The T3 pairing URL has an unsupported address.');
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const credential = fragment.get('token') ?? url.searchParams.get('token');
  if (!credential) throw new T3AdapterError('invalid', 'The T3 pairing URL has no token.');
  // Hosted app.t3.codes links carry the machine URL in `host`.
  const host = url.searchParams.get('host');
  let target: URL;
  try {
    const normalizedHost = host?.trim().replace(/^\/+/, '');
    target = normalizedHost
      ? new URL(
          /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(normalizedHost)
            ? normalizedHost
            : `https://${normalizedHost}`,
        )
      : new URL(url);
  } catch {
    throw new T3AdapterError('invalid', 'The pairing host is invalid.');
  }
  if (target.protocol === 'wss:') target.protocol = 'https:';
  if (target.protocol === 'ws:') target.protocol = 'http:';
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
    throw new T3AdapterError('invalid', 'The pairing host is unsupported.');
  }
  if (
    target.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  ) {
    throw new T3AdapterError('invalid', 'Pairing requires HTTPS or a loopback host.');
  }
  return { base: target.origin, credential };
}

export function pairingOrigin(value: string): string {
  return parsePairingUrl(value).base;
}

async function readJson(url: string, init: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: abort.signal,
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) {
      const kind =
        response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable';
      throw new T3AdapterError(kind, `T3 request failed (${response.status}).`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof T3AdapterError) throw error;
    throw new T3AdapterError('unavailable', 'T3 is unreachable or returned invalid data.');
  } finally {
    clearTimeout(timer);
  }
}

function normalizeThread(
  raw: z.infer<typeof shellThread>,
  projectTitle: string | null,
): ThreadSummary {
  return {
    id: raw.id,
    projectId: raw.projectId,
    projectTitle,
    title: raw.title,
    branch: raw.branch ?? null,
    worktreePath: raw.worktreePath ?? null,
    status: raw.session?.status ?? raw.latestTurn?.state ?? 'idle',
    activeRunId: raw.session?.activeTurnId ?? null,
    runtimeMode: raw.runtimeMode,
    interactionMode: raw.interactionMode,
    updatedAt: raw.updatedAt,
    archived: raw.archivedAt != null,
    latestMessage: null,
    pendingRequestId: null,
    hasPendingApproval: raw.hasPendingApprovals ?? false,
    hasPendingQuestion: raw.hasPendingUserInput ?? false,
  };
}

function normalizeRequests(activities: z.infer<typeof activity>[]): RuntimeRequest[] {
  const open = new Map<string, RuntimeRequest & { createdAt: string }>();
  const closed = new Set<string>();
  for (const item of activities) {
    if (typeof item.payload !== 'object' || item.payload === null || Array.isArray(item.payload))
      continue;
    const payload = item.payload as Record<string, unknown>;
    const requestId = id.safeParse(payload.requestId);
    if (!requestId.success) continue;
    const key = `${item.kind.startsWith('user-input') || item.kind.includes('user-input') ? 'question' : 'approval'}:${requestId.data}`;
    if (item.kind === 'approval.resolved' || item.kind === 'user-input.resolved') {
      closed.add(key);
      open.delete(key);
      continue;
    }
    if (
      item.kind === 'provider.approval.respond.failed' ||
      item.kind === 'provider.user-input.respond.failed'
    ) {
      const failure = typeof payload.detail === 'string' ? payload.detail.toLowerCase() : '';
      if (failure.includes('stale pending') || failure.includes('unknown pending')) {
        closed.add(key);
        open.delete(key);
      }
      continue;
    }
    if (closed.has(key)) continue;
    if (item.kind === 'approval.requested') {
      if (
        payload.requestType === 'tool_user_input' ||
        payload.requestType === 'auth_tokens_refresh'
      )
        continue;
      const options = z.array(approvalOption).safeParse(payload.options);
      const visibleOptions = options.success
        ? options.data.filter((option) => option.decision !== 'acceptAlways')
        : [];
      const choices: ApprovalDecision[] =
        options.success && options.data.length > 0
          ? visibleOptions.map((option) => option.decision)
          : ['accept', 'decline'];
      const kind = requestKind.safeParse(payload.requestKind);
      const requestTypeKind: RuntimeRequest['requestKind'] =
        payload.requestType === 'file_read_approval'
          ? 'file-read'
          : payload.requestType === 'file_change_approval' ||
              payload.requestType === 'apply_patch_approval'
            ? 'file-change'
            : payload.requestType === 'mcp_elicitation_approval'
              ? 'mcp-elicitation'
              : payload.requestType === 'permission_approval'
                ? 'permission'
                : 'command';
      open.set(key, {
        id: requestId.data,
        kind: 'approval',
        requestKind: kind.success ? kind.data : requestTypeKind,
        responseMode: 'live',
        title: item.summary,
        choices,
        ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
        ...(typeof payload.command === 'string' ? { command: payload.command } : {}),
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
        ...(typeof payload.appName === 'string' ? { appName: payload.appName } : {}),
        ...(visibleOptions.length > 0 ? { options: visibleOptions } : {}),
        createdAt: item.createdAt,
      });
    } else if (item.kind === 'user-input.requested') {
      const parsed = z.array(question).safeParse(payload.questions);
      if (!parsed.success || parsed.data.length === 0) continue;
      open.set(key, {
        id: requestId.data,
        kind: 'question',
        responseMode: payload.responseMode === 'message' ? 'message' : 'live',
        title: item.summary,
        questions: parsed.data.map((entry) => ({
          id: entry.id,
          header: entry.header,
          question: entry.question,
          options: entry.options.map((option) => ({
            label: option.label,
            description: option.description ?? '',
            ...(option.value === undefined ? {} : { value: option.value }),
          })),
          multiSelect: entry.multiSelect ?? false,
          allowCustomAnswer: entry.allowCustomAnswer ?? true,
          required: entry.required ?? true,
        })),
        createdAt: item.createdAt,
      });
    }
  }
  return [...open.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ createdAt: _createdAt, ...request }) => request);
}

function normalizeDetail(raw: z.infer<typeof detail>, projectTitle: string | null): ThreadDetail {
  const thread = normalizeThread(raw.thread, projectTitle);
  const messages: Message[] = raw.thread.messages
    .filter((entry) => entry.role !== 'reasoning')
    .map((entry) => ({
      id: entry.id,
      threadId: thread.id,
      runId: entry.turnId,
      role: entry.role as Message['role'],
      text: entry.text,
      streaming: entry.streaming,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  const last = messages.at(-1);
  const requests = normalizeRequests(raw.thread.activities);
  return {
    thread: {
      ...thread,
      latestMessage: last
        ? { id: last.id, role: last.role, text: last.text, updatedAt: last.updatedAt }
        : null,
      pendingRequestId: requests[0]?.id ?? null,
      hasPendingApproval: requests.some((item) => item.kind === 'approval'),
      hasPendingQuestion: requests.some((item) => item.kind === 'question'),
    },
    messages,
    requests,
    sequence: raw.snapshotSequence,
    hasMoreHistory: raw.page?.hasMore ?? false,
  };
}

type Unsubscribe = () => void;

export class T3Client {
  private status: ConnectionStatus = { state: 'connecting' };
  private threads: ThreadSummary[] = [];
  private projectTitles = new Map<string, string>();
  private thread: ThreadDetail | null = null;
  private selectedThreadId: string | null = null;
  private theme: ThemeState = { environmentDefaultId: null, selectedId: null, themes: [] };
  private socket: WebSocket | null = null;
  private socketConnecting = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private sequence = 0;
  private requestId = 0;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly threadListeners = new Set<ThreadListener>();
  private readonly detailListeners = new Set<DetailListener>();
  private readonly themeListeners = new Set<ThemeListener>();

  private constructor(private readonly saved: SavedConnection) {}

  static async pair(pairingUrl: string): Promise<T3Client> {
    const { base, credential } = parsePairingUrl(pairingUrl);
    const info = decode(
      descriptor,
      await readJson(endpoint(base, '/.well-known/t3/environment'), {}),
      'environment details',
    );
    if (info.orchestrationProtocolVersion !== PROTOCOL) {
      throw new T3AdapterError(
        'unsupported',
        `T3 protocol ${info.orchestrationProtocolVersion} is unsupported by this companion.`,
      );
    }
    const form = new URLSearchParams({
      grant_type: GRANT,
      subject_token: credential,
      subject_token_type: BOOTSTRAP_TOKEN,
      requested_token_type: ACCESS_TOKEN,
      scope: SCOPE,
      client_label: 'T3 Browser Companion',
      client_device_type: 'desktop',
    });
    const access = decode(
      tokenResult,
      await readJson(endpoint(base, '/oauth/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      }),
      'token response',
    );
    const scopes = new Set(access.scope.split(/\s+/));
    if (!scopes.has('orchestration:read') || !scopes.has('orchestration:operate')) {
      throw new T3AdapterError(
        'unauthorized',
        'Pairing did not grant thread read and operate access.',
      );
    }
    return T3Client.resume({
      environmentId: info.environmentId,
      label: info.label,
      serverVersion: info.serverVersion,
      protocolVersion: PROTOCOL,
      httpBaseUrl: base,
      accessToken: access.access_token,
      expiresAt: new Date(Date.now() + access.expires_in * 1000).toISOString(),
    });
  }

  static async resume(saved: SavedConnection): Promise<T3Client> {
    if (
      saved.protocolVersion !== PROTOCOL ||
      !saved.accessToken ||
      !id.safeParse(saved.environmentId).success
    ) {
      throw new T3AdapterError('invalid', 'Saved T3 connection is invalid.');
    }
    let parsed: URL;
    try {
      parsed = new URL(saved.httpBaseUrl);
    } catch {
      throw new T3AdapterError('invalid', 'Saved T3 host is invalid.');
    }
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    ) {
      throw new T3AdapterError('invalid', 'Saved T3 host is invalid.');
    }
    if (
      !Number.isFinite(Date.parse(saved.expiresAt)) ||
      Date.parse(saved.expiresAt) <= Date.now()
    ) {
      throw new T3AdapterError('unauthorized', 'T3 authorization expired. Pair again.');
    }
    const info = decode(
      descriptor,
      await readJson(endpoint(saved.httpBaseUrl, '/.well-known/t3/environment'), {}),
      'environment details',
    );
    if (
      info.environmentId !== saved.environmentId ||
      info.orchestrationProtocolVersion !== PROTOCOL
    ) {
      throw new T3AdapterError(
        'unsupported',
        'The saved connection points to a different or unsupported T3 server.',
      );
    }
    const client = new T3Client({ ...saved, label: info.label, serverVersion: info.serverVersion });
    await client.refreshThreads();
    void client.openSocket();
    return client;
  }

  getConnection(): ConnectionInfo {
    const { accessToken: _token, expiresAt: _expiry, ...info } = this.saved;
    return info;
  }
  getSavedConnection(): SavedConnection {
    return { ...this.saved };
  }
  getThreads(): ReadonlyArray<ThreadSummary> {
    return this.threads;
  }
  getThread(): ThreadDetail | null {
    return this.thread;
  }
  async readThread(threadId: string): Promise<ThreadDetail> {
    if (!id.safeParse(threadId).success)
      throw new T3AdapterError('invalid', 'Thread ID is invalid.');
    const raw = decode(
      detail,
      await readJson(
        endpoint(
          this.saved.httpBaseUrl,
          `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
        ),
        { headers: this.headers() },
      ),
      'thread details',
    );
    return normalizeDetail(raw, this.projectTitles.get(raw.thread.projectId) ?? null);
  }
  getThemes(): ThemeState {
    return this.theme;
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }
  onThreads(listener: ThreadListener): Unsubscribe {
    this.threadListeners.add(listener);
    listener(this.threads);
    return () => this.threadListeners.delete(listener);
  }
  onThread(threadId: string, listener: DetailListener): Unsubscribe {
    if (!id.safeParse(threadId).success)
      throw new T3AdapterError('invalid', 'Thread ID is invalid.');
    this.detailListeners.add(listener);
    if (this.selectedThreadId !== threadId) {
      this.selectedThreadId = threadId;
      this.thread = null;
      void this.refreshThread(threadId)
        .then(() => this.restartSocket())
        .catch(() =>
          this.setStatus({ state: 'disconnected', message: 'Cannot load this thread.' }),
        );
    } else if (this.thread) listener(this.thread);
    return () => {
      this.detailListeners.delete(listener);
      if (this.detailListeners.size === 0) {
        this.selectedThreadId = null;
        this.thread = null;
        this.restartSocket();
      }
    };
  }
  onTheme(listener: ThemeListener): Unsubscribe {
    this.themeListeners.add(listener);
    listener(this.theme);
    return () => this.themeListeners.delete(listener);
  }

  /** Client-only choice: T3's desktop theme selection is not shared server state. */
  selectTheme(idValue: string | null): void {
    if (
      idValue !== null &&
      !['system', 'light', 'dark'].includes(idValue) &&
      !this.theme.themes.some((theme) => theme.id === idValue)
    )
      throw new T3AdapterError('invalid', 'Theme is unavailable.');
    this.theme = { ...this.theme, selectedId: idValue };
    this.emitTheme();
  }
  importTheme(value: unknown): Theme {
    const parsed = decode(importedTheme, value, 'theme data');
    const generatedId = `client-${
      parsed.name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'theme'
    }`;
    const theme: Theme = {
      id: parsed.id ?? generatedId,
      name: parsed.name,
      appearance: parsed.appearance,
      source: 'client',
      colors: {
        ...parsed.colors,
        ...(parsed.canvas ? { canvas: parsed.canvas } : {}),
        ...(parsed.accent ? { accent: parsed.accent } : {}),
      },
      ...(parsed.variants?.light ? { light: parsed.variants.light } : {}),
      ...(parsed.variants?.dark ? { dark: parsed.variants.dark } : {}),
    };
    this.theme = {
      ...this.theme,
      themes: [...this.theme.themes.filter((item) => item.id !== theme.id), theme],
    };
    this.emitTheme();
    return theme;
  }

  async send(input: {
    threadId: string;
    text: string;
    commandId?: string;
    messageId?: string;
  }): Promise<SendResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    const messageId = input.messageId ?? crypto.randomUUID();
    if (
      !id.safeParse(input.threadId).success ||
      !id.safeParse(commandId).success ||
      !id.safeParse(messageId).success ||
      !input.text.trim() ||
      input.text.length > 120_000
    ) {
      return {
        commandId,
        messageId,
        status: 'rejected',
        message: 'Message or identifier is invalid.',
      };
    }
    const thread = this.threads.find((item) => item.id === input.threadId) ?? this.thread?.thread;
    if (!thread)
      return {
        commandId,
        messageId,
        status: 'rejected',
        message: 'Open a current thread before sending.',
      };
    const result = await this.dispatch({
      type: 'thread.turn.start',
      commandId,
      threadId: input.threadId,
      message: { messageId, role: 'user', text: input.text, attachments: [] },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    });
    return { ...result, messageId };
  }

  async stop(input: { threadId: string; commandId?: string }): Promise<CommandResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (!id.safeParse(input.threadId).success || !id.safeParse(commandId).success)
      return { commandId, status: 'rejected', message: 'Identifier is invalid.' };
    return this.dispatch({
      type: 'thread.turn.interrupt',
      commandId,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
    });
  }

  async respond(input: {
    threadId: string;
    requestId: string;
    decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
    answers?: Record<string, unknown>;
    commandId?: string;
  }): Promise<CommandResult> {
    const commandId = input.commandId ?? crypto.randomUUID();
    if (
      !id.safeParse(input.threadId).success ||
      !id.safeParse(input.requestId).success ||
      !id.safeParse(commandId).success ||
      (input.decision === undefined) === (input.answers === undefined)
    ) {
      return { commandId, status: 'rejected', message: 'Response is invalid.' };
    }
    const request =
      this.thread?.thread.id === input.threadId
        ? this.thread.requests.find((item) => item.id === input.requestId)
        : undefined;
    if (
      !request ||
      request.responseMode === 'unavailable' ||
      (input.decision !== undefined &&
        (request.kind !== 'approval' || !request.choices?.includes(input.decision))) ||
      (input.answers !== undefined && request.kind !== 'question')
    ) {
      return {
        commandId,
        status: 'rejected',
        message: 'This request is not currently answerable.',
      };
    }
    const answers =
      input.answers === undefined ? undefined : normalizeQuestionAnswers(request, input.answers);
    if (answers === null)
      return { commandId, status: 'rejected', message: 'Answer each question before sending.' };
    return this.dispatch({
      type: input.decision === undefined ? 'thread.user-input.respond' : 'thread.approval.respond',
      commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.decision === undefined ? { answers } : { decision: input.decision }),
      createdAt: new Date().toISOString(),
    });
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setStatus({ state: 'disconnected', message: 'Disconnected.' });
  }

  private async dispatch(
    command: Record<string, unknown> & { commandId: string },
  ): Promise<CommandResult> {
    // A network error or server error may occur after the server commits the command.
    // Preserve the ID for reconciliation, and never retry here.
    try {
      const response = await fetch(
        endpoint(this.saved.httpBaseUrl, '/api/orchestration/dispatch'),
        {
          method: 'POST',
          cache: 'no-store',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.saved.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        },
      );
      if (response.status === 401 || response.status === 403) {
        this.closed = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.clearHeartbeat();
        this.socket?.close();
        this.socket = null;
        const message = 'T3 authorization expired or lost permission. Pair again.';
        this.setStatus({ state: 'disconnected', message });
        return { commandId: command.commandId, status: 'rejected', message };
      }
      if (response.status >= 400 && response.status < 500)
        return {
          commandId: command.commandId,
          status: 'rejected',
          message: `T3 rejected the command (${response.status}).`,
        };
      if (!response.ok)
        return {
          commandId: command.commandId,
          status: 'unknown',
          message:
            'Command acknowledgement was lost. Check the thread before deciding whether to send again.',
        };
      decode(commandReceipt, await response.json(), 'command receipt');
      if (this.selectedThreadId !== null && this.selectedThreadId === command.threadId)
        this.refreshThreadInBackground(this.selectedThreadId);
      this.refreshThreadsInBackground();
      return { commandId: command.commandId, status: 'accepted' };
    } catch {
      return {
        commandId: command.commandId,
        status: 'unknown',
        message:
          'Command acknowledgement was lost. Check the thread before deciding whether to send again.',
      };
    }
  }

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.saved.accessToken}` };
  }
  private async refreshThreads(): Promise<void> {
    const raw = decode(
      shell,
      await readJson(endpoint(this.saved.httpBaseUrl, '/api/orchestration/shell'), {
        headers: this.headers(),
      }),
      'thread list',
    );
    if (raw.snapshotSequence < this.sequence) return;
    this.sequence = raw.snapshotSequence;
    this.projectTitles = new Map(raw.projects.map((project) => [project.id, project.title]));
    this.threads = raw.threads.map((thread) =>
      normalizeThread(thread, this.projectTitles.get(thread.projectId) ?? null),
    );
    for (const listener of this.threadListeners) listener(this.threads);
  }
  private async refreshThread(threadId: string): Promise<void> {
    const loaded = await this.readThread(threadId);
    if (
      this.selectedThreadId !== threadId ||
      (this.thread?.thread.id === threadId && loaded.sequence < this.thread.sequence)
    )
      return;
    this.thread = loaded;
    for (const listener of this.detailListeners) listener(this.thread);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
  private emitTheme(): void {
    for (const listener of this.themeListeners) listener(this.theme);
  }
  private restartSocket(): void {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
    void this.openSocket();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.missedPongs = 0;
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    // Effect RPC uses JSON control frames. Traffic under Chrome's 30-second
    // service-worker idle window also keeps live thread subscriptions awake.
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) return;
      if (this.missedPongs >= 3) {
        socket.close();
        return;
      }
      try {
        socket.send(JSON.stringify({ _tag: 'Ping' }));
        this.missedPongs += 1;
      } catch {
        socket.close();
      }
    }, 20_000);
  }

  private handleRefreshFailure(error: unknown): void {
    if (this.closed) return;
    if (error instanceof T3AdapterError && error.kind === 'invalid') {
      this.setStatus({ state: 'unsupported', message: 'T3 returned invalid thread data.' });
    } else if (error instanceof T3AdapterError && error.kind === 'unauthorized') {
      this.setStatus({ state: 'disconnected', message: 'T3 authorization expired. Pair again.' });
    }
    this.socket?.close();
  }
  private refreshThreadsInBackground(): void {
    void this.refreshThreads().catch((error: unknown) => this.handleRefreshFailure(error));
  }
  private refreshThreadInBackground(threadId: string): void {
    void this.refreshThread(threadId).catch((error: unknown) => this.handleRefreshFailure(error));
  }

  private async openSocket(): Promise<void> {
    if (this.closed || this.socket || this.socketConnecting) return;
    this.socketConnecting = true;
    try {
      const ticket = decode(
        ticketResult,
        await readJson(endpoint(this.saved.httpBaseUrl, '/api/auth/websocket-ticket'), {
          method: 'POST',
          headers: this.headers(),
        }),
        'WebSocket ticket',
      );
      if (this.closed) return;
      const url = new URL(this.saved.httpBaseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws';
      url.search = '';
      url.searchParams.set('orchestrationProtocol', String(PROTOCOL));
      url.searchParams.set('wsTicket', ticket.ticket);
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket || this.closed) return;
        this.setStatus({ state: 'connected' });
        this.request(socket, 'orchestration.subscribeShell', { afterSequence: this.sequence });
        if (this.selectedThreadId && this.thread)
          this.request(socket, 'orchestration.subscribeThread', {
            threadId: this.selectedThreadId,
            afterSequence: this.thread.sequence,
          });
        this.request(socket, 'subscribeServerConfig', { environmentThemes: true });
        this.startHeartbeat(socket);
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.closed) return;
        try {
          this.receive(decode(rpcFrame, JSON.parse(String(event.data)), 'protocol frame'));
        } catch {
          socket.close();
          this.setStatus({ state: 'unsupported', message: 'T3 sent an invalid protocol frame.' });
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket || this.closed) return;
        this.clearHeartbeat();
        this.socket = null;
        if (this.status.state === 'unsupported' || this.status.state === 'disconnected') return;
        this.setStatus({ state: 'reconnecting' });
        this.reconnectTimer = setTimeout(() => {
          void this.reconnect();
        }, 1500);
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (this.closed) return;
      if (error instanceof T3AdapterError && error.kind === 'unauthorized') {
        this.setStatus({ state: 'disconnected', message: 'T3 authorization expired. Pair again.' });
        return;
      }
      this.setStatus({ state: 'reconnecting' });
      this.reconnectTimer = setTimeout(() => {
        void this.reconnect();
      }, 1500);
    } finally {
      this.socketConnecting = false;
    }
  }

  private request(socket: WebSocket, tag: string, payload: object): void {
    socket.send(JSON.stringify({ _tag: 'Request', id: ++this.requestId, tag, payload }));
  }

  private receive(frame: z.infer<typeof rpcFrame>): void {
    if (frame._tag === 'Pong') {
      this.missedPongs = 0;
      return;
    }
    if (frame._tag === 'Ping') {
      this.socket?.send(JSON.stringify({ _tag: 'Pong' }));
      return;
    }
    if (frame._tag === 'Defect') {
      this.socket?.close();
      return;
    }
    if (frame._tag === 'Exit') {
      const exit = decode(z.object({ _tag: z.string() }), frame.exit, 'protocol response');
      // An ended subscription no longer observes changes, even on success.
      this.socket?.close();
      return;
    }
    for (const value of frame.values) {
      const item = z.object({ kind: z.string() }).safeParse(value);
      if (item.success) {
        if (
          [
            'snapshot',
            'thread-upserted',
            'thread-removed',
            'project-upserted',
            'project-removed',
          ].includes(item.data.kind)
        )
          this.refreshThreadsInBackground();
        if ((item.data.kind === 'event' || item.data.kind === 'snapshot') && this.selectedThreadId)
          this.refreshThreadInBackground(this.selectedThreadId);
        continue;
      }
      const config = z
        .object({
          version: z.literal(1),
          type: z.string(),
          payload: z.unknown().optional(),
          config: z.unknown().optional(),
        })
        .safeParse(value);
      if (!config.success) throw new T3AdapterError('unsupported', 'Invalid T3 stream item.');
      this.receiveConfig(config.data);
    }
  }

  private receiveConfig(event: { type: string; payload?: unknown; config?: unknown }): void {
    if (event.type === 'snapshot' && event.config) {
      const parsed = decode(
        z.object({
          settings: z.object({ defaultTheme: z.string().optional() }).optional(),
          environment: z
            .object({ capabilities: z.object({ environmentThemes: z.boolean().optional() }) })
            .optional(),
        }),
        event.config,
        'theme settings',
      );
      const environmentDefaultId = parsed.settings?.defaultTheme || null;
      this.theme = {
        ...this.theme,
        environmentDefaultId,
        themes:
          parsed.environment?.capabilities.environmentThemes === false
            ? this.theme.themes.filter((item) => item.source === 'client')
            : this.theme.themes,
      };
      this.emitTheme();
    } else if (event.type === 'settingsUpdated') {
      const parsed = decode(
        z.object({ settings: z.object({ defaultTheme: z.string().optional() }) }),
        event.payload,
        'theme settings',
      );
      this.theme = { ...this.theme, environmentDefaultId: parsed.settings.defaultTheme || null };
      this.emitTheme();
    } else if (event.type === 'environmentThemesUpdated') {
      const parsed = decode(
        z.object({ themes: z.array(publishedTheme) }),
        event.payload,
        'published themes',
      );
      const clientThemes = this.theme.themes.filter((item) => item.source === 'client');
      const themes: Theme[] = parsed.themes.map((entry) => ({
        id: entry.id,
        name: entry.name,
        appearance: entry.appearance,
        source: 'environment',
        colors: {
          ...entry.colors,
          ...(entry.canvas ? { canvas: entry.canvas } : {}),
          ...(entry.accent ? { accent: entry.accent } : {}),
        },
        ...(entry.variants?.light ? { light: entry.variants.light } : {}),
        ...(entry.variants?.dark ? { dark: entry.variants.dark } : {}),
      }));
      this.theme = { ...this.theme, themes: [...themes, ...clientThemes] };
      this.emitTheme();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    try {
      await this.refreshThreads();
      if (this.selectedThreadId) await this.refreshThread(this.selectedThreadId);
      await this.openSocket();
    } catch (error) {
      if (error instanceof T3AdapterError && error.kind === 'unauthorized') {
        this.setStatus({ state: 'disconnected', message: 'T3 authorization expired. Pair again.' });
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        void this.reconnect();
      }, 3000);
    }
  }
}
