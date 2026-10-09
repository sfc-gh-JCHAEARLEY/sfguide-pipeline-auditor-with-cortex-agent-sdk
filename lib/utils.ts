/** Snowflake identifier: alphanumeric, underscores, hyphens, dollars. Max 255 chars. */
const SAFE_IDENTIFIER = /^[\w$-]{1,255}$/;

export function isValidIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

/** Truncate and strip control characters from a string for safe prompt interpolation. */
export function sanitizeForPrompt(value: unknown, maxLen = 500): string {
  const s = String(value ?? "").slice(0, maxLen);
  // Strip control characters except newlines and tabs
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
