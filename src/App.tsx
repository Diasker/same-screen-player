import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdblockStatus, BlockedNavigation } from "./shared/adblock";
import type { CSSProperties, ReactElement } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  MAX_PANES,
  createPreset,
  defaultGlobalProxySettings,
  defaultPaneProxySettings,
  getPaneIds,
  isLayoutNode,
  normalizeGlobalProxySettings,
  normalizeHttpProxyEndpoint,
  normalizeNetworkUrl,
  removePane,
  resolvePaneProxySession,
  setRatioAtPath,
  splitPane,
  swapPanePositions,
  type InteractionMode,
  type CloudflareStatus,
  type GlobalProxySettings,
  type HttpProxyEndpoint,
  type LayoutNode,
  type Orientation,
  type PaneProxyMode,
  type PaneProxySettings,
  type PaneRuntime,
  type PlaybackSnapshot,
  type PlayerStatus,
  type Preset,
} from "./shared/types";
import { resolveEscapeAction, toggleInteractionMode } from "./shared/interaction";
import { shouldShowPaneNotice } from "./shared/debug-overlays";
import { httpLoadError, networkLoadError, samePageUrl, playbackResolvesHttpError, type PageLoadError } from "./shared/load-errors";

type WebviewElement = HTMLElement & {
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  send: (channel: string, ...args: unknown[]) => void;
  getWebContentsId: () => number;
  getURL: () => string;
};

type StableWebviewProps = {
  partition: string;
  preload: string;
  onRef: (element: HTMLElement | null) => void;
};

const StableWebview = memo(function StableWebview({ partition, preload, onRef }: StableWebviewProps): ReactElement {
  return (
    <webview
      ref={onRef}
      className="video-webview"
      src="about:blank"
      preload={preload}
      partition={partition}
      allowpopups={true}
      allowFullScreen={true}
      webpreferences="contextIsolation=yes,sandbox=yes"
    />
  );
});

type LayoutBounds = { left: number; top: number; width: number; height: number };
type PaneRect = LayoutBounds & { paneId: string };
type DividerRect = LayoutBounds & { path: number[]; orientation: Orientation; parentBounds: LayoutBounds };

function emptyPlayback(): PlaybackSnapshot {
  return { playing: false, currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: true, hasVideo: false, videoWidth: 0, videoHeight: 0, readyState: 0, playerWidth: 0, playerHeight: 0, rate: 1 };
}

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CUSTOM_RATE_VALUE = "custom";
const FONT_SCALE_OPTIONS = [0.8, 0.9, 1, 1.1, 1.25, 1.4];
const FONT_SCALE_STORAGE_KEY = "same-screen-player.font-scale";

function initialFontScale(): number {
  if (typeof window === "undefined") return 1;
  try {
    const value = Number(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY));
    return FONT_SCALE_OPTIONS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

function makeRuntime(paneId: string): PaneRuntime {
  return {
    paneId,
    url: "",
    mediaSource: "network",
    sessionMode: "shared",
    muted: true,
    adblockEnabled: true,
    playing: false,
    playerStatus: "idle",
    playback: emptyPlayback(),
    userPauseIntent: false,
    focusModeEnabled: false,
    cloudflareStatus: "none",
    proxy: defaultPaneProxySettings(),
    proxyAutoIsolated: false,
  };
}

type LocalVideoSelection =
  | { ok: true; url: string; fileName: string }
  | { ok: false; canceled: boolean; message?: string };

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function collectGeometry(node: LayoutNode, bounds: LayoutBounds, path: number[], panes: PaneRect[], dividers: DividerRect[]): void {
  if (node.kind === "pane") {
    panes.push({ ...bounds, paneId: node.paneId });
    return;
  }
  const ratio = Math.min(0.9, Math.max(0.1, node.ratio));
  if (node.orientation === "horizontal") {
    const firstWidth = bounds.width * ratio;
    dividers.push({ left: bounds.left + firstWidth, top: bounds.top, width: 0, height: bounds.height, path, orientation: node.orientation, parentBounds: bounds });
    collectGeometry(node.first, { left: bounds.left, top: bounds.top, width: firstWidth, height: bounds.height }, [...path, 0], panes, dividers);
    collectGeometry(node.second, { left: bounds.left + firstWidth, top: bounds.top, width: bounds.width - firstWidth, height: bounds.height }, [...path, 1], panes, dividers);
  } else {
    const firstHeight = bounds.height * ratio;
    dividers.push({ left: bounds.left, top: bounds.top + firstHeight, width: bounds.width, height: 0, path, orientation: node.orientation, parentBounds: bounds });
    collectGeometry(node.first, { left: bounds.left, top: bounds.top, width: bounds.width, height: firstHeight }, [...path, 0], panes, dividers);
    collectGeometry(node.second, { left: bounds.left, top: bounds.top + firstHeight, width: bounds.width, height: bounds.height - firstHeight }, [...path, 1], panes, dividers);
  }
}

function getGeometry(layout: LayoutNode): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  collectGeometry(layout, { left: 0, top: 0, width: 1, height: 1 }, [], panes, dividers);
  return { panes, dividers };
}

function normalizePlayback(value: unknown, previous: PlaybackSnapshot): PlaybackSnapshot {
  if (!value || typeof value !== "object") return previous;
  const next = value as Partial<PlaybackSnapshot>;
  return {
    playing: Boolean(next.playing),
    currentTime: typeof next.currentTime === "number" && Number.isFinite(next.currentTime) ? Math.max(0, next.currentTime) : previous.currentTime,
    duration: typeof next.duration === "number" && Number.isFinite(next.duration) ? Math.max(0, next.duration) : previous.duration,
    buffered: typeof next.buffered === "number" && Number.isFinite(next.buffered) ? Math.max(0, next.buffered) : previous.buffered,
    volume: typeof next.volume === "number" && Number.isFinite(next.volume) ? Math.min(1, Math.max(0, next.volume)) : previous.volume,
    muted: Boolean(next.muted),
    hasVideo: Boolean(next.hasVideo),
    videoWidth: typeof next.videoWidth === "number" && Number.isFinite(next.videoWidth) ? Math.max(0, next.videoWidth) : previous.videoWidth,
    videoHeight: typeof next.videoHeight === "number" && Number.isFinite(next.videoHeight) ? Math.max(0, next.videoHeight) : previous.videoHeight,
    readyState: typeof next.readyState === "number" && Number.isFinite(next.readyState) ? Math.max(0, next.readyState) : previous.readyState,
    playerWidth: typeof next.playerWidth === "number" && Number.isFinite(next.playerWidth) ? Math.max(0, next.playerWidth) : previous.playerWidth,
    playerHeight: typeof next.playerHeight === "number" && Number.isFinite(next.playerHeight) ? Math.max(0, next.playerHeight) : previous.playerHeight,
    rate: typeof next.rate === "number" && Number.isFinite(next.rate) && next.rate > 0 ? next.rate : previous.rate,
  };
}

type PaneViewProps = {
  runtime: PaneRuntime;
  active: boolean;
  guestPreloadUrl: string;
  onActive: () => void;
  onNavigate: (value: string) => void;
  onUpdate: (patch: Partial<PaneRuntime>) => void;
  onSplit: (orientation: Orientation) => void;
  onRemove: () => void;
  onOpenChrome: () => void;
  onProxyChange: (settings: PaneProxySettings) => void;
  interactionMode: InteractionMode;
  debugOverlays: boolean;
};

function isAuthenticationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
    return host === "accounts.google.com" || host.endsWith(".accounts.google.com") || host === "google.com" || host.endsWith(".google.com") || host === "passport.bilibili.com" || ((host === "bilibili.com" || host.endsWith(".bilibili.com")) && /login|signin|passport|auth|account/.test(pathAndQuery));
  } catch {
    return false;
  }
}

function authenticationUrlFor(value: string): string | null {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
    if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return "https://passport.bilibili.com/pc/passport/login";
    return null;
  } catch {
    return null;
  }
}

