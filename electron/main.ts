import { app, BrowserWindow, dialog, ipcMain, screen, session, webContents, webFrameMain } from "electron";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import { adsAndTrackingLists } from "@ghostery/adblocker";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  defaultGlobalProxySettings,
  defaultPaneProxySettings,
  isLayoutNode,
  isSupportedLocalVideoFile,
  normalizeGlobalProxySettings,
  normalizePaneProxySettings,
  resolveProxySettings,
  toElectronProxySettings,
  type GlobalProxySettings,
  type InteractionMode,
  type LayoutNode,
  type PaneProxySettings,
  type PersistedLayout,
  type WindowBounds,
} from "../src/shared/types";
import {
  cloudflareChallengeHost,
  emptyChallengeNavigation,
  isCloudflareChallengeRequest,
  observeChallengeNavigation,
  observeChallengeSignal,
  shouldBypassAdblockForChallenge,
  type ChallengeNavigationState,
} from "./cloudflare";
import { ChromeSessionManager } from "./cdp";
import { chromeUserAgent, installFingerprintForSession, mainWorldFingerprintScript } from "./fingerprint";
import { helperPath, WindowsWindowHelper } from "./windows-helper";
import { frameVideoBridgeScript } from "./frame-video-bridge";
import { debugOverlaysEnabled } from "../src/shared/debug-overlays";
import { isKnownAdRequest } from "./ad-navigation";
import { hostMatchesAdblockRule, normalizeAdblockHost } from "./adblock-policy";
import { loadLocalVideoDirectory, saveLocalVideoPath } from "./local-video-preferences";

const GHOSTERY_PRELOAD_PATH = require.resolve("@ghostery/adblocker-electron-preload");

app.userAgentFallback = chromeUserAgent();
const runtimeFlags = {
  debugOverlays: debugOverlaysEnabled(process.argv, Boolean(process.env.VITE_DEV_SERVER_URL)),
};

let mainWindow: BrowserWindow | null = null;
let interactionMode: InteractionMode = "web";
let htmlFullscreenPaneId: string | null = null;
let blocker: ElectronBlocker | null = null;
let chromeManager: ChromeSessionManager | null = null;
let windowsHelper: WindowsWindowHelper | null = null;
const paneWebContents = new Map<number, string>();
const panePartitions = new Map<string, string>();
const paneProxySettings = new Map<string, PaneProxySettings>();
const paneHosts = new Map<string, string>();
type BeforeInputListener = (event: Electron.Event, input: Electron.Input) => void;
type NavigationListener = (event: Electron.Event, url: string) => void;
type FrameCreatedListener = (event: Electron.Event, details: Electron.FrameCreatedDetails) => void;
type FrameFinishListener = (event: Electron.Event, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => void;
const guestBindings = new Map<number, { paneId: string; contents: Electron.WebContents; onBeforeInput: BeforeInputListener; onEnterFullscreen: () => void; onLeaveFullscreen: () => void; onWillNavigate: NavigationListener; onNavigate: NavigationListener; onNavigateInPage: NavigationListener; onFrameCreated: FrameCreatedListener; onFrameFinish: FrameFinishListener; onDestroyed: () => void }>();
const disabledAdblockRules = new Set<string>();
const compatibilityResourceTypes = new Set([
  "mainframe",
  "subframe",
  "media",
  "object",
  "script",
  "stylesheet",
  "font",
  "manifest",
  "xhr",
  "fetch",
  "websocket",
]);
const challengeNavigation = new Map<string, ChallengeNavigationState>();
const challengeModePanes = new Set<string>();
const installedBlockingSessions = new WeakSet<Electron.Session>();
const installedCosmeticSessions = new WeakSet<Electron.Session>();
const installedSessionDiagnostics = new WeakSet<Electron.Session>();
const headerDiagnosticSessions = new WeakSet<Electron.Session>();
const knownPartitions = new Set<string>(["persist:shared"]);
const partitionProxyKeys = new Map<string, string>();
const authorizedLocalVideoUrls = new Set<string>();
let globalProxySettings: GlobalProxySettings = defaultGlobalProxySettings();

const defaultLayout: PersistedLayout = {
  version: 1,
  layout: { kind: "pane", paneId: "pane-1" },
};

function layoutFilePath(): string {
  return path.join(app.getPath("userData"), "layout.json");
}

function proxySettingsFilePath(): string {
  return path.join(app.getPath("userData"), "proxy-settings.json");
}

function adblockCachePath(): string {
  return path.join(app.getPath("userData"), "adblock-engine.bin");
}

function isSafeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
}

async function isAuthorizedLocalVideoUrl(value: unknown): Promise<boolean> {
  if (typeof value !== "string" || !authorizedLocalVideoUrls.has(value) || !isFileUrl(value)) return false;
  try {
    const filePath = fileURLToPath(value);
    const metadata = await fs.stat(filePath);
    return isSupportedLocalVideoFile(path.basename(filePath), metadata.isFile());
  } catch {
    return false;
  }
}

