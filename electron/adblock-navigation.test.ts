import { describe, expect, it } from "vitest";
import { classifyNavigation, type NavigationIntent } from "./adblock-navigation";

describe("navigation intent", () => {
  const link: NavigationIntent = { kind: "link", target: "https://other.example/video", sourceUrl: "https://video.example/", at: 1000 };
  const media: NavigationIntent = { ...link, kind: "media", target: undefined };
  const decide = (value: Partial<Parameters<typeof classifyNavigation>[0]>) => classifyNavigation({ url: "https://other.example/video", popup: false, enabled: true, ruleBlocked: false, now: 1100, ...value });
  it("allows deliberate links across sites and new tabs", () => {
    expect(decide({ intent: link, popup: true })).toBeNull();
    expect(decide({ intent: link })).toBeNull();
    expect(decide({})).toBeNull();
  });
  it("blocks playback side effects and extra destinations without turning all clicks into ads", () => {
    expect(decide({ intent: media, popup: true })).toBe("playback");
    expect(decide({ intent: media })).toBe("playback");
    expect(decide({ intent: link, url: "https://unknown.example/" })).toBe("unexpected");
    expect(decide({ popup: true })).toBe("unexpected");
  });
  it("does not apply expired media gestures to later normal navigation", () => {
    expect(decide({ intent: media, now: 5000 })).toBeNull();
  });
  it("allows normal redirects and search forms but checks rules at each hop", () => {
    expect(decide({ intent: link, url: "https://other.example/canonical", redirect: true })).toBeNull();
    expect(decide({ redirect: true, ruleBlocked: true })).toBe("rule");
    expect(decide({ intent: { ...link, kind: "form", target: "https://other.example/search" }, url: "https://other.example/search?q=video", popup: true })).toBeNull();
  });
  it("honors site switches and rule exceptions", () => {
    expect(decide({ enabled: false, ruleBlocked: true, intent: media })).toBeNull();
    expect(decide({ ruleExcepted: true, intent: media, popup: true })).toBeNull();
    expect(decide({ ruleBlocked: true, intent: link })).toBe("rule");
  });
});