const PaneView = memo(function PaneView(props: PaneViewProps): ReactElement {
  const { runtime } = props;
  const partition = partitionFor(runtime);
  const webviewRef = useRef<WebviewElement | null>(null);
  const webviewReadyRef = useRef(false);
  const navigationRequestedRef = useRef(false);
  const navigationUrlRef = useRef(runtime.url);
  const requestedUrlRef = useRef(runtime.url);
  const pageLoadErrorRef = useRef<PageLoadError | null>(null);
  const [pageLoadError, setPageLoadError] = useState<PageLoadError | null>(null);
  const runtimeRef = useRef(runtime);
  const activeRef = useRef(props.active);
  const onUpdateRef = useRef(props.onUpdate);
  const onActiveRef = useRef(props.onActive);
  const [draftUrl, setDraftUrl] = useState(runtime.url);
  const [showControls, setShowControls] = useState(false);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false });
  const [proxyEditorOpen, setProxyEditorOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<HttpProxyEndpoint>(() => ({ ...runtime.proxy.custom }));
  const [proxyEditorError, setProxyEditorError] = useState<string | null>(null);
  const [popupNotice, setPopupNotice] = useState<BlockedNavigation | null>(null);
  const [adblockStatus, setAdblockStatus] = useState<AdblockStatus | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  runtimeRef.current = runtime;
  activeRef.current = props.active;
  onUpdateRef.current = props.onUpdate;
  onActiveRef.current = props.onActive;
  const isLocalVideo = runtime.mediaSource === "local";

  if (requestedUrlRef.current !== runtime.url) {
    requestedUrlRef.current = runtime.url;
    navigationUrlRef.current = runtime.url;
    pageLoadErrorRef.current = null;
  }

  const updateLoadError = useCallback((error: PageLoadError | null) => {
    pageLoadErrorRef.current = error;
    setPageLoadError(error);
    if (error) onUpdateRef.current({ playerStatus: error.kind === "crashed" ? "crashed" : "blocked", error: error.message });
  }, []);

  useEffect(() => {
    navigationUrlRef.current = runtime.url;
    updateLoadError(null);
  }, [runtime.url, runtime.mediaSource, partition, updateLoadError]);

  const hideControls = useCallback(() => {
    if (controlsHideTimerRef.current !== null) window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
    setShowControls(false);
  }, []);
  const revealControls = useCallback(() => {
    setShowControls(true);
    if (controlsHideTimerRef.current !== null) window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      setShowControls(false);
    }, 4500);
  }, []);

  useEffect(() => () => {
    if (controlsHideTimerRef.current !== null) window.clearTimeout(controlsHideTimerRef.current);
  }, []);

  useEffect(() => {
    const offBlocked = window.desktop.onAdblockBlocked(event => {
      if (event.paneId === runtime.paneId) { setPopupNotice(event); setAllowError(null); }
    });
    const offStatus = window.desktop.onAdblockStatus(setAdblockStatus);
    let disposed = false;
    void window.desktop.getAdblockStatus().then(value => { if (!disposed) setAdblockStatus(value); });
    return () => { disposed = true; offBlocked(); offStatus(); };
  }, [runtime.paneId]);
  useEffect(() => { setPopupNotice(null); setAllowError(null); }, [runtime.url, partition]);

  const setWebviewRef = useCallback((element: HTMLElement | null) => {
    const nextWebview = element as WebviewElement | null;
    if (webviewRef.current !== nextWebview) {
      webviewReadyRef.current = false;
      navigationRequestedRef.current = false;
      setNavigationState({ canGoBack: false, canGoForward: false });
    }
    webviewRef.current = nextWebview;
  }, []);

  const syncNavigationState = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !webviewReadyRef.current) {
      setNavigationState((current) => current.canGoBack || current.canGoForward ? { canGoBack: false, canGoForward: false } : current);
      return;
    }
    try {
      const next = { canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() };
      setNavigationState((current) => current.canGoBack === next.canGoBack && current.canGoForward === next.canGoForward ? current : next);
    } catch {
      setNavigationState((current) => current.canGoBack || current.canGoForward ? { canGoBack: false, canGoForward: false } : current);
    }
  }, []);

  const navigateHistory = useCallback((direction: "back" | "forward") => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      if (direction === "back" && navigationState.canGoBack) webview.goBack();
      if (direction === "forward" && navigationState.canGoForward) webview.goForward();
    } catch {
    }
  }, [navigationState.canGoBack, navigationState.canGoForward]);

  useEffect(() => setDraftUrl(runtime.mediaSource === "local" ? "" : runtime.url), [runtime.mediaSource, runtime.url]);

  useEffect(() => {
    if (runtime.mediaSource === "local" || !runtime.url) return;
    const host = hostFromUrl(runtime.url);
    if (!host) return;
    void window.desktop.getAdblock(runtime.paneId, host).then((enabled) => {
      if (runtimeRef.current.url === runtime.url && runtimeRef.current.mediaSource === "network") onUpdateRef.current({ adblockEnabled: enabled });
    }).catch(() => undefined);
  }, [runtime.mediaSource, runtime.paneId, runtime.url]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      webview.send("pane-activity", props.active);
      webview.send("set-focus-mode", runtime.focusModeEnabled);
    } catch {
    }
  }, [props.active, runtime.focusModeEnabled]);

  useEffect(() => {
    void window.desktop.setChallengeMode(runtime.paneId, !isLocalVideo && (runtime.cloudflareStatus === "detected" || runtime.cloudflareStatus === "looped"));
  }, [runtime.paneId, runtime.cloudflareStatus, isLocalVideo]);

  useEffect(() => {
    if (runtime.mediaSource === "local") return;
    if (runtime.cloudflareStatus !== "detected" && runtime.cloudflareStatus !== "looped") return;
    const timer = window.setTimeout(() => {
      void window.desktop.inspectFingerprint(runtime.paneId);
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [runtime.paneId, runtime.cloudflareStatus, runtime.mediaSource]);

  useEffect(() => {
    if (props.interactionMode === "web") hideControls();
  }, [props.interactionMode, hideControls]);

  useEffect(() => {
    setProxyDraft({ ...runtime.proxy.custom });
  }, [runtime.proxy.custom]);

  useEffect(() => {
    if (runtime.mediaSource === "local") return;
    const webview = webviewRef.current;
    if (!webview || !webviewReadyRef.current || !runtime.url) return;
    void window.desktop.setPaneProxy(runtime.paneId, runtime.proxy).then((result) => {
      const value = result as { ok?: boolean; message?: string };
      if (!value.ok) props.onUpdate({ error: value.message || "应用分屏代理失败" });
    }).catch((error) => props.onUpdate({ error: error instanceof Error ? error.message : "应用分屏代理失败" }));
  }, [runtime.paneId, runtime.proxy, runtime.url, partition, runtime.mediaSource]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !runtime.url || !webviewReadyRef.current) return;
    navigationRequestedRef.current = true;
    if (runtime.mediaSource === "local") {
      void window.desktop.loadLocalVideo(runtime.paneId, runtime.url).then((result) => {
        const value = result as { ok?: boolean; message?: string };
        if (!value.ok && runtimeRef.current.mediaSource === "local" && runtimeRef.current.url === runtime.url && !runtimeRef.current.playback.hasVideo) onUpdateRef.current({ playerStatus: "blocked", error: value.message || "本地视频无法加载" });
      }).catch(() => {
        if (runtimeRef.current.mediaSource === "local" && runtimeRef.current.url === runtime.url && !runtimeRef.current.playback.hasVideo) onUpdateRef.current({ playerStatus: "blocked", error: "本地视频无法加载" });
      });
      return;
    }
    try {
      void webview.loadURL(runtime.url).catch(() => undefined);
    } catch {
      webviewReadyRef.current = false;
      navigationRequestedRef.current = false;
    }
  }, [runtime.mediaSource, runtime.paneId, runtime.sessionMode, runtime.url]);

  useEffect(() => {
    const webview = webviewRef.current;
    const host = webview?.parentElement;
    if (!webview || !host || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const notifyResize = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        try {
          webview.send("host-resize", { width: host.clientWidth, height: host.clientHeight });
        } catch {
        }
      });
    };
    const observer = new ResizeObserver(notifyResize);
    observer.observe(host);
    notifyResize();
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [runtime.url, partition]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const onIpcMessage = (event: Event) => {
      const message = event as Event & { channel?: string; args?: unknown[] };
      const currentRuntime = runtimeRef.current;
      if (webviewRef.current !== webview) return;
      if (message.channel === "video-state" || message.channel === "player-status" || message.channel === "challenge-state") {
        try {
          if (!samePageUrl(webview.getURL(), navigationUrlRef.current)) return;
        } catch {
          return;
        }
      }
      if (message.channel === "pane-focus") {
        onActiveRef.current();
        return;
      }
      if (message.channel === "controls-visibility") {
        if (props.interactionMode !== "app") return;
        if (Boolean(message.args?.[0])) revealControls();
        else hideControls();
        return;
      }
      if (message.channel === "video-state") {
        const value = (message.args?.[0] ?? {}) as { userPauseIntent?: unknown };
        const playback = normalizePlayback(value, currentRuntime.playback);
        if (pageLoadErrorRef.current) {
          if (!playbackResolvesHttpError(pageLoadErrorRef.current, navigationUrlRef.current, playback)) return;
          updateLoadError(null);
        }
        const patch: Partial<PaneRuntime> = { playback, playing: playback.playing };
        // Observations update the controls; they must never echo a mute command.
        if (playback.hasVideo) patch.muted = playback.muted;
        if (typeof value.userPauseIntent === "boolean") patch.userPauseIntent = value.userPauseIntent;
        if (playback.hasVideo) {
          patch.playerStatus = "ready";
          patch.error = undefined;
        } else if (currentRuntime.playerStatus === "idle" || currentRuntime.playerStatus === "loading") {
          patch.playerStatus = "loading";
        }
        onUpdateRef.current(patch);
        return;
      }
      if (message.channel === "challenge-state") {
        const value = (message.args?.[0] ?? {}) as { status?: unknown; url?: unknown; navigationCount?: unknown; message?: unknown };
        const status = typeof value.status === "string" && ["none", "detected", "passed", "looped"].includes(value.status) ? value.status as CloudflareStatus : "none";
        const messageText = typeof value.message === "string" ? value.message : undefined;
        if (pageLoadErrorRef.current) {
          if (pageLoadErrorRef.current.kind === "http" && (status === "detected" || status === "looped")) updateLoadError(null);
          else return;
        }
        void window.desktop.reportChallengeState(currentRuntime.paneId, value);
        if (status === "detected") {
          onUpdateRef.current({ cloudflareStatus: status, playerStatus: "challenge", error: undefined });
        } else if (status === "looped") {
          onUpdateRef.current({ cloudflareStatus: status, playerStatus: "challenge", error: "验证仍在循环，应用已停止自动刷新。" });
        } else if (status === "passed") {
          onUpdateRef.current({ cloudflareStatus: status, playerStatus: "loading", error: messageText });
        } else {
          onUpdateRef.current({ cloudflareStatus: status });
        }
        return;
      }
      if (message.channel === "player-status") {
        if (pageLoadErrorRef.current) return;
        const value = (message.args?.[0] ?? {}) as { status?: PlayerStatus; message?: string };
        const status = value.status && ["idle", "loading", "ready", "unrecognized", "challenge", "blocked", "crashed"].includes(value.status) ? value.status : "loading";
        const error = status === "challenge" ? "请在当前分屏完成 Cloudflare 验证" : value.message || (status === "ready" ? undefined : currentRuntime.error);
        onUpdateRef.current({ playerStatus: status, error });
        return;
      }
      if (message.channel === "focus-diagnostic") {
        if (typeof window.desktop.logFocusDiagnostic === "function") {
          void window.desktop.logFocusDiagnostic(currentRuntime.paneId, message.args?.[0]);
        }
        return;
      }
      if (message.channel === "request-exit-fullscreen") void window.desktop.exitWebpageFullscreen(currentRuntime.paneId);
    };
    const onDomReady = () => {
      const currentRuntime = runtimeRef.current;
      void window.desktop.registerPane(currentRuntime.paneId, webview.getWebContentsId(), partitionFor(currentRuntime), currentRuntime.url, currentRuntime.proxy).then((registered) => {
        if (webviewRef.current !== webview || !registered) {
          if (!registered) onUpdateRef.current({ error: "分屏网络配置失败" });
          return;
        }
        webviewReadyRef.current = true;
        syncNavigationState();
        void window.desktop.setChallengeMode(currentRuntime.paneId, currentRuntime.mediaSource !== "local" && (currentRuntime.cloudflareStatus === "detected" || currentRuntime.cloudflareStatus === "looped"));
        try {
          webview.send("pane-activity", activeRef.current);
          webview.send("set-mute", currentRuntime.muted);
          webview.send("set-focus-mode", currentRuntime.focusModeEnabled);
        } catch {
        }
        const latestRuntime = runtimeRef.current;
        if (latestRuntime.url && !navigationRequestedRef.current) {
          navigationRequestedRef.current = true;
          if (latestRuntime.mediaSource === "local") {
            void window.desktop.loadLocalVideo(latestRuntime.paneId, latestRuntime.url).then((result) => {
              const value = result as { ok?: boolean; message?: string };
              if (!value.ok && runtimeRef.current.mediaSource === "local" && runtimeRef.current.url === latestRuntime.url && !runtimeRef.current.playback.hasVideo) onUpdateRef.current({ playerStatus: "blocked", error: value.message || "本地视频无法加载" });
            }).catch(() => {
              if (runtimeRef.current.mediaSource === "local" && runtimeRef.current.url === latestRuntime.url && !runtimeRef.current.playback.hasVideo) onUpdateRef.current({ playerStatus: "blocked", error: "本地视频无法加载" });
            });
            return;
          }
          try {
            void webview.loadURL(latestRuntime.url).catch(() => undefined);
          } catch {
            webviewReadyRef.current = false;
            navigationRequestedRef.current = false;
          }
        }
      }).catch((error) => onUpdateRef.current({ error: error instanceof Error ? error.message : "分屏网络配置失败" }));
    };
    const onNavigationStarted = (event: Event) => {
      const navigation = event as Event & { url?: string; isMainFrame?: boolean; isInPlace?: boolean };
      if (webviewRef.current !== webview || !navigation.isMainFrame || navigation.isInPlace || !navigation.url || navigation.url === "about:blank") return;
      navigationUrlRef.current = navigation.url;
      updateLoadError(null);
      onUpdateRef.current({ playerStatus: "loading", error: undefined, cloudflareStatus: "none", playback: emptyPlayback(), playing: false });
    };
    const onRedirect = (event: Event) => {
      const navigation = event as Event & { url?: string; isMainFrame?: boolean };
      if (webviewRef.current === webview && navigation.isMainFrame && navigation.url) navigationUrlRef.current = navigation.url;
    };
    const onNavigation = (event: Event) => {
      const navigation = event as Event & { url?: string; httpResponseCode?: number; isMainFrame?: boolean };
      if (webviewRef.current !== webview || navigation.isMainFrame === false || !navigation.url) return;
      if (event.type === "did-navigate-in-page") navigationUrlRef.current = navigation.url;
      if (!samePageUrl(navigation.url, navigationUrlRef.current)) return;
      if (runtimeRef.current.mediaSource === "network" && /^https?:\/\//i.test(navigation.url)) {
        setDraftUrl(navigation.url);
        const error = httpLoadError(navigation.url, navigation.httpResponseCode, navigationUrlRef.current);
        const challenge = runtimeRef.current.cloudflareStatus === "detected" || runtimeRef.current.cloudflareStatus === "looped";
        if (error && !challenge) updateLoadError(error);
      }
      window.setTimeout(syncNavigationState, 0);
    };
    const onFailedLoad = (event: Event) => {
      if (webviewRef.current !== webview) return;
      const failure = event as Event & { errorDescription?: string; errorCode?: number; isMainFrame?: boolean; validatedURL?: string };
      const error = networkLoadError(failure, navigationUrlRef.current);
      if (!error) return;
      const localFailure = runtimeRef.current.mediaSource === "local";
      if (localFailure && runtimeRef.current.playback.hasVideo) return;
      updateLoadError(localFailure ? { ...error, message: "本地视频无法加载，请确认文件未被删除、可访问且编码受支持" } : error);
    };
    const onProcessGone = () => {
      if (webviewRef.current === webview) updateLoadError({ kind: "crashed", url: navigationUrlRef.current, message: "网页进程已崩溃，请重新加载" });
    };
    const onFocus = () => onActiveRef.current();
    const onWebviewMouseMove = (event: Event) => {
      if (props.interactionMode !== "app") return;
      const mouse = event as MouseEvent;
      const bounds = webview.getBoundingClientRect();
      if (mouse.clientY >= bounds.bottom - 112) revealControls();
      else hideControls();
    };
    const onWebviewMouseLeave = () => {
      if (props.interactionMode === "app") hideControls();
    };
    webview.addEventListener("ipc-message", onIpcMessage);
    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("did-start-navigation", onNavigationStarted);
    webview.addEventListener("did-redirect-navigation", onRedirect);
    webview.addEventListener("did-frame-navigate", onNavigation);
    webview.addEventListener("did-navigate-in-page", onNavigation);
    webview.addEventListener("did-fail-load", onFailedLoad);
    webview.addEventListener("render-process-gone", onProcessGone);
    webview.addEventListener("focus", onFocus);
    webview.addEventListener("mousemove", onWebviewMouseMove);
    webview.addEventListener("mouseleave", onWebviewMouseLeave);
    return () => {
      webview.removeEventListener("ipc-message", onIpcMessage);
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("did-start-navigation", onNavigationStarted);
      webview.removeEventListener("did-redirect-navigation", onRedirect);
      webview.removeEventListener("did-frame-navigate", onNavigation);
      webview.removeEventListener("did-navigate-in-page", onNavigation);
      webview.removeEventListener("did-fail-load", onFailedLoad);
      webview.removeEventListener("render-process-gone", onProcessGone);
      webview.removeEventListener("focus", onFocus);
      webview.removeEventListener("mousemove", onWebviewMouseMove);
      webview.removeEventListener("mouseleave", onWebviewMouseLeave);
    };
  }, [runtime.paneId, runtime.url, partition, props.guestPreloadUrl, props.interactionMode, hideControls, revealControls, syncNavigationState, updateLoadError]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.interactionMode !== "app" || !props.active || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === "Space" || event.key.toLowerCase() === "m") {
        event.preventDefault();
        const isMute = event.key.toLowerCase() === "m";
        if (event.repeat && isMute) return;
        webviewRef.current?.send("video-command", isMute ? { type: "setMuted", value: !runtimeRef.current.muted } : { type: "toggle" });
        if (!isMute) onUpdateRef.current({ userPauseIntent: runtimeRef.current.playing });
        if (isMute) onUpdateRef.current({ muted: !runtimeRef.current.muted });
        return;
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        navigateHistory(event.key === "ArrowLeft" ? "back" : "forward");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.active, props.interactionMode, navigateHistory]);

  const submitUrl = () => {
    const normalized = normalizeNetworkUrl(draftUrl);
    if (!normalized) {
      props.onUpdate({ error: "请输入有效的 http 或 https 视频网址" });
      return;
    }
    setNavigationState({ canGoBack: false, canGoForward: false });
    props.onUpdate({ url: normalized, mediaSource: "network", localFileName: undefined, error: undefined, playerStatus: "loading", playback: emptyPlayback(), playing: false, userPauseIntent: false, focusModeEnabled: false, cloudflareStatus: "none" });
    props.onNavigate(normalized);
    setShowControls(false);
  };
  const selectLocalVideo = async () => {
    const result = await window.desktop.selectLocalVideo() as LocalVideoSelection;
    if (!result.ok) {
      if (!result.canceled) props.onUpdate({ error: result.message || "无法打开本地视频" });
      return;
    }
    setDraftUrl("");
    setNavigationState({ canGoBack: false, canGoForward: false });
    props.onUpdate({ url: result.url, mediaSource: "local", localFileName: result.fileName, error: undefined, playerStatus: "loading", playback: emptyPlayback(), playing: false, userPauseIntent: false, focusModeEnabled: false, cloudflareStatus: "none" });
    setShowControls(false);
  };
  const sendCommand = (command: unknown) => webviewRef.current?.send("video-command", command);
  const handleSeekChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    setSeekDraft(value);
    sendCommand({ type: "seek", value });
  };
  const commitSeek = () => {
    if (seekDraft === null) return;
    sendCommand({ type: "seek", value: seekDraft });
    setSeekDraft(null);
  };
  const togglePlay = () => {
    sendCommand({ type: runtime.playing ? "pause" : "play" });
    props.onUpdate({ userPauseIntent: runtime.playing });
  };
  const toggleMute = () => {
    const muted = !runtime.muted;
    sendCommand({ type: "setMuted", value: muted });
    props.onUpdate({ muted });
  };
  const toggleFocusMode = () => {
    const enabled = !runtime.focusModeEnabled;
    props.onUpdate({ focusModeEnabled: enabled });
    webviewRef.current?.send("set-focus-mode", enabled);
  };
  const openLogin = () => {
    if (isLocalVideo) return;
    const loginUrl = authenticationUrlFor(runtime.url);
    if (!loginUrl) return;
    if (/accounts\.google\.com/i.test(loginUrl)) {
      void window.desktop.openChromeLogin(loginUrl).then((result) => {
        const value = result as { ok?: boolean; message?: string };
        if (!value.ok) props.onUpdate({ error: value.message || "需要安装 Google Chrome 才能登录 YouTube" });
      });
      return;
    }
    void window.desktop.openAuthWindow(loginUrl, partition).then((opened) => {
      if (!opened) props.onUpdate({ error: "无法打开登录窗口，请重试" });
    });
  };
  const setVolume = (value: number) => {
    sendCommand({ type: "setVolume", value });
    if (runtime.muted && value > 0) props.onUpdate({ muted: false });
  };
  const handleRateChange = (value: string) => {
    if (value === CUSTOM_RATE_VALUE) {
      const entered = window.prompt("请输入播放倍速（0.25 - 4）", String(currentRate));
      if (entered === null) return;
      const parsed = Number(entered.trim());
      if (!Number.isFinite(parsed) || parsed < 0.25 || parsed > 4) {
        props.onUpdate({ error: "倍速必须是 0.25 到 4 之间的数字" });
        return;
      }
      sendCommand({ type: "setRate", value: parsed });
      props.onUpdate({ error: undefined });
      return;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) sendCommand({ type: "setRate", value: parsed });
  };
  const toggleAdblock = async () => {
    if (isLocalVideo) return;
    const host = hostFromUrl(runtime.url);
    const enabled = !runtime.adblockEnabled;
    if (host) await window.desktop.setAdblock(runtime.paneId, host, enabled);
    void window.desktop.setChallengeMode(runtime.paneId, false);
    props.onUpdate({ adblockEnabled: enabled, userPauseIntent: false, playerStatus: "loading", cloudflareStatus: "none", error: undefined });
    updateLoadError(null);
    webviewRef.current?.reload();
  };
  const reloadPane = () => {
    const failedUrl = pageLoadErrorRef.current?.url;
    updateLoadError(null);
    if (!isLocalVideo) void window.desktop.setChallengeMode(runtime.paneId, false);
    props.onUpdate({ userPauseIntent: false, playerStatus: "loading", cloudflareStatus: "none", error: undefined });
    if (failedUrl && !isLocalVideo) void webviewRef.current?.loadURL(failedUrl).catch(() => undefined);
    else webviewRef.current?.reload();
  };
  const openCurrentPageInChrome = () => {
    const url = navigationUrlRef.current;
    if (!/^https?:\/\//i.test(url)) return;
    void window.desktop.openInChrome(url).then((opened) => {
      if (!opened) props.onUpdate({ error: "未找到 Google Chrome" });
    });
  };
  const toggleSessionMode = () => {
    if (isLocalVideo) return;
    if (runtime.sessionMode === "isolated" && runtime.proxy.mode !== "inherit") {
      props.onUpdate({ error: "请先将分屏代理改为“跟随全局”，再切换共享会话" });
      return;
    }
    props.onUpdate({ sessionMode: runtime.sessionMode === "shared" ? "isolated" : "shared", proxyAutoIsolated: false, userPauseIntent: false, playerStatus: "loading", playback: emptyPlayback(), playing: false, focusModeEnabled: false, cloudflareStatus: "none", error: undefined });
  };
  const chooseProxyMode = (mode: PaneProxyMode) => {
    if (mode === "custom") {
      setProxyDraft({ ...runtime.proxy.custom });
      setProxyEditorError(null);
      setProxyEditorOpen(true);
      return;
    }
    setProxyEditorOpen(false);
    setProxyEditorError(null);
    props.onProxyChange({ mode, custom: runtime.proxy.custom });
  };
  const savePaneProxy = () => {
    const custom = normalizeHttpProxyEndpoint(proxyDraft);
    if (!custom) {
      setProxyEditorError("请输入有效的代理地址和 1–65535 端口");
      return;
    }
    setProxyEditorOpen(false);
    setProxyEditorError(null);
    props.onProxyChange({ mode: "custom", custom });
  };
  const handleMouseMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!runtime.url) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientY >= bounds.bottom - 110) revealControls();
  };
  const duration = runtime.playback.duration > 0 ? runtime.playback.duration : 1;
  const bufferedPercent = runtime.playback.duration > 0 ? Math.min(100, Math.max(0, runtime.playback.buffered / runtime.playback.duration * 100)) : 0;
  const currentRate = Number.isFinite(runtime.playback.rate) && runtime.playback.rate > 0 ? runtime.playback.rate : 1;
  const rateOptions = RATE_OPTIONS.includes(currentRate) ? RATE_OPTIONS : [...RATE_OPTIONS, currentRate].sort((a, b) => a - b);
  const decoderIssue = runtime.playback.hasVideo && runtime.playback.readyState >= 2 && (runtime.playback.videoWidth === 0 || runtime.playback.videoHeight === 0);
  const renderIssue = runtime.focusModeEnabled && runtime.playerStatus === "ready" && runtime.playback.hasVideo && runtime.playback.videoWidth > 0 && runtime.playback.videoHeight > 0 && (runtime.playback.playerWidth <= 2 || runtime.playback.playerHeight <= 2);
  const hasPaneNotice = Boolean(runtime.error || runtime.playerStatus === "unrecognized" || runtime.playerStatus === "challenge" || runtime.cloudflareStatus === "detected" || runtime.cloudflareStatus === "looped");
  const visibleLoadError = pageLoadErrorRef.current === pageLoadError ? pageLoadError : null;
  const showPaneNotice = Boolean(visibleLoadError) || shouldShowPaneNotice({ debugOverlays: props.debugOverlays, interactionMode: props.interactionMode, hasContent: Boolean(runtime.url), hasNotice: hasPaneNotice });

  return (
    <div className={`video-pane ${props.active ? "active" : ""} ${props.interactionMode === "app" ? "app-input-mode" : "web-input-mode"}`} onPointerDown={props.onActive} onPointerMove={handleMouseMove} onMouseLeave={() => runtime.url && hideControls()}>
      {runtime.url ? (
        <div className="video-webview-host">
          <StableWebview key={partition} partition={partition} preload={props.guestPreloadUrl} onRef={setWebviewRef} />
        </div>
      ) : (
        <div className="empty-pane">
          <div className="empty-icon">＋</div>
          <div className="empty-title">添加视频</div>
          <div className="empty-subtitle">输入网页视频地址，或选择本地视频文件</div>
          <UrlEditor value={draftUrl} onChange={setDraftUrl} onSubmit={submitUrl} placeholder="粘贴视频网址…" />
          <button className="local-video-button" onClick={() => void selectLocalVideo()}>打开本地视频</button>
        </div>
      )}
      {runtime.url && props.interactionMode === "app" && <div className="pane-control-trigger" onPointerEnter={revealControls} onPointerLeave={(event) => {
        const related = event.relatedTarget as Node | null;
        if (!related || !(related instanceof HTMLElement && related.closest(".pane-controls"))) hideControls();
      }} />}
      {runtime.url && props.interactionMode === "app" && showControls && (
        <div className="pane-controls" onPointerDown={(event) => event.stopPropagation()} onPointerMove={revealControls} onPointerLeave={(event) => {
          const related = event.relatedTarget as Node | null;
          if (!related || !(related instanceof HTMLElement && related.closest(".pane-control-trigger"))) hideControls();
        }}>
          {runtime.playback.hasVideo && (
            <div className="media-controls">
              <button className="icon-button media-play" onClick={togglePlay} aria-label={runtime.playing ? "暂停视频" : "播放视频"}>{runtime.playing ? "暂停" : "播放"}</button>
              <span className="media-time">{formatTime(runtime.playback.currentTime)}</span>
              <input className="media-range media-seek" aria-label="播放进度" type="range" min={0} max={duration} step={0.1} value={seekDraft ?? Math.min(runtime.playback.currentTime, duration)} style={{ background: `linear-gradient(to right, #69d6bf ${bufferedPercent}%, #344052 ${bufferedPercent}%)` }} onChange={(event) => handleSeekChange(Number(event.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
              <span className="media-time">{formatTime(runtime.playback.duration)}</span>
              <input className="media-range media-volume" aria-label="音量" type="range" min={0} max={1} step={0.01} value={runtime.muted ? 0 : runtime.playback.volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <button className={`icon-button ${runtime.muted ? "selected" : ""}`} onClick={toggleMute} aria-label="切换静音">{runtime.muted ? "静音" : "有声"}</button>
              <select className="media-rate" aria-label="播放倍速" value={String(currentRate)} onChange={(event) => handleRateChange(event.target.value)}>
                {rateOptions.map((rate) => <option key={rate} value={rate}>{rate === 1 ? "1x" : `${rate}x`}</option>)}
                <option value={CUSTOM_RATE_VALUE}>自定义…</option>
              </select>
            </div>
          )}
          <div className="pane-url-row">
            {isLocalVideo ? <><div className="local-file-label" title={runtime.localFileName}>{runtime.localFileName || "本地视频"}</div><input aria-label="网页视频网址" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitUrl()} placeholder="粘贴网页视频地址…" /><button className="icon-button primary" onClick={submitUrl}>打开网页</button></> : <><button className="icon-button history-button" onClick={() => navigateHistory("back")} disabled={!navigationState.canGoBack} aria-label="后退" title="后退">后退</button><button className="icon-button history-button" onClick={() => navigateHistory("forward")} disabled={!navigationState.canGoForward} aria-label="前进" title="前进">前进</button><input aria-label="视频网址" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitUrl()} placeholder="输入视频网址…" /><button className="icon-button primary" onClick={submitUrl}>打开</button></>}
          </div>
          <div className="pane-actions">
            <button className="icon-button" onClick={reloadPane}>刷新</button>
            <button className="icon-button" onClick={() => void selectLocalVideo()}>本地视频</button>
            {!isLocalVideo && <button className={`icon-button ${runtime.adblockEnabled ? "selected" : "warning"}`} onClick={() => void toggleAdblock()}>{runtime.adblockEnabled ? "拦截" : "放行"}</button>}
            <button className="icon-button" onClick={() => props.onSplit("horizontal")}>左右分屏</button>
            <button className="icon-button" onClick={() => props.onSplit("vertical")}>上下分屏</button>
            {!isLocalVideo && <button className="icon-button" onClick={toggleSessionMode} disabled={runtime.sessionMode === "isolated" && runtime.proxy.mode !== "inherit"} title={runtime.sessionMode === "isolated" && runtime.proxy.mode !== "inherit" ? "请先改为跟随全局代理" : undefined}>{runtime.sessionMode === "shared" ? "共享会话" : "独立会话"}</button>}
            {!isLocalVideo && authenticationUrlFor(runtime.url) && <button className="icon-button" onClick={openLogin}>登录</button>}
            <button className={`icon-button ${runtime.focusModeEnabled ? "selected" : "warning"}`} onClick={toggleFocusMode}>{runtime.focusModeEnabled ? "专注模式" : "网页原始模式"}</button>
            {!isLocalVideo && <select className="pane-proxy-select" aria-label="分屏代理" value={runtime.proxy.mode} onChange={(event) => chooseProxyMode(event.target.value as PaneProxyMode)}>
              <option value="inherit">跟随全局代理</option>
              <option value="direct">分屏直连</option>
              <option value="custom">分屏自定义 HTTP</option>
            </select>
            }
            {!isLocalVideo && runtime.playerStatus === "blocked" && <button className="icon-button warning" onClick={openCurrentPageInChrome}>用 Chrome 打开</button>}
            <button className="icon-button" onClick={hideControls}>收起</button>
            <button className="icon-button danger" onClick={props.onRemove}>关闭</button>
          </div>
          {!isLocalVideo && adblockStatus && <div className="adblock-status" role="status">
            {adblockStatus.state === "unavailable" ? "广告规则不可用" : adblockStatus.source === "bundled" ? "使用内置广告规则" : adblockStatus.source === "cache" ? "使用缓存广告规则" : "广告规则已更新"}
            {adblockStatus.updatedAt && ` · ${new Date(adblockStatus.updatedAt).toLocaleString()}`}
            {adblockStatus.message && ` · ${adblockStatus.message}`}
          </div>}
          {runtime.proxyAutoIsolated && <div className="proxy-isolation-note">此分屏使用独立代理，Cookie 不再与共享会话同步；改回“跟随全局代理”可恢复共享。</div>}
          {runtime.error && <div className="pane-error">{runtime.error}</div>}
          {runtime.playerStatus === "unrecognized" && !runtime.error && <div className="pane-error">无法识别播放器，已保留网页兼容画面。</div>}
          {runtime.cloudflareStatus === "detected" && <div className="pane-error">检测到 Cloudflare 验证，已放行验证资源，请在当前页面完成验证。</div>}
          {runtime.cloudflareStatus === "looped" && <div className="pane-error">验证仍在循环，应用已停止自动刷新。</div>}
          {decoderIssue && <div className="pane-error">视频尚未解码，当前视频尺寸无效；可切换“网页原始模式”重试。</div>}
          {renderIssue && <div className="pane-error">视频层渲染异常；可切换“网页原始模式”恢复站点原生布局。</div>}
        </div>
      )}
      {runtime.url && !isLocalVideo && props.interactionMode === "app" && proxyEditorOpen && (
        <div className="proxy-popover pane-proxy-popover" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-label="分屏代理设置">
          <div className="proxy-popover-title">分屏自定义 HTTP 代理</div>
          {runtime.sessionMode === "shared" && <div className="proxy-form-hint warning">保存后会自动切换到独立会话，此分屏将不再共享 Cookie。</div>}
          <label className="proxy-checkbox"><input type="checkbox" checked onChange={() => { setProxyEditorOpen(false); props.onProxyChange({ mode: "direct", custom: proxyDraft }); }} />使用代理服务器</label>
          <ProxyEndpointFields value={proxyDraft} onChange={setProxyDraft} />
          {proxyEditorError && <div className="proxy-form-error">{proxyEditorError}</div>}
          <div className="proxy-form-actions"><button className="icon-button" onClick={() => setProxyEditorOpen(false)}>取消</button><button className="icon-button primary" onClick={savePaneProxy}>保存</button></div>
        </div>
      )}
      {popupNotice && <div className="pane-popup-notice" role="status" onPointerDown={event => event.stopPropagation()}>
        <span>已阻止 {popupNotice.host}：{popupNotice.reason === "rule" ? "广告规则命中" : popupNotice.reason === "playback" ? "播放附带跳转" : "未确认用途的跳转"}</span>
        {popupNotice.canAllow && <button className="icon-button" onClick={() => {
          void window.desktop.allowBlockedNavigation(runtime.paneId, popupNotice.id).then(ok => {
            if (ok) setPopupNotice(null); else setAllowError("该跳转已过期，请重新操作");
          });
        }}>本次放行</button>}
        <button className="icon-button" aria-label="关闭拦截提示" onClick={() => setPopupNotice(null)}>关闭</button>
        {allowError && <span>{allowError}</span>}
      </div>}
      {showPaneNotice && (
        <div className="pane-notice" role={visibleLoadError ? "alert" : "status"} onPointerDown={(event) => event.stopPropagation()}>
          <span>{visibleLoadError?.message || (runtime.cloudflareStatus === "detected" ? "检测到 Cloudflare 验证，已放行验证资源，请在当前页面完成验证。" : runtime.cloudflareStatus === "looped" ? "验证仍在循环，应用已停止自动刷新。" : runtime.error || (runtime.playerStatus === "challenge" ? "请在当前分屏完成 Cloudflare 验证" : "无法识别播放器，已保留网页兼容画面"))}</span>
          {visibleLoadError && <button className="icon-button" onClick={reloadPane}>重试</button>}
          {!isLocalVideo && (visibleLoadError || runtime.playerStatus === "blocked") && <button className="icon-button warning" onClick={openCurrentPageInChrome}>用 Chrome 打开</button>}
        </div>
      )}
      {runtime.url && props.interactionMode === "app" && !showControls && <button className="pane-badge" onPointerDown={(event) => event.stopPropagation()} onClick={revealControls}>{runtime.error ? "播放受限" : runtime.playerStatus === "unrecognized" ? "播放器未识别" : runtime.playing ? "播放中" : "已暂停"} · 控制</button>}
    </div>
  );
}, (previous, next) => (
  previous.runtime === next.runtime
  && previous.active === next.active
  && previous.interactionMode === next.interactionMode
  && previous.debugOverlays === next.debugOverlays
  && previous.guestPreloadUrl === next.guestPreloadUrl
));

