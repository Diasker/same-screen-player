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

export type ProxyMode = "system" | "direct" | "custom";

export type PaneProxyMode = "inherit" | "direct" | "custom";

export type HttpProxyEndpoint = {
  host: string;
  port: number;
  bypassList: string;
  bypassLocal: boolean;
};

export type GlobalProxySettings = {
  mode: ProxyMode;
  custom: HttpProxyEndpoint;
};

export type PaneProxySettings = {
  mode: PaneProxyMode;
  custom: HttpProxyEndpoint;
};

export type ElectronProxySettings = {
  mode: "system" | "direct" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
};

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
  proxy: PaneProxySettings;
  proxyAutoIsolated: boolean;
  error?: string;
};

export type PersistedLayout = {
  version: 1;
  layout: LayoutNode;
};

export const MAX_PANES = 6;

export function defaultHttpProxyEndpoint(): HttpProxyEndpoint {
  return { host: "", port: 8080, bypassList: "", bypassLocal: true };
}

export function defaultGlobalProxySettings(): GlobalProxySettings {
  return { mode: "system", custom: defaultHttpProxyEndpoint() };
}

export function defaultPaneProxySettings(): PaneProxySettings {
  return { mode: "inherit", custom: defaultHttpProxyEndpoint() };
}

function normalizeBypassList(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const entries = value.split(";").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => {
    if (/[\u0000-\u001f\u007f]/.test(entry) || entry.includes("/") || entry.includes("\\")) return true;
    if (entry.toLowerCase() === "<local>") return false;
    return !/^[a-zA-Z0-9*?.:_\-[\]]+$/.test(entry);
  })) return null;
  const uniqueEntries: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEntries.push(entry);
  }
  return uniqueEntries.join(";");
}

export function normalizeHttpProxyEndpoint(value: unknown): HttpProxyEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.host !== "string" || source.host.trim().length === 0 || source.host.trim().length > 253) return null;
  const host = source.host.trim();
  const validHost = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) || /^\[[0-9a-fA-F:]+\]$/.test(host);
  if (!validHost || host.includes("/") || host.includes("\\")) return null;
  const port = typeof source.port === "number" ? source.port : typeof source.port === "string" && /^\d+$/.test(source.port.trim()) ? Number(source.port.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const bypassList = normalizeBypassList(source.bypassList);
  if (bypassList === null || typeof source.bypassLocal !== "boolean") return null;
  return { host, port, bypassList, bypassLocal: source.bypassLocal };
}

export function normalizeGlobalProxySettings(value: unknown): GlobalProxySettings | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.mode !== "system" && source.mode !== "direct" && source.mode !== "custom") return null;
  const custom = normalizeHttpProxyEndpoint(source.custom) ?? (source.mode === "custom" ? null : defaultHttpProxyEndpoint());
  if (!custom) return null;
  return { mode: source.mode, custom };
}

export function normalizePaneProxySettings(value: unknown): PaneProxySettings | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.mode !== "inherit" && source.mode !== "direct" && source.mode !== "custom") return null;
  const custom = normalizeHttpProxyEndpoint(source.custom) ?? (source.mode === "custom" ? null : defaultHttpProxyEndpoint());
  if (!custom) return null;
  return { mode: source.mode, custom };
}

export function resolveProxySettings(global: GlobalProxySettings, pane: PaneProxySettings): GlobalProxySettings {
  if (pane.mode === "inherit") return global;
  if (pane.mode === "direct") return { mode: "direct", custom: pane.custom };
  return { mode: "custom", custom: pane.custom };
}

export function resolvePaneProxySession(sessionMode: SessionMode, proxyAutoIsolated: boolean, paneProxyMode: PaneProxyMode): { sessionMode: SessionMode; proxyAutoIsolated: boolean } {
  if (paneProxyMode !== "inherit" && sessionMode === "shared") return { sessionMode: "isolated", proxyAutoIsolated: true };
  if (paneProxyMode === "inherit" && sessionMode === "isolated" && proxyAutoIsolated) return { sessionMode: "shared", proxyAutoIsolated: false };
  return { sessionMode, proxyAutoIsolated: sessionMode === "isolated" && proxyAutoIsolated };
}

export function toElectronProxySettings(settings: GlobalProxySettings): ElectronProxySettings {
  if (settings.mode === "system") return { mode: "system" };
  if (settings.mode === "direct") return { mode: "direct" };
  const endpoint = `${settings.custom.host}:${settings.custom.port}`;
  const bypassEntries = settings.custom.bypassList.split(";").map((entry) => entry.trim()).filter(Boolean);
  if (settings.custom.bypassLocal && !bypassEntries.some((entry) => entry.toLowerCase() === "<local>")) bypassEntries.push("<local>");
  const bypass = bypassEntries.join(";");
  return { mode: "fixed_servers", proxyRules: `http=${endpoint};https=${endpoint}`, ...(bypass ? { proxyBypassRules: bypass } : {}) };
}

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

export function swapPanePositions(node: LayoutNode, firstPaneId: string, secondPaneId: string): LayoutNode {
  if (firstPaneId === secondPaneId) return node;
  const paneIds = getPaneIds(node);
  if (!paneIds.includes(firstPaneId) || !paneIds.includes(secondPaneId)) return node;
  const replace = (current: LayoutNode): LayoutNode => {
    if (current.kind === "pane") {
      if (current.paneId === firstPaneId) return { ...current, paneId: secondPaneId };
      if (current.paneId === secondPaneId) return { ...current, paneId: firstPaneId };
      return current;
    }
    return { ...current, first: replace(current.first), second: replace(current.second) };
  };
  return replace(node);
}

export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "pane") return node.paneId === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
