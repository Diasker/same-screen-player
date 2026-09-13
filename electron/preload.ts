import { contextBridge, ipcRenderer } from "electron";
import type { AdblockStatus, BlockedNavigation } from "../src/shared/adblock";

let fullscreenListener: ((event: Electron.IpcRendererEvent, fullscreen: unknown) => void) | null = null;
let htmlFullscreenListener: ((event: Electron.IpcRendererEvent, paneId: unknown, fullscreen: unknown) => void) | null = null;
let toggleInteractionListener: (() => void) | null = null;
let toggleAppFullscreenListener: (() => void) | null = null;
let escapeListener: (() => void) | null = null;
let chromeSessionErrorListener: ((event: Electron.IpcRendererEvent, message: unknown) => void) | null = null;
let proxyStatusListener: ((event: Electron.IpcRendererEvent, status: unknown) => void) | null = null;

contextBridge.exposeInMainWorld("desktop", {
  guestPreloadUrl: ipcRenderer.sendSync("get-guest-preload-url") as string,
  getRuntimeFlags: (): Promise<{ debugOverlays: boolean }> => ipcRenderer.invoke("app:getRuntimeFlags"),
  setFullscreen: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke("window:setFullscreen", enabled),
  setInteractionMode: (mode: "web" | "app"): Promise<boolean> => ipcRenderer.invoke("window:setInteractionMode", mode),
  onFullscreenChange: (callback: (fullscreen: boolean) => void): void => {
    if (fullscreenListener) ipcRenderer.removeListener("window:fullscreen-change", fullscreenListener);
    fullscreenListener = (_event, fullscreen: unknown) => callback(Boolean(fullscreen));
    ipcRenderer.on("window:fullscreen-change", fullscreenListener);
  },
  onHtmlFullscreenChange: (callback: (paneId: string, fullscreen: boolean) => void): void => {
    if (htmlFullscreenListener) ipcRenderer.removeListener("window:html-fullscreen-change", htmlFullscreenListener);
    htmlFullscreenListener = (_event, paneId: unknown, fullscreen: unknown) => {
      if (typeof paneId === "string") callback(paneId, Boolean(fullscreen));
    };
    ipcRenderer.on("window:html-fullscreen-change", htmlFullscreenListener);
  },
  onToggleInteractionMode: (callback: () => void): void => {
    if (toggleInteractionListener) ipcRenderer.removeListener("window:toggle-interaction-mode", toggleInteractionListener);
    toggleInteractionListener = () => callback();
    ipcRenderer.on("window:toggle-interaction-mode", toggleInteractionListener);
  },
  onToggleAppFullscreen: (callback: () => void): void => {
    if (toggleAppFullscreenListener) ipcRenderer.removeListener("window:toggle-app-fullscreen", toggleAppFullscreenListener);
    toggleAppFullscreenListener = () => callback();
    ipcRenderer.on("window:toggle-app-fullscreen", toggleAppFullscreenListener);
  },
  onEscape: (callback: () => void): void => {
    if (escapeListener) ipcRenderer.removeListener("window:escape", escapeListener);
    escapeListener = () => callback();
    ipcRenderer.on("window:escape", escapeListener);
  },
  loadLayout: (): Promise<unknown> => ipcRenderer.invoke("layout:load"),
  saveLayout: (layout: unknown): Promise<boolean> => ipcRenderer.invoke("layout:save", layout),
  selectLocalVideo: (): Promise<unknown> => ipcRenderer.invoke("pane:selectLocalVideo"),
  loadLocalVideo: (paneId: string, url: string): Promise<unknown> => ipcRenderer.invoke("pane:loadLocalVideo", paneId, url),
  clearSession: (): Promise<boolean> => ipcRenderer.invoke("session:clear"),
  registerPane: (paneId: string, webContentsId: number, partition: string, pageUrl?: string, proxy?: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:register", paneId, webContentsId, partition, pageUrl, proxy),
  getGlobalProxy: (): Promise<unknown> => ipcRenderer.invoke("proxy:getGlobal"),
  setGlobalProxy: (settings: unknown): Promise<unknown> => ipcRenderer.invoke("proxy:setGlobal", settings),
  setPaneProxy: (paneId: string, settings: unknown): Promise<unknown> => ipcRenderer.invoke("proxy:setPane", paneId, settings),
  onProxyStatus: (callback: (status: unknown) => void): void => {
    if (proxyStatusListener) ipcRenderer.removeListener("proxy:status", proxyStatusListener);
    proxyStatusListener = (_event, status: unknown) => callback(status);
    ipcRenderer.on("proxy:status", proxyStatusListener);
  },
  openInChrome: (url: string): Promise<boolean> => ipcRenderer.invoke("pane:openInChrome", url),
  openAuthWindow: (url: string, partition: string): Promise<boolean> => ipcRenderer.invoke("pane:openAuthWindow", url, partition),
  exitWebpageFullscreen: (paneId?: string): Promise<boolean> => ipcRenderer.invoke("window:exitWebpageFullscreen", paneId),
  setAdblock: (paneId: string, host: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pane:setAdblock", paneId, host, enabled),
  getAdblock: (paneId: string, host: string): Promise<boolean> => ipcRenderer.invoke("pane:getAdblock", paneId, host),
  getAdblockStatus: (): Promise<AdblockStatus> => ipcRenderer.invoke("adblock:status"),
  allowBlockedNavigation: (paneId: string, id: string): Promise<boolean> => ipcRenderer.invoke("adblock:allow", paneId, id),
  onAdblockBlocked: (callback: (event: BlockedNavigation) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: BlockedNavigation) => callback(value);
    ipcRenderer.on("adblock:blocked", listener);
    return () => ipcRenderer.removeListener("adblock:blocked", listener);
  },
  onAdblockStatus: (callback: (status: AdblockStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: AdblockStatus) => callback(value);
    ipcRenderer.on("adblock:status-changed", listener);
    return () => ipcRenderer.removeListener("adblock:status-changed", listener);
  },
  setChallengeMode: (paneId: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pane:setChallengeMode", paneId, enabled),
  reportChallengeState: (paneId: string, state: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:reportChallengeState", paneId, state),
  inspectFingerprint: (paneId: string): Promise<unknown> => ipcRenderer.invoke("pane:inspectFingerprint", paneId),
  openChromeLogin: (url: string): Promise<unknown> => ipcRenderer.invoke("chrome:openLogin", url),
  reportPlaybackState: (paneId: string, state: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:reportPlaybackState", { paneId, state }),
  logFocusDiagnostic: (paneId: string, info: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:logFocusDiagnostic", paneId, info),
  onChromeSessionError: (callback: (message: string) => void): void => {
    if (chromeSessionErrorListener) ipcRenderer.removeListener("chrome:sessionError", chromeSessionErrorListener);
    chromeSessionErrorListener = (_event, message) => { if (typeof message === "string") callback(message); };
    ipcRenderer.on("chrome:sessionError", chromeSessionErrorListener);
  },
});
