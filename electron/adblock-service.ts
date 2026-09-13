import { BrowserWindow, ipcMain, type WebContents, type WebFrameMain, type Session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { Request } from "@ghostery/adblocker";
import { parse } from "tldts-experimental";
import { randomUUID, createHash } from "node:crypto";
import type { IMessageFromBackground } from "@ghostery/adblocker-content";
import type { AdblockEngine } from "./adblock-engine";
import { httpUrl, playbackCompatibility } from "./adblock-engine";
import { classifyNavigation, sameNavigationTarget, type NavigationIntent } from "./adblock-navigation";
import { isCloudflareChallengeRequest } from "./cloudflare";
import { isKnownAdRequest } from "./ad-navigation";
import type { BlockedNavigation } from "../src/shared/adblock";

type Owner = { paneId: string; contents: WebContents; initialUrl: string; intents: Map<number, NavigationIntent>; pending: Map<string, Pending>; bypass?: { url: string; expires: number; frameId?: number }; dispose: () => void };
type Pending = { url: string; sourceUrl: string; createdAt: number; frame?: WebFrameMain; postBody?: Electron.PostBody };
type Auxiliary = { owner: Owner; window: BrowserWindow; intent?: NavigationIntent; sourceUrl: string; timer: ReturnType<typeof setTimeout>; finished?: boolean };
const emptyRules = (): IMessageFromBackground => ({ active: false, scripts: [], styles: "", extended: [] });

export class AdblockService {
  private readonly owners = new Map<number, Owner>();
  private readonly auxiliary = new Map<number, Auxiliary>();
  private readonly sessions = new WeakSet<Session>();
  private readonly preloadSessions = new WeakSet<Session>();
  private readonly ipcDisposers: (() => void)[] = [];

  constructor(private readonly options: {
    engine: () => AdblockEngine | null;
    enabled: (paneId: string, topUrl: string) => boolean;
    notify: (event: BlockedNavigation) => void;
    diagnostic?: (entry: { paneId: string; host: string; kind: string; rule?: string }) => void;
    authenticate: (url: string, contents: WebContents) => boolean;
    isAuthenticationUrl?: (url: string) => boolean;
  }) {}

  registerIpc(): void {
    const rules = (event: IpcMainEvent) => { event.returnValue = this.frameRules(event); };
    const intent = (event: IpcMainEvent, value: unknown) => {
      const owner = this.owners.get(event.sender.id);
      const frame = event.senderFrame;
      if (owner && frame && value && typeof value === "object") {
        const input = value as { kind?: unknown; target?: unknown };
        if (["link", "media", "form", "other"].includes(String(input.kind))) {
          owner.intents.set(frame.frameTreeNodeId, { kind: input.kind as NavigationIntent["kind"], target: httpUrl(input.target) ?? undefined, sourceUrl: this.frameUrl(frame, owner), at: Date.now() });
        }
      }
      event.returnValue = null;
    };
    ipcMain.on("adblock:frame-rules", rules);
    ipcMain.on("adblock:intent", intent);
    const scriptFailure = (event: IpcMainEvent, value: { id?: unknown; name?: unknown } | null) => {
      const owner = this.owners.get(event.sender.id);
      const frame = event.senderFrame;
      if (!owner || !frame || !value || typeof value.id !== "string" || !/^[a-f0-9]{16}$/.test(value.id)) return;
      const name = typeof value.name === "string" && /^[A-Za-z]{1,40}$/.test(value.name) ? value.name : "Error";
      const url = httpUrl(this.frameUrl(frame, owner));
      if (url) this.options.diagnostic?.({ paneId: owner.paneId, host: new URL(url).hostname, kind: `scriptlet-error:${name}`, rule: value.id });
    };
    ipcMain.on("adblock:scriptlet-error", scriptFailure);
    ipcMain.handle("adblock:frame-rules-update", (event, features) => this.frameRules(event, features));
    this.ipcDisposers.push(() => {
      ipcMain.removeListener("adblock:frame-rules", rules);
      ipcMain.removeListener("adblock:intent", intent);
      ipcMain.removeListener("adblock:scriptlet-error", scriptFailure);
      ipcMain.removeHandler("adblock:frame-rules-update");
    });
  }

  private topUrl(owner: Owner): string {
    return httpUrl(owner.contents.getURL()) ?? owner.initialUrl;
  }

  private frameUrl(frame: WebFrameMain | null, owner: Owner): string {
    for (let current = frame; current; current = current.parent) {
      if (httpUrl(current.url)) return current.url;
    }
    return this.topUrl(owner);
  }

  private frameRules(event: IpcMainEvent | IpcMainInvokeEvent, features?: unknown): IMessageFromBackground & { scriptIds?: string[] } {
    const owner = this.owners.get(event.sender.id);
    const frame = event.senderFrame;
    const engine = this.options.engine();
    if (!owner || !frame || !engine || !this.options.enabled(owner.paneId, this.topUrl(owner))) return emptyRules();
    const url = this.frameUrl(frame, owner);
    if (!httpUrl(url) || isCloudflareChallengeRequest(url)) return emptyRules();
    const host = parse(url);
    const values = features as Record<string, unknown> | undefined;
    const strings = (key: string): string[] | undefined => Array.isArray(values?.[key]) ? (values[key] as unknown[]).filter((v): v is string => typeof v === "string" && v.length < 2048).slice(0, 2048) : undefined;
    const result = engine.network.getCosmeticsFilters({
      url, hostname: host.hostname ?? "", domain: host.domain ?? "",
      classes: strings("classes"), ids: strings("ids"), hrefs: strings("hrefs"),
      getBaseRules: !features, getInjectionRules: !features, getExtendedRules: true,
      getRulesFromHostname: !features, getRulesFromDOM: Boolean(features),
    });
    return { ...result, scriptIds: result.scripts.map(script => createHash("sha256").update(script).digest("hex").slice(0, 16)) };
  }

  prepareSession(session: Session, preloadPath: string): void {
    if (!this.preloadSessions.has(session)) {
      session.registerPreloadScript({ type: "frame", filePath: preloadPath });
      this.preloadSessions.add(session);
    }
    if (this.sessions.has(session)) return;
    this.sessions.add(session);
    // One listener per event per Session. Updating rules swaps the engine pointer;
    // it never replaces the fingerprint/header diagnostic listeners.
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const auxiliary = this.auxiliary.get(details.webContentsId ?? -1);
      if (auxiliary && details.resourceType === "mainFrame" && httpUrl(details.url)) {
        this.finishAuxiliary(auxiliary, details.url);
        callback({ cancel: true });
        return;
      }
      const owner = this.owners.get(details.webContentsId ?? -1);
      const engine = this.options.engine();
      if (!owner || !engine || !httpUrl(details.url) || !this.options.enabled(owner.paneId, this.topUrl(owner)) || isCloudflareChallengeRequest(details.url, details.resourceType)) { callback({}); return; }
      if (owner.bypass && owner.bypass.expires > Date.now() && sameNavigationTarget(owner.bypass.url, details.url) && (details.resourceType === "mainFrame" || details.resourceType === "subFrame") && owner.bypass.frameId === details.frame?.frameTreeNodeId) {
        owner.bypass = undefined;
        callback({}); return;
      }
      const sourceUrl = details.referrer || this.frameUrl(details.resourceType === "mainFrame" ? null : details.frame ?? null, owner);
      const compatibility = playbackCompatibility(details.url, sourceUrl, this.topUrl(owner), details.resourceType);
      if (compatibility) {
        this.options.diagnostic?.({ paneId: owner.paneId, host: new URL(details.url).hostname, kind: "compatibility", rule: compatibility });
        callback({});
        return;
      }
      const result = engine.match(details.url, sourceUrl, details.resourceType);
      if (result.redirect && details.resourceType !== "mainFrame") callback({ redirectURL: result.redirect.dataUrl });
      else if (result.match || (!result.exception && isKnownAdRequest(details.url))) {
        if (details.resourceType === "mainFrame") this.block(owner, details.url, sourceUrl, "navigation", "rule");
        this.options.diagnostic?.({ paneId: owner.paneId, host: new URL(details.url).hostname, kind: details.resourceType, rule: result.filter?.toString() });
        callback({ cancel: true });
      } else callback({});
    });
    session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      const owner = this.owners.get(details.webContentsId ?? -1);
      const engine = this.options.engine();
      if (!owner || !engine || !this.options.enabled(owner.paneId, this.topUrl(owner)) || isCloudflareChallengeRequest(details.url) || !["mainFrame", "subFrame"].includes(details.resourceType)) { callback({}); return; }
      const directives = engine.network.getCSPDirectives(Request.fromRawDetails({ url: details.url, sourceUrl: details.referrer || this.topUrl(owner), type: details.resourceType }));
      if (!directives) { callback({}); return; }
      const headers = { ...details.responseHeaders };
      const key = Object.keys(headers).find(name => name.toLowerCase() === "content-security-policy") ?? "Content-Security-Policy";
      // Separate CSP policies are intersected by Chromium; never weaken the site's.
      headers[key] = [...(headers[key] ?? []), directives];
      callback({ responseHeaders: headers });
    });
  }

  attach(paneId: string, contents: WebContents, initialUrl: string): void {
    const existing = this.owners.get(contents.id);
    if (existing) { existing.initialUrl = initialUrl; return; }
    const owner: Owner = { paneId, contents, initialUrl, intents: new Map(), pending: new Map(), dispose: () => undefined };
    this.owners.set(contents.id, owner);
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      if (!httpUrl(event.url)) return;
      const sourceFrame = event.initiator ?? event.frame;
      const sourceUrl = this.frameUrl(sourceFrame, owner);
      const intent = sourceFrame ? owner.intents.get(sourceFrame.frameTreeNodeId) : undefined;
      const reason = this.decision(owner, event.url, sourceUrl, false, event.isMainFrame ? intent : undefined);
      if (reason) {
        event.preventDefault();
        this.block(owner, event.url, sourceUrl, "navigation", reason, event.isMainFrame ? undefined : event.frame ?? undefined);
      }
    };
    const redirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      if (!httpUrl(event.url)) return;
      const sourceUrl = this.frameUrl(event.frame, owner);
      const reason = this.decision(owner, event.url, sourceUrl, false, undefined, true);
      if (reason) {
        event.preventDefault();
        this.block(owner, event.url, sourceUrl, "navigation", reason, event.isMainFrame ? undefined : event.frame ?? undefined);
      }
    };
    const committed = (_event: Electron.Event, url: string) => {
      owner.initialUrl = url;
      owner.intents.clear();
      owner.pending.clear();
      owner.bypass = undefined;
      for (const child of this.auxiliary.values()) if (child.owner === owner && !child.window.isDestroyed()) child.window.destroy();
    };
    contents.setWindowOpenHandler(details => {
      const referrer = httpUrl(details.referrer.url);
      const intent = [...owner.intents.values()].sort((a, b) => b.at - a.at).find(item => Date.now() - item.at < 2000 && (!referrer || (httpUrl(item.sourceUrl) && new URL(item.sourceUrl).origin === new URL(referrer).origin)));
      const sourceUrl = intent?.sourceUrl ?? referrer ?? this.topUrl(owner);
      if (details.url === "about:blank" || details.url === "") {
        // Keep the native WindowProxy for sites that assign its URL later. The
        // staging window stays hidden and every outbound document is intercepted.
        if ([...this.auxiliary.values()].filter(value => value.owner === owner).length >= 2) return { action: "deny" };
        return { action: "allow", createWindow: options => {
          const child = new BrowserWindow({ ...options, show: false, webPreferences: { ...options.webPreferences, session: contents.session, nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: true, contextIsolation: true } });
          const auxiliary: Auxiliary = { owner, window: child, intent, sourceUrl, timer: setTimeout(() => child.destroy(), 30000) };
          this.auxiliary.set(child.webContents.id, auxiliary);
          const id = child.webContents.id;
          child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          child.on("closed", () => { clearTimeout(auxiliary.timer); this.auxiliary.delete(id); });
          child.webContents.on("will-navigate", (event, url) => {
            if (httpUrl(url)) { event.preventDefault(); this.finishAuxiliary(auxiliary, url); }
          });
          return child.webContents;
        } };
      }
      if (!httpUrl(details.url)) return { action: "deny" };
      const reason = this.decision(owner, details.url, sourceUrl, true, intent);
      if (reason) this.block(owner, details.url, sourceUrl, "popup", reason, undefined, details.postBody);
      else this.open(owner, details.url, sourceUrl, details.postBody);
      return { action: "deny" };
    });
    contents.on("will-frame-navigate", navigate);
    contents.on("will-redirect", redirect);
    contents.on("did-navigate", committed);
    const destroyed = () => this.detach(contents.id);
    contents.once("destroyed", destroyed);
    owner.dispose = () => {
      contents.removeListener("will-frame-navigate", navigate);
      contents.removeListener("will-redirect", redirect);
      contents.removeListener("did-navigate", committed);
      contents.removeListener("destroyed", destroyed);
    };
  }

  private decision(owner: Owner, url: string, sourceUrl: string, popup: boolean, intent?: NavigationIntent, redirect = false) {
    if (owner.bypass && owner.bypass.expires > Date.now() && sameNavigationTarget(owner.bypass.url, url)) return null;
    if (isCloudflareChallengeRequest(url)) return null;
    const engine = this.options.engine();
    const network = engine?.match(url, sourceUrl, "mainFrame");
    const popupRule = popup || intent?.kind === "media" ? engine?.popup(url, sourceUrl) : undefined;
    const blocked = Boolean(network?.match || popupRule?.blocked || (!network?.exception && isKnownAdRequest(url)));
    const trustedLogin = popup && intent && intent.kind !== "media" && Date.now() - intent.at < 2000 && this.options.isAuthenticationUrl?.(url);
    const excepted = !blocked && Boolean(network?.exception || popupRule?.excepted || trustedLogin);
    return classifyNavigation({ url, popup, intent, redirect, enabled: this.options.enabled(owner.paneId, this.topUrl(owner)), ruleBlocked: blocked, ruleExcepted: excepted });
  }

  private finishAuxiliary(auxiliary: Auxiliary, url: string): void {
    if (auxiliary.window.isDestroyed() || auxiliary.finished) return;
    auxiliary.finished = true;
    const { owner, sourceUrl } = auxiliary;
    const intent = auxiliary.intent ? { ...auxiliary.intent, at: Date.now() } : undefined;
    const reason = this.decision(owner, url, sourceUrl, true, intent);
    if (reason) this.block(owner, url, sourceUrl, "popup", reason);
    else this.open(owner, url, sourceUrl);
    setImmediate(() => { if (!auxiliary.window.isDestroyed()) auxiliary.window.destroy(); });
  }

  private block(owner: Owner, url: string, sourceUrl: string, kind: BlockedNavigation["kind"], reason: BlockedNavigation["reason"], frame?: WebFrameMain, postBody?: Electron.PostBody): void {
    if (!httpUrl(url)) return;
    const id = randomUUID();
    if (owner.pending.size >= 20) owner.pending.delete(owner.pending.keys().next().value!);
    owner.pending.set(id, { url, sourceUrl, frame, postBody, createdAt: Date.now() });
    const engine = this.options.engine();
    const rule = reason === "rule" ? engine?.popup(url, sourceUrl).rule ?? engine?.match(url, sourceUrl, "mainFrame").filter?.toString() : undefined;
    this.options.diagnostic?.({ paneId: owner.paneId, host: new URL(url).hostname, kind: `${kind}:${reason}`, rule });
    this.options.notify({ id, paneId: owner.paneId, host: new URL(url).hostname, kind, reason, canAllow: !frame?.isDestroyed() });
  }

  allow(paneId: string, id: string): boolean {
    const owner = [...this.owners.values()].find(value => value.paneId === paneId);
    const pending = owner?.pending.get(id);
    if (!owner || !pending || Date.now() - pending.createdAt > 120000 || pending.frame?.isDestroyed()) return false;
    owner.pending.delete(id);
    owner.bypass = { url: pending.url, expires: Date.now() + 5000, frameId: (pending.frame ?? owner.contents.mainFrame).frameTreeNodeId };
    if (pending.frame) void pending.frame.executeJavaScript(`location.assign(${JSON.stringify(pending.url)})`).catch(() => undefined);
    else this.open(owner, pending.url, pending.sourceUrl, pending.postBody);
    return true;
  }

  private open(owner: Owner, url: string, sourceUrl: string, postBody?: Electron.PostBody): void {
    setImmediate(() => {
      if (owner.contents.isDestroyed()) return;
      if (!postBody && this.options.authenticate(url, owner.contents)) return;
      void owner.contents.loadURL(url, {
        httpReferrer: sourceUrl,
        ...(postBody ? { postData: postBody.data, extraHeaders: `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}` } : {}),
      }).catch(() => undefined);
    });
  }

  detach(contentsId: number): void {
    const owner = this.owners.get(contentsId);
    if (!owner) return;
    owner.dispose();
    this.owners.delete(contentsId);
    for (const auxiliary of this.auxiliary.values()) if (auxiliary.owner === owner && !auxiliary.window.isDestroyed()) auxiliary.window.destroy();
  }

  dispose(): void {
    for (const id of this.owners.keys()) this.detach(id);
    this.ipcDisposers.forEach(dispose => dispose());
  }
}
