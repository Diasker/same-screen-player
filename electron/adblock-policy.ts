export function normalizeAdblockHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch { return null; }
}

export function hostMatchesAdblockRule(requestHost: unknown, ruleHost: unknown): boolean {
  const request = normalizeAdblockHost(requestHost);
  const rule = normalizeAdblockHost(ruleHost);
  return Boolean(request && rule && (request === rule || request.endsWith(`.${rule}`)));
}