async function selectLocalVideo(): Promise<{ ok: true; url: string; fileName: string } | { ok: false; canceled: boolean; message?: string }> {
  try {
    const preferenceFile = path.join(app.getPath("userData"), "last-local-video.json");
    const defaultPath = await loadLocalVideoDirectory(preferenceFile);
    const result = await dialog.showOpenDialog({
      title: "选择本地视频",
      ...(defaultPath ? { defaultPath } : {}),
      properties: ["openFile"],
      filters: [{ name: "视频文件", extensions: ["mp4", "m4v", "webm", "mov", "ogv"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const metadata = await fs.stat(filePath);
    if (!isSupportedLocalVideoFile(path.basename(filePath), metadata.isFile())) {
      return { ok: false, canceled: false, message: "请选择 MP4、M4V、WebM、MOV 或 OGV 视频文件" };
    }
    const url = pathToFileURL(filePath).toString();
    authorizedLocalVideoUrls.add(url);
    await saveLocalVideoPath(preferenceFile, filePath).catch(() => undefined);
    return { ok: true, url, fileName: path.basename(filePath) };
  } catch {
    return { ok: false, canceled: false, message: "无法读取所选本地视频，请确认文件仍存在且有访问权限" };
  }
}

function chromeExecutable(): string | null {
  const candidates = process.platform === "win32"
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
        process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function chromeProfilePath(): string {
  return path.join(app.getPath("userData"), "chrome-profile");
}

function chromeExtensionPath(): string {
  const candidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath, "chrome-extension")] : []),
    path.join(app.getAppPath(), "chrome-extension"),
    path.join(__dirname, "..", "chrome-extension"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function ensureChromeManager(): ChromeSessionManager | null {
  if (process.platform !== "win32") return null;
  if (!chromeManager) {
    const executable = chromeExecutable();
    if (!executable) return null;
    chromeManager = new ChromeSessionManager({ userDataDir: chromeProfilePath(), extensionPath: chromeExtensionPath(), executable });
    chromeManager.onEvent((event) => {
      if (event.type === "ready") {
        if (event.pane.processId) {
          void windowsHelper?.send({ action: "stylePid", pid: event.pane.processId }).then((result) => {
            if (!result.ok) sendWindowMessage("chrome:sessionError", `Chrome 无边框辅助程序不可用：${result.error ?? "未知错误"}`);
          });
        }
      }
      else if (event.type === "crashed" || event.type === "error") sendWindowMessage("chrome:sessionError", event.message);
    });
  }
  return chromeManager;
}

function openInChrome(value: unknown): boolean {
  if (!isSafeUrl(value)) return false;
  const executable = chromeExecutable();
  if (!executable) return false;
  try {
    const child = spawn(executable, ["--profile-directory=Default", `--app=${value}`], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function isAuthenticationUrl(value: unknown): value is string {
  if (!isSafeUrl(value)) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (host === "accounts.google.com" || host.endsWith(".accounts.google.com") || host === "google.com" || host.endsWith(".google.com")) return true;
    if (host === "passport.bilibili.com") return true;
    if (host === "bilibili.com" || host.endsWith(".bilibili.com")) return /login|signin|passport|auth|account/.test(pathAndQuery);
    return false;
  } catch {
    return false;
  }
}

function openAuthenticationWindow(value: unknown, partition: unknown): boolean {
  if (!isAuthenticationUrl(value)) return false;
  const safePartition = typeof partition === "string" && /^persist:[a-zA-Z0-9._-]+$/.test(partition) ? partition : "persist:shared";
  knownPartitions.add(safePartition);
  const authSession = session.fromPartition(safePartition);
  configureSession(authSession);
  const authWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    title: "登录",
    webPreferences: {
      preload: path.join(__dirname, "fingerprint-preload.js"),
      partition: safePartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  authWindow.webContents.setWindowOpenHandler(({ url }) => ({ action: isAuthenticationUrl(url) ? "allow" : "deny" }));
  installDebuggerInjection(authWindow.webContents);
  void authWindow.loadURL(value).catch(() => authWindow.close());
  return true;
}

async function exitWebpageFullscreen(paneId?: string): Promise<boolean> {
  let exited = false;
  const ids = paneId
    ? [...paneWebContents.entries()].filter(([, registeredPaneId]) => registeredPaneId === paneId).map(([id]) => id)
    : [...paneWebContents.keys()];
  await Promise.all(ids.map(async (id) => {
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) return;
    try {
      await contents.executeJavaScript("document.exitFullscreen?.(); document.webkitExitFullscreen?.(); void 0", true);
      exited = true;
    } catch {
    }
  }));
  return exited;
}

function sendWindowMessage(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}

function sendProxyStatus(scope: "global" | "pane", ok: boolean, message?: string, paneId?: string): void {
  sendWindowMessage("proxy:status", { scope, ok, ...(paneId ? { paneId } : {}), ...(message ? { message } : {}) });
}

function isAdblockDisabledForHost(paneId: string, host: unknown): boolean {
  const normalized = normalizeAdblockHost(host);
  if (!normalized) return false;
  for (const rule of disabledAdblockRules) {
    const separator = rule.indexOf("|");
    if (separator < 0) continue;
    const scope = rule.slice(0, separator);
    if ((scope === paneId || scope === "*") && hostMatchesAdblockRule(normalized, rule.slice(separator + 1))) return true;
  }
  return false;
}

function isAdblockDisabledForUrl(paneId: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return isAdblockDisabledForHost(paneId, new URL(value).hostname); } catch { return false; }
}

function recordCloudflareDiagnostic(paneId: string, url: unknown, status: string, navigationCount: number, httpStatus?: number): void {
  let host = "unknown";
  try {
    host = cloudflareChallengeHost(url) ?? (new URL(typeof url === "string" ? url : "").hostname.toLowerCase() || host);
  } catch {
  }
  const entry = {
    timestamp: new Date().toISOString(),
    paneId,
    host,
    status,
    navigationCount,
    httpStatus: typeof httpStatus === "number" ? httpStatus : undefined,
    adblockEnabled: !isAdblockDisabledForUrl(paneId, url),
  };
  void fs.mkdir(path.dirname(layoutFilePath()), { recursive: true })
    .then(() => fs.appendFile(path.join(app.getPath("userData"), "cloudflare-diagnostics.log"), `${JSON.stringify(entry)}\n`, "utf8"))
    .catch(() => undefined);
}

function recordFingerprintDiagnostic(paneId: string, data: unknown): void {
  const entry = { timestamp: new Date().toISOString(), paneId, fingerprint: data };
  void fs.appendFile(path.join(app.getPath("userData"), "cloudflare-diagnostics.log"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
}

function handlePaneNavigation(paneId: string, contents: Electron.WebContents, url: string): void {
  if (isFileUrl(url)) {
    try { contents.send("challenge-navigation", { status: "none" }); } catch { }
    return;
  }
  if (isSafeUrl(url)) {
    try {
      paneHosts.set(paneId, new URL(url).hostname.toLowerCase());
    } catch {
    }
  }
  const previous = challengeNavigation.get(paneId) ?? emptyChallengeNavigation();
  const explicitChallenge = isCloudflareChallengeRequest(url);
  const isChallenge = explicitChallenge || challengeModePanes.has(paneId);
  const next = isChallenge ? observeChallengeSignal(previous, url) : observeChallengeNavigation(previous, url);
  challengeNavigation.set(paneId, next);
  const payload = {
    status: next.status,
    url: isChallenge ? url : undefined,
    navigationCount: next.navigationCount,
    message: next.status === "looped"
      ? "验证仍在循环，应用已停止自动刷新。"
      : isChallenge
        ? "检测到 Cloudflare 验证，已放行验证资源，请在当前页面完成验证。"
        : undefined,
  };
  try {
    contents.send("challenge-navigation", payload);
  } catch {
  }
  if (isChallenge || next.status === "passed") {
    recordCloudflareDiagnostic(paneId, url, next.status, next.navigationCount);
  }
}

function unbindGuest(webContentsId: number): void {
  const binding = guestBindings.get(webContentsId);
  if (!binding) return;
  binding.contents.removeListener("before-input-event", binding.onBeforeInput);
  binding.contents.removeListener("enter-html-full-screen", binding.onEnterFullscreen);
  binding.contents.removeListener("leave-html-full-screen", binding.onLeaveFullscreen);
  binding.contents.removeListener("will-navigate", binding.onWillNavigate);
  binding.contents.removeListener("did-navigate", binding.onNavigate);
  binding.contents.removeListener("did-navigate-in-page", binding.onNavigateInPage);
  binding.contents.removeListener("frame-created", binding.onFrameCreated);
  binding.contents.removeListener("did-frame-finish-load", binding.onFrameFinish);
  binding.contents.removeListener("destroyed", binding.onDestroyed);
  guestBindings.delete(webContentsId);
  paneWebContents.delete(webContentsId);
  panePartitions.delete(binding.paneId);
  paneProxySettings.delete(binding.paneId);
  challengeNavigation.delete(binding.paneId);
  challengeModePanes.delete(binding.paneId);
  if (htmlFullscreenPaneId === binding.paneId) {
    htmlFullscreenPaneId = null;
    sendWindowMessage("window:html-fullscreen-change", binding.paneId, false);
  }
}

function installDebuggerInjection(contents: Electron.WebContents): void {
  try {
    contents.debugger.attach("1.3");
    void contents.debugger.sendCommand("Page.enable")
      .then(() => contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `${mainWorldFingerprintScript()}\n${frameVideoBridgeScript()}` }))
      .then(() => {
        // Detach once the script is registered to avoid keeping the DevTools
        // debugger attached to the guest, which can interfere with site input
        // (mouse clicks) and media seeking on heavy SPA pages.
        try { contents.debugger.detach(); } catch { /* already detached */ }
      })
      .catch(() => {
        try { contents.debugger.detach(); } catch { /* already detached */ }
      });
  } catch {
  }
}

function installFrameVideoBridge(frame: Electron.WebFrameMain | null): void {
  if (!frame || frame.isDestroyed()) return;
  void frame.executeJavaScript(frameVideoBridgeScript(), false).catch(() => undefined);
}

function installFrameVideoBridges(contents: Electron.WebContents): void {
  try {
    contents.mainFrame.framesInSubtree.forEach(installFrameVideoBridge);
  } catch {
  }
}

function bindGuest(paneId: string, webContentsId: number): void {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) return;
  const existing = guestBindings.get(webContentsId);
  if (existing && existing.paneId === paneId) return;
  if (existing) unbindGuest(webContentsId);
  installDebuggerInjection(contents);
  installFrameVideoBridges(contents);
  const onBeforeInput: BeforeInputListener = (event, input) => {
    if (input.type !== "keyDown") return;
    const isSpace = input.code === "Space" || input.key === " ";
    const isMute = input.key.toLowerCase() === "m";
    const isHistoryBack = input.alt && (input.key === "ArrowLeft" || input.code === "ArrowLeft");
    const isHistoryForward = input.alt && (input.key === "ArrowRight" || input.code === "ArrowRight");
    if (isHistoryBack || isHistoryForward) {
      event.preventDefault();
      try {
        if (isHistoryBack && contents.canGoBack()) contents.goBack();
        if (isHistoryForward && contents.canGoForward()) contents.goForward();
      } catch {
      }
      return;
    }
    if (input.key === "F8" || input.code === "F8") {
      event.preventDefault();
      sendWindowMessage("window:toggle-interaction-mode");
      return;
    }
    if (input.key === "F11" || input.code === "F11") {
      event.preventDefault();
      sendWindowMessage("window:toggle-app-fullscreen");
      return;
    }
    if (input.key === "Escape" || input.code === "Escape") {
      if (htmlFullscreenPaneId === paneId) {
        event.preventDefault();
        void exitWebpageFullscreen(paneId);
      } else if (interactionMode === "app" || mainWindow?.isFullScreen()) {
        event.preventDefault();
        sendWindowMessage("window:escape");
      }
      return;
    }
    if (interactionMode !== "app" || (!isSpace && !isMute)) return;
    event.preventDefault();
    contents.send("video-command", isSpace ? { type: "toggle" } : { type: "toggleMuted" });
  };
  const onEnterFullscreen = () => {
    htmlFullscreenPaneId = paneId;
    sendWindowMessage("window:html-fullscreen-change", paneId, true);
  };
  const onLeaveFullscreen = () => {
    if (htmlFullscreenPaneId === paneId) htmlFullscreenPaneId = null;
    sendWindowMessage("window:html-fullscreen-change", paneId, false);
  };
  const onWillNavigate: NavigationListener = (event, url) => {
    if (isKnownAdRequest(url) && !isAdblockDisabledForUrl(paneId, url)) {
      event.preventDefault();
      return;
    }
    if (isSafeUrl(url)) return;
    if (isFileUrl(url) && authorizedLocalVideoUrls.has(url)) return;
    event.preventDefault();
  };
  const onNavigate = (_event: Electron.Event, url: string) => handlePaneNavigation(paneId, contents, url);
  const onNavigateInPage = (_event: Electron.Event, url: string) => handlePaneNavigation(paneId, contents, url);
  const onFrameCreated: FrameCreatedListener = (_event, details) => installFrameVideoBridge(details.frame);
  const onFrameFinish: FrameFinishListener = (_event, _isMainFrame, frameProcessId, frameRoutingId) => installFrameVideoBridge(webFrameMain.fromId(frameProcessId, frameRoutingId) ?? null);
  const onDestroyed = () => unbindGuest(webContentsId);
  contents.on("before-input-event", onBeforeInput);
  contents.on("enter-html-full-screen", onEnterFullscreen);
  contents.on("leave-html-full-screen", onLeaveFullscreen);
  contents.on("will-navigate", onWillNavigate);
  contents.on("did-navigate", onNavigate);
  contents.on("did-navigate-in-page", onNavigateInPage);
  contents.on("frame-created", onFrameCreated);
  contents.on("did-frame-finish-load", onFrameFinish);
  contents.on("destroyed", onDestroyed);
  guestBindings.set(webContentsId, { paneId, contents, onBeforeInput, onEnterFullscreen, onLeaveFullscreen, onWillNavigate, onNavigate, onNavigateInPage, onFrameCreated, onFrameFinish, onDestroyed });
}

async function loadLayout(): Promise<PersistedLayout> {
  try {
    const raw = JSON.parse(await fs.readFile(layoutFilePath(), "utf8")) as Partial<PersistedLayout>;
    if (raw.version === 1 && isLayoutNode(raw.layout) && collectPaneIds(raw.layout).length <= 6) return { version: 1, layout: raw.layout };
  } catch {
  }
  return defaultLayout;
}

async function saveLayout(layout: unknown): Promise<boolean> {
  if (!isLayoutNode(layout)) return false;
  const ids = collectPaneIds(layout);
  if (ids.length === 0 || ids.length > 6) return false;
  await fs.mkdir(path.dirname(layoutFilePath()), { recursive: true });
  await fs.writeFile(layoutFilePath(), JSON.stringify({ version: 1, layout }, null, 2), "utf8");
  return true;
}

async function loadGlobalProxySettings(): Promise<GlobalProxySettings> {
  try {
    const raw = JSON.parse(await fs.readFile(proxySettingsFilePath(), "utf8")) as unknown;
    return normalizeGlobalProxySettings(raw) ?? defaultGlobalProxySettings();
  } catch {
    return defaultGlobalProxySettings();
  }
}

async function saveGlobalProxySettings(settings: GlobalProxySettings): Promise<void> {
  await fs.mkdir(path.dirname(proxySettingsFilePath()), { recursive: true });
  await fs.writeFile(proxySettingsFilePath(), JSON.stringify(settings, null, 2), "utf8");
}

function proxySettingsKey(settings: GlobalProxySettings): string {
  return JSON.stringify(settings);
}

async function applyProxyToPartition(partition: string, settings: GlobalProxySettings, force = false): Promise<void> {
  const key = proxySettingsKey(settings);
  if (!force && partitionProxyKeys.get(partition) === key) return;
  const targetSession = session.fromPartition(partition);
  await targetSession.setProxy(toElectronProxySettings(settings));
  await targetSession.closeAllConnections();
  partitionProxyKeys.set(partition, key);
}

function reloadContents(contents: Electron.WebContents): void {
  if (contents.isDestroyed()) return;
  const performReload = () => {
    if (contents.isDestroyed()) return;
    try {
      contents.reload();
    } catch {
    }
  };
  try {
    if (!contents.isLoading()) {
      performReload();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      contents.removeListener("did-stop-loading", onStopLoading);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const onStopLoading = () => {
      cleanup();
      performReload();
    };
    contents.once("did-stop-loading", onStopLoading);
    timer = setTimeout(() => {
      cleanup();
      performReload();
    }, 1500);
  } catch {
    performReload();
  }
}

function reloadPanesInPartitions(partitions: Set<string>): void {
  for (const [webContentsId, paneId] of paneWebContents) {
    const partition = panePartitions.get(paneId);
    if (!partition || !partitions.has(partition)) continue;
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) continue;
    reloadContents(contents);
  }
}

function reloadPane(paneId: string): void {
  const webContentsId = [...paneWebContents.entries()].find(([, registeredPaneId]) => registeredPaneId === paneId)?.[0];
  if (webContentsId === undefined) return;
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) return;
  reloadContents(contents);
}

function collectPaneIds(node: LayoutNode): string[] {
  if (node.kind === "pane") return [node.paneId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

function registerIpc(): void {
  ipcMain.handle("app:getRuntimeFlags", () => runtimeFlags);
  ipcMain.on("get-guest-preload-url", (event) => {
    event.returnValue = pathToFileURL(path.join(__dirname, "guest-preload.js")).toString();
  });
  ipcMain.handle("window:setFullscreen", (event, enabled: unknown) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) return false;
    targetWindow.setFullScreen(Boolean(enabled));
    return targetWindow.isFullScreen();
  });
  ipcMain.handle("window:setInteractionMode", (_event, mode: unknown) => {
    if (mode !== "web" && mode !== "app") return false;
    interactionMode = mode;
    return true;
  });
  ipcMain.handle("proxy:getGlobal", () => globalProxySettings);
  ipcMain.handle("proxy:setGlobal", async (_event, value: unknown) => {
    const next = normalizeGlobalProxySettings(value);
    if (!next) {
      const message = "代理配置无效，请检查地址、端口和例外地址";
      sendProxyStatus("global", false, message);
      return { ok: false, message };
    }
    const previous = globalProxySettings;
    const affectedPartitions = new Set<string>(["persist:shared"]);
    for (const [paneId, partition] of panePartitions) {
      const paneProxy = paneProxySettings.get(paneId) ?? defaultPaneProxySettings();
      if (paneProxy.mode === "inherit") affectedPartitions.add(partition);
    }
    try {
      for (const partition of affectedPartitions) await applyProxyToPartition(partition, next, true);
      for (const [paneId, partition] of panePartitions) {
        const paneProxy = paneProxySettings.get(paneId) ?? defaultPaneProxySettings();
        if (paneProxy.mode === "inherit") affectedPartitions.add(partition);
      }
      for (const partition of affectedPartitions) await applyProxyToPartition(partition, next, true);
      await saveGlobalProxySettings(next);
      globalProxySettings = next;
      reloadPanesInPartitions(affectedPartitions);
      sendProxyStatus("global", true);
      return { ok: true, settings: next };
    } catch (error) {
      for (const partition of affectedPartitions) await applyProxyToPartition(partition, previous, true).catch(() => undefined);
      const message = error instanceof Error ? error.message : "应用全局代理失败";
      sendProxyStatus("global", false, message);
      return { ok: false, message };
    }
  });
  ipcMain.handle("proxy:setPane", async (_event, paneId: unknown, value: unknown) => {
    if (typeof paneId !== "string") {
      const message = "无效分屏";
      sendProxyStatus("pane", false, message);
      return { ok: false, message };
    }
    const next = normalizePaneProxySettings(value);
    if (!next) {
      const message = "代理配置无效，请检查地址、端口和例外地址";
      sendProxyStatus("pane", false, message, paneId);
      return { ok: false, message };
    }
    const partition = panePartitions.get(paneId);
    if (!partition) {
      const message = "分屏网页尚未准备好";
      sendProxyStatus("pane", false, message, paneId);
      return { ok: false, message };
    }
    if (partition === "persist:shared" && next.mode !== "inherit") {
      const message = "共享会话不能使用独立代理，请先切换为独立会话";
      sendProxyStatus("pane", false, message, paneId);
      return { ok: false, message };
    }
    const previous = paneProxySettings.get(paneId) ?? defaultPaneProxySettings();
    const previousEffective = resolveProxySettings(globalProxySettings, previous);
    const nextEffective = resolveProxySettings(globalProxySettings, next);
    const effectiveChanged = proxySettingsKey(previousEffective) !== proxySettingsKey(nextEffective)
      || partitionProxyKeys.get(partition) !== proxySettingsKey(nextEffective);
    try {
      paneProxySettings.set(paneId, next);
      if (effectiveChanged) {
        await applyProxyToPartition(partition, nextEffective, true);
        reloadPane(paneId);
      }
      sendProxyStatus("pane", true, undefined, paneId);
      return { ok: true, settings: next };
    } catch (error) {
      paneProxySettings.set(paneId, previous);
      await applyProxyToPartition(partition, resolveProxySettings(globalProxySettings, previous), true).catch(() => undefined);
      const message = error instanceof Error ? error.message : "应用分屏代理失败";
      sendProxyStatus("pane", false, message, paneId);
      return { ok: false, message };
    }
  });
  ipcMain.handle("layout:load", () => loadLayout());
  ipcMain.handle("layout:save", (_event, layout: unknown) => saveLayout(layout));
  ipcMain.handle("pane:selectLocalVideo", () => selectLocalVideo());
  ipcMain.handle("pane:loadLocalVideo", async (_event, paneId: unknown, value: unknown) => {
    if (typeof paneId !== "string" || !await isAuthorizedLocalVideoUrl(value)) {
      return { ok: false, message: "本地视频未获授权或已无法访问，请重新选择文件" };
    }
    const webContentsId = [...paneWebContents.entries()].find(([, registeredPaneId]) => registeredPaneId === paneId)?.[0];
    const contents = webContentsId === undefined ? null : webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) return { ok: false, message: "分屏播放器尚未准备好" };
    try {
      await contents.loadURL(value as string);
      return { ok: true };
    } catch {
      return { ok: false, message: "本地视频无法加载，请确认文件未被删除且格式受支持" };
    }
  });
  ipcMain.handle("pane:openInChrome", (_event, value: unknown) => openInChrome(value));
  ipcMain.handle("pane:openAuthWindow", (_event, value: unknown, partition: unknown) => openAuthenticationWindow(value, partition));
  ipcMain.handle("window:exitWebpageFullscreen", (_event, paneId: unknown) => exitWebpageFullscreen(typeof paneId === "string" ? paneId : undefined));
  ipcMain.handle("pane:reportPlaybackState", () => true);
  ipcMain.handle("chrome:openLogin", async (_event, url: unknown) => {
    if (!isSafeUrl(url)) return { ok: false, message: "无效网址" };
    const manager = ensureChromeManager();
    if (!manager) return { ok: false, message: "需要安装 Google Chrome 才能登录" };
    try {
      const pane = await manager.launchPane("__solver__", url as string);
      const display = screen.getPrimaryDisplay();
      const width = 1080;
      const height = 720;
      const bounds: WindowBounds = {
        x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
        y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
        width,
        height,
      };
      await manager.applyLayout({ __solver__: bounds });
      return { ok: true, windowId: pane.windowId };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Chrome 登录窗口启动失败" };
    }
  });
  ipcMain.handle("pane:inspectFingerprint", async (_event, paneId: unknown) => {
    if (typeof paneId !== "string") return null;
    const webContentsId = [...paneWebContents.entries()].find(([, registeredPaneId]) => registeredPaneId === paneId)?.[0];
    if (webContentsId === undefined) return null;
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed()) return null;
    const script = `(async () => {
      const gl = document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl");
      const debug = gl && gl.getExtension ? gl.getExtension("WEBGL_debug_renderer_info") : null;
      const highEntropy = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "platformVersion", "uaFullVersion", "wow64"])
        : null;
      return JSON.stringify({
        applied: window.__sameScreenFingerprintApplied === true,
        ua: navigator.userAgent,
        brands: (navigator.userAgentData && navigator.userAgentData.brands) ? Array.from(navigator.userAgentData.brands) : null,
        highEntropy,
        platform: navigator.platform,
        languages: navigator.languages ? Array.from(navigator.languages) : null,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
        webgl: debug && gl ? { vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) } : null,
        plugins: (navigator.plugins && navigator.plugins.length) || 0,
        mimeTypes: (navigator.mimeTypes && navigator.mimeTypes.length) || 0,
        webdriver: navigator.webdriver,
        chrome: typeof window.chrome,
      });
    })()`;
    try {
      const raw = (await contents.executeJavaScript(script, true)) as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      recordFingerprintDiagnostic(paneId, parsed);
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordFingerprintDiagnostic(paneId, { error: message });
      return { error: message };
    }
  });
  ipcMain.handle("pane:logFocusDiagnostic", async (_event, paneId: unknown, info: unknown) => {
    if (typeof paneId !== "string") return false;
    const entry = { timestamp: new Date().toISOString(), paneId, focus: info };
    void fs.appendFile(path.join(app.getPath("userData"), "focus-diagnostics.log"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
    return true;
  });
  ipcMain.handle("pane:setChallengeMode", (_event, paneId: unknown, enabled: unknown) => {
    if (typeof paneId !== "string") return false;
    if (enabled) challengeModePanes.add(paneId);
    else challengeModePanes.delete(paneId);
    return true;
  });
  ipcMain.handle("pane:reportChallengeState", (_event, paneId: unknown, state: unknown) => {
    if (typeof paneId !== "string" || !state || typeof state !== "object") return false;
    const value = state as { status?: unknown; url?: unknown; navigationCount?: unknown };
    if (value.status !== "none" && value.status !== "detected" && value.status !== "passed" && value.status !== "looped") return false;
    if (value.status === "detected" || value.status === "looped") {
      challengeModePanes.add(paneId);
      const previous = challengeNavigation.get(paneId) ?? emptyChallengeNavigation();
      const next = value.status === "looped"
        ? { ...observeChallengeSignal(previous, value.url), status: "looped" as const }
        : previous.status === "none" || previous.status === "passed"
          ? observeChallengeSignal(previous, value.url)
          : previous;
      challengeNavigation.set(paneId, next);
      if (next.status === "looped") {
        const webContentsId = [...paneWebContents.entries()].find(([, registeredPaneId]) => registeredPaneId === paneId)?.[0];
        const contents = webContentsId === undefined ? null : webContents.fromId(webContentsId);
        try {
          contents?.send("challenge-navigation", {
            status: "looped",
            url: typeof value.url === "string" ? value.url : undefined,
            navigationCount: next.navigationCount,
            message: "验证仍在循环，应用已停止自动刷新。",
          });
        } catch {
        }
      }
    } else if (value.status === "passed" || value.status === "none") {
      challengeModePanes.delete(paneId);
      challengeNavigation.set(paneId, value.status === "passed"
        ? observeChallengeNavigation(challengeNavigation.get(paneId), "https://passed.invalid/")
        : emptyChallengeNavigation());
    }
    recordCloudflareDiagnostic(paneId, value.url, value.status, typeof value.navigationCount === "number" ? value.navigationCount : 0);
    return true;
  });
  ipcMain.handle("pane:register", async (_event, paneId: unknown, webContentsId: unknown, partition: unknown, pageUrl: unknown, proxy: unknown) => {
    if (typeof paneId !== "string" || typeof webContentsId !== "number" || typeof partition !== "string") return false;
    if (partition !== "persist:shared" && partition !== `persist:${paneId}`) return false;
    const paneProxy = proxy === undefined ? defaultPaneProxySettings() : normalizePaneProxySettings(proxy);
    if (!paneProxy) return false;
    if (partition === "persist:shared" && paneProxy.mode !== "inherit") return false;
    try {
      await applyProxyToPartition(partition, resolveProxySettings(globalProxySettings, paneProxy));
    } catch {
      return false;
    }
    for (const [registeredWebContentsId, registeredPaneId] of paneWebContents) {
      if (registeredPaneId === paneId && registeredWebContentsId !== webContentsId) unbindGuest(registeredWebContentsId);
    }
    paneWebContents.set(webContentsId, paneId);
    panePartitions.set(paneId, partition);
    paneProxySettings.set(paneId, paneProxy);
    bindGuest(paneId, webContentsId);
    if (typeof pageUrl === "string" && await isAuthorizedLocalVideoUrl(pageUrl)) {
      paneHosts.delete(paneId);
    } else if (typeof pageUrl === "string" && isSafeUrl(pageUrl)) {
      try {
        paneHosts.set(paneId, new URL(pageUrl).hostname.toLowerCase());
      } catch {
      }
    } else {
      paneHosts.delete(paneId);
    }
    knownPartitions.add(partition);
    configureSession(session.fromPartition(partition));
    installAdblockForSession(session.fromPartition(partition));
    return true;
  });
  ipcMain.handle("pane:setAdblock", (_event, paneId: unknown, host: unknown, enabled: unknown) => {
    if (typeof paneId !== "string" || typeof host !== "string") return false;
    const normalizedHost = normalizeAdblockHost(host);
    if (!normalizedHost) return false;
    const key = `${paneId}|${normalizedHost}`;
    if (enabled) {
      disabledAdblockRules.delete(key);
    } else {
      disabledAdblockRules.add(key);
    }
    return true;
  });
  ipcMain.handle("pane:getAdblock", (_event, paneId: unknown, host: unknown) => typeof paneId === "string" && typeof host === "string" ? !isAdblockDisabledForHost(paneId, host) : true);
  ipcMain.handle("session:clear", async () => {
    await Promise.all([...knownPartitions].map((partition) => session.fromPartition(partition).clearStorageData()));
    return true;
  });
}

async function setupAdblock(): Promise<void> {
  ipcMain.removeHandler("@ghostery/adblocker/inject-cosmetic-filters");
  ipcMain.removeHandler("@ghostery/adblocker/is-mutation-observer-enabled");
  ipcMain.handle("@ghostery/adblocker/inject-cosmetic-filters", async (event, url: unknown, message: unknown) => {
    if (!blocker || typeof url !== "string") return;
    const paneId = paneWebContents.get(event.sender.id);
    const pageHost = paneId ? paneHosts.get(paneId) : undefined;
    if (paneId && (isAdblockDisabledForUrl(paneId, url) || (pageHost !== undefined && isAdblockDisabledForHost(paneId, pageHost)))) return;
    await blocker.onInjectCosmeticFilters(event, url, message as undefined | { classes: string[]; hrefs: string[]; ids: string[]; lifecycle: "start" | "dom-update" });
  });
  ipcMain.handle("@ghostery/adblocker/is-mutation-observer-enabled", () => Boolean(blocker?.config.enableMutationObserver));
  try {
    const cachePath = adblockCachePath();
    blocker = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists, {
      enableMutationObserver: true,
      loadExtendedSelectors: true,
      loadCosmeticFilters: true,
      loadGenericCosmeticsFilters: true,
    }, {
      path: cachePath,
      read: async (value) => new Uint8Array(await fs.readFile(value)),
      write: async (value, data) => {
        await fs.mkdir(path.dirname(value), { recursive: true });
        await fs.writeFile(value, data);
      },
    });
    for (const partition of knownPartitions) installAdblockForSession(session.fromPartition(partition));
  } catch (error) {
    console.warn("Ad blocking rules could not be loaded:", error);
  }
}

function installAdblockForSession(targetSession: Electron.Session): void {
  installSessionDiagnostics(targetSession);
  if (blocker && !installedCosmeticSessions.has(targetSession)) {
    installedCosmeticSessions.add(targetSession);
    targetSession.registerPreloadScript({ type: "frame", filePath: GHOSTERY_PRELOAD_PATH });
  }
  if (!blocker || installedBlockingSessions.has(targetSession)) return;
  installedBlockingSessions.add(targetSession);
  targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const paneId = typeof details.webContentsId === "number" ? paneWebContents.get(details.webContentsId) : undefined;
    let host = "";
    try {
      host = new URL(details.url).hostname.toLowerCase();
    } catch {
      callback({});
      return;
    }
    const pageHost = paneId ? paneHosts.get(paneId) : undefined;
    if (shouldBypassAdblockForChallenge(details.url, details.resourceType, false)) {
      callback({});
      return;
    }
    if (paneId && (isAdblockDisabledForHost(paneId, host) || (pageHost !== undefined && isAdblockDisabledForHost(paneId, pageHost)))) {
      callback({});
      return;
    }
    if (paneId && isKnownAdRequest(details.url) && !isAdblockDisabledForUrl(paneId, details.url)) {
      callback({ cancel: true });
      return;
    }
    if (compatibilityResourceTypes.has(String(details.resourceType).toLowerCase())) {
      callback({});
      return;
    }
    if (isAuthenticationUrl(details.url)) {
      callback({});
      return;
    }
    if (isVideoRequest(details.url, details.resourceType, pageHost)) {
      callback({});
      return;
    }
    blocker?.onBeforeRequest(details, callback);
  });
}

function installSessionDiagnostics(targetSession: Electron.Session): void {
  if (installedSessionDiagnostics.has(targetSession)) return;
  installedSessionDiagnostics.add(targetSession);
  targetSession.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
    const resourceType = String(details.resourceType);
    const paneId = typeof details.webContentsId === "number" ? paneWebContents.get(details.webContentsId) : undefined;
    const challengeResource = isCloudflareChallengeRequest(details.url, details.resourceType);
    const trackedChallengePage = Boolean(paneId && challengeModePanes.has(paneId) && resourceType === "mainFrame");
    if (paneId && (challengeResource || trackedChallengePage)) {
      recordCloudflareDiagnostic(paneId, details.url, "resource-completed", challengeNavigation.get(paneId)?.navigationCount ?? 0, details.statusCode);
    }
  });
}

