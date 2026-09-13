import { ipcRenderer, webFrame } from "electron";
import { mainWorldFingerprintScript } from "./fingerprint";
import { challengeSignature, observeChallengeNavigation, type CloudflareStatus, type ChallengeNavigationState, emptyChallengeNavigation } from "./cloudflare";

// Session preloads filter every frame; player aggregation belongs to the top frame.
if (process.isMainFrame) {
try {
  void webFrame.executeJavaScript(mainWorldFingerprintScript(), false).catch(() => undefined);
} catch {
  // Fingerprint injection is best-effort; the guest page still loads normally.
}

type VideoCommand =
  | { type: "play" | "pause" | "toggle" | "toggleMuted" }
  | { type: "seek" | "setVolume" | "setRate"; value: number }
  | { type: "setMuted"; value: boolean };

type PlayerTarget = {
  root: HTMLElement;
  video: HTMLVideoElement | null;
  site: "youtube" | "bilibili" | "generic";
  frame?: HTMLIFrameElement;
};

type PlaybackSnapshot = {
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

type RemoteFrameState = {
  state: PlaybackSnapshot;
  receivedAt: number;
  playerId: string;
  muteSequence: number;
};

type PlayerStatus = "idle" | "loading" | "ready" | "unrecognized" | "challenge";

let paneActive = true;
let paneMuted = true;
let userPauseIntent = false;
let focusTarget: PlayerTarget | null = null;
let focusAncestors: HTMLElement[] = [];
let focusHidden: HTMLElement[] = [];
let focusStyle: HTMLStyleElement | null = null;
let focusModeEnabled = false;
let detectionScheduled = false;
let unrecognizedTimer: number | null = null;
let lastStatus: PlayerStatus | null = null;
let lastStatusMessage = "";
let lastSnapshot: PlaybackSnapshot | null = null;
let suppressPauseIntent = false;
let playRequestVersion = 0;
let pauseCommandLocked = false;
let lastUserInteractionAt = 0;
let controlsVisible = false;
let targetMissingSince = 0;
let cloudflareStatus: CloudflareStatus = "none";
let cloudflareUrl = "";
let cloudflareNavigationCount = 0;
let cloudflareNavigation: ChallengeNavigationState = emptyChallengeNavigation();
let lastChallengeMessage = "";
const boundVideos = new WeakSet<HTMLVideoElement>();
const wasPlaying = new WeakMap<HTMLVideoElement, boolean>();
const remoteFrameStates = new Map<HTMLIFrameElement, RemoteFrameState>();
const remoteFrameMuteSynced = new WeakMap<HTMLIFrameElement, Set<string>>();
const pendingFrameMute = new WeakMap<HTMLIFrameElement, { playerId: string; sequence: number; at: number }>();
let muteSequence = 0;
const FRAME_VIDEO_SOURCE = "same-screen-frame-video";
const nativeMediaPlay = HTMLMediaElement.prototype.play;
const nativeMediaPause = HTMLMediaElement.prototype.pause;

function sendChallengeState(status: CloudflareStatus, url?: string, navigationCount?: number, message?: string): void {
  const nextUrl = url ?? "";
  const nextCount = navigationCount ?? cloudflareNavigationCount;
  const nextMessage = message ?? "";
  if (cloudflareStatus === status && cloudflareUrl === nextUrl && cloudflareNavigationCount === nextCount && lastChallengeMessage === nextMessage) return;
  cloudflareStatus = status;
  cloudflareUrl = nextUrl;
  cloudflareNavigationCount = nextCount;
  lastChallengeMessage = nextMessage;
  ipcRenderer.sendToHost("challenge-state", {
    status,
    url: nextUrl || undefined,
    navigationCount: nextCount,
    message: nextMessage || undefined,
  });
}

function sendStatus(status: PlayerStatus, message?: string): void {
  const nextMessage = message ?? "";
  if (lastStatus === status && lastStatusMessage === nextMessage) return;
  lastStatus = status;
  lastStatusMessage = nextMessage;
  ipcRenderer.sendToHost("player-status", { status, message: message || undefined });
}

function getOpenShadowRoots(root: ParentNode = document): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  root.querySelectorAll("*").forEach((element) => {
    if (element.shadowRoot) roots.push(element.shadowRoot);
  });
  return roots;
}

function querySelectorDeep<T extends Element>(selector: string): T | null {
  const queue: ParentNode[] = [document];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const found = current.querySelector<T>(selector);
    if (found) return found;
    queue.push(...getOpenShadowRoots(current));
  }
  return null;
}

function queryAllDeep<T extends Element>(selector: string): T[] {
  const direct = Array.from(document.querySelectorAll<T>(selector));
  if (direct.length > 0) return direct;
  const results: T[] = [];
  const seen = new Set<Element>();
  const queue: ParentNode[] = [document];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    current.querySelectorAll<T>(selector).forEach((element) => {
      if (!seen.has(element)) {
        seen.add(element);
        results.push(element);
      }
    });
    queue.push(...getOpenShadowRoots(current));
  }
  return results;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

