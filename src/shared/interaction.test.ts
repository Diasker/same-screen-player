import { describe, expect, it } from "vitest";
import { resolveEscapeAction, toggleInteractionMode } from "./interaction";

describe("interaction layers", () => {
  it("toggles between webpage and application input", () => {
    expect(toggleInteractionMode("web")).toBe("app");
    expect(toggleInteractionMode("app")).toBe("web");
  });

  it("resolves Escape in fullscreen and input-layer priority order", () => {
    expect(resolveEscapeAction({ webpageFullscreen: true, interactionMode: "app", appFullscreen: true })).toBe("exit-webpage-fullscreen");
    expect(resolveEscapeAction({ webpageFullscreen: false, interactionMode: "app", appFullscreen: true })).toBe("exit-interaction-mode");
    expect(resolveEscapeAction({ webpageFullscreen: false, interactionMode: "web", appFullscreen: true })).toBe("exit-app-fullscreen");
    expect(resolveEscapeAction({ webpageFullscreen: false, interactionMode: "web", appFullscreen: false })).toBe("none");
  });
});
