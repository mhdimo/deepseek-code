
/**
 * Render-time secret masking (Claude Code parity): API keys that leak into
 * tool output (cat settings.json, env dumps) are redacted on screen only —
 * the model still receives the raw text.
 */

// DeepSeek-style keys: sk- followed by 16+ hex/alphanumerics.
const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

export function redactSecrets(text: string): string {
  if (!text || !text.includes("sk-")) return text;
  return text.replace(API_KEY_RE, (match) => `sk-…${match.slice(-4)} (redacted)`);
}
