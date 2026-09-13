import type { BlockedNavigation } from "../src/shared/adblock";
import { httpUrl } from "./adblock-engine";

export type NavigationIntent = {
  kind: "link" | "media" | "form" | "other";
  target?: string;
  sourceUrl: string;
  at: number;
};

export function sameNavigationTarget(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    const a = new URL(left); const b = new URL(right);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  } catch { return false; }
}

export function classifyNavigation(input: {
  url: string;
  popup: boolean;
  ruleBlocked: boolean;
  ruleExcepted?: boolean;
  enabled: boolean;
  intent?: NavigationIntent;
  redirect?: boolean;
  now?: number;
}): BlockedNavigation["reason"] | null {
  if (!input.enabled) return null;
  if (input.ruleBlocked) return "rule";
  if (input.ruleExcepted) return null;
  const intent = input.intent && (input.now ?? Date.now()) - input.intent.at < 2000 ? input.intent : undefined;
  if (intent?.kind === "link" && sameNavigationTarget(intent.target, input.url)) return null;
  // Search forms may append query parameters; their actual action is known.
  if (intent?.kind === "form" && intent.target && httpUrl(input.url)) {
    const action = new URL(intent.target); const target = new URL(input.url);
    if (action.origin === target.origin && action.pathname === target.pathname) return null;
  }
  // A legitimate initial navigation can redirect (SSO, short links, site moves).
  // Every hop is still filtered; it doesn't need to equal the original href.
  if (input.redirect) return null;
  if (intent?.kind === "media") return "playback";
  if (input.popup) return "unexpected";
  if (intent?.kind === "link" && intent.target) return "unexpected";
  return null;
}