function visibleVideo(video: HTMLVideoElement): boolean {
  return isVisible(video) && video.readyState >= HTMLMediaElement.HAVE_METADATA;
}

function isPlayerSized(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect();
  return rect.width >= window.innerWidth * 0.3 && rect.height >= window.innerHeight * 0.25;
}

function collectVideosDeep(root: ParentNode): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  const seen = new Set<HTMLVideoElement>();
  const queue: ParentNode[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    current.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
      if (!seen.has(video)) {
        seen.add(video);
        found.push(video);
      }
    });
    queue.push(...getOpenShadowRoots(current));
  }
  return found;
}

function pickVideo(root: ParentNode): HTMLVideoElement | null {
  const visible = collectVideosDeep(root).filter(visibleVideo);
  return visible.sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  })[0] ?? null;
}

function pickLargestVisible(selector: string): HTMLElement | null {
  return queryAllDeep<HTMLElement>(selector).filter(isVisible).sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  })[0] ?? null;
}

function pickPlayerRoot(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const root = pickLargestVisible(selector);
    if (root) return root;
  }
  return null;
}

// YouTube/bilibili keep their players in the light DOM, so a plain
// querySelectorAll is enough. Using queryAllDeep here would fall back to a
// full-document shadow-root walk (querySelectorAll("*")) on every detection
// tick when the player is absent (e.g. bilibili homepage), which starves the
// page's own scripts and breaks SPA clicks.
function pickLargestVisibleLight(selector: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible).sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  })[0] ?? null;
}

function pickPlayerRootLight(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const root = pickLargestVisibleLight(selector);
    if (root) return root;
  }
  return null;
}

function findPlayerContainer(video: HTMLVideoElement): HTMLElement {
  let current: HTMLElement | null = video.parentElement;
  let fallback: HTMLElement = video;
  let hintMatch: HTMLElement | null = null;
  for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.width > 2 && rect.height > 2) fallback = current;
    const hint = `${current.id} ${typeof current.className === "string" ? current.className : ""}`.toLowerCase();
    const hasControls = Boolean(current.querySelector("button, input[type=range], [role=button], [aria-label*=play i], [aria-label*=volume i], [role=slider]"));
    if (hasControls) return current;
    if (!hintMatch && /player|video|media|control|player-wrap|container/.test(hint)) hintMatch = current;
    current = current.parentElement;
  }
  return hintMatch ?? fallback;
}

function detectPlayer(): PlayerTarget | null {
  const hostname = window.location.hostname.toLowerCase();
  const youtube = hostname === "youtu.be" || hostname.endsWith("youtube.com");
  const bilibili = hostname === "bilibili.com" || hostname.endsWith("bilibili.com");
  if (youtube) {
    const root = pickPlayerRootLight(["#movie_player", ".html5-video-player", ".html5-video-container"]);
    if (root) return { root, video: pickVideo(root), site: "youtube" };
  }
  if (bilibili) {
    const root = pickPlayerRootLight([".bpx-player-container", ".bilibili-player-container", ".bpx-player-video-wrap", ".bilibili-player-video-wrap"]);
    if (root) return { root, video: pickVideo(root), site: "bilibili" };
    return null;
  }
  const videos = queryAllDeep<HTMLVideoElement>("video");
  const video = videos.filter(visibleVideo).sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  })[0] ?? videos[0] ?? null;
  if (video && isPlayerSized(video)) return { root: findPlayerContainer(video), video, site: "generic" };
  const frame = visibleFrames().find((candidate) => Boolean(remoteFramePlayback(candidate))) ?? largestVisibleFrame();
  if (frame) return { root: frame, video: null, site: "generic", frame };
  return null;
}

function visibleFrames(): HTMLIFrameElement[] {
  return queryAllDeep<HTMLIFrameElement>("iframe").filter((frame) => {
    if (!isVisible(frame)) return false;
    const rect = frame.getBoundingClientRect();
    return rect.width >= window.innerWidth * 0.25 && rect.height >= window.innerHeight * 0.25;
  }).sort((left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return b.width * b.height - a.width * a.height;
  });
}

function largestVisibleFrame(): HTMLIFrameElement | null {
  return visibleFrames()[0] ?? null;
}

type ChallengeDetection = { message: string; url: string };

function detectChallenge(): ChallengeDetection | null {
  const currentUrl = window.location.href;
  if (challengeSignature(currentUrl)) return { message: "该站点需要在真实浏览器中完成 Cloudflare 验证", url: currentUrl };
  const bodyText = document.body?.textContent || "";
  if (bodyText.length < 20000 && /verify you are human|checking your browser|just a moment|验证你是真人|检查你的浏览器|请完成安全验证/i.test(bodyText)) return { message: "该站点需要在真实浏览器中完成 Cloudflare 验证", url: currentUrl };
  if (document.querySelector("iframe[src*='turnstile'], iframe[title*='challenge' i], input[name='cf-turnstile-response']")) return { message: "该站点需要在真实浏览器中完成 Cloudflare 验证", url: currentUrl };
  return null;
}

