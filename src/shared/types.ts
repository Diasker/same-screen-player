export type Orientation = "horizontal" | "vertical";

export type LayoutNode =
  | {
      kind: "split";
      orientation: Orientation;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    }
  | {
      kind: "pane";
      paneId: string;
    };

export type Preset = "single" | "split-2" | "split-3" | "grid-2x2" | "grid-3x2";

export type SessionMode = "shared" | "isolated";

export type InteractionMode = "web" | "app";

export type BrowserBackend = "electron" | "chrome";

export type ChromeStatus = "disabled" | "starting" | "ready" | "challenge" | "crashed" | "closed";

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type PlayerStatus = "idle" | "loading" | "ready" | "unrecognized" | "challenge" | "blocked" | "crashed";

export type CloudflareStatus = "none" | "detected" | "passed" | "looped";

export type PlaybackSnapshot = {
  playing: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  hasVideo: boolean;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  playerWidth: number;
  playerHeight: number;
  rate: number;
};

export type PaneRuntime = {
  paneId: string;
  url: string;
  sessionMode: SessionMode;
  muted: boolean;
  adblockEnabled: boolean;
  playing: boolean;
  playerStatus: PlayerStatus;
  playback: PlaybackSnapshot;
  userPauseIntent: boolean;
  focusModeEnabled: boolean;
  cloudflareStatus: CloudflareStatus;
  error?: string;
};

export type PersistedLayout = {
  version: 1;
  layout: LayoutNode;
};

export const MAX_PANES = 6;

export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane") return typeof node.paneId === "string" && node.paneId.length > 0;
  if (node.kind !== "split") return false;
  return (
    (node.orientation === "horizontal" || node.orientation === "vertical") &&
    typeof node.ratio === "number" &&
    node.ratio > 0.1 &&
    node.ratio < 0.9 &&
    isLayoutNode(node.first) &&
    isLayoutNode(node.second)
  );
}

export function getPaneIds(node: LayoutNode): string[] {
  if (node.kind === "pane") return [node.paneId];
  return [...getPaneIds(node.first), ...getPaneIds(node.second)];
}

export function createPaneId(): string {
  return `pane-${Math.random().toString(36).slice(2, 8)}`;
}

function split(first: LayoutNode, second: LayoutNode, orientation: Orientation): LayoutNode {
  return { kind: "split", orientation, ratio: 0.5, first, second };
}

function makeGrid(columns: number, rows: number): LayoutNode {
  const columnNodes: LayoutNode[] = [];
  for (let column = 0; column < columns; column += 1) {
    const panes: LayoutNode[] = [];
    for (let row = 0; row < rows; row += 1) panes.push({ kind: "pane", paneId: `pane-${column * rows + row + 1}` });
    let columnNode = panes[0];
    for (let index = 1; index < panes.length; index += 1) columnNode = split(columnNode, panes[index], "vertical");
    columnNodes.push(columnNode);
  }
  let result = columnNodes[0];
  for (let index = 1; index < columnNodes.length; index += 1) result = split(result, columnNodes[index], "horizontal");
  return result;
}

export function createPreset(preset: Preset): LayoutNode {
  if (preset === "single") return { kind: "pane", paneId: "pane-1" };
  if (preset === "split-2") return split({ kind: "pane", paneId: "pane-1" }, { kind: "pane", paneId: "pane-2" }, "horizontal");
  if (preset === "split-3") return split({ kind: "pane", paneId: "pane-1" }, split({ kind: "pane", paneId: "pane-2" }, { kind: "pane", paneId: "pane-3" }, "vertical"), "horizontal");
  if (preset === "grid-2x2") return makeGrid(2, 2);
  return makeGrid(3, 2);
}

export function setRatioAtPath(node: LayoutNode, path: number[], ratio: number): LayoutNode {
  if (path.length === 0 && node.kind === "split") return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  if (node.kind === "pane" || path.length === 0) return node;
  const [head, ...tail] = path;
  return head === 0
    ? { ...node, first: setRatioAtPath(node.first, tail, ratio) }
    : { ...node, second: setRatioAtPath(node.second, tail, ratio) };
}

export function splitPane(node: LayoutNode, paneId: string, orientation: Orientation): LayoutNode {
  if (node.kind === "pane") {
    if (node.paneId !== paneId) return node;
    return split(node, { kind: "pane", paneId: createPaneId() }, orientation);
  }
  return { ...node, first: splitPane(node.first, paneId, orientation), second: splitPane(node.second, paneId, orientation) };
}

export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "pane") return node.paneId === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