function LayoutDivider({ divider, onResize }: { divider: DividerRect; onResize: (path: number[], ratio: number) => void }): ReactElement {
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const surface = event.currentTarget.parentElement;
    if (!surface) return;
    const surfaceBounds = surface.getBoundingClientRect();
    const parent = divider.parentBounds;
    const parentLeft = surfaceBounds.left + parent.left * surfaceBounds.width;
    const parentTop = surfaceBounds.top + parent.top * surfaceBounds.height;
    const ratio = divider.orientation === "horizontal" ? (event.clientX - parentLeft) / (parent.width * surfaceBounds.width) : (event.clientY - parentTop) / (parent.height * surfaceBounds.height);
    onResize(divider.path, ratio);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`layout-divider ${divider.orientation}`} role="separator" aria-orientation={divider.orientation === "horizontal" ? "vertical" : "horizontal"} style={divider.orientation === "horizontal" ? { left: `${divider.left * 100}%`, top: `${divider.top * 100}%`, height: `${divider.parentBounds.height * 100}%` } : { left: `${divider.left * 100}%`, top: `${divider.top * 100}%`, width: `${divider.parentBounds.width * 100}%` }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />;
}

type LayoutSurfaceProps = {
  layout: LayoutNode;
  runtimes: Record<string, PaneRuntime>;
  activePaneId: string;
  guestPreloadUrl: string;
  onActive: (paneId: string) => void;
  onNavigate: (paneId: string, value: string) => void;
  onUpdatePane: (paneId: string, patch: Partial<PaneRuntime>) => void;
  onProxyChange: (paneId: string, settings: PaneProxySettings) => void;
  onResize: (path: number[], ratio: number) => void;
  onSwap: (firstPaneId: string, secondPaneId: string) => void;
  onSplit: (paneId: string, orientation: Orientation) => void;
  onRemove: (paneId: string) => void;
  onOpenChrome: (paneId: string) => void;
  interactionMode: InteractionMode;
  debugOverlays: boolean;
};