function hasVisibleDialog(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'], tp-yt-paper-dialog, .bpx-player-login, .login-dialog, .modal")).some((element) => {
    if (!isVisible(element)) return false;
    return (element.textContent || "").trim().length > 0;
  });
}

function isPlayerControlElement(element: HTMLElement): boolean {
  const identity = [element.id || "", typeof element.className === "string" ? element.className : "", element.getAttribute("aria-label") || "", element.getAttribute("title") || ""].join(" ");
  return /(?:^|[-_\s])(?:control|controls|progress|volume|fullscreen|settings?|seek|timeline|tooltip|play|pause)(?:$|[-_\s])/i.test(identity);
}

function isHighConfidenceAdOverlay(element: HTMLElement, videoRect: DOMRect): boolean {
  if (element === document.documentElement || element === document.body || element.contains(focusTarget?.video ?? null)) return false;
  if (isPlayerControlElement(element)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  if (style.position !== "absolute" && style.position !== "fixed" && style.position !== "sticky") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 2 || rect.height <= 2 || rect.width * rect.height > videoRect.width * videoRect.height * 0.7) return false;
  if (rect.right <= videoRect.left || rect.left >= videoRect.right || rect.bottom <= videoRect.top || rect.top >= videoRect.bottom) return false;
  const identity = [element.id || "", typeof element.className === "string" ? element.className : "", element.getAttribute("src") || "", element.getAttribute("href") || "", element.getAttribute("aria-label") || "", element.getAttribute("title") || ""].join(" ");
  const text = (element.textContent || "").trim().slice(0, 800);
  const knownAd = /content-sync\.xyz|tsyndicate\.com|wishapptrack\.com|mengmei8\.com|twinrdengine\.com|marzaent\.com|trafficType=popunder/i.test(identity);
  const adultAd = /\b(?:porn|porno|adult|erotic|sex|18\s*\+|live\s*cams?)\b|порно|эротик|для взрослых|фото|оживлен|广告|赞助|推广|优惠|折扣|弹窗/i.test(`${identity} ${text}`);
  if (!knownAd && !adultAd) return false;
  const hasCloseControl = Boolean(element.querySelector("button, [role='button'], [aria-label*='close' i], [title*='close' i], [aria-label*='关闭'], [title*='关闭']"));
  const hasImageOrLink = Boolean(element.querySelector("img, picture, svg, a"));
  const styleZIndex = Number.parseInt(style.zIndex || "0", 10);
  const floatingFrame = element.tagName === "IFRAME" && styleZIndex >= 10 && rect.width * rect.height < videoRect.width * videoRect.height * 0.7;
  return knownAd || floatingFrame || (adultAd && hasImageOrLink && hasCloseControl);
}

function cleanupAdOverlays(): void {
  const target = detectPlayer()?.video;
  if (!target) return;
  const videoRect = target.getBoundingClientRect();
  if (videoRect.width <= 2 || videoRect.height <= 2) return;
  let candidates: HTMLElement[] = [];
  try { candidates = Array.from(document.querySelectorAll<HTMLElement>("[id], [class], [src], [href], [role='dialog'], iframe")); } catch { return; }
  candidates.forEach((element) => {
    if (isHighConfidenceAdOverlay(element, videoRect)) element.style.setProperty("display", "none", "important");
  });
}

function isNativeFullscreen(): boolean {
  return Boolean(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement);
}

function installFocusStyle(): void {
  if (focusStyle) return;
  focusStyle = document.createElement("style");
  focusStyle.dataset.sameScreen = "player-focus";
  focusStyle.textContent = `
    html.same-screen-focus-mode, html.same-screen-focus-mode body {
      width: 100% !important; height: 100% !important; min-width: 0 !important; min-height: 0 !important;
      margin: 0 !important; overflow: hidden !important; background: #000 !important;
    }
    html.same-screen-focus-mode .same-screen-focus-hidden { display: none !important; }
    html.same-screen-focus-mode .same-screen-focus-ancestor {
      width: 100% !important; height: 100% !important; min-width: 0 !important; min-height: 0 !important;
      max-width: none !important; max-height: none !important; overflow: visible !important;
      transform: none !important; filter: none !important; backdrop-filter: none !important;
      contain: none !important; will-change: auto !important; content-visibility: visible !important;
    }
    html.same-screen-focus-mode .same-screen-focus-target {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important; margin: 0 !important; z-index: 2147483000 !important;
      overflow: hidden !important; background: #000 !important;
      transform: none !important; filter: none !important; contain: none !important;
    }
    html[data-sameScreenSite="generic"].same-screen-focus-mode .same-screen-focus-video {
      width: 100% !important; height: 100% !important;
      max-width: none !important; max-height: none !important;
      object-fit: contain !important;
    }
  `;
  (document.head || document.documentElement).appendChild(focusStyle);
}

const PIN_PROPS = ["position", "inset", "width", "height", "max-width", "max-height", "margin", "object-fit", "background", "z-index", "transform"] as const;
let pinnedInlineElement: HTMLElement | null = null;
let pinnedInlineOriginals: Array<{ prop: string; value: string; priority: string }> = [];

