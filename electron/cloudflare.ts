export type CloudflareStatus = "none" | "detected" | "passed" | "looped";

export type ChallengeNavigationState = {
  status: CloudflareStatus;
  signature: string;
  firstSeenAt: number;
  lastSeenAt: number;
  navigationCount: number;
};

export type ChallengeNavigationOptions = {
  windowMs?: number;
  loopThreshold?: number;
};

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_LOOP_THRESHOLD = 4;

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function navigationSignature(value: unknown): string | null {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
}

function isChallengePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return /^\/cdn-cgi\/(?:challenge-platform|challenge)(?:\/|$)/.test(path);
}

export function isCloudflareChallengeRequest(value: unknown, resourceType?: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false;
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === "challenges.cloudflare.com") return true;
  if (isChallengePath(pathname)) return true;
  if (parsed.searchParams.has("__cf_chl_tk") || parsed.searchParams.has("__cf_chl_rt_tk")) return true;
  if (host.endsWith(".cloudflare.com") && /turnstile|challenge-platform|\/challenge(?:\/|$)/.test(`${pathname}${parsed.search}`)) return true;
  if (resourceType === "subFrame" && /\/cdn-cgi\//.test(pathname) && /challenge|turnstile/.test(pathname)) return true;
  return false;
}

export function shouldBypassAdblockForChallenge(value: unknown, resourceType: string | undefined, paneAdblockDisabled: boolean): boolean {
  return paneAdblockDisabled || isCloudflareChallengeRequest(value, resourceType);
}

export function cloudflareChallengeHost(value: unknown): string | null {
  const parsed = parseUrl(value);
  if (!parsed || !isCloudflareChallengeRequest(value)) return null;
  return parsed.hostname.toLowerCase();
}

export function challengeSignature(value: unknown): string | null {
  const parsed = parseUrl(value);
  if (!parsed || !isCloudflareChallengeRequest(value)) return null;
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
}

export function observeChallengeNavigation(
  previous: ChallengeNavigationState | undefined,
  value: unknown,
  now = Date.now(),
  options: ChallengeNavigationOptions = {},
): ChallengeNavigationState {
  const signature = challengeSignature(value) ?? "";
  return observeSignature(previous, signature, now, options);
}

export function observeChallengeSignal(
  previous: ChallengeNavigationState | undefined,
  value: unknown,
  now = Date.now(),
  options: ChallengeNavigationOptions = {},
): ChallengeNavigationState {
  return observeSignature(previous, navigationSignature(value) ?? "", now, options);
}

function observeSignature(
  previous: ChallengeNavigationState | undefined,
  signature: string,
  now: number,
  options: ChallengeNavigationOptions,
): ChallengeNavigationState {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const loopThreshold = options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
  if (!signature) {
    return {
      status: previous?.status === "detected" || previous?.status === "looped" ? "passed" : "none",
      signature: "",
      firstSeenAt: previous?.firstSeenAt ?? 0,
      lastSeenAt: now,
      navigationCount: previous?.navigationCount ?? 0,
    };
  }
  const continuing = previous?.signature === signature && now - previous.lastSeenAt <= windowMs;
  const navigationCount = continuing ? previous.navigationCount + 1 : 1;
  return {
    status: navigationCount >= loopThreshold ? "looped" : "detected",
    signature,
    firstSeenAt: continuing ? previous.firstSeenAt : now,
    lastSeenAt: now,
    navigationCount,
  };
}

export function emptyChallengeNavigation(): ChallengeNavigationState {
  return { status: "none", signature: "", firstSeenAt: 0, lastSeenAt: 0, navigationCount: 0 };
}
