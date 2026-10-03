/** Values exposed by the T3 adapter. Tokens stay in the background broker. */
export interface ConnectionInfo {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly protocolVersion: number;
  readonly httpBaseUrl: string;
}

/** Sensitive: persist only in chrome.storage.local and never send to a view. */
export interface SavedConnection extends ConnectionInfo {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export type ConnectionStatus =
  | { readonly state: 'connecting' | 'connected' | 'reconnecting' }
  | { readonly state: 'disconnected' | 'unsupported'; readonly message: string };

export interface ThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly status: string;
  readonly activeRunId: string | null;
  readonly runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
  readonly interactionMode: 'default' | 'plan';
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly latestMessage: Pick<Message, 'id' | 'role' | 'text' | 'updatedAt'> | null;
  readonly pendingRequestId: string | null;
  readonly hasPendingApproval: boolean;
  readonly hasPendingQuestion: boolean;
}

export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ApprovalDecision =
  'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';

export interface RuntimeRequest {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly requestKind?: 'command' | 'file-read' | 'file-change' | 'mcp-elicitation' | 'permission';
  readonly responseMode: 'live' | 'message' | 'unavailable';
  readonly title: string;
  /** Exact provider activity text. Treat as plain text, not markup. */
  readonly detail?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly appName?: string;
  readonly choices?: ReadonlyArray<ApprovalDecision>;
  readonly options?: ReadonlyArray<{
    readonly decision: ApprovalDecision;
    readonly label: string;
    readonly warning?: string;
  }>;
  readonly questions?: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
      readonly value?: string;
    }>;
    readonly multiSelect: boolean;
    readonly allowCustomAnswer: boolean;
    readonly required: boolean;
  }>;
}

export interface ThreadDetail {
  readonly thread: ThreadSummary;
  readonly messages: ReadonlyArray<Message>;
  readonly requests: ReadonlyArray<RuntimeRequest>;
  readonly sequence: number;
  readonly hasMoreHistory: boolean;
}

/** Data-only palette. The UI must map tokens to its own CSS variables. */
export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly source: 'environment' | 'client';
  readonly appearance: 'light' | 'dark';
  readonly colors: Readonly<Record<string, string>>;
  readonly light?: Readonly<Record<string, string>>;
  readonly dark?: Readonly<Record<string, string>>;
}

export interface ThemeState {
  readonly environmentDefaultId: string | null;
  readonly selectedId: string | null;
  readonly themes: ReadonlyArray<Theme>;
}

export interface CommandResult {
  readonly commandId: string;
  /** Unknown means the socket closed before an acknowledgement. Never replay automatically. */
  readonly status: 'accepted' | 'rejected' | 'unknown';
  readonly message?: string;
}

export interface SendResult extends CommandResult {
  readonly messageId: string;
}

export type ThreadListener = (threads: ReadonlyArray<ThreadSummary>) => void;
export type DetailListener = (detail: ThreadDetail) => void;
export type StatusListener = (status: ConnectionStatus) => void;
export type ThemeListener = (theme: ThemeState) => void;
