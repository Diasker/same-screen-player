import { describe, expect, it } from "vitest";
import {
  emptyChallengeNavigation,
  isCloudflareChallengeRequest,
  observeChallengeSignal,
  observeChallengeNavigation,
  shouldBypassAdblockForChallenge,
} from "./cloudflare";

describe("Cloudflare challenge matching", () => {
  it("matches dedicated challenge and origin challenge paths", () => {
    expect(isCloudflareChallengeRequest("https://challenges.cloudflare.com/turnstile/v0/api.js", "script")).toBe(true);
    expect(isCloudflareChallengeRequest("https://example.com/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1", "script")).toBe(true);
    expect(isCloudflareChallengeRequest("https://example.com/cdn-cgi/challenge/", "subFrame")).toBe(true);
    expect(isCloudflareChallengeRequest("https://example.com/assets/advert.js", "script")).toBe(false);
  });

  it("bypasses all filtering for a pane with ad blocking disabled", () => {
    expect(shouldBypassAdblockForChallenge("https://ads.example/tracker.js", "script", true)).toBe(true);
    expect(shouldBypassAdblockForChallenge("https://ads.example/tracker.js", "script", false)).toBe(false);
    expect(shouldBypassAdblockForChallenge("https://challenges.cloudflare.com/turnstile/v0/api.js", "script", false)).toBe(true);
  });

  it("marks repeated challenge navigations as looped without requesting a reload", () => {
    let state = emptyChallengeNavigation();
    const url = "https://example.com/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1";
    state = observeChallengeNavigation(state, url, 1_000, { loopThreshold: 3 });
    expect(state.status).toBe("detected");
    state = observeChallengeNavigation(state, url, 2_000, { loopThreshold: 3 });
    expect(state.status).toBe("detected");
    state = observeChallengeNavigation(state, url, 3_000, { loopThreshold: 3 });
    expect(state.status).toBe("looped");
    expect(state.navigationCount).toBe(3);
  });

  it("transitions to passed when navigation leaves the challenge", () => {
    const challenge = observeChallengeNavigation(emptyChallengeNavigation(), "https://challenges.cloudflare.com/turnstile/v0/api.js", 1_000);
    const passed = observeChallengeNavigation(challenge, "https://example.com/video", 2_000);
    expect(passed.status).toBe("passed");
    expect(passed.navigationCount).toBe(challenge.navigationCount);
  });

  it("can count repeated challenge documents served at the original URL", () => {
    const url = "https://video.example/watch/123";
    let state = observeChallengeSignal(emptyChallengeNavigation(), url, 1_000, { loopThreshold: 2 });
    state = observeChallengeSignal(state, url, 2_000, { loopThreshold: 2 });
    expect(state.status).toBe("looped");
  });
});
