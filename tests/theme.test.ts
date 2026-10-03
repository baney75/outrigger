import { describe, expect, it } from 'vitest';
import { builtInThemes, parseThemeFile, resolvePalette, safeColors } from '../src/core/theme';
import { THEME_COLOR_ROLES } from '../src/vendor/t3-theme-palettes';

describe('T3 theme compatibility', () => {
  it('preserves exact upstream role values for every built-in and variant', () => {
    for (const theme of builtInThemes)
      for (const appearance of ['light', 'dark'] as const) {
        const source =
          theme.appearance === appearance
            ? theme.colors
            : (theme.variants?.[appearance] ?? theme.colors);
        const actual = resolvePalette({ id: theme.id, appearance }, false);
        for (const role of THEME_COLOR_ROLES) expect(actual.colors[role]).toBe(source[role]);
      }
  });
  it('imports T3 exported custom palettes without running CSS', () => {
    const palette = parseThemeFile(
      JSON.stringify({
        version: 1,
        name: 'Custom',
        appearance: 'dark',
        colors: { accent: '#c47c9b', canvas: 'oklch(0.2 0.03 280)' },
      }),
    );
    expect(palette.colors.accent).toBe('#c47c9b');
    expect(palette.appearance).toBe('dark');
    expect(Object.keys(palette.colors)).toHaveLength(THEME_COLOR_ROLES.length);
  });
  it('rejects network URLs, variable references, and arbitrary style properties', () => {
    expect(
      safeColors({
        accent: 'url(https://example.com/track)',
        canvas: 'var(--remote)',
        text: '#ffffff',
        position: 'fixed',
      }),
    ).toEqual({ text: '#ffffff' });
    expect(() =>
      parseThemeFile(
        JSON.stringify({
          version: 1,
          name: 'Bad',
          appearance: 'dark',
          colors: { accent: 'red; background:url(https://example.com)' },
        }),
      ),
    ).toThrow();
  });
  it('selects the supplied custom variant and follows system appearance', () => {
    const themes = [
      { id: 'custom', name: 'Custom', colors: { canvas: '#000000' }, light: { canvas: '#fafafa' } },
    ];
    expect(
      resolvePalette({ id: 'custom', appearance: 'system' }, false, themes).colors.canvas,
    ).toBe('#fafafa');
    expect(resolvePalette({ id: 'custom', appearance: 'system' }, true, themes).colors.canvas).toBe(
      '#000000',
    );
  });
  it('preserves both variants of an imported T3 theme after appearance changes', () => {
    const imported = parseThemeFile(
      JSON.stringify({
        version: 1,
        name: 'Dual',
        appearance: 'dark',
        colors: { canvas: '#201820', accent: '#d89bbb' },
        variants: { light: { canvas: '#fff1f8', accent: '#81274e' } },
      }),
    );
    expect(
      resolvePalette({ id: 'imported', appearance: 'light', imported }, true).colors.canvas,
    ).toBe('#fff1f8');
    expect(
      resolvePalette({ id: 'imported', appearance: 'dark', imported }, false).colors.canvas,
    ).toBe('#201820');
    expect(
      resolvePalette({ id: 'imported', appearance: 'system', imported }, false).colors.accent,
    ).toBe('#81274e');
  });
});