function unpinInline(): void {
  if (!pinnedInlineElement) return;
  for (const { prop, value, priority } of pinnedInlineOriginals) {
    if (value) pinnedInlineElement.style.setProperty(prop, value, priority);
    else pinnedInlineElement.style.removeProperty(prop);
  }
  pinnedInlineElement = null;
  pinnedInlineOriginals = [];
}

function pinInline(element: HTMLElement): void {
  unpinInline();
  pinnedInlineOriginals = PIN_PROPS.map((prop) => ({
    prop,
    value: element.style.getPropertyValue(prop),
    priority: element.style.getPropertyPriority(prop),
  }));
  const override: Record<string, string> = {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    "max-width": "none",
    "max-height": "none",
    margin: "0",
    "object-fit": "contain",
    background: "#000",
    "z-index": "2147483647",
    transform: "none",
  };
  for (const [prop, value] of Object.entries(override)) element.style.setProperty(prop, value, "important");
  pinnedInlineElement = element;
}

function restoreFocus(): void {
  unpinInline();
  focusTarget?.root.classList.remove("same-screen-focus-target");
  focusAncestors.forEach((ancestor) => ancestor.classList.remove("same-screen-focus-ancestor"));
  focusHidden.forEach((element) => element.classList.remove("same-screen-focus-hidden"));
  focusTarget?.video?.classList.remove("same-screen-focus-video");
  focusAncestors = [];
  focusHidden = [];
  focusTarget = null;
  targetMissingSince = 0;
  document.documentElement.classList.remove("same-screen-focus-mode");
  delete document.documentElement.dataset.sameScreenSite;
}

function parentAcrossShadow(element: HTMLElement): HTMLElement | null {
  if (element === document.body) return null;
  const parent = element.parentElement;
  if (parent) return parent;
  const root = element.getRootNode();
  if (root instanceof ShadowRoot && root.host instanceof HTMLElement) return root.host;
  return null;
}

function applyFocus(target: PlayerTarget): void {
  const sameTarget = focusTarget?.root === target.root && focusTarget.video === target.video;
  if (!sameTarget) restoreFocus();
  installFocusStyle();
  focusTarget = target;
  target.root.classList.add("same-screen-focus-target");
  target.video?.classList.add("same-screen-focus-video");
  let child: HTMLElement = target.root;
  let ancestor = parentAcrossShadow(target.root);
  while (ancestor) {
    ancestor.classList.add("same-screen-focus-ancestor");
    if (!focusAncestors.includes(ancestor)) focusAncestors.push(ancestor);
    Array.from(ancestor.children).forEach((sibling) => {
      if (sibling !== child && sibling instanceof HTMLElement && !focusHidden.includes(sibling)) {
        sibling.classList.add("same-screen-focus-hidden");
        focusHidden.push(sibling);
      }
    });
    child = ancestor;
    if (ancestor === document.body) break;
    ancestor = parentAcrossShadow(ancestor);
  }
  document.documentElement.dataset.sameScreenSite = target.site;
  document.documentElement.classList.add("same-screen-focus-mode");
  if (target.site === "generic") {
    const element = target.frame ?? target.root;
    pinInline(element);
  }
}

function getBuffered(video: HTMLVideoElement): number {
  try {
    if (video.buffered.length === 0) return 0;
    return Math.max(0, video.buffered.end(video.buffered.length - 1));
  } catch {
    return 0;
  }
}

function normalizeRemoteFrameState(value: unknown): PlaybackSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const next = value as Partial<PlaybackSnapshot>;
  if (typeof next.hasVideo !== "boolean") return null;
  return {
    playing: Boolean(next.playing),
    currentTime: typeof next.currentTime === "number" && Number.isFinite(next.currentTime) ? Math.max(0, next.currentTime) : 0,
    duration: typeof next.duration === "number" && Number.isFinite(next.duration) ? Math.max(0, next.duration) : 0,
    buffered: typeof next.buffered === "number" && Number.isFinite(next.buffered) ? Math.max(0, next.buffered) : 0,
    volume: typeof next.volume === "number" && Number.isFinite(next.volume) ? Math.min(1, Math.max(0, next.volume)) : 1,
    muted: Boolean(next.muted),
    hasVideo: next.hasVideo,
    videoWidth: typeof next.videoWidth === "number" && Number.isFinite(next.videoWidth) ? Math.max(0, next.videoWidth) : 0,
    videoHeight: typeof next.videoHeight === "number" && Number.isFinite(next.videoHeight) ? Math.max(0, next.videoHeight) : 0,
    readyState: typeof next.readyState === "number" && Number.isFinite(next.readyState) ? Math.max(0, next.readyState) : 0,
    playerWidth: 0,
    playerHeight: 0,
    rate: typeof next.rate === "number" && Number.isFinite(next.rate) && next.rate > 0 ? Math.min(4, Math.max(0.25, next.rate)) : 1,
  };
}

