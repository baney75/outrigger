import type {
  ConnectionInfo,
  ConnectionStatus,
  ThreadSummary,
  ThreadDetail,
  ThemeState,
} from '../t3/types';
import { defaultThemePreference, type ThemePreference } from './theme';

export interface Preferences {
  silent: boolean;
  watched: string[];
  theme: ThemePreference;
}
export interface PanelState {
  connection: ConnectionInfo | null;
  status: ConnectionStatus;
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: string | null;
  detail: ThreadDetail | null;
  preferences: Preferences;
  themes: ThemeState;
  responses: Record<string, 'unknown' | 'accepted'>;
  pending: boolean;
  error: string | null;
}
export const initialState: PanelState = {
  connection: null,
  status: { state: 'disconnected', message: 'Connect to T3 Code to continue your sessions.' },
  threads: [],
  selectedId: null,
  detail: null,
  preferences: { silent: true, watched: [], theme: defaultThemePreference },
  themes: { environmentDefaultId: null, selectedId: null, themes: [] },
  pending: false,
  responses: {},
  error: null,
};

export type { Draft } from './drafts';
