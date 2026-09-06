import { contextBridge, ipcRenderer } from "electron";

let fullscreenListener: ((event: Electron.IpcRendererEvent, fullscreen: unknown) => void) | null = null;
let htmlFullscreenListener: ((event: Electron.IpcRendererEvent, paneId: unknown, fullscreen: unknown) => void) | null = null;
let toggleInteractionListener: (() => void) | null = null;
let toggleAppFullscreenListener: (() => void) | null = null;
let escapeListener: (() => void) | null = null;
let paneBlockedListener: ((event: Electron.IpcRendererEvent, paneId: unknown, statusCode: unknown) => void) | null = null;
let chromeSessionErrorListener: ((event: Electron.IpcRendererEvent, message: unknown) => void) | null = null;

contextBridge.exposeInMainWorld("desktop", {
  guestPreloadUrl: ipcRenderer.sendSync("get-guest-preload-url") as string,
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
  onPaneBlocked: (callback: (paneId: string, statusCode: number) => void): void => {
    if (paneBlockedListener) ipcRenderer.removeListener("pane:blocked", paneBlockedListener);
    paneBlockedListener = (_event, paneId: unknown, statusCode: unknown) => {
      if (typeof paneId === "string" && typeof statusCode === "number") callback(paneId, statusCode);
    };
    ipcRenderer.on("pane:blocked", paneBlockedListener);
  },
  loadLayout: (): Promise<unknown> => ipcRenderer.invoke("layout:load"),
  saveLayout: (layout: unknown): Promise<boolean> => ipcRenderer.invoke("layout:save", layout),
  clearSession: (): Promise<boolean> => ipcRenderer.invoke("session:clear"),
  registerPane: (paneId: string, webContentsId: number, partition: string, pageUrl?: string): Promise<boolean> =>
    ipcRenderer.invoke("pane:register", paneId, webContentsId, partition, pageUrl),
  openInChrome: (url: string): Promise<boolean> => ipcRenderer.invoke("pane:openInChrome", url),
  openAuthWindow: (url: string, partition: string): Promise<boolean> => ipcRenderer.invoke("pane:openAuthWindow", url, partition),
  exitWebpageFullscreen: (paneId?: string): Promise<boolean> => ipcRenderer.invoke("window:exitWebpageFullscreen", paneId),
  setAdblock: (paneId: string, host: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pane:setAdblock", paneId, host, enabled),
  setChallengeMode: (paneId: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("pane:setChallengeMode", paneId, enabled),
  reloadChallenge: (paneId: string): Promise<boolean> => ipcRenderer.invoke("pane:reloadChallenge", paneId),
  reportChallengeState: (paneId: string, state: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:reportChallengeState", paneId, state),
  inspectFingerprint: (paneId: string): Promise<unknown> => ipcRenderer.invoke("pane:inspectFingerprint", paneId),
  harvestChromeClearance: (paneId: string, url: string): Promise<unknown> =>
    ipcRenderer.invoke("chrome:harvestClearance", paneId, url),
  applyClearance: (partition: string, url: string, cookies: unknown): Promise<boolean> =>
    ipcRenderer.invoke("pane:applyClearance", partition, url, cookies),
  openChromeSolver: (url: string): Promise<unknown> => ipcRenderer.invoke("chrome:openSolver", url),
  openChromeLogin: (url: string): Promise<unknown> => ipcRenderer.invoke("chrome:openLogin", url),
  clearChromeProfile: (): Promise<boolean> => ipcRenderer.invoke("chrome:clearProfile"),
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
