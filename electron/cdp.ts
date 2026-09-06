import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import type { BrowserBackend, ChromeStatus, WindowBounds } from "../src/shared/types";

type CdpTargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title?: string;
};

type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string };

type CdpResponse = { id: number; result?: unknown; error?: { code: number; message: string }; sessionId?: string };

type CdpConnectionOptions = { port: number };

type ChromePane = {
  paneId: string;
  targetId: string;
  sessionId: string;
  windowId: number;
  processId?: number;
  status: ChromeStatus;
  url: string;
  bounds?: WindowBounds;
};

type ChromeEvent =
  | { type: "ready"; pane: ChromePane }
  | { type: "closed"; paneId: string }
  | { type: "crashed"; paneId: string; message: string }
  | { type: "error"; message: string };

type ChromeSessionOptions = {
  userDataDir: string;
  extensionPath: string;
  executable: string;
};

export type HarvestedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

function mapSameSite(sameSite?: string): HarvestedCookie["sameSite"] {
  if (sameSite === "Strict") return "strict";
  if (sameSite === "Lax") return "lax";
  if (sameSite === "None") return "no_restriction";
  return "unspecified";
}

function isBlankTarget(info: CdpTargetInfo): boolean {
  return info.type === "page" && (info.url === "about:blank" || info.url === "chrome://newtab/" || info.url === "chrome://new-tab-page/");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Chrome DevTools HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

class CdpConnection {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<(event: CdpEvent) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (payload) => this.onMessage(payload.toString()));
    socket.on("close", () => this.rejectAll(new Error("Chrome DevTools connection closed")));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  static async connect(options: CdpConnectionOptions, timeoutMs = 12_000): Promise<CdpConnection> {
    const version = await getJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${options.port}/json/version`);
    if (!version.webSocketDebuggerUrl) throw new Error("Chrome DevTools websocket URL unavailable");
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools")), timeoutMs);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return new CdpConnection(socket);
  }

  private onMessage(raw: string): void {
    let value: CdpResponse | CdpEvent;
    try {
      value = JSON.parse(raw) as CdpResponse | CdpEvent;
    } catch {
      return;
    }
    if ("id" in value) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(value.error.message));
      else pending.resolve(value.result);
      return;
    }
    const listeners = this.listeners.get(value.method);
    listeners?.forEach((listener) => listener(value));
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: (event: CdpEvent) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {
    this.rejectAll(new Error("Chrome DevTools connection closed"));
    this.socket.close();
  }

  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}

export class ChromeSessionManager {
  private readonly options: ChromeSessionOptions;
  private child: ChildProcess | null = null;
  private connection: CdpConnection | null = null;
  private port = 0;
  private readonly panes = new Map<string, ChromePane>();
  private readonly targetToPane = new Map<string, string>();
  private readonly listeners = new Set<(event: ChromeEvent) => void>();
  private pendingTargets: Array<{ paneId: string; resolve: (target: CdpTargetInfo) => void; reject: (error: Error) => void }> = [];
  private cleanupTargetEvents: Array<() => void> = [];

  private async findUnusedBlankTarget(): Promise<CdpTargetInfo | null> {
    if (!this.connection) return null;
    const result = await this.connection.send<{ targetInfos?: CdpTargetInfo[] }>("Target.getTargets");
    return (result.targetInfos ?? []).find((info) => isBlankTarget(info) && !this.targetToPane.has(info.targetId)) ?? null;
  }

  constructor(options: ChromeSessionOptions) {
    this.options = options;
  }

  onEvent(listener: (event: ChromeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): { running: boolean; port: number; panes: ChromePane[]; profileDir: string; backend: BrowserBackend } {
    return { running: Boolean(this.connection), port: this.port, panes: [...this.panes.values()], profileDir: this.options.userDataDir, backend: "chrome" };
  }

  async ensureSession(): Promise<void> {
    if (this.connection) return;
    await fs.mkdir(this.options.userDataDir, { recursive: true });
    this.port = await freePort();
    const args = [
      `--user-data-dir=${this.options.userDataDir}`,
      "--profile-directory=Default",
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      `--load-extension=${this.options.extensionPath}`,
      "--app=about:blank",
    ];
    this.child = spawn(this.options.executable, args, { detached: false, stdio: "ignore", windowsHide: true });
    this.child.once("exit", (code, signal) => {
      this.connection = null;
      this.panes.forEach((pane) => this.emit({ type: "crashed", paneId: pane.paneId, message: `Chrome 已退出（${code ?? signal ?? "unknown"}）` }));
      this.panes.clear();
      this.targetToPane.clear();
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        this.connection = await CdpConnection.connect({ port: this.port });
        break;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    if (!this.connection) throw lastError instanceof Error ? lastError : new Error("Unable to connect to Chrome DevTools");
    this.cleanupTargetEvents.push(this.connection.on("Target.targetCreated", (event) => {
      const info = event.params?.targetInfo as CdpTargetInfo | undefined;
      if (!info || !isBlankTarget(info)) return;
      const pending = this.pendingTargets.shift();
      pending?.resolve(info);
    }));
    this.cleanupTargetEvents.push(this.connection.on("Target.targetDestroyed", (event) => {
      const targetId = event.params?.targetId;
      if (typeof targetId !== "string") return;
      const paneId = this.targetToPane.get(targetId);
      if (!paneId) return;
      this.targetToPane.delete(targetId);
      this.panes.delete(paneId);
      this.emit({ type: "closed", paneId });
    }));
    await this.connection.send("Target.setDiscoverTargets", { discover: true });
  }

  async launchPane(paneId: string, url?: string): Promise<ChromePane> {
    await this.ensureSession();
    const existing = this.panes.get(paneId);
    if (existing) {
      if (url) await this.navigatePane(paneId, url);
      return existing;
    }
    let target = await this.findUnusedBlankTarget();
    if (!target) {
      const targetPromise = new Promise<CdpTargetInfo>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for Chrome App window")), 15_000);
        this.pendingTargets.push({ paneId, resolve: (createdTarget) => { clearTimeout(timer); resolve(createdTarget); }, reject });
      });
      spawn(this.options.executable, [
        `--user-data-dir=${this.options.userDataDir}`,
        "--profile-directory=Default",
        `--remote-debugging-port=${this.port}`,
        "--remote-debugging-address=127.0.0.1",
        `--load-extension=${this.options.extensionPath}`,
        "--app=about:blank",
      ], { detached: false, stdio: "ignore", windowsHide: true });
      target = await targetPromise;
    }
    const attached = await this.connection!.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const window = await this.connection!.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: target.targetId });
    const pane: ChromePane = { paneId, targetId: target.targetId, sessionId: attached.sessionId, windowId: window.windowId, processId: this.child?.pid, status: "starting", url: "about:blank" };
    this.panes.set(paneId, pane);
    this.targetToPane.set(target.targetId, paneId);
    await this.connection!.send("Page.enable", {}, pane.sessionId);
    await this.connection!.send("Runtime.enable", {}, pane.sessionId);
    await this.connection!.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__sameScreenPlayerBackend = 'chrome';" }, pane.sessionId);
    if (url) await this.navigatePane(paneId, url);
    pane.status = "ready";
    this.emit({ type: "ready", pane });
    return pane;
  }

  async navigatePane(paneId: string, url: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane || !this.connection) return false;
    if (pane.url === url) return true;
    await this.connection.send("Page.navigate", { url }, pane.sessionId);
    pane.url = url;
    pane.status = "ready";
    return true;
  }

  async reloadPane(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane || !this.connection) return false;
    await this.connection.send("Page.reload", { ignoreCache: false }, pane.sessionId);
    return true;
  }

  async getChromeVersion(): Promise<{ version: string; userAgent: string } | null> {
    await this.ensureSession();
    try {
      const info = await this.connection!.send<{ product?: string; userAgent?: string }>("Browser.getVersion");
      const product = typeof info.product === "string" && info.product.startsWith("Chrome/") ? info.product.slice("Chrome/".length) : "";
      if (!product) return null;
      return { version: product, userAgent: typeof info.userAgent === "string" && info.userAgent.length > 0 ? info.userAgent : "" };
    } catch {
      return null;
    }
  }

  async harvestCloudflareCookies(url: string): Promise<HarvestedCookie[]> {
    await this.ensureSession();
    const host = new URL(url).hostname.toLowerCase();
    const result = await this.connection!.send<{ cookies?: CdpCookie[] }>("Storage.getCookies");
    return (result.cookies ?? [])
      .filter((cookie) => {
        const domain = (cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain).toLowerCase();
        return host === domain || host.endsWith(`.${domain}`);
      })
      .filter((cookie) => cookie.name === "cf_clearance" || cookie.name === "__cf_bm" || cookie.name.startsWith("cf_"))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.session || cookie.expires <= 0 ? undefined : cookie.expires,
        sameSite: mapSameSite(cookie.sameSite),
      }));
  }

  async harvestCookies(domains: string[]): Promise<HarvestedCookie[]> {
    await this.ensureSession();
    const normalized = domains.map((domain) => domain.toLowerCase().replace(/^\./, ""));
    const result = await this.connection!.send<{ cookies?: CdpCookie[] }>("Storage.getCookies");
    return (result.cookies ?? [])
      .filter((cookie) => {
        const domain = (cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain).toLowerCase();
        return normalized.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
      })
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.session || cookie.expires <= 0 ? undefined : cookie.expires,
        sameSite: mapSameSite(cookie.sameSite),
      }));
  }

  async closePane(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId);
    if (!pane || !this.connection) return false;
    await this.connection.send("Target.closeTarget", { targetId: pane.targetId });
    return true;
  }

  async applyLayout(bounds: Record<string, WindowBounds>): Promise<void> {
    if (!this.connection) return;
    await Promise.all([...this.panes.values()].map(async (pane) => {
      const next = bounds[pane.paneId];
      if (!next) return;
      pane.bounds = next;
      await this.connection!.send("Browser.setWindowBounds", { windowId: pane.windowId, bounds: { left: next.x, top: next.y, width: next.width, height: next.height, windowState: "normal" } });
    }));
  }

  async setFullscreen(enabled: boolean, bounds: Record<string, WindowBounds>): Promise<void> {
    if (!this.connection) return;
    void enabled;
    await this.applyLayout(bounds);
  }

  async clearProfile(): Promise<void> {
    await this.closeAll();
    await fs.rm(this.options.userDataDir, { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    if (this.connection) {
      await Promise.all([...this.panes.keys()].map((paneId) => this.closePane(paneId).catch(() => undefined)));
      this.cleanupTargetEvents.forEach((cleanup) => cleanup());
      this.cleanupTargetEvents = [];
      this.connection.close();
      this.connection = null;
    }
    if (this.child && !this.child.killed) {
      this.child.kill();
      this.child = null;
    }
    this.panes.clear();
    this.targetToPane.clear();
  }

  private emit(event: ChromeEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

export function isValidChromeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export type { ChromeEvent, ChromePane, ChromeSessionOptions };