function remoteFramePlayback(frame: HTMLIFrameElement | null): PlaybackSnapshot | null {
  if (!frame) return null;
  const entry = remoteFrameStates.get(frame);
  if (!entry || Date.now() - entry.receivedAt > 3000 || !entry.state.hasVideo) return null;
  return entry.state;
}

function frameForMessage(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  return queryAllDeep<HTMLIFrameElement>("iframe").find((frame) => frame.contentWindow === source) ?? null;
}

function receiveFrameVideoMessage(event: MessageEvent): void {
  const value = event.data as { source?: unknown; kind?: unknown; state?: unknown; result?: unknown; playerId?: unknown; muteSequence?: unknown; nativeMuteIntent?: unknown } | null;
  if (!value || value.source !== FRAME_VIDEO_SOURCE) return;
  if (value.kind === "command-result") {
    ipcRenderer.sendToHost("focus-diagnostic", { kind: "frame-command", result: value.result });
    return;
  }
  if (value.kind !== "state") return;
  const frame = frameForMessage(event.source);
  if (!frame) return;
  const state = normalizeRemoteFrameState(value.state);
  if (!state || typeof value.playerId !== "string" || value.playerId.length > 200 || !Number.isSafeInteger(value.muteSequence)) return;
  const previous = remoteFrameStates.get(frame);
  if (previous?.playerId === value.playerId && Number(value.muteSequence) < previous.muteSequence) return;
  const pending = pendingFrameMute.get(frame);
  if (pending?.playerId === value.playerId) {
    if (Number(value.muteSequence) < pending.sequence && Date.now() - pending.at < 1500) return;
    pendingFrameMute.delete(frame);
  }
  remoteFrameStates.set(frame, { state, receivedAt: Date.now(), playerId: value.playerId, muteSequence: Number(value.muteSequence) });
  const synced = remoteFrameMuteSynced.get(frame) ?? new Set<string>();
  if (!pending && synced.has(value.playerId) && value.nativeMuteIntent === true) {
    const selected = mediaTarget();
    if (selected?.kind === "frame" && selected.frame === frame) paneMuted = state.muted;
  }
  if (!synced.has(value.playerId)) {
    synced.add(value.playerId);
    if (synced.size > 128) synced.delete(synced.values().next().value!);
    remoteFrameMuteSynced.set(frame, synced);
    if (state.muted !== paneMuted) {
      sendFrameVideoCommand(frame, { type: "setMuted", value: paneMuted });
      return;
    }
  }
  scheduleDetection();
  reportPlayback();
}

function sendFrameVideoCommand(frame: HTMLIFrameElement, command: VideoCommand): void {
  try {
    const entry = remoteFrameStates.get(frame);
    const changesMute = command.type === "setMuted" || command.type === "setVolume";
    const sequence = changesMute ? ++muteSequence : undefined;
    if (changesMute && entry) pendingFrameMute.set(frame, { playerId: entry.playerId, sequence: sequence!, at: Date.now() });
    frame.contentWindow?.postMessage({ source: FRAME_VIDEO_SOURCE, command: { ...command, ...(changesMute && entry ? { targetPlayerId: entry.playerId, muteSequence: sequence } : {}) } }, "*");
  } catch {
  }
}

type MediaTarget =
  | { kind: "local"; video: HTMLVideoElement }
  | { kind: "frame"; frame: HTMLIFrameElement; state: PlaybackSnapshot };

function mediaTarget(): MediaTarget | null {
  const target = focusTarget ?? detectPlayer();
  if (!target) return null;
  if (target.video) return { kind: "local", video: target.video };
  if (target.frame) {
    const state = remoteFramePlayback(target.frame);
    if (state) return { kind: "frame", frame: target.frame, state };
  }
  return null;
}

function snapshot(): PlaybackSnapshot {
  const target = focusTarget ?? detectPlayer();
  if (!target) return { playing: false, currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: paneMuted, hasVideo: false, videoWidth: 0, videoHeight: 0, readyState: 0, playerWidth: 0, playerHeight: 0, rate: 1 };
  const playerRect = target.root.getBoundingClientRect();
  const remote = target.frame ? remoteFramePlayback(target.frame) : null;
  const video = target.video;
  if (!video && !remote) return { playing: false, currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: paneMuted, hasVideo: false, videoWidth: 0, videoHeight: 0, readyState: 0, playerWidth: playerRect.width, playerHeight: playerRect.height, rate: 1 };
  if (!video && remote) return { ...remote, playerWidth: playerRect.width, playerHeight: playerRect.height };
  if (!video) return { playing: false, currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: paneMuted, hasVideo: false, videoWidth: 0, videoHeight: 0, readyState: 0, playerWidth: playerRect.width, playerHeight: playerRect.height, rate: 1 };
  return {
    playing: !video.paused && !video.ended,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    buffered: getBuffered(video),
    volume: Number.isFinite(video.volume) ? video.volume : 1,
    muted: video.muted,
    hasVideo: true,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
    playerWidth: playerRect?.width ?? 0,
    playerHeight: playerRect?.height ?? 0,
    rate: Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1,
  };
}