function LayoutSurface(props: LayoutSurfaceProps): ReactElement {
  const geometry = useMemo(() => getGeometry(props.layout), [props.layout]);
  const orderedPanes = useMemo(() => [...geometry.panes].sort((first, second) => first.paneId.localeCompare(second.paneId)), [geometry.panes]);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{ paneId: string; dragging: boolean; startX: number; startY: number; offsetX: number; offsetY: number; targetPaneId: string | null } | null>(null);
  const [dragState, setDragState] = useState<{ paneId: string; dragging: boolean; startX: number; startY: number; offsetX: number; offsetY: number; targetPaneId: string | null } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ paneId: string; left: number; top: number } | null>(null);

  useEffect(() => {
    paneRefs.current.forEach((_element, paneId) => {
      if (!geometry.panes.some((pane) => pane.paneId === paneId)) paneRefs.current.delete(paneId);
    });
  }, [geometry.panes]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".pane-context-menu")) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("pointerdown", closeMenu, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeMenu, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (props.interactionMode !== "app") {
      dragRef.current = null;
      setDragState(null);
      setContextMenu(null);
    }
  }, [props.interactionMode]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, paneId: string) => {
    if (props.interactionMode !== "app" || event.button !== 0) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, input, select, textarea, a, .pane-controls, .pane-control-trigger, .pane-badge")) return;
    setContextMenu(null);
    props.onActive(paneId);
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { paneId, dragging: false, startX: event.clientX, startY: event.clientY, offsetX: 0, offsetY: 0, targetPaneId: null as string | null };
    dragRef.current = next;
    setDragState(next);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const offsetX = event.clientX - current.startX;
    const offsetY = event.clientY - current.startY;
    const dragging = current.dragging || Math.hypot(offsetX, offsetY) >= 5;
    let targetPaneId: string | null = null;
    if (dragging) {
      paneRefs.current.forEach((element, candidatePaneId) => {
        if (candidatePaneId === current.paneId) return;
        const bounds = element.getBoundingClientRect();
        if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) targetPaneId = candidatePaneId;
      });
    }
    const next = { ...current, dragging, offsetX, offsetY, targetPaneId };
    dragRef.current = next;
    setDragState(next);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragState(null);
    if (current?.dragging && current.targetPaneId) props.onSwap(current.paneId, current.targetPaneId);
  };

  const showContextMenu = (event: React.MouseEvent<HTMLDivElement>, paneId: string) => {
    if (props.interactionMode !== "app") return;
    event.preventDefault();
    props.onActive(paneId);
    const menuWidth = 150;
    const menuHeight = 42;
    setContextMenu({ paneId, left: Math.max(6, Math.min(event.clientX, window.innerWidth - menuWidth - 6)), top: Math.max(6, Math.min(event.clientY, window.innerHeight - menuHeight - 6)) });
  };

  return (
    <div className="layout-surface">
      {orderedPanes.map((rect) => {
        const runtime = props.runtimes[rect.paneId] ?? makeRuntime(rect.paneId);
        const isDragged = dragState?.paneId === rect.paneId && dragState.dragging;
        const isDropTarget = dragState?.targetPaneId === rect.paneId;
        return <div key={rect.paneId} ref={(element) => { if (element) paneRefs.current.set(rect.paneId, element); else paneRefs.current.delete(rect.paneId); }} className={`layout-pane ${isDragged ? "is-dragging" : ""} ${isDropTarget ? "is-drop-target" : ""}`} style={{ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, transform: isDragged ? `translate(${dragState.offsetX}px, ${dragState.offsetY}px)` : undefined }} onPointerDown={(event) => startDrag(event, rect.paneId)} onPointerMove={updateDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onContextMenu={(event) => showContextMenu(event, rect.paneId)}><PaneView runtime={runtime} active={props.activePaneId === rect.paneId} interactionMode={props.interactionMode} debugOverlays={props.debugOverlays} guestPreloadUrl={props.guestPreloadUrl} onActive={() => props.onActive(rect.paneId)} onNavigate={(value) => props.onNavigate(rect.paneId, value)} onUpdate={(patch) => props.onUpdatePane(rect.paneId, patch)} onProxyChange={(settings) => props.onProxyChange(rect.paneId, settings)} onSplit={(orientation) => props.onSplit(rect.paneId, orientation)} onRemove={() => props.onRemove(rect.paneId)} onOpenChrome={() => props.onOpenChrome(rect.paneId)} /></div>;
      })}
      {geometry.dividers.map((divider) => <LayoutDivider key={divider.path.join(".")} divider={divider} onResize={props.onResize} />)}
      {contextMenu && <div className="pane-context-menu" style={{ left: contextMenu.left, top: contextMenu.top }} role="menu"><button type="button" role="menuitem" className="pane-context-action" disabled={geometry.panes.length <= 1} onClick={() => { setContextMenu(null); props.onRemove(contextMenu.paneId); }}>关闭当前分屏</button></div>}
    </div>
  );
}