function installHeaderDiagnostics(targetSession: Electron.Session): void {
  if (headerDiagnosticSessions.has(targetSession)) return;
  headerDiagnosticSessions.add(targetSession);
  targetSession.webRequest.onSendHeaders({ urls: ["<all_urls>"] }, (details) => {
    if (details.resourceType !== "mainFrame" && !/challenges\.cloudflare\.com/i.test(details.url)) return;
    const headers = details.requestHeaders ?? {};
    const entry = {
      timestamp: new Date().toISOString(),
      url: details.url,
      userAgent: headers["User-Agent"] ?? headers["user-agent"],
      secChUa: headers["sec-ch-ua"] ?? headers["Sec-CH-UA"],
      secChUaFullVersionList: headers["sec-ch-ua-full-version-list"] ?? headers["Sec-CH-UA-Full-Version-List"],
    };
    void fs.appendFile(path.join(app.getPath("userData"), "cloudflare-diagnostics.log"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
  });
}

function isVideoRequest(url: string, resourceType: string, pageHost?: string): boolean {
  if (resourceType === "media" || resourceType === "object") return true;
  if (/\.(?:m3u8|mp4|m4v|webm|mpd|m4s|ts|aac|m4a)(?:$|[?#])/i.test(url)) return true;
  let requestHost = "";
  try {
    requestHost = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!pageHost) return false;
  if (requestHost === pageHost || requestHost.endsWith(`.${pageHost}`)) return true;
  const siteHosts = pageHost.includes("youtube")
    ? ["youtube.com", "googlevideo.com", "ytimg.com", "googleusercontent.com"]
    : pageHost.includes("bilibili")
      ? ["bilibili.com", "bilivideo.com", "hdslb.com"]
      : [];
  return siteHosts.some((siteHost) => requestHost === siteHost || requestHost.endsWith(`.${siteHost}`));
}

function configureSession(targetSession: Electron.Session): void {
  installFingerprintForSession(targetSession);
  installHeaderDiagnostics(targetSession);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0e1219",
    title: "同屏播放",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: "deny" };
  });

  mainWindow.on("enter-full-screen", () => mainWindow?.webContents.send("window:fullscreen-change", true));
  mainWindow.on("leave-full-screen", () => mainWindow?.webContents.send("window:fullscreen-change", false));
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F8" || input.code === "F8") {
      event.preventDefault();
      sendWindowMessage("window:toggle-interaction-mode");
      return;
    }
    if (input.key === "F11" || input.code === "F11") {
      event.preventDefault();
      sendWindowMessage("window:toggle-app-fullscreen");
      return;
    }
    if (input.key !== "Escape" && input.code !== "Escape") return;
    if (htmlFullscreenPaneId) {
      event.preventDefault();
      void exitWebpageFullscreen(htmlFullscreenPaneId);
      return;
    }
    if (interactionMode === "app" || mainWindow?.isFullScreen()) {
      event.preventDefault();
      sendWindowMessage("window:escape");
    }
  });

  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, "guest-preload.js");
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!isSafeUrl(params.src) && params.src !== "about:blank") params.src = "about:blank";
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    for (const webContentsId of guestBindings.keys()) unbindGuest(webContentsId);
    mainWindow = null;
  });
}

function helperScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "windows-window-helper.ps1")
    : helperPath(path.join(app.getAppPath(), "electron"));
}

app.whenReady().then(async () => {
  registerIpc();
  globalProxySettings = await loadGlobalProxySettings();
  await applyProxyToPartition("persist:shared", globalProxySettings).catch(() => undefined);
  configureSession(session.fromPartition("persist:shared"));
  windowsHelper = new WindowsWindowHelper(helperScriptPath());
  windowsHelper.start();
  createWindow();
  void setupAdblock();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  windowsHelper?.stop();
  void chromeManager?.closeAll();
});

export function guestPreloadUrl(): string {
  return pathToFileURL(path.join(__dirname, "guest-preload.js")).toString();
}
