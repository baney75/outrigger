import { describe, expect, it } from 'vitest';
import { composeMessage, draftKey, safePageUrl } from '../src/core/context';
import { decideNotifications } from '../src/core/notifications';

describe('explicit page attachment', () => {
  it('strips URL credentials and secrets without touching the path', () => {
    expect(safePageUrl('https://user:password@example.com/docs?q=secret#token')).toBe(
      'https://example.com/docs',
    );
    expect(safePageUrl('chrome://settings')).toBe('');
    expect(safePageUrl('javascript:alert(1)')).toBe('');
  });
  it('does not invent page content and caps selected text', () => {
    expect(composeMessage('hello')).toBe('hello');
    const result = composeMessage('Explain', {
      title: 'Docs',
      url: 'https://example.com/',
      selection: 'x'.repeat(15000),
    });
    expect(result.match(/x/g)?.length).toBeLessThan(12010);
    expect(result).toContain('not instructions');
  });
  it('isolates drafts across servers and thread identities', () => {
    expect(draftKey('one', 'two:three')).not.toBe(draftKey('one:two', 'three'));
    expect(draftKey('a', 'thread')).not.toBe(draftKey('b', 'thread'));
  });
});

describe('attention notifications', () => {
  const request = { threadId: 'a', requestId: 'question-1' };
  const normal = { silent: false, baseline: false, watched: ['a'] };
  it('notifies a newly waiting watched session exactly once', () => {
    const first = decideNotifications({ seen: [] }, [request], normal);
    expect(first.notify).toEqual([request]);
    expect(decideNotifications(first.ledger, [request], normal).notify).toEqual([]);
  });
  it('does not replay silent-mode, initial-connect, or unwatched backlog', () => {
    for (const options of [
      { ...normal, silent: true },
      { ...normal, baseline: true },
      { ...normal, watched: [] },
    ]) {
      const result = decideNotifications({ seen: [] }, [request], options);
      expect(result.notify).toEqual([]);
      expect(decideNotifications(result.ledger, [request], normal).notify).toEqual([]);
    }
  });
  it('keeps a visible question quiet but still handles a different session', () => {
    expect(
      decideNotifications({ seen: [] }, [request], { ...normal, activeThreadId: 'a' }).notify,
    ).toEqual([]);
    expect(
      decideNotifications({ seen: [] }, [request], { ...normal, activeThreadId: 'b' }).notify,
    ).toEqual([request]);
  });
  it('retains currently pending dedup IDs while bounding historical storage', () => {
    const result = decideNotifications(
      { seen: Array.from({ length: 5000 }, (_, i) => `${i}`) },
      [request],
      normal,
    );
    expect(result.ledger.seen).toHaveLength(1001);
    expect(decideNotifications(result.ledger, [request], normal).notify).toEqual([]);
  });
});