function reportPlayback(): void {
  const target = mediaTarget();
  const pending = target?.kind === "frame" ? pendingFrameMute.get(target.frame) : undefined;
  if (pending && Date.now() - pending.at < 1500) return;
  const next = snapshot();
  const previous = lastSnapshot;
  if (previous && previous.playing === next.playing && Math.abs(previous.currentTime - next.currentTime) < 0.15 && previous.duration === next.duration && Math.abs(previous.buffered - next.buffered) < 0.25 && previous.volume === next.volume && previous.muted === next.muted && previous.hasVideo === next.hasVideo && previous.videoWidth === next.videoWidth && previous.videoHeight === next.videoHeight && previous.readyState === next.readyState && previous.playerWidth === next.playerWidth && previous.playerHeight === next.playerHeight && previous.rate === next.rate) return;
  lastSnapshot = next;
  ipcRenderer.sendToHost("video-state", { ...next, userPauseIntent });
}

function markUserInteraction(): void {
  lastUserInteractionAt = Date.now();
}

function isBilibiliHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "bilibili.com" || normalized.endsWith(".bilibili.com");
}

function installBilibiliNavigationBridge(): void {
  if (!isBilibiliHost(window.location.hostname)) return;
  document.addEventListener("click", (event) => {
    const target = event.composedPath().find((entry) => entry instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    if (!target || target.target !== "_blank" || !target.href) return;
    try {
      const destination = new URL(target.href, window.location.href);
      if (!isBilibiliHost(destination.hostname)) return;
      event.preventDefault();
      window.location.assign(destination.href);
    } catch {
    }
  }, true);
}

function reportControlsVisibility(visible: boolean): void {
  if (controlsVisible === visible) return;
  controlsVisible = visible;
  ipcRenderer.sendToHost("controls-visibility", visible);
}

function attachVideo(video: HTMLVideoElement): void {
  if (boundVideos.has(video)) return;
  boundVideos.add(video);
  video.muted = paneMuted;
  video.addEventListener("play", () => {
    if (pauseCommandLocked && Date.now() - lastUserInteractionAt >= 900) {
      try {
        nativeMediaPause.call(video);
      } catch {
      }
      reportPlayback();
      return;
    }
    wasPlaying.set(video, true);
    if (Date.now() - lastUserInteractionAt < 900) userPauseIntent = false;
    reportPlayback();
  });
  video.addEventListener("pause", () => {
    const hadBeenPlaying = wasPlaying.get(video) === true;
    const likelyUserPause = !suppressPauseIntent && Date.now() - lastUserInteractionAt < 900;
    if (likelyUserPause) userPauseIntent = true;
    if (!paneActive && hadBeenPlaying && !userPauseIntent && !likelyUserPause && !video.ended) {
      window.setTimeout(() => {
        if (paneActive || userPauseIntent || video.ended || !video.paused) return;
        void video.play().catch(() => undefined);
      }, 220);
    } else if (!video.ended) {
      wasPlaying.set(video, false);
    }
    reportPlayback();
  });
  video.addEventListener("ended", () => {
    wasPlaying.set(video, false);
    reportPlayback();
  });
  video.addEventListener("volumechange", () => {
    const selected = mediaTarget();
    if (Date.now() - lastUserInteractionAt < 900 && selected?.kind === "local" && selected.video === video) paneMuted = video.muted;
    reportPlayback();
  });
  ["durationchange", "progress", "timeupdate", "ratechange", "loadedmetadata", "canplay"].forEach((eventName) => video.addEventListener(eventName, reportPlayback));
}

function attachVideos(): void {
  queryAllDeep<HTMLVideoElement>("video").forEach(attachVideo);
  reportPlayback();
}

let lastFocusDiagnostic = "";

function reportFocusDiagnostic(info: Record<string, unknown>): void {
  const key = JSON.stringify(info);
  if (key === lastFocusDiagnostic) return;
  lastFocusDiagnostic = key;
  ipcRenderer.sendToHost("focus-diagnostic", info);
}

let lastDetectionAt = 0;
const DETECTION_MIN_INTERVAL_MS = 450;

function detectAndApply(): void {
  detectionScheduled = false;
  const now = Date.now();
  if (now - lastDetectionAt < DETECTION_MIN_INTERVAL_MS) return;
  lastDetectionAt = now;
  const challenge = detectChallenge();
  if (challenge) {
    restoreFocus();
    if (unrecognizedTimer !== null) window.clearTimeout(unrecognizedTimer);
    unrecognizedTimer = null;
    if (cloudflareStatus === "none" || cloudflareStatus === "passed") {
      cloudflareNavigation = observeChallengeNavigation(cloudflareNavigation, challenge.url);
      sendChallengeState("detected", challenge.url, Math.max(1, cloudflareNavigation.navigationCount), challenge.message);
    } else {
      sendChallengeState(cloudflareStatus, challenge.url, cloudflareNavigationCount, cloudflareStatus === "looped" ? "验证仍在循环，应用已停止自动刷新。" : challenge.message);
    }
    sendStatus("challenge", cloudflareStatus === "looped" ? "验证仍在循环，应用已停止自动刷新。" : challenge.message);
    reportPlayback();
    return;
  }
  if (cloudflareStatus === "detected" || cloudflareStatus === "looped") {
    sendChallengeState("passed", undefined, cloudflareNavigationCount, "验证完成，正在重新识别播放器。");
    cloudflareNavigation = emptyChallengeNavigation();
  }
  const target = detectPlayer();
  cleanupAdOverlays();
  const hasDialog = hasVisibleDialog();
  const nativeFullscreen = isNativeFullscreen();
  if (target) {
    targetMissingSince = 0;
    if (unrecognizedTimer !== null) window.clearTimeout(unrecognizedTimer);
    unrecognizedTimer = null;
    const pinnable = Boolean(target.video || target.frame);
    const remoteVideo = target.frame ? remoteFramePlayback(target.frame) : null;
    const shouldApply = focusModeEnabled && pinnable && !hasDialog && !nativeFullscreen;
    if (shouldApply) applyFocus(target);
    else restoreFocus();
    reportFocusDiagnostic({
      found: true,
      site: target.site,
      rootTag: target.root.tagName,
      rootId: target.root.id || "",
      rootClass: typeof target.root.className === "string" ? target.root.className.slice(0, 90) : "",
      videoFound: Boolean(target.video || remoteVideo),
      frameVideoFound: Boolean(remoteVideo),
      frameFound: Boolean(target.frame),
      focusModeEnabled,
      dialog: hasDialog,
      fullscreen: nativeFullscreen,
      applied: shouldApply,
    });
    sendStatus(target.video || remoteVideo ? "ready" : "loading");
    attachVideos();
    reportPlayback();
    return;
  }
  reportFocusDiagnostic({
    found: false,
    videoCount: queryAllDeep<HTMLVideoElement>("video").length,
    focusModeEnabled,
    dialog: hasDialog,
    fullscreen: nativeFullscreen,
  });
  if (focusTarget) {
    if (targetMissingSince === 0) targetMissingSince = Date.now();
    if (Date.now() - targetMissingSince < 1600) {
      sendStatus("loading");
      reportPlayback();
      return;
    }
  }
  restoreFocus();
  sendStatus("loading");
  if (unrecognizedTimer === null) {
    unrecognizedTimer = window.setTimeout(() => {
      unrecognizedTimer = null;
      if (!detectPlayer() && !detectChallenge()) sendStatus("unrecognized", "无法识别播放器，已保留网页兼容画面");
    }, 1800);
  }
  reportPlayback();
}

function scheduleDetection(): void {
  if (detectionScheduled) return;
  detectionScheduled = true;
  window.requestAnimationFrame(() => {
    attachVideos();
    detectAndApply();
  });
}

function setMuted(muted: boolean): void {
  paneMuted = muted;
  const target = mediaTarget();
  if (target?.kind === "local") target.video.muted = muted;
  else if (target?.kind === "frame") sendFrameVideoCommand(target.frame, { type: "setMuted", value: muted });
  else queryAllDeep<HTMLVideoElement>("video").forEach((video) => { video.muted = muted; });
  reportPlayback();
}

function runCommand(command: VideoCommand): void {
  if (command.type === "setMuted" || command.type === "toggleMuted") {
    const target = mediaTarget();
    const pending = target?.kind === "frame" ? pendingFrameMute.get(target.frame) : undefined;
    setMuted(command.type === "setMuted" ? command.value : !(pending && Date.now() - pending.at < 1500 ? paneMuted : snapshot().muted));
    return;
  }
  const requestVersion = ++playRequestVersion;
  const target = mediaTarget();
  if (!target) return;
  if (target.kind === "frame") {
    let frameCommand = command;
    if (command.type === "toggle") frameCommand = { type: target.state.playing ? "pause" : "play" };
    if (command.type === "setVolume" && command.value > 0) paneMuted = false;
    if (frameCommand.type === "pause") userPauseIntent = true;
    else if (frameCommand.type === "play") userPauseIntent = false;
    sendFrameVideoCommand(target.frame, frameCommand);
    reportPlayback();
    return;
  }
  const video = target.video;
  try {
    if (command.type === "play") {
      pauseCommandLocked = false;
      userPauseIntent = false;
      playVideo(video, requestVersion);
    } else if (command.type === "pause") {
      pauseCommandLocked = true;
      userPauseIntent = true;
      suppressPauseIntent = true;
      pauseVideo(video, requestVersion);
      suppressPauseIntent = false;
    } else if (command.type === "toggle") {
      if (video.paused || video.ended) {
        pauseCommandLocked = false;
        userPauseIntent = false;
        playVideo(video, requestVersion);
      } else {
        pauseCommandLocked = true;
        userPauseIntent = true;
        suppressPauseIntent = true;
        pauseVideo(video, requestVersion);
        suppressPauseIntent = false;
      }
    } else if (command.type === "seek") {
      if (Number.isFinite(command.value)) video.currentTime = Math.max(0, command.value);
    } else if (command.type === "setVolume") {
      if (Number.isFinite(command.value)) {
        video.volume = Math.min(1, Math.max(0, command.value));
        if (video.volume > 0) {
          paneMuted = false;
          video.muted = false;
        }
      }
    } else if (command.type === "setRate") {
      if (Number.isFinite(command.value)) {
        video.playbackRate = Math.min(4, Math.max(0.25, command.value));
      }
    }
  } catch {
  }
  reportPlayback();
}

function playVideo(video: HTMLVideoElement, requestVersion: number): void {
  try {
    const pending = nativeMediaPlay.call(video);
    void pending.catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError" || requestVersion !== playRequestVersion || !video.paused || video.muted) return;
      video.muted = true;
      void nativeMediaPlay.call(video).catch(() => undefined);
    });
  } catch {
  }
}

