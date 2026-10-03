import { z } from 'zod';
import {
  BUILT_IN_THEMES,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeDefinition,
} from '../vendor/t3-theme-palettes';

export const literalColor = z
  .string()
  .max(100)
  .refine(
    (value) =>
      /^(#[\da-f]{3,8}|(?:oklch|oklab|rgb|rgba|hsl|hsla|lab|lch|color)\([\da-z.,%+\- /]+\)|[a-z]+)$/i.test(
        value,
      ) && !/^(inherit|initial|unset|revert|currentcolor)$/i.test(value),
    'Use a literal CSS color, without variables or URLs.',
  );
const colorsSchema = z.partialRecord(z.enum(THEME_COLOR_ROLES), literalColor);
const importSchema = z.object({
  version: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  name: z.string().trim().min(1).max(48),
  appearance: z.enum(['light', 'dark']),
  colors: colorsSchema,
  variants: z.object({ light: colorsSchema.optional(), dark: colorsSchema.optional() }).optional(),
});

export interface Palette {
  id: string;
  name: string;
  appearance: 'light' | 'dark';
  colors: Record<string, string>;
  variants?: { light?: Record<string, string>; dark?: Record<string, string> };
}
export type ThemePreference = {
  id: string;
  appearance: 'system' | 'light' | 'dark';
  imported?: Palette;
};
export const defaultThemePreference: ThemePreference = { id: 'server', appearance: 'system' };
export const builtInThemes = BUILT_IN_THEMES;
export function defaultColors(dark: boolean): Record<string, string> {
  return dark ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
}

export function safeColors(input: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) {
    const parsed = literalColor.safeParse(input[role]);
    if (parsed.success) result[role] = parsed.data;
  }
  return result;
}

export function parseThemeFile(text: string): Palette {
  if (text.length > 100000) throw new Error('Theme files must be smaller than 100 KB.');
  const value = importSchema.parse(JSON.parse(text));
  const clean = (colors: z.infer<typeof colorsSchema>) =>
    safeColors(
      Object.fromEntries(
        Object.entries(colors).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    );
  if (Object.keys(value.colors).length === 0)
    throw new Error('The theme needs at least one color.');
  const variants: Palette['variants'] = {};
  for (const mode of ['light', 'dark'] as const)
    if (value.variants?.[mode])
      variants[mode] = { ...defaultColors(mode === 'dark'), ...clean(value.variants[mode]) };
  return {
    id: value.id ?? 'imported',
    name: value.name,
    appearance: value.appearance,
    colors: { ...defaultColors(value.appearance === 'dark'), ...clean(value.colors) },
    variants,
  };
}

export function resolvePalette(
  preference: ThemePreference,
  systemDark: boolean,
  environment: ReadonlyArray<{
    id: string;
    name: string;
    colors: Readonly<Record<string, string>>;
    light?: Readonly<Record<string, string>>;
    dark?: Readonly<Record<string, string>>;
  }> = [],
): Palette {
  const dark =
    preference.appearance === 'dark' || (preference.appearance === 'system' && systemDark);
  const appearance = dark ? 'dark' : 'light';
  if (preference.id === 'imported' && preference.imported) {
    const imported = preference.imported;
    const colors =
      imported.appearance === appearance ? imported.colors : imported.variants?.[appearance];
    return {
      ...imported,
      appearance: colors ? appearance : imported.appearance,
      colors: safeColors(colors ?? imported.colors),
    };
  }
  const builtin: ThemeDefinition | undefined = BUILT_IN_THEMES.find(
    (theme) => theme.id === preference.id,
  );
  const custom = environment.find((theme) => theme.id === preference.id);
  const colors = builtin
    ? builtin.appearance === appearance
      ? builtin.colors
      : (builtin.variants?.[appearance] ?? builtin.colors)
    : custom
      ? (custom[appearance] ?? custom.colors)
      : defaultColors(dark);
  return {
    id: preference.id,
    name: builtin?.label ?? custom?.name ?? 'T3 Code',
    appearance,
    colors: { ...defaultColors(dark), ...safeColors(colors) },
  };
}

export function applyPalette(palette: Palette): void {
  for (const role of THEME_COLOR_ROLES) {
    const key = `--${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    const value = palette.colors[role];
    if (value && literalColor.safeParse(value).success && CSS.supports('color', value))
      document.documentElement.style.setProperty(key, value);
    else document.documentElement.style.removeProperty(key);
  }
  document.documentElement.style.colorScheme = palette.appearance;
  document.documentElement.dataset.theme = palette.id;
}
