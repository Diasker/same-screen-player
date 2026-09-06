import type { InteractionMode } from "./types";

export type EscapeAction = "exit-webpage-fullscreen" | "exit-interaction-mode" | "exit-app-fullscreen" | "none";

export function toggleInteractionMode(mode: InteractionMode): InteractionMode {
  return mode === "web" ? "app" : "web";
}

export function resolveEscapeAction(input: { webpageFullscreen: boolean; interactionMode: InteractionMode; appFullscreen: boolean }): EscapeAction {
  if (input.webpageFullscreen) return "exit-webpage-fullscreen";
  if (input.interactionMode === "app") return "exit-interaction-mode";
  if (input.appFullscreen) return "exit-app-fullscreen";
  return "none";
}