function pauseVideo(video: HTMLVideoElement, requestVersion: number): void {
  try {
    nativeMediaPause.call(video);
  } catch {
  }
  [80, 220, 500].forEach((delay) => {
    window.setTimeout(() => {
      if (requestVersion !== playRequestVersion || video.ended || video.paused) return;
      try {
        nativeMediaPause.call(video);
      } catch {
      }
      reportPlayback();
    }, delay);
  });
}

function initialize(): void {
  installFocusStyle();
  installBilibiliNavigationBridge();
  sendStatus("loading");
  document.addEventListener("pointerdown", () => {
    markUserInteraction();
    if (pauseCommandLocked) pauseCommandLocked = false;
    ipcRenderer.sendToHost("pane-focus");
  }, true);
  document.addEventListener("mousemove", (event) => reportControlsVisibility(event.clientY >= window.innerHeight - 112), true);
  document.addEventListener("mouseleave", () => reportControlsVisibility(false), true);
  document.addEventListener("keydown", (event) => {
    markUserInteraction();
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable=true]"))) return;
    if (event.key === "Escape" && isNativeFullscreen()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const exitFullscreen = (document.exitFullscreen ?? (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen);
      if (exitFullscreen) void Promise.resolve(exitFullscreen.call(document)).catch(() => undefined);
      ipcRenderer.sendToHost("request-exit-fullscreen");
    }
  }, true);
  document.addEventListener("click", markUserInteraction, true);
  const reportFullscreen = () => {
    if (isNativeFullscreen()) restoreFocus();
    else scheduleDetection();
    if (!isNativeFullscreen()) ipcRenderer.sendToHost("request-exit-fullscreen");
  };
  document.addEventListener("fullscreenchange", reportFullscreen, true);
  document.addEventListener("webkitfullscreenchange", reportFullscreen, true);
  const observer = new MutationObserver(scheduleDetection);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleDetection, { passive: true });
  window.addEventListener("message", receiveFrameVideoMessage);
  attachVideos();
  detectAndApply();
  window.setInterval(() => { attachVideos(); detectAndApply(); }, 300);
  window.setInterval(reportPlayback, 500);
}

