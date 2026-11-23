/**
 * Uniform tool errors: { code, message_localized, retryable, next_action }.
 * next_action never asks the lawyer anything, except for CONSENT_REQUIRED (the payment "yes").
 * Messages are English for now (message_lang); the calling AI translates them.
 */
export type ToolErrorCode =
  | "CONSENT_REQUIRED"
  | "PLAN_UNKNOWN"
  | "BILLING_UNAVAILABLE"
  | "PAYMENT_REQUIRED"
  | "ACCESS_ENDED"
  | "QUOTA_EXCEEDED"
  | "INVALID_KEY"
  | "PAIRING_EXPIRED"
  | "NOT_PAID_YET"
  | "HASH_INVALID"
  | "LABEL_INVALID"
  | "TSA_UNAVAILABLE"
  | "NOT_FOUND"
  | "PROOF_NOT_FOUND"
  | "PROOF_INVALID";

export type ToolError = {
  ok: false;
  code: ToolErrorCode;
  message_localized: string;
  message_lang: string;
  retryable: boolean;
  next_action: string;
  [k: string]: unknown;
};

export function toolError(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  next_action: string,
  extra: Record<string, unknown> = {},
): ToolError {
  return { ok: false, code, message_localized: message, message_lang: "en", retryable, next_action, ...extra };
}

export function isToolError(x: unknown): x is ToolError {
  return !!x && typeof x === "object" && (x as { ok?: unknown }).ok === false && typeof (x as { code?: unknown }).code === "string";
}
