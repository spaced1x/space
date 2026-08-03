// Correlation ids tie a command, its events, its log lines and its audit row
// together. Web Crypto is available in every runtime SPACE targets.
export function correlationId(prefix = "cid"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