ipcRenderer.on("video-command", (_event, command: unknown) => {
  if (!command || typeof command !== "object") return;
  const value = command as Partial<VideoCommand>;
  if (value.type === "play" || value.type === "pause" || value.type === "toggle" || value.type === "toggleMuted" || value.type === "seek" || value.type === "setVolume" || value.type === "setRate" || value.type === "setMuted") runCommand(value as VideoCommand);
});
ipcRenderer.on("challenge-navigation", (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const next = value as { status?: unknown; url?: unknown; navigationCount?: unknown; message?: unknown };
  if (next.status !== "none" && next.status !== "detected" && next.status !== "passed" && next.status !== "looped") return;
  const url = typeof next.url === "string" ? next.url : undefined;
  const navigationCount = typeof next.navigationCount === "number" && Number.isFinite(next.navigationCount) ? next.navigationCount : 0;
  const signature = challengeSignature(url);
  cloudflareNavigation = {
    status: next.status,
    signature: signature ?? "",
    firstSeenAt: cloudflareNavigation.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    navigationCount,
  };
  sendChallengeState(next.status, url, navigationCount, typeof next.message === "string" ? next.message : undefined);
  if (next.status === "detected" || next.status === "looped") restoreFocus();
  if (next.status === "passed") scheduleDetection();
});
ipcRenderer.on("set-mute", (_event, muted: boolean) => setMuted(Boolean(muted)));
ipcRenderer.on("set-focus-mode", (_event, enabled: boolean) => {
  focusModeEnabled = Boolean(enabled);
  if (!focusModeEnabled) restoreFocus();
  scheduleDetection();
});
ipcRenderer.on("host-resize", () => {
  scheduleDetection();
  reportPlayback();
});
ipcRenderer.on("pane-activity", (_event, active: boolean) => {
  paneActive = Boolean(active);
  if (!paneActive) queryAllDeep<HTMLVideoElement>("video").forEach((video) => wasPlaying.set(video, !video.paused && !video.ended));
});

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();

}
