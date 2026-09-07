import type { InteractionMode } from "./types";

export function debugOverlaysEnabled(argv: readonly string[], development: boolean): boolean {
  return development || argv.includes("--debug-overlays");
}

export function shouldShowPaneNotice(options: {
  debugOverlays: boolean;
  interactionMode: InteractionMode;
  hasContent: boolean;
  hasNotice: boolean;
}): boolean {
  return options.debugOverlays && options.interactionMode === "web" && options.hasContent && options.hasNotice;
}
