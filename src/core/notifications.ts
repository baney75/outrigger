export interface Attention {
  threadId: string;
  requestId: string;
}
export interface NotificationLedger {
  seen: string[];
}
export interface NotificationResult {
  ledger: NotificationLedger;
  notify: Attention[];
}

/** Deduplicate across reconnect and worker restarts, including time spent silent. */
export function decideNotifications(
  previous: NotificationLedger,
  pending: Attention[],
  options: { silent: boolean; baseline: boolean; watched: string[]; activeThreadId?: string },
): NotificationResult {
  const seen = new Set(previous.seen);
  const notify: Attention[] = [];
  for (const attention of pending) {
    const key = JSON.stringify([attention.threadId, attention.requestId]);
    if (
      !seen.has(key) &&
      !options.silent &&
      !options.baseline &&
      options.watched.includes(attention.threadId) &&
      options.activeThreadId !== attention.threadId
    )
      notify.push(attention);
    seen.add(key);
  }
  // Pending items stay in the ledger; historical IDs are bounded to protect storage.
  const current = new Set(pending.map((a) => JSON.stringify([a.threadId, a.requestId])));
  const history = [...seen].filter((key) => !current.has(key)).slice(-1000);
  return { ledger: { seen: [...history, ...current] }, notify };
}