function partitionFor(runtime: PaneRuntime): string {
  return runtime.sessionMode === "shared" ? "persist:shared" : `persist:${runtime.paneId}`;
}

function UrlEditor({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string }): ReactElement {
  return <div className="url-editor"><input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onSubmit()} placeholder={placeholder} /><button className="open-button" onClick={onSubmit}>播放</button></div>;
}

function ProxyEndpointFields({ value, onChange }: { value: HttpProxyEndpoint; onChange: (value: HttpProxyEndpoint) => void }): ReactElement {
  return <div className="proxy-endpoint-fields">
    <div className="proxy-field-row">
      <label>代理 IP 地址<input value={value.host} onChange={(event) => onChange({ ...value, host: event.target.value })} placeholder="127.0.0.1" /></label>
      <label className="proxy-port-field">端口<input type="number" min={1} max={65535} value={value.port || ""} onChange={(event) => onChange({ ...value, port: event.target.value === "" ? 0 : Number(event.target.value) })} placeholder="8080" /></label>
    </div>
    <label>例外地址（使用英文分号分隔）<textarea value={value.bypassList} onChange={(event) => onChange({ ...value, bypassList: event.target.value })} placeholder="localhost;127.0.0.1;192.168.*" rows={3} /></label>
    <label className="proxy-checkbox"><input type="checkbox" checked={value.bypassLocal} onChange={(event) => onChange({ ...value, bypassLocal: event.target.checked })} />请勿将代理服务器用于本地(Intranet)地址</label>
  </div>;
}

