import { describe, expect, it } from "vitest";
import { debugOverlaysEnabled, shouldShowPaneNotice } from "./debug-overlays";

describe("debug overlays", () => {
  it("enables overlays in development or with the exact startup flag", () => {
    expect(debugOverlaysEnabled([], true)).toBe(true);
    expect(debugOverlaysEnabled(["electron", "--debug-overlays"], false)).toBe(true);
  });

  it("keeps production overlays hidden without the exact startup flag", () => {
    expect(debugOverlaysEnabled([], false)).toBe(false);
    expect(debugOverlaysEnabled(["--debug-overlay"], false)).toBe(false);
    expect(debugOverlaysEnabled(["--debug-overlays=true"], false)).toBe(false);
  });

  it("only renders notices in web mode when overlays are enabled", () => {
    expect(shouldShowPaneNotice({ debugOverlays: true, interactionMode: "web", hasContent: true, hasNotice: true })).toBe(true);
    expect(shouldShowPaneNotice({ debugOverlays: false, interactionMode: "web", hasContent: true, hasNotice: true })).toBe(false);
    expect(shouldShowPaneNotice({ debugOverlays: true, interactionMode: "app", hasContent: true, hasNotice: true })).toBe(false);
    expect(shouldShowPaneNotice({ debugOverlays: true, interactionMode: "web", hasContent: false, hasNotice: true })).toBe(false);
  });
});
