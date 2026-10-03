import { draftSchema, responseKey, type DraftWrite } from './core/drafts';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import {
  ArrowLeft,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  ExternalLink,
  Link,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Unplug,
  X,
} from 'lucide-react';
import { pairingOrigin } from './t3/client';
import type { CommandResult, RuntimeRequest, SendResult } from './t3/types';
import { initialState, type Draft, type PanelState } from './core/state';
import { applyPalette, builtInThemes, parseThemeFile, resolvePalette } from './core/theme';
import { composeMessage, draftKey, normalizeContext } from './core/context';
import './styles.css';

async function rpc<T = PanelState>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(response?.error ?? 'The extension restarted. Reopen this panel to reconnect.');
  return response.value as T;
}
function usePanel(view: 'sessions' | 'chat' | 'settings') {
  const [state, setState] = useState<PanelState>(initialState);
  useEffect(() => {
    let stopped = false;
    let port: chrome.runtime.Port;
    let timer: ReturnType<typeof setTimeout>;
    const visibility = () => {
      try {
        port?.postMessage({
          type: 'visibility',
          active: view === 'chat' && document.visibilityState === 'visible' && document.hasFocus(),
        });
      } catch {
        /* The reconnect will report visibility. */
      }
    };
    const connect = () => {
      if (stopped) return;
      port = chrome.runtime.connect({ name: 'panel' });
      port.onMessage.addListener((next: PanelState) => setState(next));
      visibility();
      port.onDisconnect.addListener(() => {
        if (!stopped) timer = setTimeout(connect, 500);
      });
    };
    connect();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', visibility);
    window.addEventListener('blur', visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      port?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', visibility);
      window.removeEventListener('blur', visibility);
    };
  }, [view]);
  return state;
}
function Mark({ large = false }: { large?: boolean }) {
  return (
    <span className={`mark ${large ? 'large' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path d="M8 7v18M16 10v12M24 7v18M8 16h16" />
      </svg>
    </span>
  );
}
function IconButton({
  label,
  onClick,
  children,
  pressed,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function App() {
  const [view, setView] = useState<'sessions' | 'chat' | 'settings'>('sessions');
  const state = usePanel(view);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [pairUrl, setPairUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft>({ text: '' });
  const [draftLoading, setDraftLoading] = useState(false);
  const [loadedDraftKey, setLoadedDraftKey] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const currentKey =
    state.connection && state.selectedId
      ? draftKey(state.connection.environmentId, state.selectedId)
      : null;
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const connected = state.status.state === 'connected';
  const selected = state.threads.find((t) => t.id === state.selectedId);
  const waiting = state.detail?.requests ?? [];

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    applyPalette(
      resolvePalette(
        {
          ...state.preferences.theme,
          id:
            state.preferences.theme.id === 'server'
              ? (state.themes.environmentDefaultId ?? 't3-code')
              : state.preferences.theme.id,
        },
        systemDark,
        state.themes.themes,
      ),
    );
  }, [state.preferences.theme, systemDark, state.themes]);
  useEffect(() => {
    let cancelled = false;
    setLoadedDraftKey(null);
    setComposerExpanded(false);
    setDraft({ text: '' });
    setDraftLoading(true);
    setNotice('');
    atBottom.current = true;
    if (!currentKey) {
      setDraftLoading(false);
      return;
    }
    void chrome.storage.local.get(currentKey).then((data) => {
      if (!cancelled) {
        setDraft(draftSchema.safeParse(data[currentKey]).data ?? { text: '' });
        setLoadedDraftKey(currentKey);
        setDraftLoading(false);
      }
    });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && currentKey in changes && !cancelled) {
        setDraft(draftSchema.safeParse(changes[currentKey]!.newValue).data ?? { text: '' });
        setLoadedDraftKey(currentKey);
        setDraftLoading(false);
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [currentKey]);
  useEffect(() => {
    if (atBottom.current && view === 'chat') endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.detail?.messages, view]);
  useEffect(() => {
    if (!state.selectedId && view === 'chat') setView('sessions');
  }, [state.selectedId, view]);

  useEffect(() => {
    const target = new URL(location.href).searchParams.get('thread');
    if (!target || !connected || !state.threads.some((thread) => thread.id === target)) return;
    history.replaceState(null, '', location.pathname);
    void rpc({ type: 'select', threadId: target })
      .then(() => setView('chat'))
      .catch(() => setNotice('Open this session from the session list.'));
  }, [connected, state.threads]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        view !== 'sessions' ||
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [view]);

  function updateDraft(next: Draft) {
    if (!currentKey || loadedDraftKey !== currentKey) return;
    const versioned = { ...next, revision: crypto.randomUUID() };
    setDraft(versioned);
    void rpc({ type: 'draft', key: currentKey, value: versioned }).catch(() =>
      setNotice('Your draft could not be saved. Keep this panel open.'),
    );
  }
  async function action(work: () => Promise<unknown>) {
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    }
  }
  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await action(async () => {
      const origin = pairingOrigin(pairUrl);
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error('Allow access to your T3 Code server to connect.');
      await rpc({ type: 'pair', url: pairUrl });
      setPairUrl('');
      setView('sessions');
    });
    setBusy(false);
  }
  async function toggleSilent() {
    await action(async () => {
      if (
        state.preferences.silent &&
        !(await chrome.permissions.request({ permissions: ['notifications'] }))
      )
        throw new Error('Notification permission was not granted. Silent mode is still on.');
      await rpc({ type: 'silent', value: !state.preferences.silent });
    });
  }
  async function openThread(threadId: string) {
    await action(async () => {
      await rpc({ type: 'select', threadId });
      setView('chat');
    });
  }
  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    if (
      !currentKey ||
      loadedDraftKey !== currentKey ||
      draftLoading ||
      !state.selectedId ||
      !draft.text.trim() ||
      draft.uncertain ||
      !connected ||
      busy ||
      state.pending
    )
      return;
    const key = currentKey,
      threadId = state.selectedId,
      outgoing = draft;
    setBusy(true);
    setNotice('');
    // A reload at any point after submission keeps an explicit uncertain draft.
    const marked = { ...outgoing, uncertain: true, revision: crypto.randomUUID() };
    try {
      const lock = await rpc<DraftWrite>({
        type: 'draft',
        key,
        value: marked,
        expectedRevision: outgoing.revision ?? null,
      });
      if (!lock.applied) {
        if (keyRef.current === key) setDraft(lock.value ?? { text: '' });
        setNotice('This draft changed in another panel. Review it before sending.');
        return;
      }
      if (keyRef.current === key) setDraft(marked);
      const result = await rpc<SendResult>({
        type: 'send',
        threadId,
        text: composeMessage(outgoing.text, outgoing.context),
        commandId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
      });
      if (result.status === 'accepted') {
        const clear = await rpc<DraftWrite>({
          type: 'draft',
          key,
          value: null,
          expectedRevision: marked.revision,
        });
        if (keyRef.current === key) {
          setDraft(clear.value ?? { text: '' });
          composer.current?.focus();
        }
      } else if (result.status === 'rejected') {
        const restore = await rpc<DraftWrite>({
          type: 'draft',
          key,
          value: outgoing,
          expectedRevision: marked.revision,
        });
        if (keyRef.current === key) setDraft(restore.value ?? { text: '' });
        setNotice(result.message ?? 'T3 Code did not accept this message. Your draft is saved.');
      } else
        setNotice(
          'Delivery is uncertain. Check this conversation in T3 Code before sending again.',
        );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Delivery is uncertain. Check T3 Code before sending again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function attachPage() {
    await action(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Open the web page you want to attach first.');
      let selection = '';
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.getSelection()?.toString().slice(0, 12000) ?? '',
        });
        selection = result[0]?.result ?? '';
      } catch {
        throw new Error(
          'Open Outrigger from its toolbar icon on a regular web page to attach it. Browser settings and restricted pages cannot be attached.',
        );
      }
      const context = normalizeContext({
        title: tab.title ?? 'Current page',
        url: tab.url ?? '',
        selection,
      });
      if (!context.url) throw new Error('This browser page cannot be attached.');
      updateDraft({ ...draft, context });
    });
  }
  async function openT3() {
    if (state.connection) await chrome.tabs.create({ url: state.connection.httpBaseUrl });
  }
  const silent = state.preferences.silent;
  const filtered = state.threads.filter(
    (t) =>
      !t.archived &&
      `${t.title} ${t.projectTitle ?? ''} ${t.branch ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const attentionCount = state.threads.filter(
    (t) => !t.archived && (t.hasPendingApproval || t.hasPendingQuestion),
  ).length;

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="wordmark"
          onClick={() => setView('sessions')}
          aria-label="Outrigger sessions"
        >
          <Mark />
          <span>
            Outrigger<span className="wordmark-sub">for T3 Code</span>
          </span>
        </button>
        <div className="header-actions">
          <IconButton
            label={
              silent
                ? 'Silent mode is on. Enable notifications'
                : 'Notifications are on. Enable silent mode'
            }
            pressed={silent}
            onClick={() => void toggleSilent()}
          >
            {silent ? <BellOff size={17} /> : <Bell size={17} />}
          </IconButton>
          <IconButton
            label="Settings"
            pressed={view === 'settings'}
            onClick={() => setView(view === 'settings' ? 'sessions' : 'settings')}
          >
            <Settings size={17} />
          </IconButton>
        </div>
      </header>
      {notice && (
        <div className="notice" role="alert">
          <span>{notice}</span>
          <IconButton label="Dismiss message" onClick={() => setNotice('')}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {!state.connection && view !== 'settings' ? (
        <main className="onboarding">
          <div className="onboarding-art">
            <Mark large />
            <span className="orbit orbit-one" />
            <span className="orbit orbit-two" />
          </div>
          <p className="eyebrow">KEEP YOUR PLACE</p>
          <h1>
            Same session.
            <br />A little more room.
          </h1>
          <p className="intro">
            Continue your T3 Code conversations while you browse. Your work stays in T3.
          </p>
          <form className="connect-form" onSubmit={pair}>
            <label htmlFor="pairing">T3 Code pairing link</label>
            <input
              id="pairing"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={pairUrl}
              onChange={(event) => setPairUrl(event.target.value)}
              placeholder="Paste your pairing link"
              required
            />
            <button className="primary full" disabled={busy || state.status.state === 'connecting'}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Link size={16} />}
              {busy ? 'Connecting…' : 'Connect to T3 Code'}
            </button>
          </form>
          <details className="setup-help">
            <summary>Where do I get a pairing link?</summary>
            <p>
              In T3 Code, open Settings → Connections and create a pairing link. Or run{' '}
              <code>t3 serve</code> and copy its connection link. Keep T3 Code running.
            </p>
            <p>
              Pair only with a server you trust. T3 grants access to its sessions. Outrigger stores
              the connection on this device.
            </p>
          </details>
          {(state.status.state === 'disconnected' || state.status.state === 'unsupported') &&
            state.status.message !== 'Connect to T3 Code to continue your sessions.' && (
              <p className="inline-error" role="alert">
                {state.status.message}
              </p>
            )}
          <div className="privacy-note">
            <ShieldCheck size={16} />
            <span>
              No account to create. No browsing history collected.
              <br />
              Notifications start in silent mode.
            </span>
          </div>
        </main>
      ) : view === 'settings' ? (
        <main className="settings scroll-area">
          <button
            className="back-link"
            onClick={() => setView(state.selectedId ? 'chat' : 'sessions')}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <h1>Make it feel like yours.</h1>
          <p className="muted">Your T3 palette. Your pace.</p>
          <section className="setting-section">
            <h2>Appearance</h2>
            <p>Use the exact T3 Code palettes, or import your custom theme.</p>
            <label htmlFor="theme">Theme</label>
            <select
              id="theme"
              value={state.preferences.theme.id}
              onChange={(event) =>
                void action(() =>
                  rpc({
                    type: 'theme',
                    value: { ...state.preferences.theme, id: event.target.value },
                  }),
                )
              }
            >
              <option value="server">Follow T3 server default</option>
              <option value="t3-code">T3 Code</option>
              {builtInThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
              {state.themes.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · server
                </option>
              ))}
              {state.preferences.theme.imported && (
                <option value="imported">{state.preferences.theme.imported.name} · imported</option>
              )}
            </select>
            <label htmlFor="appearance">Appearance</label>
            <select
              id="appearance"
              value={state.preferences.theme.appearance}
              onChange={(event) =>
                void action(() =>
                  rpc({
                    type: 'theme',
                    value: { ...state.preferences.theme, appearance: event.target.value },
                  }),
                )
              }
            >
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <label className="secondary file-button">
              Import T3 theme
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void action(async () => {
                    if (file.size > 100000)
                      throw new Error('Choose a theme file smaller than 100 KB.');
                    const imported = parseThemeFile(await file.text());
                    await rpc({
                      type: 'theme',
                      value: { id: 'imported', appearance: imported.appearance, imported },
                    });
                  });
                  event.target.value = '';
                }}
              />
            </label>
            <p className="hint">
              Export the theme from T3 Code’s Appearance settings. Desktop theme selections are
              local to T3, so choose or import that theme here once.
            </p>
          </section>
          <section className="setting-section">
            <h2>Attention, on your terms</h2>
            <button className="setting-row" onClick={() => void toggleSilent()}>
              <span>
                <strong>Silent mode</strong>
                <small>
                  {silent
                    ? 'No desktop notifications. Badges still work.'
                    : 'Notify when a watched session needs input.'}
                </small>
              </span>
              <span className={`toggle ${silent ? 'on' : ''}`} aria-hidden="true">
                <i />
              </span>
            </button>
            <p className="hint">
              Watch a session with its bell. Notifications contain no conversation text, and old
              questions won’t repeat when you reconnect.
            </p>
          </section>
          {state.connection && (
            <section className="setting-section">
              <h2>Connection</h2>
              <div className="connection-card">
                <span className={`status-dot ${connected ? 'online' : ''}`} />
                <span>
                  <strong>{state.connection.label}</strong>
                  <small>T3 Code {state.connection.serverVersion}</small>
                </span>
              </div>
              <button className="secondary full" onClick={() => void openT3()}>
                <ExternalLink size={15} /> Open T3 Code
              </button>
              <details className="repair-form">
                <summary>Pair again or connect another server</summary>
                <form className="connect-form" onSubmit={pair}>
                  <label htmlFor="repair-pairing">New T3 Code pairing link</label>
                  <input
                    id="repair-pairing"
                    type="password"
                    autoComplete="off"
                    value={pairUrl}
                    onChange={(event) => setPairUrl(event.target.value)}
                    required
                  />
                  <button className="secondary full" disabled={busy}>
                    {busy ? 'Connecting…' : 'Pair with this link'}
                  </button>
                  <p className="hint">Saved drafts stay with their original server and session.</p>
                </form>
              </details>
              <button
                className="text-button danger"
                onClick={() =>
                  void action(async () => {
                    await rpc({ type: 'disconnect' });
                    setView('sessions');
                  })
                }
              >
                <Unplug size={15} /> Disconnect and clear local drafts
              </button>
            </section>
          )}
          <p className="footer-note">Outrigger 0.1.0 · An independent companion for T3 Code.</p>
        </main>
      ) : (
        <>
          <div className={`connection-strip ${connected ? '' : 'offline'}`} role="status">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            <span>
              {connected
                ? state.connection?.label
                : state.status.state === 'connecting' || state.status.state === 'reconnecting'
                  ? 'Reconnecting to T3 Code…'
                  : 'T3 Code is disconnected'}
            </span>
            <span className="spacer" />
            {connected ? (
              <span>{silent ? 'Silent' : 'Needs you alerts'}</span>
            ) : (
              <button onClick={() => void action(() => rpc({ type: 'reconnect' }))}>
                Reconnect
              </button>
            )}
          </div>
          {!connected && (
            <div className="offline-note">
              {state.status.state === 'disconnected' || state.status.state === 'unsupported'
                ? state.status.message
                : 'Draft saved. Reconnect, then send when ready.'}
            </div>
          )}
          {view === 'sessions' ? (
            <main className="sessions">
              <div className="section-heading">
                <div>
                  <h1>
                    Sessions <span className="count">{filtered.length}</span>
                  </h1>
                </div>
                {attentionCount > 0 && (
                  <span className="attention-pill">
                    {attentionCount} {attentionCount === 1 ? 'needs' : 'need'} input
                  </span>
                )}
              </div>
              <label className="search-field">
                <Search size={16} />
                <input
                  ref={searchInput}
                  aria-label="Search sessions"
                  placeholder="Find a session…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd>/</kbd>
              </label>
              <div className="session-list scroll-area">
                {filtered.map((thread) => {
                  const needsInput = thread.hasPendingApproval || thread.hasPendingQuestion;
                  const watched = state.preferences.watched.includes(thread.id);
                  return (
                    <div
                      className={`session-row ${needsInput ? 'needs-input' : ''}`}
                      key={thread.id}
                    >
                      <button className="session-open" onClick={() => void openThread(thread.id)}>
                        <span
                          className={`session-indicator ${needsInput ? 'waiting' : thread.activeRunId ? 'working' : ''}`}
                        />
                        <span className="session-copy">
                          <strong>{thread.title || 'Untitled session'}</strong>
                          <span>
                            {thread.projectTitle ? `${thread.projectTitle} · ` : ''}
                            {needsInput
                              ? 'Waiting for your input'
                              : thread.activeRunId
                                ? 'Working'
                                : 'Ready to continue'}
                          </span>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                      <IconButton
                        label={watched ? `Stop watching ${thread.title}` : `Watch ${thread.title}`}
                        pressed={watched}
                        onClick={() =>
                          void action(() =>
                            rpc({ type: 'watch', threadId: thread.id, value: !watched }),
                          )
                        }
                      >
                        {watched ? <Bell size={15} /> : <BellOff size={15} />}
                      </IconButton>
                    </div>
                  );
                })}
                {!filtered.length && (
                  <div className="empty-state">
                    <MessageCircle size={28} />
                    <h2>{search ? 'No matching sessions' : 'A little quiet here.'}</h2>
                    <p>
                      {search
                        ? 'Try another title.'
                        : 'Start a session in T3 Code, then continue it here.'}
                    </p>
                    {!search && (
                      <button className="secondary" onClick={() => void openT3()}>
                        Open T3 Code <ExternalLink size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <footer className="list-footer">
                <button onClick={() => void openT3()}>
                  Open T3 <ExternalLink size={12} />
                </button>
              </footer>
            </main>
          ) : (
            <main
              className={`conversation ${waiting.length ? 'has-requests' : ''} ${composerExpanded ? 'composer-expanded' : ''}`}
            >
              <div className="thread-header">
                <IconButton label="Back to sessions" onClick={() => setView('sessions')}>
                  <ArrowLeft size={18} />
                </IconButton>
                <div>
                  <h1>{selected?.title ?? 'Session'}</h1>
                  <span title={selected?.worktreePath ?? undefined}>
                    {[selected?.projectTitle, selected?.branch].filter(Boolean).join(' · ') ||
                      (selected?.activeRunId
                        ? 'Working in T3 Code'
                        : waiting.length
                          ? 'Waiting for your input'
                          : 'Ready to continue')}
                  </span>
                </div>
                {selected && (
                  <IconButton
                    label={
                      state.preferences.watched.includes(selected.id)
                        ? 'Stop watching this session'
                        : 'Watch this session'
                    }
                    pressed={state.preferences.watched.includes(selected.id)}
                    onClick={() =>
                      void action(() =>
                        rpc({
                          type: 'watch',
                          threadId: selected.id,
                          value: !state.preferences.watched.includes(selected.id),
                        }),
                      )
                    }
                  >
                    <Bell size={16} />
                  </IconButton>
                )}
              </div>
              {waiting.length > 0 && (
                <button
                  className="needs-you-strip"
                  onClick={() =>
                    document
                      .querySelector('.request-card')
                      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                  }
                >
                  <span>
                    <span className="status-dot" /> {waiting.length}{' '}
                    {waiting.length === 1 ? 'request needs' : 'requests need'} you
                    {!connected ? ' · last known' : ''}
                  </span>
                  <span>
                    Review <ChevronRight size={13} />
                  </span>
                </button>
              )}
              <div
                className="messages scroll-area"
                ref={logRef}
                role="log"
                aria-label="Conversation"
                aria-live="off"
                onScroll={() => {
                  const el = logRef.current;
                  if (el) atBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
                }}
              >
                {!state.detail ? (
                  <div className="loading-state" role="status">
                    <LoaderCircle className="spin" size={20} /> Loading your conversation…
                  </div>
                ) : (
                  <>
                    {state.detail.hasMoreHistory && (
                      <button className="history-note" onClick={() => void openT3()}>
                        Showing recent messages. Full history in T3 Code <ExternalLink size={12} />
                      </button>
                    )}
                    {!state.detail.messages.length && (
                      <div className="empty-state compact">
                        <MessageCircle size={25} />
                        <h2>Pick up the conversation.</h2>
                        <p>Messages sent here continue this T3 Code session.</p>
                      </div>
                    )}
                    {state.detail.messages.map((message) => (
                      <article className={`message ${message.role}`} key={message.id}>
                        <div className="message-label">
                          {message.role === 'user'
                            ? 'You'
                            : message.role === 'assistant'
                              ? 'T3 Code'
                              : 'Session'}
                          {message.streaming && (
                            <span className="streaming-label">
                              <span className="status-dot online" /> Writing
                            </span>
                          )}
                        </div>
                        <div className="message-body">
                          {message.role === 'user' ? (
                            <p className="plain-message">{message.text}</p>
                          ) : (
                            <Markdown
                              components={{
                                img: () => <span className="muted">[Image · open in T3 Code]</span>,
                                a: ({ href, children }) =>
                                  href && /^https?:\/\//i.test(href) ? (
                                    <a href={href} target="_blank" rel="noreferrer noopener">
                                      {children}
                                    </a>
                                  ) : (
                                    <span>{children}</span>
                                  ),
                              }}
                            >
                              {message.text}
                            </Markdown>
                          )}
                        </div>
                      </article>
                    ))}
                    {waiting.map((item) => (
                      <RequestCard
                        key={item.id}
                        request={item}
                        sessionTitle={selected?.title ?? 'Current session'}
                        delivery={
                          state.connection && state.selectedId
                            ? state.responses[
                                responseKey(
                                  state.connection.environmentId,
                                  state.selectedId,
                                  item.id,
                                )
                              ]
                            : undefined
                        }
                        onOpenT3={() => void openT3()}
                        disabled={!connected || state.pending || busy}
                        onReply={async (value) => {
                          const result = await rpc<CommandResult>({
                            type: 'respond',
                            threadId: state.selectedId,
                            requestId: item.id,
                            ...value,
                          });
                          return result;
                        }}
                      />
                    ))}
                  </>
                )}
                <div ref={endRef} />
              </div>
              <button
                className="composer-collapsed"
                onClick={() => {
                  setComposerExpanded(true);
                  requestAnimationFrame(() => composer.current?.focus());
                }}
              >
                <span>{draft.text ? 'Draft saved locally' : 'Need to send a message?'}</span>
                <span>Open composer ↑</span>
              </button>
              <form
                className={`composer ${draft.uncertain ? 'has-uncertain' : ''}`}
                onSubmit={(event) => void send(event)}
              >
                {draft.context && (
                  <div className="context-preview">
                    <div>
                      <Paperclip size={14} />
                      <strong>{draft.context.title}</strong>
                    </div>
                    <span>{draft.context.url}</span>
                    {draft.context.selection && <p>{draft.context.selection}</p>}
                    <IconButton
                      label="Remove attached page"
                      onClick={() => updateDraft({ ...draft, context: undefined })}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                )}
                {draft.uncertain && (
                  <div className="uncertain" role="alert">
                    <strong>Check delivery before resending.</strong>
                    <p>This draft may already be in T3 Code.</p>
                    <button
                      type="button"
                      onClick={() => updateDraft({ ...draft, uncertain: false })}
                    >
                      I checked — keep as an editable draft
                    </button>
                  </div>
                )}
                <label className="sr-only" htmlFor="message">
                  Message this session
                </label>
                <textarea
                  ref={composer}
                  id="message"
                  placeholder={
                    connected ? 'Continue the conversation…' : 'Write a draft while disconnected…'
                  }
                  value={loadedDraftKey === currentKey ? draft.text : ''}
                  disabled={
                    loadedDraftKey !== currentKey || draftLoading || busy || !!draft.uncertain
                  }
                  onChange={(event) => updateDraft({ ...draft, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={3}
                />
                <div className="composer-tools">
                  <button
                    type="button"
                    className="attach-button"
                    disabled={loadedDraftKey !== currentKey || busy || !!draft.uncertain}
                    onClick={() => void attachPage()}
                  >
                    <Paperclip size={15} /> Attach page
                  </button>
                  <span className="spacer" />
                  {selected?.activeRunId && (
                    <button
                      type="button"
                      className="stop-button"
                      disabled={!connected || state.pending}
                      onClick={() =>
                        void action(async () => {
                          const r = await rpc<CommandResult>({
                            type: 'stop',
                            threadId: selected.id,
                          });
                          if (r.status !== 'accepted')
                            throw new Error(
                              r.message ?? 'Stop delivery is uncertain. Check T3 Code.',
                            );
                        })
                      }
                    >
                      <Square size={12} /> Stop
                    </button>
                  )}
                  <button
                    className="send-button"
                    aria-label="Send message"
                    title="Send message"
                    disabled={
                      loadedDraftKey !== currentKey ||
                      !connected ||
                      !draft.text.trim() ||
                      busy ||
                      state.pending ||
                      draftLoading ||
                      !!draft.uncertain
                    }
                  >
                    {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}
                  </button>
                </div>
                <div className="composer-hint">
                  <span>Enter to send · Shift + Enter for a new line</span>
                  <span>
                    {draft.text ? 'Draft saved locally' : 'Only attached pages are shared'}
                  </span>
                </div>
              </form>
            </main>
          )}
        </>
      )}
    </div>
  );
}

function RequestCard({
  request,
  sessionTitle,
  delivery,
  onOpenT3,
  disabled,
  onReply,
}: {
  delivery?: 'unknown' | 'accepted';
  request: RuntimeRequest;
  sessionTitle: string;
  onOpenT3: () => void;
  disabled: boolean;
  onReply: (value: {
    decision?: string;
    answers?: Record<string, string | string[]>;
  }) => Promise<CommandResult>;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  async function reply(value: { decision?: string; answers?: Record<string, string | string[]> }) {
    if (pending || sent || uncertain) return;
    setPending(true);
    setError('');
    try {
      const result = await onReply(value);
      if (result.status === 'accepted') setSent(true);
      else {
        setUncertain(result.status === 'unknown');
        setError(result.message ?? 'Check this request in T3 Code before responding again.');
      }
    } catch (err) {
      setUncertain(true);
      setError(
        err instanceof Error ? err.message : 'Response delivery is uncertain. Check T3 Code.',
      );
    } finally {
      setPending(false);
    }
  }
  const missingApprovalContext = request.kind === 'approval' && !request.command && !request.detail;
  const locked =
    !!delivery ||
    disabled ||
    pending ||
    sent ||
    uncertain ||
    missingApprovalContext ||
    request.responseMode === 'unavailable';
  return (
    <section className="request-card">
      <div className="request-heading">
        <span className="request-glyph">?</span>
        <span>{request.kind === 'approval' ? 'Permission requested' : 'Your input is needed'}</span>
      </div>
      <h2>{request.title}</h2>
      <p className="request-session">{sessionTitle}</p>
      {delivery && (
        <p className="hint" role="status">
          {delivery === 'accepted'
            ? 'Response sent. Waiting for T3 Code to update.'
            : 'Response delivery is uncertain. Review this request in T3 Code.'}
        </p>
      )}
      {request.command && <pre className="approval-command">{request.command}</pre>}
      {request.cwd && (
        <p className="request-cwd">
          In <code>{request.cwd}</code>
        </p>
      )}
      {request.detail && request.detail !== request.command && (
        <p className="request-detail">{request.detail}</p>
      )}
      {(request.responseMode === 'unavailable' ||
        missingApprovalContext ||
        uncertain ||
        !!delivery) && (
        <button className="secondary full" onClick={onOpenT3}>
          Review in T3 Code <ExternalLink size={14} />
        </button>
      )}
      {request.kind === 'approval' ? (
        <>
          <p className="hint">Review the request before allowing the agent to proceed.</p>
          {request.options
            ?.filter((option) => option.warning)
            .map((option) => (
              <p className="hint" key={option.decision}>
                {option.warning}
              </p>
            ))}
          <div className="request-actions">
            {(request.choices ?? ['decline', 'accept'])
              .filter((choice) => choice !== 'acceptAlways')
              .map((choice) => (
                <button
                  key={choice}
                  className={choice === 'accept' ? 'primary' : 'secondary'}
                  disabled={locked}
                  onClick={() => void reply({ decision: choice })}
                >
                  {request.options?.find((option) => option.decision === choice)?.label ??
                    (choice === 'accept'
                      ? 'Allow once'
                      : choice === 'decline'
                        ? 'Deny'
                        : choice === 'acceptForSession'
                          ? 'Allow for session'
                          : choice)}
                </button>
              ))}
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void reply({ answers });
          }}
        >
          {(request.questions ?? []).map((question) => (
            <fieldset key={question.id} disabled={locked}>
              <legend>{question.question}</legend>
              {question.options.map((option) => {
                const value = option.value ?? option.label;
                const selected = answers[question.id];
                return (
                  <label
                    className={`answer-option ${Array.isArray(selected) ? (selected.includes(value) ? 'selected' : '') : selected === value ? 'selected' : ''}`}
                    key={value}
                  >
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={question.id}
                      checked={
                        Array.isArray(selected) ? selected.includes(value) : selected === value
                      }
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: question.multiSelect
                            ? event.target.checked
                              ? [
                                  ...(Array.isArray(current[question.id])
                                    ? (current[question.id] as string[])
                                    : []),
                                  value,
                                ]
                              : (Array.isArray(current[question.id])
                                  ? (current[question.id] as string[])
                                  : []
                                ).filter((v) => v !== value)
                            : value,
                        }))
                      }
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                );
              })}
              {(question.allowCustomAnswer || !question.options.length) && (
                <>
                  <label htmlFor={`answer-${request.id}-${question.id}`} className="hint">
                    Your answer
                  </label>
                  <textarea
                    id={`answer-${request.id}-${question.id}`}
                    placeholder="Write an answer…"
                    value={
                      typeof answers[question.id] === 'string' &&
                      !question.options.some((o) => (o.value ?? o.label) === answers[question.id])
                        ? (answers[question.id] as string)
                        : ''
                    }
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                    }
                  />
                </>
              )}
            </fieldset>
          ))}
          <button
            className="primary full"
            disabled={
              locked ||
              (request.questions ?? []).some(
                (q) => q.required && (!answers[q.id] || answers[q.id]?.length === 0),
              )
            }
          >
            {sent ? <Check size={15} /> : <ArrowUp size={15} />}{' '}
            {sent ? 'Response sent' : pending ? 'Sending…' : 'Send answer'}
          </button>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
