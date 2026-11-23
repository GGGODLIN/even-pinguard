export interface TelegramMessageOptions {
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
}

export interface TelegramDeliveryPort {
  sendMessage(chatId: string, text: string, options?: TelegramMessageOptions): Promise<{
    chat: { id: string };
    message_id: number;
  }>;
  pinChatMessage(chatId: string, messageId: number, options: { disable_notification: true }): Promise<boolean>;
}

export interface IncomingTelegramMessage {
  chatId: string;
  messageId: number;
  fromUserId?: string;
  isBot?: boolean;
  /** Unix seconds, matching Telegram's message.date. */
  timestamp: number;
  text?: string;
}

export interface CallbackQueryEvent {
  chatId: string;
  fromUserId: string;
  data?: string;
}

export interface FactSeedItem {
  factKey: string;
  text: string;
  questions?: readonly string[];
  /** Unix seconds. When omitted, use the seed source's timestamp. */
  effectiveAt?: number;
}

export type LockState = "CLEAR" | "HOLD_CONFLICT" | "AWAITING_CONFIRM";
export type DeliveryStatus = "PENDING" | "SEND_IN_FLIGHT" | "PINNED" | "PIN_FAILED" | "SEND_FAILED" | "SEND_UNKNOWN";

export interface FactState {
  fact_key: string;
  text: string;
  revision: number;
  effective_at: number;
  version: number;
  lock_state: LockState;
  confirmed: boolean;
  conflict: { id: string; text: string; chat_id: string; message_id: number; timestamp: number } | null;
}

export interface ClusterState {
  cluster_id: string;
  fact_key: string;
  status: "READY" | "EXECUTING" | Exclude<LockState, "CLEAR">;
  lock_state: LockState;
  version: number;
  confirmed: boolean;
  draft: string;
  groups: { chat_id: string; count: number }[];
}

export interface StateSnapshot {
  facts: FactState[];
  clusters: ClusterState[];
}

export interface DeliveryReceipt {
  action_id: string;
  chat_id: string;
  message_id: number | null;
  status: DeliveryStatus;
  sent: boolean;
  pinned: boolean;
  error: string | null;
}

export class PinGuardError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 415 | 502, message: string) {
    super(message);
  }
}