function proxyModeLabel(mode: string): string {
  if (mode === "direct") return "直连";
  if (mode === "custom") return "自定义 HTTP";
  return "系统代理";
}

export default function App(): ReactElement {
  const [layout, setLayout] = useState<LayoutNode>(() => createPreset("single"));
  const [runtimes, setRuntimes] = useState<Record<string, PaneRuntime>>({ "pane-1": makeRuntime("pane-1") });
  const [activePaneId, setActivePaneId] = useState("pane-1");
  const [status, setStatus] = useState("准备就绪");
  const [guestPreloadUrl, setGuestPreloadUrl] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [htmlFullscreen, setHtmlFullscreen] = useState(false);
  const [htmlFullscreenPaneId, setHtmlFullscreenPaneId] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("web");
  const [fontScale, setFontScale] = useState(initialFontScale);
  const [globalProxy, setGlobalProxy] = useState<GlobalProxySettings>(() => defaultGlobalProxySettings());
  const [globalProxyDraft, setGlobalProxyDraft] = useState<GlobalProxySettings>(() => defaultGlobalProxySettings());
  const [globalProxyOpen, setGlobalProxyOpen] = useState(false);
  const [globalProxyError, setGlobalProxyError] = useState<string | null>(null);
  const [debugOverlays, setDebugOverlays] = useState(import.meta.env.DEV);
  const paneIds = useMemo(() => getPaneIds(layout), [layout]);

  useEffect(() => {
    void window.desktop.getRuntimeFlags().then((flags) => setDebugOverlays(import.meta.env.DEV || flags.debugOverlays)).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.desktop.onFullscreenChange(setFullscreen);
    window.desktop.onHtmlFullscreenChange((paneId, active) => {
      setHtmlFullscreen(active);
      setHtmlFullscreenPaneId(active ? paneId : (current) => current === paneId ? null : current);
    });
    window.desktop.onToggleInteractionMode(() => {
      setInteractionMode(toggleInteractionMode);
    });
    window.desktop.onToggleAppFullscreen(() => {
      setFullscreen((current) => {
        void window.desktop.setFullscreen(!current).then(setFullscreen);
        return current;
      });
    });
    window.desktop.onEscape(() => {
      const action = resolveEscapeAction({ webpageFullscreen: htmlFullscreen, interactionMode, appFullscreen: fullscreen });
      if (action === "exit-webpage-fullscreen") {
        void window.desktop.exitWebpageFullscreen(htmlFullscreenPaneId ?? activePaneId);
      } else if (action === "exit-interaction-mode") {
        setInteractionMode("web");
      } else if (action === "exit-app-fullscreen") {
        void window.desktop.setFullscreen(false).then(setFullscreen);
      }
    });
    window.desktop.onProxyStatus((value) => {
      if (!value || typeof value !== "object") return;
      const statusValue = value as { ok?: unknown; message?: unknown };
      if (statusValue.ok === false && typeof statusValue.message === "string") setStatus(statusValue.message);
    });
    window.desktop.onChromeSessionError((message) => setStatus(message));
  }, [activePaneId, fullscreen, htmlFullscreen, htmlFullscreenPaneId, interactionMode]);

  useEffect(() => {
    void window.desktop.setInteractionMode(interactionMode);
  }, [interactionMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(fontScale));
    } catch {
    }
  }, [fontScale]);

  useEffect(() => {
    void window.desktop.getGlobalProxy().then((saved) => {
      const value = normalizeGlobalProxySettings(saved);
      if (value) {
        setGlobalProxy(value);
        setGlobalProxyDraft({ ...value, custom: { ...value.custom } });
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!globalProxyOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".global-proxy-popover, .proxy-button")) return;
      setGlobalProxyOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGlobalProxyOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [globalProxyOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F8") {
        event.preventDefault();
        setInteractionMode(toggleInteractionMode);
      } else if (event.key === "F11") {
        event.preventDefault();
        void window.desktop.setFullscreen(!fullscreen).then(setFullscreen);
      } else if (event.key === "Escape") {
        const action = resolveEscapeAction({ webpageFullscreen: htmlFullscreen, interactionMode, appFullscreen: fullscreen });
        if (action === "none") return;
        event.preventDefault();
        if (action === "exit-webpage-fullscreen") void window.desktop.exitWebpageFullscreen(htmlFullscreenPaneId ?? activePaneId);
        else if (action === "exit-interaction-mode") setInteractionMode("web");
        else if (action === "exit-app-fullscreen") {
          void window.desktop.setFullscreen(false).then(setFullscreen);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePaneId, fullscreen, htmlFullscreen, htmlFullscreenPaneId, interactionMode]);

  useEffect(() => {
    let cancelled = false;
    void window.desktop.loadLayout().then((saved) => {
      if (cancelled) return;
      const value = saved as { version?: number; layout?: unknown };
      if (value.version === 1 && isLayoutNode(value.layout) && getPaneIds(value.layout).length <= MAX_PANES) setLayout(value.layout);
      setGuestPreloadUrl(window.desktop.guestPreloadUrl);
      setStatus("布局已加载");
    }).catch(() => setStatus("使用默认布局"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRuntimes((current) => {
      const next: Record<string, PaneRuntime> = {};
      paneIds.forEach((paneId) => { next[paneId] = current[paneId] ?? makeRuntime(paneId); });
      return next;
    });
    if (!paneIds.includes(activePaneId)) setActivePaneId(paneIds[0] ?? "");
  }, [paneIds, activePaneId]);

  const updatePane = useCallback((paneId: string, patch: Partial<PaneRuntime>) => {
    setRuntimes((current) => {
      const previous = current[paneId] ?? makeRuntime(paneId);
      const changed = Object.keys(patch).some((key) => previous[key as keyof PaneRuntime] !== patch[key as keyof PaneRuntime]);
      if (!changed) return current;
      return { ...current, [paneId]: { ...previous, ...patch } };
    });
  }, []);
  const applyPreset = (preset: Preset) => { setLayout(createPreset(preset)); setStatus(`${presetLabel(preset)}布局已应用`); };
  const resizeDivider = (path: number[], ratio: number) => setLayout((current) => setRatioAtPath(current, path, ratio));
  const split = (paneId: string, orientation: Orientation) => {
    if (paneIds.length >= MAX_PANES) { setStatus("已达到最多 6 格限制"); return; }
    setLayout(splitPane(layout, paneId, orientation));
    setStatus("已新增分屏");
  };
  const closePane = (paneId: string) => {
    if (paneIds.length <= 1) { setStatus("至少保留一个分屏"); return; }
    const next = removePane(layout, paneId);
    if (next) { setLayout(next); setStatus("分屏已关闭"); }
  };
  const swapPanes = (firstPaneId: string, secondPaneId: string) => {
    if (firstPaneId === secondPaneId) return;
    setLayout((current) => swapPanePositions(current, firstPaneId, secondPaneId));
    setStatus("分屏位置已交换");
  };
  const navigate = (paneId: string, value: string) => {
    const normalized = normalizeNetworkUrl(value);
    if (!normalized) { updatePane(paneId, { error: "请输入有效的 http 或 https 视频网址" }); return; }
    updatePane(paneId, { url: normalized, mediaSource: "network", localFileName: undefined, error: undefined, playerStatus: "loading", playback: emptyPlayback(), playing: false, userPauseIntent: false, focusModeEnabled: false, cloudflareStatus: "none" });
  };
  const openChrome = async (paneId: string) => {
    const url = runtimes[paneId]?.url;
    if (!url) return;
    const opened = await window.desktop.openInChrome(url);
    setStatus(opened ? "已在 Chrome Default 配置中打开" : "未找到 Chrome");
  };
  const save = async () => setStatus(await window.desktop.saveLayout(layout) ? "布局已保存（网址不会保存）" : "布局保存失败");
  const clearSession = async () => { await window.desktop.clearSession(); setStatus("共享登录数据已清除"); };
  const toggleFullscreen = async () => {
    const next = !fullscreen;
    const value = await window.desktop.setFullscreen(next);
    setFullscreen(value);
  };
  const toggleInputMode = () => setInteractionMode(toggleInteractionMode);
  const updatePaneProxy = useCallback((paneId: string, settings: PaneProxySettings) => {
    const runtime = runtimes[paneId];
    if (!runtime) return;
    const transition = resolvePaneProxySession(runtime.sessionMode, runtime.proxyAutoIsolated, settings.mode);
    if (settings.mode !== "inherit" && runtime.sessionMode === "shared") {
      updatePane(paneId, {
        sessionMode: transition.sessionMode,
        proxy: settings,
        proxyAutoIsolated: transition.proxyAutoIsolated,
        userPauseIntent: false,
        playerStatus: "loading",
        playback: emptyPlayback(),
        playing: false,
        focusModeEnabled: false,
        cloudflareStatus: "none",
        error: undefined,
      });
      setStatus("分屏代理已启用，已切换独立会话（Cookie 不再共享）");
      return;
    }
    if (settings.mode === "inherit" && runtime.sessionMode === "isolated" && runtime.proxyAutoIsolated) {
      updatePane(paneId, {
        sessionMode: transition.sessionMode,
        proxy: settings,
        proxyAutoIsolated: transition.proxyAutoIsolated,
        userPauseIntent: false,
        playerStatus: "loading",
        playback: emptyPlayback(),
        playing: false,
        focusModeEnabled: false,
        cloudflareStatus: "none",
        error: undefined,
      });
      setStatus("分屏已恢复跟随全局代理，并重新加入共享会话");
      return;
    }
    updatePane(paneId, { proxy: settings, ...transition, error: undefined });
    setStatus(settings.mode === "inherit" ? "分屏已跟随全局代理" : "分屏代理已更新");
  }, [runtimes, updatePane]);

  const saveGlobalProxy = useCallback(async () => {
    const normalized = normalizeGlobalProxySettings(globalProxyDraft);
    if (!normalized) {
      setGlobalProxyError("请输入有效的代理地址和 1–65535 端口");
      return;
    }
    let result: { ok?: boolean; settings?: unknown; message?: string };
    try {
      result = await window.desktop.setGlobalProxy(normalized) as { ok?: boolean; settings?: unknown; message?: string };
    } catch (error) {
      setGlobalProxyError(error instanceof Error ? error.message : "应用全局代理失败");
      return;
    }
    if (!result.ok) {
      setGlobalProxyError(result.message || "应用全局代理失败");
      return;
    }
    const applied = normalizeGlobalProxySettings(result.settings) ?? normalized;
    setGlobalProxy(applied);
    setGlobalProxyDraft({ ...applied, custom: { ...applied.custom } });
    setGlobalProxyError(null);
    setGlobalProxyOpen(false);
    setStatus(`全局代理已切换为${proxyModeLabel(applied.mode)}`);
  }, [globalProxyDraft]);

  const openGlobalProxyEditor = () => {
    setGlobalProxyDraft({ ...globalProxy, custom: { ...globalProxy.custom } });
    setGlobalProxyError(null);
    setGlobalProxyOpen((current) => !current);
  };

  return (
    <div className={`app-shell ${fullscreen ? "is-fullscreen" : ""} ${htmlFullscreen ? "is-html-fullscreen" : ""} ${interactionMode === "app" ? "is-app-input-mode" : "is-web-input-mode"}`} style={{ "--app-font-scale": fontScale } as CSSProperties}>
       <header className="app-header"><div className="brand"><div className="brand-mark">▦</div><div><div className="brand-title">同屏播放</div><div className="brand-subtitle">沉浸式多视频工作台</div></div></div><div className="header-actions"><span className={`interaction-mode ${interactionMode}`}>{interactionMode === "web" ? "网页操作" : "应用操作"}</span><button className="header-button" onClick={toggleInputMode}>{interactionMode === "web" ? "切到应用层" : "切回网页层"} · F8</button><button className={`header-button proxy-button ${globalProxy.mode === "custom" ? "selected" : ""}`} onClick={openGlobalProxyEditor}>代理：{proxyModeLabel(globalProxy.mode)}</button><label className="font-scale-control"><span>字号</span><select aria-label="应用字号" value={fontScale} onChange={(event) => setFontScale(Number(event.target.value))}>{FONT_SCALE_OPTIONS.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></label><span className="pane-count">{paneIds.length}/{MAX_PANES} 格</span><button className="header-button" onClick={() => void toggleFullscreen()}>{fullscreen ? "退出全屏" : "全屏"}</button><button className="header-button" onClick={() => void save()}>保存布局</button><button className="header-button subtle" onClick={() => void clearSession()}>清除登录</button></div>{globalProxyOpen && <div className="proxy-popover global-proxy-popover" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-label="全局代理设置"><div className="proxy-popover-title">全局代理设置</div><div className="proxy-form-hint">仅影响 Electron 内嵌分屏，不改变外部 Chrome 的网络设置。</div><label className="proxy-mode-field">代理模式<select value={globalProxyDraft.mode} onChange={(event) => setGlobalProxyDraft((current) => ({ ...current, mode: event.target.value as GlobalProxySettings["mode"] }))}><option value="system">系统代理</option><option value="direct">直连（不使用代理）</option><option value="custom">自定义 HTTP</option></select></label>{globalProxyDraft.mode === "custom" && <><label className="proxy-checkbox"><input type="checkbox" checked={globalProxyDraft.mode === "custom"} onChange={(event) => setGlobalProxyDraft((current) => ({ ...current, mode: event.target.checked ? "custom" : "direct" }))} />使用代理服务器</label><ProxyEndpointFields value={globalProxyDraft.custom} onChange={(custom) => setGlobalProxyDraft((current) => ({ ...current, custom }))} /></>}{globalProxyError && <div className="proxy-form-error">{globalProxyError}</div>}<div className="proxy-form-actions"><button className="icon-button" onClick={() => { setGlobalProxyOpen(false); setGlobalProxyError(null); }}>取消</button><button className="icon-button primary" onClick={() => void saveGlobalProxy()}>保存</button></div></div>}</header>
       <div className="toolbar"><span className="toolbar-label">布局</span><div className="preset-group">{(["single", "split-2", "split-3", "grid-2x2", "grid-3x2"] as Preset[]).map((preset) => <button key={preset} className="preset-button" onClick={() => applyPreset(preset)}>{presetLabel(preset)}</button>)}</div><div className="toolbar-hint">{interactionMode === "web" ? "网页播放器直接接收鼠标和键盘 · F8 切换应用层" : "应用层接管活动分屏 · 鼠标移到底部显示控制"}</div></div>
       <main className="workspace">{guestPreloadUrl ? <LayoutSurface layout={layout} runtimes={runtimes} activePaneId={activePaneId} interactionMode={interactionMode} debugOverlays={debugOverlays} guestPreloadUrl={guestPreloadUrl} onActive={setActivePaneId} onNavigate={navigate} onUpdatePane={updatePane} onProxyChange={updatePaneProxy} onResize={resizeDivider} onSwap={swapPanes} onSplit={split} onRemove={closePane} onOpenChrome={(paneId) => void openChrome(paneId)} /> : <div className="loading-state">正在准备网页播放内核…</div>}</main>
       <footer className="status-bar"><span className="status-dot" /><span>{status}</span><span className="status-spacer" /><span>全局代理：{proxyModeLabel(globalProxy.mode)} · 共享会话 · 安全拦截</span></footer>
      {(fullscreen || htmlFullscreen) && (
        <div className="fullscreen-top-zone">
          <div className="fullscreen-top-bar">
            <span className="fullscreen-hint">按 Esc 退出全屏</span>
            <button className="icon-button" onClick={() => { if (htmlFullscreen) void window.desktop.exitWebpageFullscreen(htmlFullscreenPaneId ?? activePaneId); else void window.desktop.setFullscreen(false); }}>退出全屏</button>
          </div>
        </div>
      )}
    </div>
  );
}

function presetLabel(preset: Preset): string {
  if (preset === "single") return "单屏";
  if (preset === "split-2") return "2 格";
  if (preset === "split-3") return "3 格";
  if (preset === "grid-2x2") return "4 格";
  return "6 格";
}
