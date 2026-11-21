import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Session, WebContents } from "electron";
import {
  buildNetscapeCookieFile,
  buildQualityOptions,
  formatEta,
  formatSpeed,
  hasExtractableMediaInfo,
  normalizeDownloadProbeUrl,
  parseYtDlpProgressLine,
  resolveYtDlpProxyUrl,
  sanitizeDownloadFileName,
  selectConcurrentFormats,
  type ConcurrentFormatSelection,
  type CookieInput,
  type DownloadProbeResult,
  type DownloadQualityOption,
  type DownloadStartRequest,
  type DownloadStateSnapshot,
  type DownloadTask,
  type DownloadToolStatus,
  type RawYtDlpFormat,
  type ResolvedStreamSpec,
  type ToolBinaryInfo,
} from "../src/shared/downloads";
import type { GlobalProxySettings } from "../src/shared/types";
import { loadDownloadSettings, saveDownloadSettings, type DownloadSettings } from "./download-settings";
import { isKnownAdRequest } from "./ad-navigation";
import { RangeHttpError, RangeUrlExpiredError, SingleStreamTransfer } from "./range-downloader";
import { extractZipEntry } from "./zip-extract";

type DownloadManagerOptions = {
  userDataDir: string;
  defaultDownloadDir: string;
  bundledToolsDir?: string;
  appToolsDir?: string;
  userAgent: string;
  fetchWithProxy: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  getPaneIdByWebContentsId?: (webContentsId: number) => string | undefined;
  isAdUrl?: (url: string, sourceUrl: string, resourceType: string) => boolean;
  onStateChanged: (snapshot: DownloadStateSnapshot) => void;
  spawnProcess?: typeof spawn;
};

type FrameInspection = {
  frameUrl: string;
  title: string;
  videos: Array<{
    src: string;
    isBlob: boolean;
    width: number;
    height: number;
    area: number;
    duration: number;
    visible: boolean;
    playing?: boolean;
  }>;
};

type ObservedMediaEntry = {
  url: string;
  refererUrl: string;
  frameUrl: string;
  kind: "playlist" | "media";
  firstObservedAt: number;
  lastObservedAt: number;
  hits: number;
  adFlagged: boolean;
};

type ActiveController = {
  cancel: () => void;
  pause?: () => void;
  resume?: () => void;
};

type ProbedMediaCacheEntry = {
  formats: RawYtDlpFormat[];
  httpHeaders?: Record<string, string>;
  cachedAt: number;
};

const MAX_TASKS_HISTORY = 40;
const MAX_OBSERVED_MEDIA = 32;
const MAX_PROBED_MEDIA_CACHE = 20;
const PROBED_MEDIA_CACHE_TTL_MS = 15 * 60 * 1000;
const OBSERVED_MEDIA_TTL_MS = 10 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 160;
const PROBE_TIMEOUT_MS = 25000;

async function writeChunkWithBackpressure(
  writer: ReturnType<typeof createWriteStream>,
  chunk: Uint8Array
): Promise<void> {
  if (writer.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      writer.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      writer.off("drain", onDrain);
      reject(error);
    };
    writer.once("drain", onDrain);
    writer.once("error", onError);
  });
}

function normalizeNavigationKey(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function getResponseHeader(headers: Record<string, string[]> | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === target && Array.isArray(values) && values.length > 0) {
      return values[0] ?? null;
    }
  }
  return null;
}

function parseTotalSizeFromHeaders(headers: Record<string, string[]> | undefined): number | null {
  const contentRange = getResponseHeader(headers, "content-range");
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)\s*$/);
    if (match) {
      const total = Number(match[1]);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }
  const contentLength = getResponseHeader(headers, "content-length");
  if (contentLength) {
    const total = Number(contentLength);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}

function isDedicatedExtractorHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const dedicated = [
      "bilibili.com",
      "b23.tv",
      "youtube.com",
      "youtu.be",
      "twitch.tv",
      "nicovideo.jp",
      "vimeo.com",
      "dailymotion.com",
      "tiktok.com",
      "douyin.com",
      "ixigua.com",
      "acfun.cn",
      "youku.com",
      "iqiyi.com",
      "v.qq.com",
      "mgtv.com",
      "pornhub.com",
      "xvideos.com",
      "xhamster.com",
      "spankbang.com",
      "twitter.com",
      "x.com",
      "instagram.com",
      "facebook.com",
      "reddit.com",
    ];
    return dedicated.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isMasterPlaylistUrl(url: string): boolean {
  return /(?:^|\/)(?:master|playlist|index|manifest)[^/]*\.(?:m3u8|mpd)(?:$|\?)/i.test(url) || /\.mpd(?:$|\?)/i.test(url);
}

function isSubPlaylistUrl(url: string): boolean {
  return /(?:^|[/_-])(?:144|240|360|480|720|1080|1440|2160)p\b|chunklist|playlistType=standard|subtitles?|audio(?:_only)?/i.test(url);
}

function isLikelyAdMedia(
  url: string,
  contextUrl = "",
  width = 0,
  height = 0,
  duration = 0,
  frameUrl = ""
): boolean {
  if (isKnownAdRequest(url) || (contextUrl && isKnownAdRequest(contextUrl)) || (frameUrl && isKnownAdRequest(frameUrl))) {
    return true;
  }
  const combined = `${url} ${contextUrl} ${frameUrl}`;
  if (/\b(?:banner|smartpop|popunder|vast|preroll|midroll)\b|pornfhd\.com|storagexhd\.com|growcdnssedge\.com|myavlive\.com|mavrtracktor\.com|mayzaent\.com|marzaent\.com|greentrafsa\.com|gasipedibexide\.com|bestjavporn\.live|javhd-trk\.com|tsyndicate\.com|magsrv\.com|stripcash|exoclick|juicyads|trafficjunky|whitetrafsa\.com|snaptrckr\.fun|wheelroot\.com|nomandswitch\.cc|udzpel\.com|alaphoid\.com/i.test(combined)) {
    return true;
  }
  if (/\b(?:300x250|728x90|160x600|320x100|320x50|300x100|440x250)\b/i.test(url)) return true;
  if (width > 0 && height > 0 && width <= 360 && height <= 280 && duration > 0 && duration <= 45) {
    return true;
  }
  return false;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function binaryName(tool: "yt-dlp" | "ffmpeg", platform = process.platform): string {
  return platform === "win32" ? `${tool}.exe` : tool;
}

function inferExtensionFromUrl(url: string, fallback = "mp4"): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(/^\./, "").toLowerCase();
    if (/^(mp4|m4v|webm|mov|ogv|mkv|mp3|m4a|aac|flac|wav|ogg|ts)$/.test(ext)) {
      return ext;
    }
  } catch {
  }
  return fallback;
}

function inferExtensionFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  if (mime === "video/mp4" || mime === "video/x-m4v") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/ogg") return "ogv";
  if (mime === "video/x-matroska") return "mkv";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return "m4a";
  return null;
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      return;
    } catch {
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    }, 2000).unref();
  } catch {
  }
}

function translateYtDlpError(stderrText: string, hasFfmpeg: boolean): string {
  const lower = stderrText.toLowerCase();
  if (lower.includes("unusual and will be skipped for safety reasons")) {
    return "解析到的目标不是有效视频流（检测到网页文件），请确认分屏正在播放具体视频后重新解析";
  }
  if (lower.includes("geo-restricted")) {
    return "该视频存在地区限制，请尝试切换代理节点后重试";
  }
  if (lower.includes("http error 412") || lower.includes("412: precondition failed")) {
    return "站点触发风控拦截 (412)，请先在分屏内刷新或完成验证后再试";
  }
  if (lower.includes("ffmpeg is not installed") || lower.includes("ffmpeg not found")) {
    return "该清晰度需要 ffmpeg 合并音视频，请先安装或指定 ffmpeg";
  }
  if (!hasFfmpeg && lower.includes("requested merging of multiple formats")) {
    return "合并高画质音视频需要 ffmpeg，请先在下载面板点击安装组件";
  }
  if (lower.includes("sign in to confirm") || lower.includes("login required") || lower.includes("cookies")) {
    return "该视频需要登录后才能下载，请先在分屏内完成登录再试";
  }
  if (lower.includes("http error 403") || lower.includes("403 forbidden")) {
    return "站点拒绝下载请求 (403)，可尝试刷新页面、登录账号或检查代理";
  }
  if (lower.includes("http error 404") || lower.includes("video unavailable")) {
    return "视频不存在或当前不可用";
  }
  if (lower.includes("unable to connect to proxy") || lower.includes("proxyerror")) {
    return "无法连接配置的代理服务器，请检查代理设置";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "连接超时，请检查网络或代理设置";
  }
  if (lower.includes("unsupported url")) {
    return "暂不支持解析该网页地址";
  }
  const lines = stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line)) ?? lines.at(-1);
  if (errorLine) {
    return errorLine.replace(/^ERROR:\s*/i, "").slice(0, 180);
  }
  return "下载失败，请检查网络连接或稍后重试";
}

function ytDlpReleaseUrl(platform = process.platform, arch = process.arch): string | null {
  if (platform === "win32") {
    return arch === "ia32"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_x86.exe"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  }
  if (platform === "darwin") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  }
  return null;
}

function ffmpegZipUrl(platform = process.platform, arch = process.arch): string | null {
  if (platform === "win32" && arch === "x64") {
    return "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";
  }
  return null;
}

export class DownloadManager {
  private settings: DownloadSettings = {};
  private readonly settingsFile: string;
  private readonly localToolsDir: string;
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly activeControllers = new Map<string, ActiveController>();
  private readonly activeProbes = new Map<string, () => void>();
  private readonly reservedPaths = new Set<string>();
  private readonly attachedSessions = new WeakSet<Session>();
  private readonly observedMedia = new Map<number, ObservedMediaEntry[]>();
  private readonly observedPageKeys = new Map<number, string>();
  private readonly probedMediaCache = new Map<string, ProbedMediaCacheEntry>();
  private installAbort: AbortController | null = null;
  private toolStatus: DownloadToolStatus;
  private lastBroadcastAt = new Map<string, number>();

  constructor(private readonly options: DownloadManagerOptions) {
    this.settingsFile = path.join(options.userDataDir, "download-settings.json");
    this.localToolsDir = path.join(options.userDataDir, "tools");
    this.toolStatus = {
      ytDlp: { available: false },
      ffmpeg: { available: false },
      installing: false,
      downloadDir: options.defaultDownloadDir,
    };
  }

  async initialize(): Promise<void> {
    this.settings = await loadDownloadSettings(this.settingsFile);
    await this.refreshToolStatus();
  }

  private isAdFlagged(url: string, sourceUrl: string, resourceType: string): boolean {
    try {
      return Boolean(this.options.isAdUrl?.(url, sourceUrl, resourceType));
    } catch {
      return false;
    }
  }

  private logDiagnostic(event: string, data: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data,
    };
    const logPath = path.join(this.options.userDataDir, "download-diagnostics.log");
    void fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
  }

  handlePaneNavigation(webContentsId: number, pageUrl: string): void {
    const key = normalizeNavigationKey(pageUrl);
    if (!key) return;
    const prevKey = this.observedPageKeys.get(webContentsId);
    this.observedPageKeys.set(webContentsId, key);
    if (prevKey !== undefined && prevKey !== key) {
      this.observedMedia.delete(webContentsId);
    }
  }

  observeCompletedRequest(details: {
    url: string;
    webContentsId?: number;
    resourceType: string;
    statusCode: number;
    referrer?: string;
    frameUrl?: string;
    responseHeaders?: Record<string, string[]>;
  }): void {
    const wcId = details.webContentsId;
    if (typeof wcId !== "number" || wcId < 0 || !isHttpUrl(details.url)) return;
    if (details.statusCode < 200 || details.statusCode >= 400) return;

    if (details.resourceType === "mainFrame") {
      const key = normalizeNavigationKey(details.url);
      if (key) this.observedPageKeys.set(wcId, key);
      this.observedMedia.delete(wcId);
      return;
    }

    const frameUrl = isHttpUrl(details.frameUrl) ? details.frameUrl : "";
    const refererUrl = isHttpUrl(details.referrer) ? details.referrer : frameUrl;
    if (isLikelyAdMedia(details.url, refererUrl, 0, 0, 0, frameUrl)) return;

    let pathname = "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(details.url);
      pathname = parsedUrl.pathname.toLowerCase();
    } catch {
      return;
    }
    const contentType = (getResponseHeader(details.responseHeaders, "content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

    const isPlaylist =
      pathname.endsWith(".m3u8")
      || pathname.endsWith(".mpd")
      || /(?:^|[/?&=])[^/]*\.(?:m3u8|mpd)(?:$|&)/i.test(details.url)
      || contentType === "application/vnd.apple.mpegurl"
      || contentType === "application/x-mpegurl"
      || contentType === "audio/mpegurl"
      || contentType === "application/dash+xml";

    const looksLikeMediaSegment =
      details.resourceType !== "media"
      && (
        /(?:^|[/_-])(?:init|seg|segment|frag|chunk)[_-]?\d*\.(?:mp4|m4s|m4v)$|_\d{3,6}_[A-Za-z0-9]+_\d+\.mp4$/i.test(pathname)
        || parsedUrl.searchParams.has("range")
        || parsedUrl.searchParams.has("sq")
      );

    const isMedia =
      !isPlaylist
      && !looksLikeMediaSegment
      && (
        /^video\/(?:mp4|webm|quicktime|ogg|x-matroska|x-m4v)$/.test(contentType)
        || (details.resourceType === "media" && /\.(?:mp4|webm|mov|m4v|ogv|mkv)$/.test(pathname))
      );

    if (!isPlaylist && !isMedia) return;

    if (isMedia) {
      const totalSize = parseTotalSizeFromHeaders(details.responseHeaders);
      if (totalSize !== null && totalSize < 256 * 1024) return;
    }

    const now = Date.now();
    const adFlagged =
      this.isAdFlagged(details.url, refererUrl || frameUrl || details.url, details.resourceType)
      || Boolean(frameUrl && this.isAdFlagged(frameUrl, details.url, "subFrame"));

    const existingList = (this.observedMedia.get(wcId) ?? []).filter(
      (entry) => now - entry.lastObservedAt < OBSERVED_MEDIA_TTL_MS
    );
    const existingIndex = existingList.findIndex((entry) => entry.url === details.url);
    if (existingIndex >= 0) {
      const existing = existingList[existingIndex];
      existingList[existingIndex] = {
        ...existing,
        refererUrl: refererUrl || existing.refererUrl,
        frameUrl: frameUrl || existing.frameUrl,
        lastObservedAt: now,
        hits: existing.hits + 1,
        adFlagged: existing.adFlagged || adFlagged,
      };
    } else {
      existingList.push({
        url: details.url,
        refererUrl,
        frameUrl,
        kind: isPlaylist ? "playlist" : "media",
        firstObservedAt: now,
        lastObservedAt: now,
        hits: 1,
        adFlagged,
      });
      if (existingList.length > MAX_OBSERVED_MEDIA) {
        existingList.sort((a, b) => Number(a.adFlagged) - Number(b.adFlagged) || a.firstObservedAt - b.firstObservedAt);
        existingList.shift();
      }
    }
    this.observedMedia.set(wcId, existingList);
    this.logDiagnostic("observe", {
      wcId,
      kind: isPlaylist ? "playlist" : "media",
      url: details.url,
      frameUrl,
      refererUrl,
      adFlagged,
    });
  }

  clearObservedMedia(webContentsId: number): void {
    this.observedMedia.delete(webContentsId);
    this.observedPageKeys.delete(webContentsId);
  }

  getDownloadDir(): string {
    const candidate = this.settings.downloadDir;
    if (candidate && existsSync(candidate)) return candidate;
    return this.options.defaultDownloadDir;
  }

  getSnapshot(): DownloadStateSnapshot {
    const tasks = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    return {
      tools: { ...this.toolStatus, downloadDir: this.getDownloadDir() },
      tasks: tasks.map((task) => ({ ...task })),
    };
  }

  private emitState(): void {
    this.options.onStateChanged(this.getSnapshot());
  }

  private async isRegularFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async detectBinary(tool: "yt-dlp" | "ffmpeg"): Promise<ToolBinaryInfo> {
    const exeName = binaryName(tool);
    const customPath = tool === "yt-dlp" ? this.settings.ytDlpPath : this.settings.ffmpegPath;
    if (customPath && await this.isRegularFile(customPath)) {
      return { available: true, path: customPath, source: "custom" };
    }

    const bundledCandidates = [
      this.options.bundledToolsDir ? path.join(this.options.bundledToolsDir, exeName) : null,
      this.options.appToolsDir ? path.join(this.options.appToolsDir, exeName) : null,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of bundledCandidates) {
      if (await this.isRegularFile(candidate)) {
        return { available: true, path: candidate, source: "bundled" };
      }
    }

    const localCandidate = path.join(this.localToolsDir, exeName);
    if (await this.isRegularFile(localCandidate)) {
      return { available: true, path: localCandidate, source: "local" };
    }

    const pathDirs = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA;
      const userProfile = process.env.USERPROFILE;
      const programData = process.env.ProgramData;
      if (localAppData) {
        pathDirs.push(path.join(localAppData, "Microsoft", "WinGet", "Links"));
        pathDirs.push(path.join(localAppData, "Programs", tool));
      }
      if (userProfile) {
        pathDirs.push(path.join(userProfile, "scoop", "shims"));
      }
      if (programData) {
        pathDirs.push(path.join(programData, "chocolatey", "bin"));
      }
    }

    const seen = new Set<string>();
    for (const dir of pathDirs) {
      const key = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = path.join(dir, exeName);
      if (await this.isRegularFile(candidate)) {
        return { available: true, path: candidate, source: "path" };
      }
    }

    return { available: false };
  }

  async refreshToolStatus(): Promise<DownloadToolStatus> {
    const [ytDlp, ffmpeg] = await Promise.all([
      this.detectBinary("yt-dlp"),
      this.detectBinary("ffmpeg"),
    ]);
    this.toolStatus = {
      ...this.toolStatus,
      ytDlp,
      ffmpeg,
      downloadDir: this.getDownloadDir(),
    };
    return { ...this.toolStatus };
  }

  async setDownloadDir(dirPath: string): Promise<boolean> {
    if (!path.isAbsolute(dirPath)) return false;
    try {
      await fs.mkdir(dirPath, { recursive: true });
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) return false;
      this.settings = { ...this.settings, downloadDir: dirPath };
      await saveDownloadSettings(this.settingsFile, this.settings);
      this.toolStatus = { ...this.toolStatus, downloadDir: dirPath };
      this.emitState();
      return true;
    } catch {
      return false;
    }
  }

  async setCustomToolPath(tool: "yt-dlp" | "ffmpeg", filePath: string): Promise<{ ok: boolean; message?: string }> {
    if (!path.isAbsolute(filePath) || !(await this.isRegularFile(filePath))) {
      return { ok: false, message: "所选文件不存在或无法读取" };
    }
    this.settings = {
      ...this.settings,
      ...(tool === "yt-dlp" ? { ytDlpPath: filePath } : { ffmpegPath: filePath }),
    };
    await saveDownloadSettings(this.settingsFile, this.settings);
    await this.refreshToolStatus();
    this.emitState();
    return { ok: true };
  }

  cancelToolInstall(): boolean {
    if (!this.installAbort) return false;
    this.installAbort.abort();
    return true;
  }

  async installTools(): Promise<{ ok: boolean; message?: string }> {
    if (this.toolStatus.installing) {
      return { ok: false, message: "正在安装下载组件，请稍候" };
    }
    const tools = await this.refreshToolStatus();
    const abort = new AbortController();
    this.installAbort = abort;
    this.toolStatus = {
      ...tools,
      installing: true,
      installStage: "准备下载组件…",
      installProgress: 0,
      installError: undefined,
    };
    this.emitState();

    const tempFiles: string[] = [];
    try {
      await fs.mkdir(this.localToolsDir, { recursive: true });

      if (!tools.ytDlp.available) {
        const ytUrl = ytDlpReleaseUrl();
        if (!ytUrl) {
          throw new Error("当前操作系统暂不支持自动下载 yt-dlp，请手动选择程序路径");
        }
        const destPath = path.join(this.localToolsDir, binaryName("yt-dlp"));
        const tmpPath = `${destPath}.tmp-${Date.now()}`;
        tempFiles.push(tmpPath);
        await this.downloadBinaryAsset(ytUrl, tmpPath, "正在下载 yt-dlp…", abort.signal);
        if (process.platform !== "win32") {
          await fs.chmod(tmpPath, 0o755);
        }
        await fs.rename(tmpPath, destPath);
      }

      if (!tools.ffmpeg.available) {
        const ffUrl = ffmpegZipUrl();
        if (ffUrl) {
          const zipTmp = path.join(this.localToolsDir, `ffmpeg-download-${Date.now()}.zip`);
          const ffDest = path.join(this.localToolsDir, binaryName("ffmpeg"));
          tempFiles.push(zipTmp);
          await this.downloadBinaryAsset(ffUrl, zipTmp, "正在下载 ffmpeg（用于合并高画质音视频）…", abort.signal);
          this.toolStatus = {
            ...this.toolStatus,
            installStage: "正在解压 ffmpeg…",
            installProgress: null,
          };
          this.emitState();
          const extracted = await extractZipEntry(zipTmp, (name) => /(?:^|\/)bin\/ffmpeg\.exe$/i.test(name), ffDest);
          if (!extracted) {
            throw new Error("未在归档中找到 ffmpeg.exe");
          }
          await fs.rm(zipTmp, { force: true }).catch(() => undefined);
        }
      }

      this.toolStatus = {
        ...this.toolStatus,
        installing: false,
        installStage: undefined,
        installProgress: null,
        installError: undefined,
      };
      await this.refreshToolStatus();
      this.emitState();
      return { ok: true };
    } catch (error) {
      const canceled = abort.signal.aborted;
      const message = canceled
        ? "已取消组件下载"
        : error instanceof Error
          ? error.message
          : "组件下载失败";
      this.toolStatus = {
        ...this.toolStatus,
        installing: false,
        installStage: undefined,
        installProgress: null,
        installError: canceled ? undefined : message,
      };
      await this.refreshToolStatus();
      this.emitState();
      return { ok: false, message };
    } finally {
      this.installAbort = null;
      await Promise.all(tempFiles.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
    }
  }

  private async downloadBinaryAsset(
    url: string,
    destPath: string,
    stage: string,
    signal: AbortSignal
  ): Promise<void> {
    this.toolStatus = {
      ...this.toolStatus,
      installStage: stage,
      installProgress: 0,
    };
    this.emitState();

    const response = await this.options.fetchWithProxy(url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }

    const totalHeader = Number(response.headers.get("content-length") ?? "0");
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
    let received = 0;
    let lastEmit = 0;
    const reader = response.body.getReader();
    const writer = createWriteStream(destPath);

    try {
      while (true) {
        if (signal.aborted) {
          throw new Error("Aborted");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          await writeChunkWithBackpressure(writer, value);
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            this.toolStatus = {
              ...this.toolStatus,
              installStage: total ? `${stage} (${Math.round((received / total) * 100)}%)` : stage,
              installProgress: total ? Math.min(100, (received / total) * 100) : null,
            };
            this.emitState();
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        writer.end(() => resolve());
        writer.once("error", reject);
      });
    } catch (error) {
      writer.destroy();
      throw error;
    }
  }

  private async inspectPaneMedia(contents: WebContents): Promise<{
    pageUrl: string;
    pageTitle: string;
    videoFrameUrl?: string;
    directVideoUrl?: string;
    directVideoReferer?: string;
    activeFrameUrls: string[];
  }> {
    const pageUrl = contents.getURL();
    const pageTitle = contents.getTitle() || "";
    const frames = (() => {
      try {
        return contents.mainFrame.framesInSubtree;
      } catch {
        return [];
      }
    })();

    const script = `(() => {
      const videos = Array.from(document.querySelectorAll('video')).map((video) => {
        const style = window.getComputedStyle(video);
        const rect = video.getBoundingClientRect();
        const src = video.currentSrc || video.src || video.querySelector('source')?.src || '';
        const visible = !video.hidden && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 2 && rect.height > 2;
        const playing = !video.paused && !video.ended && video.readyState >= 2;
        return {
          src: /^https?:/i.test(src) ? src : '',
          isBlob: /^blob:/i.test(src),
          width: Math.max(0, rect.width),
          height: Math.max(0, rect.height),
          area: Math.max(0, rect.width * rect.height),
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          visible,
          playing,
        };
      });
      return {
        frameUrl: location.href,
        title: document.title || '',
        videos,
      };
    })()`;

    const inspections = await Promise.all(
      frames.slice(0, 16).map(async (frame): Promise<FrameInspection | null> => {
        if (frame.isDestroyed()) return null;
        try {
          const result = await Promise.race([
            frame.executeJavaScript(script, false) as Promise<FrameInspection>,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
          ]);
          return result && typeof result === "object" ? result : null;
        } catch {
          return null;
        }
      })
    );

    let bestPrimaryScore = -1;
    let primaryFrameUrl: string | undefined;
    let primaryDirectUrl: string | undefined;
    let primaryIsBlob = false;
    let bestDirectUrl: string | undefined;
    let bestDirectReferer: string | undefined;
    let bestDirectScore = -1;
    let videoFrameUrl: string | undefined;
    let bestFrameScore = -1;

    const activeFrameUrls: string[] = [];
    for (const item of inspections) {
      if (!item) continue;
      if (isHttpUrl(item.frameUrl) && !activeFrameUrls.includes(item.frameUrl)) {
        activeFrameUrls.push(item.frameUrl);
      }
      if (!Array.isArray(item.videos)) continue;
      for (const video of item.videos) {
        if (isLikelyAdMedia(video.src || "", item.frameUrl, video.width, video.height, video.duration, item.frameUrl)) {
          continue;
        }
        const durationBonus = video.duration > 60 ? 1_000_000 : video.duration > 15 ? 100_000 : 0;
        const visibleBonus = video.visible ? 2_000_000 : 0;
        const playingBonus = video.playing ? 500_000 : 0;
        const visibilityFactor = video.visible ? 1 : 0.1;
        const adPenalty =
          (video.src && this.isAdFlagged(video.src, item.frameUrl || pageUrl, "media"))
          || (item.frameUrl && item.frameUrl !== pageUrl && this.isAdFlagged(item.frameUrl, pageUrl, "subFrame"))
            ? -500_000
            : 0;
        const score = (video.area * visibilityFactor) + visibleBonus + playingBonus + durationBonus + adPenalty;

        if (score >= bestPrimaryScore) {
          bestPrimaryScore = score;
          primaryFrameUrl = isHttpUrl(item.frameUrl) ? item.frameUrl : undefined;
          primaryDirectUrl = video.src && isHttpUrl(video.src) ? video.src : undefined;
          primaryIsBlob = Boolean(video.isBlob && !primaryDirectUrl);
        }
        if (video.src && isHttpUrl(video.src) && score >= bestDirectScore) {
          bestDirectScore = score;
          bestDirectUrl = video.src;
          bestDirectReferer = isHttpUrl(item.frameUrl) ? item.frameUrl : pageUrl;
        }
        if (item.frameUrl !== pageUrl && isHttpUrl(item.frameUrl) && score >= bestFrameScore) {
          bestFrameScore = score;
          videoFrameUrl = item.frameUrl;
        }
      }
    }

    const directVideoUrl = primaryIsBlob ? undefined : (primaryDirectUrl ?? bestDirectUrl);
    const directVideoReferer = primaryIsBlob ? undefined : (primaryDirectUrl ? (primaryFrameUrl ?? pageUrl) : bestDirectReferer);

    return {
      pageUrl,
      pageTitle,
      videoFrameUrl,
      directVideoUrl,
      directVideoReferer,
      activeFrameUrls,
    };
  }

  private async prepareSessionHelpers(
    targetSession: Session,
    targetUrl: string,
    proxySettings: GlobalProxySettings
  ): Promise<{ proxyUrl: string | null; cookieFile: string | null }> {
    let systemResolvedProxy: string | undefined;
    if (proxySettings.mode === "system") {
      try {
        systemResolvedProxy = await targetSession.resolveProxy(targetUrl);
      } catch {
      }
    }
    const proxyUrl = resolveYtDlpProxyUrl(proxySettings, targetUrl, systemResolvedProxy);

    let cookieFile: string | null = null;
    try {
      const cookies = (await targetSession.cookies.get({})) as CookieInput[];
      const content = buildNetscapeCookieFile(cookies, targetUrl);
      if (content) {
        cookieFile = path.join(os.tmpdir(), `same-screen-cookies-${randomUUID()}.txt`);
        await fs.writeFile(cookieFile, content, { encoding: "utf8", mode: 0o600 });
      }
    } catch {
      cookieFile = null;
    }

    return { proxyUrl, cookieFile };
  }

  cancelProbe(probeId: string): boolean {
    const cancel = this.activeProbes.get(probeId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  async probePane(
    probeId: string,
    paneId: string,
    contents: WebContents,
    targetSession: Session,
    proxySettings: GlobalProxySettings
  ): Promise<DownloadProbeResult> {
    const tools = await this.refreshToolStatus();
    const hasYtDlp = tools.ytDlp.available;
    const hasFfmpeg = tools.ffmpeg.available;

    const inspected = await this.inspectPaneMedia(contents);
    if (!isHttpUrl(inspected.pageUrl)) {
      return {
        ok: false,
        code: "invalid-url",
        message: "当前分屏没有可下载的网页视频",
        paneId,
        hasYtDlp,
        hasFfmpeg,
      };
    }

    const now = Date.now();
    const observedEntries = (typeof contents.id === "number" ? this.observedMedia.get(contents.id) ?? [] : [])
      .filter((entry) => now - entry.lastObservedAt < OBSERVED_MEDIA_TTL_MS);
    const activeFrameSet = new Set(
      inspected.activeFrameUrls
        .map((url) => normalizeNavigationKey(url) ?? url)
        .filter(Boolean)
    );
    const isFromStaleFrame = (entry: ObservedMediaEntry): boolean => {
      if (!entry.frameUrl || activeFrameSet.size === 0) return false;
      const key = normalizeNavigationKey(entry.frameUrl) ?? entry.frameUrl;
      return !activeFrameSet.has(key);
    };

    const scoreObservedPlaylist = (entry: ObservedMediaEntry): number => {
      let score = 0;
      const pageOrigin = (() => {
        try { return new URL(inspected.pageUrl).origin; } catch { return ""; }
      })();
      const frameOrigin = (() => {
        try { return inspected.videoFrameUrl ? new URL(inspected.videoFrameUrl).origin : ""; } catch { return ""; }
      })();
      const contextMatchesExact =
        entry.refererUrl === inspected.pageUrl
        || (inspected.videoFrameUrl && entry.refererUrl === inspected.videoFrameUrl)
        || entry.frameUrl === inspected.pageUrl
        || (inspected.videoFrameUrl && entry.frameUrl === inspected.videoFrameUrl);
      const contextMatchesOrigin = Boolean(
        (pageOrigin && (entry.refererUrl.startsWith(pageOrigin) || entry.frameUrl.startsWith(pageOrigin)))
        || (frameOrigin && (entry.refererUrl.startsWith(frameOrigin) || entry.frameUrl.startsWith(frameOrigin)))
      );
      if (contextMatchesExact) score += 1200;
      else if (contextMatchesOrigin) score += 900;
      else if (!entry.refererUrl) score -= 500;

      if (isFromStaleFrame(entry)) score -= 2000;
      if (isMasterPlaylistUrl(entry.url)) {
        score += 400;
      }
      if (isSubPlaylistUrl(entry.url)) {
        score -= 400;
      }
      if (entry.hits > 6) score -= 400;
      if (entry.adFlagged) score -= 1200;
      return score;
    };

    const observedPlaylists = observedEntries
      .filter((entry) => entry.kind === "playlist")
      .sort((a, b) => {
        const scoreDiff = scoreObservedPlaylist(b) - scoreObservedPlaylist(a);
        if (scoreDiff !== 0) return scoreDiff;
        const sameMasterWindow =
          Math.abs(a.firstObservedAt - b.firstObservedAt) <= 1_500
          && !(isMasterPlaylistUrl(a.url) && isMasterPlaylistUrl(b.url));
        if (sameMasterWindow) {
          return a.firstObservedAt - b.firstObservedAt;
        }
        return b.lastObservedAt - a.lastObservedAt;
      });
    const observedDirectMedia = observedEntries
      .filter((entry) => entry.kind === "media")
      .sort(
        (a, b) =>
          Number(a.adFlagged) - Number(b.adFlagged)
          || Number(isFromStaleFrame(a)) - Number(isFromStaleFrame(b))
          || b.lastObservedAt - a.lastObservedAt
      );

    const fallbackDirectUrl = inspected.directVideoUrl ?? observedDirectMedia[0]?.url;
    const fallbackDirectReferer = inspected.directVideoUrl
      ? (inspected.directVideoReferer ?? inspected.pageUrl)
      : (observedDirectMedia[0]?.refererUrl || inspected.videoFrameUrl || inspected.pageUrl);

    const nonAdPlaylists = observedPlaylists.filter((entry) => !entry.adFlagged);
    const liveFramePlaylists = nonAdPlaylists.filter((entry) => !isFromStaleFrame(entry));
    const nonAdDirectMedia = observedDirectMedia.filter((entry) => !entry.adFlagged && !isFromStaleFrame(entry));
    const hasInPagePlaylistSwitch =
      liveFramePlaylists.length >= 2
      && (
        Math.abs(liveFramePlaylists[0].firstObservedAt - liveFramePlaylists[1].firstObservedAt) > 1_500
        || (isMasterPlaylistUrl(liveFramePlaylists[0].url) && isMasterPlaylistUrl(liveFramePlaylists[1].url))
      );
    const isGenericPage = !isDedicatedExtractorHost(inspected.pageUrl);
    const latestDirectAt = nonAdDirectMedia[0]?.lastObservedAt ?? 0;
    const latestPlaylistAt = liveFramePlaylists[0]?.lastObservedAt ?? 0;
    const preferLiveDirectVideo = Boolean(
      isGenericPage
      && inspected.directVideoUrl
      && (
        nonAdDirectMedia.length >= 2
        || (nonAdPlaylists.length > 0 && (liveFramePlaylists.length === 0 || latestDirectAt >= latestPlaylistAt))
      )
    );

    if (!tools.ytDlp.path || preferLiveDirectVideo) {
      if (fallbackDirectUrl) {
        this.logDiagnostic("probe:direct", {
          probeId,
          paneId,
          pageUrl: inspected.pageUrl,
          videoFrameUrl: inspected.videoFrameUrl,
          directUrl: fallbackDirectUrl,
          preferLiveDirectVideo,
        });
        const suggestedName = sanitizeDownloadFileName(
          inspected.pageTitle || path.basename(new URL(fallbackDirectUrl).pathname) || "video"
        );
        const ext = inferExtensionFromUrl(fallbackDirectUrl, "mp4");
        return {
          ok: true,
          paneId,
          pageUrl: inspected.pageUrl,
          probeUrl: fallbackDirectUrl,
          refererUrl: fallbackDirectReferer,
          title: inspected.pageTitle || suggestedName,
          suggestedName,
          sourceType: "direct",
          directUrl: fallbackDirectUrl,
          qualities: [
            {
              id: "direct",
              label: `原视频直链 (.${ext})${!tools.ytDlp.path ? " · 无需外部组件" : ""}`,
              selector: "direct",
              ext,
              isDirect: true,
            },
          ],
          hasYtDlp: tools.ytDlp.available,
          hasFfmpeg,
        };
      }
      if (!tools.ytDlp.path) {
        return {
          ok: false,
          code: "missing-yt-dlp",
          message: "下载 YouTube、bilibili 等流媒体视频需要先安装 yt-dlp 组件",
          paneId,
          pageUrl: inspected.pageUrl,
          hasYtDlp: false,
          hasFfmpeg,
        };
      }
    }

    const candidates: Array<{ probeUrl: string; refererUrl: string; isPlaylist?: boolean }> = [];
    const seenCandidates = new Set<string>();
    const addCandidate = (probeUrl: string | undefined, refererUrl: string, isPlaylist = false) => {
      if (!probeUrl || !isHttpUrl(probeUrl) || seenCandidates.has(probeUrl)) return;
      seenCandidates.add(probeUrl);
      candidates.push({ probeUrl, refererUrl, isPlaylist });
    };
    const normalizedPageUrl = normalizeDownloadProbeUrl(inspected.pageUrl);
    const preferObservedPlaylists = Boolean(
      isGenericPage
      && liveFramePlaylists.length > 0
      && (hasInPagePlaylistSwitch || !isSubPlaylistUrl(liveFramePlaylists[0].url))
    );
    if (isGenericPage) {
      if (preferObservedPlaylists) {
        for (const playlist of liveFramePlaylists.slice(0, 4)) {
          addCandidate(playlist.url, playlist.refererUrl || inspected.videoFrameUrl || inspected.pageUrl, true);
        }
      }
      if (inspected.videoFrameUrl && inspected.videoFrameUrl !== inspected.pageUrl) {
        addCandidate(normalizeDownloadProbeUrl(inspected.videoFrameUrl), inspected.pageUrl);
        addCandidate(inspected.videoFrameUrl, inspected.pageUrl);
      }
      if (!preferObservedPlaylists) {
        for (const playlist of liveFramePlaylists.slice(0, 4)) {
          addCandidate(playlist.url, playlist.refererUrl || inspected.videoFrameUrl || inspected.pageUrl, true);
        }
      }
      addCandidate(normalizedPageUrl, normalizedPageUrl);
      addCandidate(inspected.pageUrl, inspected.pageUrl);
      for (const playlist of observedPlaylists.slice(0, 4)) {
        addCandidate(playlist.url, playlist.refererUrl || inspected.videoFrameUrl || inspected.pageUrl, true);
      }
    } else {
      addCandidate(normalizedPageUrl, normalizedPageUrl);
      addCandidate(inspected.pageUrl, inspected.pageUrl);
      if (inspected.videoFrameUrl && inspected.videoFrameUrl !== inspected.pageUrl) {
        addCandidate(normalizeDownloadProbeUrl(inspected.videoFrameUrl), inspected.pageUrl);
        addCandidate(inspected.videoFrameUrl, inspected.pageUrl);
      }
      for (const playlist of observedPlaylists.slice(0, 4)) {
        addCandidate(playlist.url, playlist.refererUrl || inspected.videoFrameUrl || inspected.pageUrl, true);
      }
    }

    this.logDiagnostic("probe:plan", {
      probeId,
      paneId,
      pageUrl: inspected.pageUrl,
      videoFrameUrl: inspected.videoFrameUrl,
      directVideoUrl: inspected.directVideoUrl,
      activeFrameUrls: inspected.activeFrameUrls,
      preferObservedPlaylists,
      hasInPagePlaylistSwitch,
      observedPlaylists: observedPlaylists.slice(0, 6).map((p) => ({
        url: p.url,
        frameUrl: p.frameUrl,
        hits: p.hits,
        stale: isFromStaleFrame(p),
        score: scoreObservedPlaylist(p),
        firstObservedAt: p.firstObservedAt,
        lastObservedAt: p.lastObservedAt,
      })),
      candidates: candidates.map((c) => c.probeUrl),
    });

    let lastErrorMessage = "无法解析当前页面的视频流";
    for (const candidate of candidates) {
      const result = await this.runYtDlpProbe(
        probeId,
        tools.ytDlp.path,
        candidate.probeUrl,
        candidate.refererUrl,
        targetSession,
        proxySettings,
        hasFfmpeg
      );
      this.logDiagnostic("probe:candidate", {
        probeId,
        probeUrl: candidate.probeUrl,
        ok: result.ok,
        canceled: !result.ok ? result.canceled : false,
        title: result.ok ? result.title : undefined,
        message: !result.ok ? result.message : undefined,
      });
      if (result.canceled) {
        return {
          ok: false,
          code: "canceled",
          message: "已取消解析",
          paneId,
          pageUrl: inspected.pageUrl,
          hasYtDlp: true,
          hasFfmpeg,
        };
      }
      if (result.ok) {
        this.cacheProbedFormats(candidate.probeUrl, result.formats, result.httpHeaders);
        const cleanPageTitle = inspected.pageTitle.trim();
        const usePageTitle =
          candidate.isPlaylist
          && cleanPageTitle.length > 0
          && !/^(?:about:blank|loading|just a moment\.\.\.)$/i.test(cleanPageTitle);
        const title = (usePageTitle ? cleanPageTitle : result.title) || cleanPageTitle || "video";
        const suggestedName = sanitizeDownloadFileName(title, "video");
        return {
          ok: true,
          paneId,
          pageUrl: inspected.pageUrl,
          probeUrl: candidate.probeUrl,
          refererUrl: candidate.refererUrl,
          title,
          suggestedName,
          sourceType: "yt-dlp",
          duration: result.duration,
          qualities: result.qualities,
          hasYtDlp: true,
          hasFfmpeg,
        };
      }
      lastErrorMessage = result.message;
    }

    if (fallbackDirectUrl) {
      const suggestedName = sanitizeDownloadFileName(inspected.pageTitle || "video");
      const ext = inferExtensionFromUrl(fallbackDirectUrl, "mp4");
      return {
        ok: true,
        paneId,
        pageUrl: inspected.pageUrl,
        probeUrl: fallbackDirectUrl,
        refererUrl: fallbackDirectReferer,
        title: inspected.pageTitle || suggestedName,
        suggestedName,
        sourceType: "direct",
        directUrl: fallbackDirectUrl,
        qualities: [
          {
            id: "direct",
            label: `原视频直链 (.${ext})`,
            selector: "direct",
            ext,
            isDirect: true,
          },
        ],
        hasYtDlp: true,
        hasFfmpeg,
      };
    }

    const finalMessage =
      lastErrorMessage === "暂不支持解析该网页地址" && observedPlaylists.length === 0
        ? "暂不支持直接解析该网页；如果页面需先点击播放才会加载视频，请先在分屏内点击播放后再点“重新解析”"
        : lastErrorMessage;

    return {
      ok: false,
      code: "failed",
      message: finalMessage,
      paneId,
      pageUrl: inspected.pageUrl,
      hasYtDlp: true,
      hasFfmpeg,
    };
  }

  private cacheProbedFormats(
    probeUrl: string,
    formats: RawYtDlpFormat[],
    httpHeaders?: Record<string, string>
  ): void {
    this.probedMediaCache.delete(probeUrl);
    this.probedMediaCache.set(probeUrl, {
      formats,
      httpHeaders,
      cachedAt: Date.now(),
    });
    while (this.probedMediaCache.size > MAX_PROBED_MEDIA_CACHE) {
      const oldestKey = this.probedMediaCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.probedMediaCache.delete(oldestKey);
    }
  }

  private async runYtDlpProbe(
    probeId: string,
    ytDlpPath: string,
    targetUrl: string,
    refererUrl: string,
    targetSession: Session,
    proxySettings: GlobalProxySettings,
    hasFfmpeg: boolean
  ): Promise<
    | {
        ok: true;
        canceled?: false;
        title?: string;
        duration?: number;
        qualities: DownloadQualityOption[];
        formats: RawYtDlpFormat[];
        httpHeaders?: Record<string, string>;
      }
    | { ok: false; canceled: boolean; message: string }
  > {
    const helpers = await this.prepareSessionHelpers(targetSession, targetUrl, proxySettings);
    const args = [
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--no-colors",
      "--encoding",
      "utf-8",
      "--socket-timeout",
      "15",
      "--user-agent",
      this.options.userAgent,
      "--referer",
      refererUrl,
    ];
    if (helpers.proxyUrl) args.push("--proxy", helpers.proxyUrl);
    if (helpers.cookieFile) args.push("--cookies", helpers.cookieFile);
    args.push("--", targetUrl);

    return new Promise((resolve) => {
      let settled = false;
      let canceled = false;
      let stdout = "";
      let stderr = "";
      const child = (this.options.spawnProcess ?? spawn)(ytDlpPath, args, {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });

      const finish = (
        value:
          | {
              ok: true;
              canceled?: false;
              title?: string;
              duration?: number;
              qualities: DownloadQualityOption[];
              formats: RawYtDlpFormat[];
              httpHeaders?: Record<string, string>;
            }
          | { ok: false; canceled: boolean; message: string }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeProbes.delete(probeId);
        if (helpers.cookieFile) void fs.rm(helpers.cookieFile, { force: true }).catch(() => undefined);
        resolve(value);
      };

      const timer = setTimeout(() => {
        canceled = false;
        killProcessTree(child);
        finish({ ok: false, canceled: false, message: "解析视频超时，请检查网络或代理" });
      }, PROBE_TIMEOUT_MS);

      this.activeProbes.set(probeId, () => {
        canceled = true;
        killProcessTree(child);
        finish({ ok: false, canceled: true, message: "已取消解析" });
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish({ ok: false, canceled, message: `无法启动 yt-dlp：${error.message}` });
      });
      child.on("close", (code) => {
        if (canceled) {
          finish({ ok: false, canceled: true, message: "已取消解析" });
          return;
        }
        if (code !== 0) {
          finish({ ok: false, canceled: false, message: translateYtDlpError(stderr, hasFfmpeg) });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            title?: unknown;
            duration?: unknown;
            ext?: unknown;
            http_headers?: unknown;
            formats?: RawYtDlpFormat[];
          };
          if (!hasExtractableMediaInfo(parsed)) {
            finish({
              ok: false,
              canceled: false,
              message: "未能识别到可下载的视频流（仅检测到网页链接），请确认当前页面正在播放具体视频",
            });
            return;
          }
          const title = typeof parsed.title === "string" ? parsed.title : undefined;
          const duration = typeof parsed.duration === "number" && Number.isFinite(parsed.duration) ? parsed.duration : undefined;
          const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
          const httpHeaders: Record<string, string> = {};
          if (parsed.http_headers && typeof parsed.http_headers === "object") {
            for (const [key, val] of Object.entries(parsed.http_headers as Record<string, unknown>)) {
              if (typeof val === "string") httpHeaders[key] = val;
            }
          }
          const qualities = buildQualityOptions(formats, hasFfmpeg, duration);
          finish({ ok: true, title, duration, qualities, formats, httpHeaders });
        } catch {
          finish({ ok: false, canceled: false, message: "解析视频信息失败（返回格式无效）" });
        }
      });
    });
  }

  private makeUniqueStemSync(dir: string, desiredStem: string, expectedExt: string): string {
    mkdirSync(dir, { recursive: true });
    let counter = 0;
    while (counter < 9999) {
      const candidateStem = counter === 0 ? desiredStem : `${desiredStem} (${counter})`;
      const candidatePath = path.join(dir, `${candidateStem}.${expectedExt}`);
      const partPath = `${candidatePath}.part`;
      if (!existsSync(candidatePath) && !existsSync(partPath) && !this.reservedPaths.has(candidatePath)) {
        this.reservedPaths.add(candidatePath);
        return candidateStem;
      }
      counter += 1;
    }
    const fallbackStem = `${desiredStem}-${Date.now()}`;
    this.reservedPaths.add(path.join(dir, `${fallbackStem}.${expectedExt}`));
    return fallbackStem;
  }

  private makeUniqueFilePathSync(dir: string, rawFileName: string): string {
    mkdirSync(dir, { recursive: true });
    const parsed = path.parse(rawFileName);
    const stem = sanitizeDownloadFileName(parsed.name || "download", "download");
    const ext = parsed.ext.replace(/^\./, "");
    let counter = 0;
    while (counter < 9999) {
      const candidateStem = counter === 0 ? stem : `${stem} (${counter})`;
      const fileName = ext ? `${candidateStem}.${ext}` : candidateStem;
      const candidatePath = path.join(dir, fileName);
      if (!existsSync(candidatePath) && !existsSync(`${candidatePath}.part`) && !this.reservedPaths.has(candidatePath)) {
        this.reservedPaths.add(candidatePath);
        return candidatePath;
      }
      counter += 1;
    }
    const fallbackName = ext ? `${stem}-${Date.now()}.${ext}` : `${stem}-${Date.now()}`;
    const fallbackPath = path.join(dir, fallbackName);
    this.reservedPaths.add(fallbackPath);
    return fallbackPath;
  }

  private trimHistory(): void {
    if (this.tasks.size <= MAX_TASKS_HISTORY) return;
    const removable = [...this.tasks.values()]
      .filter((task) => task.status === "completed" || task.status === "failed" || task.status === "canceled")
      .sort((a, b) => a.createdAt - b.createdAt);
    while (this.tasks.size > MAX_TASKS_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) this.tasks.delete(oldest.id);
    }
  }

  private updateTask(taskId: string, patch: Partial<DownloadTask>, forceEmit = false): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    const updated: DownloadTask = { ...existing, ...patch };
    this.tasks.set(taskId, updated);
    const now = Date.now();
    const last = this.lastBroadcastAt.get(taskId) ?? 0;
    if (forceEmit || now - last >= PROGRESS_THROTTLE_MS) {
      this.lastBroadcastAt.set(taskId, now);
      this.emitState();
    }
  }

  private cleanupPartFilesLater(reservedPath: string): void {
    const prefix = `${path.parse(reservedPath).name}.`;
    const dir = path.dirname(reservedPath);
    setTimeout(() => {
      void fs.readdir(dir).then((entries) =>
        Promise.all(
          entries
            .filter((name) => name.startsWith(prefix) && (name.endsWith(".part") || name.endsWith(".ytdl")))
            .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => undefined))
        )
      ).catch(() => undefined);
    }, 350).unref();
  }

  private buildRefererCandidates(
    request: DownloadStartRequest,
    extraHeaders?: Record<string, string>
  ): Array<string | undefined> {
    const candidates: Array<string | undefined> = [];
    const addCandidate = (value: unknown) => {
      if (isHttpUrl(value) && !candidates.includes(value)) {
        candidates.push(value);
      }
    };
    addCandidate(extraHeaders?.Referer);
    addCandidate(extraHeaders?.referer);
    addCandidate(request.refererUrl);
    addCandidate(request.pageUrl);
    candidates.push(undefined);
    return candidates;
  }

  private runFfmpegProcess(
    ffmpegPath: string,
    args: string[],
    onSpawned: (child: ChildProcess) => void
  ): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let stderr = "";
      const child = (this.options.spawnProcess ?? spawn)(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
      });
      onSpawned(child);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: -1, stderr: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr });
      });
    });
  }

  async startDownload(
    request: DownloadStartRequest,
    targetSession: Session,
    proxySettings: GlobalProxySettings
  ): Promise<{ ok: true; taskId: string } | { ok: false; message: string }> {
    if (!isHttpUrl(request.pageUrl) || !isHttpUrl(request.probeUrl)) {
      return { ok: false, message: "无效的视频网址" };
    }
    const safeRefererUrl = isHttpUrl(request.refererUrl) ? request.refererUrl : request.pageUrl;
    const normalizedRequest: DownloadStartRequest = { ...request, refererUrl: safeRefererUrl };
    if (normalizedRequest.sourceType === "direct") {
      if (!isHttpUrl(normalizedRequest.directUrl)) return { ok: false, message: "无效的直链地址" };
      return this.startDirectDownload(normalizedRequest, targetSession);
    }

    const tools = await this.refreshToolStatus();
    if (!tools.ytDlp.path) {
      return { ok: false, message: "未检测到 yt-dlp 组件，请先安装或手动指定路径" };
    }
    const selector = request.selector.trim();
    if (!selector || selector.length > 200 || /[\r\n\0]/.test(selector)) {
      return { ok: false, message: "无效的清晰度参数" };
    }

    const safeExt = /^[a-z0-9]{1,8}$/i.test(request.ext ?? "") ? request.ext!.toLowerCase() : "mp4";
    const outputDir = this.getDownloadDir();
    const safeStem = sanitizeDownloadFileName(request.fileName, "video");
    const expectedExt = request.isAudioOnly ? (tools.ffmpeg.path ? "mp3" : "m4a") : safeExt;
    const uniqueStem = this.makeUniqueStemSync(outputDir, safeStem, expectedExt);
    const reservedPath = path.join(outputDir, `${uniqueStem}.${expectedExt}`);
    const outputTemplate = path.join(outputDir, `${uniqueStem}.%(ext)s`);

    const cached = this.probedMediaCache.get(normalizedRequest.probeUrl);
    const cacheValid = cached && Date.now() - cached.cachedAt < PROBED_MEDIA_CACHE_TTL_MS;
    const concurrentSelection = cacheValid
      ? selectConcurrentFormats(
          cached.formats,
          normalizedRequest.qualityId,
          Boolean(tools.ffmpeg.path),
          cached.httpHeaders
        )
      : null;

    const taskId = randomUUID();
    const task: DownloadTask = {
      id: taskId,
      paneId: request.paneId,
      title: safeStem,
      fileName: `${uniqueStem}.${expectedExt}`,
      qualityLabel: request.qualityLabel || "最佳画质",
      source: "yt-dlp",
      status: "queued",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      outputDir,
      createdAt: Date.now(),
    };
    this.tasks.set(taskId, task);
    this.trimHistory();
    this.emitState();

    if (concurrentSelection) {
      void this.executeConcurrentRangeTask(
        taskId,
        concurrentSelection,
        tools.ytDlp.path,
        tools.ffmpeg.path,
        normalizedRequest,
        outputDir,
        uniqueStem,
        outputTemplate,
        reservedPath,
        targetSession,
        proxySettings
      );
    } else {
      void this.executeYtDlpTask(
        taskId,
        tools.ytDlp.path,
        tools.ffmpeg.path,
        normalizedRequest,
        outputTemplate,
        reservedPath,
        targetSession,
        proxySettings
      );
    }
    return { ok: true, taskId };
  }

  private async executeConcurrentRangeTask(
    taskId: string,
    initialSelection: ConcurrentFormatSelection,
    ytDlpPath: string,
    ffmpegPath: string | undefined,
    request: DownloadStartRequest,
    outputDir: string,
    uniqueStem: string,
    outputTemplate: string,
    reservedPath: string,
    targetSession: Session,
    proxySettings: GlobalProxySettings
  ): Promise<void> {
    let selection = initialSelection;
    const ext = path.extname(reservedPath).replace(/^\./, "").toLowerCase() || "mp4";
    const tmpMuxPath = path.join(outputDir, `${uniqueStem}.mux.tmp.${ext}`);

    const makePartPath = (role: "video" | "audio" | "single"): string => {
      if (role === "single") {
        return selection.isAudioOnly && ffmpegPath && ext === "mp3"
          ? path.join(outputDir, `${uniqueStem}.audio.part`)
          : `${reservedPath}.part`;
      }
      return path.join(outputDir, `${uniqueStem}.${role}.part`);
    };

    const transfers: {
      video?: SingleStreamTransfer;
      audio?: SingleStreamTransfer;
      single?: SingleStreamTransfer;
    } = {};
    const transferList: SingleStreamTransfer[] = [];

    let stopIntent: "none" | "pause" | "cancel" = "none";
    let isRunning = false;
    let runAbort: AbortController | null = null;
    let runPromise: Promise<void> | null = null;
    let ffmpegChild: ChildProcess | null = null;
    let lastMeasureAt = Date.now();
    let lastMeasureBytes = 0;
    let currentSpeed = 0;
    let urlRefreshAttempts = 0;

    const getSummedProgress = (): { downloadedBytes: number; totalBytes: number | null } => {
      let downloaded = 0;
      let totalSum = 0;
      let allTotalsKnown = true;
      for (const item of transferList) {
        const p = item.getProgress();
        downloaded += p.downloadedBytes;
        if (p.totalBytes !== null && p.totalBytes > 0) {
          totalSum += p.totalBytes;
        } else {
          allTotalsKnown = false;
        }
      }
      return {
        downloadedBytes: downloaded,
        totalBytes: allTotalsKnown && totalSum > 0 ? totalSum : null,
      };
    };

    const emitProgress = () => {
      if (stopIntent !== "none") return;
      const { downloadedBytes, totalBytes } = getSummedProgress();
      const now = Date.now();
      const elapsed = (now - lastMeasureAt) / 1000;
      if (elapsed >= 0.4) {
        currentSpeed = Math.max(0, (downloadedBytes - lastMeasureBytes) / elapsed);
        lastMeasureAt = now;
        lastMeasureBytes = downloadedBytes;
      }
      const etaSeconds =
        totalBytes && currentSpeed > 0 ? Math.max(0, (totalBytes - downloadedBytes) / currentSpeed) : null;
      const progress = totalBytes && totalBytes > 0
        ? Math.min(99.5, (downloadedBytes / totalBytes) * 100)
        : null;
      this.updateTask(taskId, {
        status: "downloading",
        downloadedBytes,
        totalBytes,
        progress,
        speedText: currentSpeed > 0 ? formatSpeed(currentSpeed) : undefined,
        etaText: etaSeconds !== null ? formatEta(etaSeconds) : undefined,
      });
    };

    if (selection.mode === "dual") {
      const videoTransfer = new SingleStreamTransfer(
        targetSession,
        this.options.userAgent,
        {
          url: selection.video.url,
          partPath: makePartPath("video"),
          refererCandidates: this.buildRefererCandidates(request, selection.video.headers),
          extraHeaders: selection.video.headers,
          concurrency: 4,
        },
        { onProgress: emitProgress }
      );
      const audioTransfer = new SingleStreamTransfer(
        targetSession,
        this.options.userAgent,
        {
          url: selection.audio.url,
          partPath: makePartPath("audio"),
          refererCandidates: this.buildRefererCandidates(request, selection.audio.headers),
          extraHeaders: selection.audio.headers,
          concurrency: 4,
        },
        { onProgress: emitProgress }
      );
      transfers.video = videoTransfer;
      transfers.audio = audioTransfer;
      transferList.push(videoTransfer, audioTransfer);
    } else {
      const singleTransfer = new SingleStreamTransfer(
        targetSession,
        this.options.userAgent,
        {
          url: selection.stream.url,
          partPath: makePartPath("single"),
          refererCandidates: this.buildRefererCandidates(request, selection.stream.headers),
          extraHeaders: selection.stream.headers,
          concurrency: 6,
        },
        { onProgress: emitProgress }
      );
      transfers.single = singleTransfer;
      transferList.push(singleTransfer);
    }

    const tempPathsToDelete = (): string[] => [
      ...transferList.map((item) => item.getPartPath()),
      tmpMuxPath,
    ];

    const cleanupFilesAndCancel = async () => {
      await Promise.all(tempPathsToDelete().map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
      this.activeControllers.delete(taskId);
      this.reservedPaths.delete(reservedPath);
      this.updateTask(
        taskId,
        {
          status: "canceled",
          speedText: undefined,
          etaText: undefined,
        },
        true
      );
    };

    const refreshStreamUrls = async (): Promise<boolean> => {
      const probeResult = await this.runYtDlpProbe(
        `refresh-${taskId}-${Date.now()}`,
        ytDlpPath,
        request.probeUrl,
        request.refererUrl || request.pageUrl,
        targetSession,
        proxySettings,
        Boolean(ffmpegPath)
      );
      if (!probeResult.ok) return false;
      this.cacheProbedFormats(request.probeUrl, probeResult.formats, probeResult.httpHeaders);
      const refreshed = selectConcurrentFormats(
        probeResult.formats,
        request.qualityId,
        Boolean(ffmpegPath),
        probeResult.httpHeaders
      );
      if (!refreshed || refreshed.mode !== selection.mode) return false;
      selection = refreshed;
      if (refreshed.mode === "dual") {
        transfers.video?.updateEndpoint({
          url: refreshed.video.url,
          refererCandidates: this.buildRefererCandidates(request, refreshed.video.headers),
          extraHeaders: refreshed.video.headers,
        });
        transfers.audio?.updateEndpoint({
          url: refreshed.audio.url,
          refererCandidates: this.buildRefererCandidates(request, refreshed.audio.headers),
          extraHeaders: refreshed.audio.headers,
        });
      } else {
        transfers.single?.updateEndpoint({
          url: refreshed.stream.url,
          refererCandidates: this.buildRefererCandidates(request, refreshed.stream.headers),
          extraHeaders: refreshed.stream.headers,
        });
      }
      return true;
    };

    const startRun = async (): Promise<void> => {
      isRunning = true;
      const controllerAbort = new AbortController();
      runAbort = controllerAbort;
      const initialSum = getSummedProgress();
      lastMeasureAt = Date.now();
      lastMeasureBytes = initialSum.downloadedBytes;
      currentSpeed = 0;

      try {
        while (true) {
          try {
            await Promise.all(
              transferList.map((item) =>
                item.isCompleted() ? Promise.resolve() : item.run(controllerAbort.signal)
              )
            );
            break;
          } catch (error) {
            if (stopIntent !== "none") break;
            if (error instanceof RangeUrlExpiredError && urlRefreshAttempts < 1) {
              urlRefreshAttempts += 1;
              const refreshed = await refreshStreamUrls();
              if (refreshed) continue;
            }
            throw error;
          }
        }

        if (stopIntent === "pause") {
          const { downloadedBytes, totalBytes } = getSummedProgress();
          const progress = totalBytes && totalBytes > 0
            ? Math.min(99.5, (downloadedBytes / totalBytes) * 100)
            : this.tasks.get(taskId)?.progress ?? null;
          this.updateTask(
            taskId,
            {
              status: "paused",
              downloadedBytes,
              totalBytes,
              progress,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return;
        }

        if (stopIntent === "cancel") {
          await cleanupFilesAndCancel();
          return;
        }

        // All streams finished cleanly -> merge or rename
        if (selection.mode === "dual") {
          if (!ffmpegPath) {
            throw new Error("合并高画质音视频需要 ffmpeg，请先在下载面板点击安装组件");
          }
          this.updateTask(
            taskId,
            {
              status: "merging",
              progress: 100,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          const videoPart = transfers.video!.getPartPath();
          const audioPart = transfers.audio!.getPartPath();
          let muxResult = await this.runFfmpegProcess(
            ffmpegPath,
            ["-y", "-i", videoPart, "-i", audioPart, "-c", "copy", "-movflags", "+faststart", tmpMuxPath],
            (child) => {
              ffmpegChild = child;
            }
          );
          ffmpegChild = null;
          if ((stopIntent as string) === "cancel") {
            await cleanupFilesAndCancel();
            return;
          }
          if (muxResult.code !== 0) {
            muxResult = await this.runFfmpegProcess(
              ffmpegPath,
              [
                "-y",
                "-i",
                videoPart,
                "-i",
                audioPart,
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                tmpMuxPath,
              ],
              (child) => {
                ffmpegChild = child;
              }
            );
            ffmpegChild = null;
            if ((stopIntent as string) === "cancel") {
              await cleanupFilesAndCancel();
              return;
            }
            if (muxResult.code !== 0) {
              throw new Error("ffmpeg 合并音视频失败");
            }
          }
          await fs.rename(tmpMuxPath, reservedPath);
          await Promise.all([
            fs.rm(videoPart, { force: true }).catch(() => undefined),
            fs.rm(audioPart, { force: true }).catch(() => undefined),
          ]);
        } else {
          const singlePart = transfers.single!.getPartPath();
          if (selection.isAudioOnly && ffmpegPath && ext === "mp3") {
            this.updateTask(
              taskId,
              {
                status: "merging",
                progress: 100,
                speedText: undefined,
                etaText: undefined,
              },
              true
            );
            const convResult = await this.runFfmpegProcess(
              ffmpegPath,
              ["-y", "-i", singlePart, "-vn", "-c:a", "libmp3lame", "-q:a", "2", tmpMuxPath],
              (child) => {
                ffmpegChild = child;
              }
            );
            ffmpegChild = null;
            if ((stopIntent as string) === "cancel") {
              await cleanupFilesAndCancel();
              return;
            }
            if (convResult.code !== 0) {
              throw new Error("ffmpeg 转换音频格式失败");
            }
            await fs.rename(tmpMuxPath, reservedPath);
            await fs.rm(singlePart, { force: true }).catch(() => undefined);
          } else {
            await fs.rename(singlePart, reservedPath);
          }
        }

        const finalStat = await fs.stat(reservedPath).catch(() => null);
        const finalSize = finalStat?.size ?? getSummedProgress().downloadedBytes;
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedPath);
        this.updateTask(
          taskId,
          {
            status: "completed",
            progress: 100,
            downloadedBytes: finalSize,
            totalBytes: finalSize,
            filePath: reservedPath,
            fileName: path.basename(reservedPath),
            speedText: undefined,
            etaText: undefined,
            error: undefined,
          },
          true
        );
      } catch (error) {
        if (stopIntent === "pause") {
          const { downloadedBytes, totalBytes } = getSummedProgress();
          this.updateTask(
            taskId,
            {
              status: "paused",
              downloadedBytes,
              totalBytes,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return;
        }
        if (stopIntent === "cancel") {
          await cleanupFilesAndCancel();
          return;
        }

        const { downloadedBytes } = getSummedProgress();
        if (downloadedBytes === 0 && !(error instanceof RangeHttpError && error.statusCode === 404)) {
          // Clean up empty temp files and transparently fall back to yt-dlp
          await Promise.all(tempPathsToDelete().map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
          this.activeControllers.delete(taskId);
          await this.executeYtDlpTask(
            taskId,
            ytDlpPath,
            ffmpegPath,
            request,
            outputTemplate,
            reservedPath,
            targetSession,
            proxySettings
          );
          return;
        }

        await Promise.all(tempPathsToDelete().map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedPath);
        const message = error instanceof Error ? error.message : "下载失败";
        this.updateTask(
          taskId,
          {
            status: "failed",
            error: message,
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      } finally {
        isRunning = false;
        runAbort = null;
      }
    };

    this.activeControllers.set(taskId, {
      pause: () => {
        if (stopIntent !== "none" || ffmpegChild) return;
        stopIntent = "pause";
        runAbort?.abort();
        this.updateTask(
          taskId,
          {
            status: "paused",
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      },
      resume: () => {
        void (async () => {
          if (runPromise) await runPromise.catch(() => undefined);
          if (stopIntent === "cancel") return;
          const current = this.tasks.get(taskId);
          if (!current || current.status !== "paused") return;
          stopIntent = "none";
          this.updateTask(taskId, { status: "downloading", error: undefined }, true);
          runPromise = startRun();
        })();
      },
      cancel: () => {
        stopIntent = "cancel";
        runAbort?.abort();
        if (ffmpegChild) killProcessTree(ffmpegChild);
        if (!isRunning) {
          void cleanupFilesAndCancel();
        }
      },
    });

    this.updateTask(taskId, { status: "downloading" }, true);
    runPromise = startRun();
    await runPromise;
  }

  private async executeYtDlpTask(
    taskId: string,
    ytDlpPath: string,
    ffmpegPath: string | undefined,
    request: DownloadStartRequest,
    outputTemplate: string,
    reservedPath: string,
    targetSession: Session,
    proxySettings: GlobalProxySettings
  ): Promise<void> {
    let stopIntent: "none" | "pause" | "cancel" = "none";
    let resumePending = false;
    let activeChild: ChildProcess | null = null;
    let closePromise: Promise<void> | null = null;
    let activeCookieFile: string | null = null;

    const cleanupAndCancel = () => {
      this.activeControllers.delete(taskId);
      this.reservedPaths.delete(reservedPath);
      if (activeCookieFile) {
        void fs.rm(activeCookieFile, { force: true }).catch(() => undefined);
        activeCookieFile = null;
      }
      this.cleanupPartFilesLater(reservedPath);
      this.updateTask(
        taskId,
        {
          status: "canceled",
          speedText: undefined,
          etaText: undefined,
        },
        true
      );
    };

    const launchYtDlp = async (): Promise<void> => {
      const helpers = await this.prepareSessionHelpers(targetSession, request.probeUrl, proxySettings);
      activeCookieFile = helpers.cookieFile;
      const task = this.tasks.get(taskId);
      if (!task || task.status === "canceled" || stopIntent === "cancel") {
        cleanupAndCancel();
        return;
      }

      const args = [
        "--newline",
        "--no-colors",
        "--encoding",
        "utf-8",
        "--no-playlist",
        "--no-overwrites",
        "--continue",
        "--concurrent-fragments",
        "4",
        "--progress",
        "--no-quiet",
        "--progress-template",
        "download:__SSDL__|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s",
        "--progress-template",
        "postprocess:__SSPP__|%(progress.status)s",
        "--print",
        "after_move:__SSFILE__|%(filepath)s",
        "--user-agent",
        this.options.userAgent,
        "--referer",
        request.refererUrl || request.pageUrl,
      ];
      if (ffmpegPath) {
        args.push("--ffmpeg-location", ffmpegPath);
      }
      args.push("-f", request.selector);
      if (request.isAudioOnly) {
        if (ffmpegPath) args.push("-x", "--audio-format", "mp3");
      } else if (ffmpegPath) {
        args.push("--merge-output-format", "mp4");
      }
      if (helpers.proxyUrl) args.push("--proxy", helpers.proxyUrl);
      if (helpers.cookieFile) args.push("--cookies", helpers.cookieFile);
      args.push("-o", outputTemplate, "--", request.probeUrl);

      const child = (this.options.spawnProcess ?? spawn)(ytDlpPath, args, {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
      activeChild = child;
      let resolveClose!: () => void;
      closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });

      let finalFilePath: string | undefined;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let finishedStreams = 0;
      const expectsTwoStreams = !request.isAudioOnly && Boolean(ffmpegPath) && request.selector.includes("+");
      const stderrLines: string[] = [];

      this.updateTask(taskId, { status: "downloading", error: undefined }, true);

      const mapProgress = (rawProgress: number | null, finished: boolean): number | null => {
        if (!expectsTwoStreams) return finished ? 100 : rawProgress;
        if (finished) return finishedStreams === 0 ? 90 : 99;
        if (rawProgress === null) return null;
        return finishedStreams === 0
          ? Math.min(90, rawProgress * 0.9)
          : Math.min(99, 90 + rawProgress * 0.09);
      };

      const handleOutputLine = (line: string): boolean => {
        if (stopIntent !== "none") return true;
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith("__SSFILE__|")) {
          const filePath = trimmed.slice("__SSFILE__|".length).trim();
          if (filePath) {
            finalFilePath = filePath;
            this.updateTask(taskId, {
              filePath,
              fileName: path.basename(filePath),
            });
          }
          return true;
        }
        const parsed = parseYtDlpProgressLine(trimmed);
        if (!parsed) return false;
        if (parsed.kind === "postprocess") {
          this.updateTask(
            taskId,
            {
              status: "merging",
              progress: 100,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return true;
        }
        if (parsed.status === "finished") {
          const mapped = mapProgress(100, true);
          finishedStreams += 1;
          this.updateTask(
            taskId,
            {
              downloadedBytes: parsed.totalBytes ?? parsed.downloadedBytes,
              totalBytes: parsed.totalBytes ?? parsed.downloadedBytes,
              progress: mapped,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return true;
        }
        this.updateTask(taskId, {
          status: "downloading",
          downloadedBytes: parsed.downloadedBytes,
          totalBytes: parsed.totalBytes,
          progress: mapProgress(parsed.progress, false),
          speedText: parsed.speedBytesPerSec ? formatSpeed(parsed.speedBytesPerSec) : undefined,
          etaText: parsed.etaSeconds !== null ? formatEta(parsed.etaSeconds) : undefined,
        });
        return true;
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleOutputLine(line);
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (handleOutputLine(trimmed)) continue;
          stderrLines.push(trimmed);
          if (stderrLines.length > 30) stderrLines.shift();
        }
      });

      child.on("error", (error) => {
        activeChild = null;
        if (activeCookieFile) {
          void fs.rm(activeCookieFile, { force: true }).catch(() => undefined);
          activeCookieFile = null;
        }
        resolveClose();
        if (stopIntent === "pause") {
          if (!resumePending) {
            this.updateTask(taskId, { status: "paused", speedText: undefined, etaText: undefined }, true);
          }
          return;
        }
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedPath);
        this.updateTask(
          taskId,
          {
            status: stopIntent === "cancel" ? "canceled" : "failed",
            error: stopIntent === "cancel" ? undefined : `启动 yt-dlp 失败：${error.message}`,
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      });

      child.on("close", (code) => {
        activeChild = null;
        if (stdoutBuffer) handleOutputLine(stdoutBuffer);
        if (stderrBuffer) {
          const trimmed = stderrBuffer.trim();
          if (trimmed && !handleOutputLine(trimmed)) {
            stderrLines.push(trimmed);
            if (stderrLines.length > 30) stderrLines.shift();
          }
        }
        if (activeCookieFile) {
          void fs.rm(activeCookieFile, { force: true }).catch(() => undefined);
          activeCookieFile = null;
        }
        resolveClose();

        if (stopIntent === "pause") {
          if (!resumePending) {
            this.updateTask(
              taskId,
              {
                status: "paused",
                speedText: undefined,
                etaText: undefined,
              },
              true
            );
          }
          return;
        }

        if (stopIntent === "cancel") {
          cleanupAndCancel();
          return;
        }

        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedPath);

        if (code === 0) {
          const currentTask = this.tasks.get(taskId);
          const resolvedPath = finalFilePath && existsSync(finalFilePath)
            ? finalFilePath
            : existsSync(reservedPath)
              ? reservedPath
              : finalFilePath;
          this.updateTask(
            taskId,
            {
              status: "completed",
              progress: 100,
              filePath: resolvedPath,
              fileName: resolvedPath ? path.basename(resolvedPath) : currentTask?.fileName ?? path.basename(reservedPath),
              speedText: undefined,
              etaText: undefined,
              error: undefined,
            },
            true
          );
          return;
        }

        this.updateTask(
          taskId,
          {
            status: "failed",
            error: translateYtDlpError(stderrLines.join("\n"), Boolean(ffmpegPath)),
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      });
    };

    this.activeControllers.set(taskId, {
      pause: () => {
        if (stopIntent !== "none") return;
        const current = this.tasks.get(taskId);
        if (!current || current.status === "merging") return;
        stopIntent = "pause";
        resumePending = false;
        if (activeChild) killProcessTree(activeChild);
        this.updateTask(
          taskId,
          {
            status: "paused",
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      },
      resume: () => {
        const current = this.tasks.get(taskId);
        if (!current || current.status !== "paused" || resumePending) return;
        resumePending = true;
        this.updateTask(taskId, { status: "queued", error: undefined }, true);
        void (async () => {
          if (closePromise) await closePromise;
          resumePending = false;
          if (stopIntent === "cancel") {
            cleanupAndCancel();
            return;
          }
          stopIntent = "none";
          await launchYtDlp();
        })();
      },
      cancel: () => {
        stopIntent = "cancel";
        resumePending = false;
        if (activeChild) {
          killProcessTree(activeChild);
        } else {
          cleanupAndCancel();
        }
      },
    });

    await launchYtDlp();
  }

  private async startDirectDownload(
    request: DownloadStartRequest,
    targetSession: Session
  ): Promise<{ ok: true; taskId: string } | { ok: false; message: string }> {
    const directUrl = request.directUrl!;
    const outputDir = this.getDownloadDir();
    const safeStem = sanitizeDownloadFileName(request.fileName, "video");
    const ext = /^[a-z0-9]{1,8}$/i.test(request.ext ?? "") ? request.ext!.toLowerCase() : inferExtensionFromUrl(directUrl, "mp4");
    const uniqueStem = this.makeUniqueStemSync(outputDir, safeStem, ext);
    let reservedDest = path.join(outputDir, `${uniqueStem}.${ext}`);
    let partPath = `${reservedDest}.part`;

    const taskId = randomUUID();
    const task: DownloadTask = {
      id: taskId,
      paneId: request.paneId,
      title: safeStem,
      fileName: `${uniqueStem}.${ext}`,
      qualityLabel: request.qualityLabel || "原视频直链",
      source: "direct",
      status: "downloading",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      outputDir,
      createdAt: Date.now(),
    };
    this.tasks.set(taskId, task);
    this.trimHistory();
    this.emitState();

    let stopIntent: "none" | "pause" | "cancel" = "none";
    let isRunning = false;
    let runAbort: AbortController | null = null;
    let runPromise: Promise<void> | null = null;
    let lastMeasureAt = Date.now();
    let lastMeasureBytes = 0;
    let currentSpeed = 0;

    const refererCandidates = this.buildRefererCandidates(request);
    let transfer: SingleStreamTransfer;

    const emitProgress = () => {
      if (stopIntent !== "none") return;
      const { downloadedBytes, totalBytes } = transfer.getProgress();
      const now = Date.now();
      const elapsed = (now - lastMeasureAt) / 1000;
      if (elapsed >= 0.4) {
        currentSpeed = Math.max(0, (downloadedBytes - lastMeasureBytes) / elapsed);
        lastMeasureAt = now;
        lastMeasureBytes = downloadedBytes;
      }
      const etaSeconds =
        totalBytes && currentSpeed > 0 ? Math.max(0, (totalBytes - downloadedBytes) / currentSpeed) : null;
      this.updateTask(taskId, {
        status: "downloading",
        downloadedBytes,
        totalBytes,
        progress: totalBytes ? Math.min(100, (downloadedBytes / totalBytes) * 100) : null,
        speedText: currentSpeed > 0 ? formatSpeed(currentSpeed) : undefined,
        etaText: etaSeconds !== null ? formatEta(etaSeconds) : undefined,
      });
    };

    transfer = new SingleStreamTransfer(
      targetSession,
      this.options.userAgent,
      {
        url: directUrl,
        partPath,
        refererCandidates,
        concurrency: 6,
      },
      {
        onProgress: emitProgress,
        onInitialHeaders: ({ contentType, totalBytes }) => {
          const headerExt = inferExtensionFromContentType(contentType);
          if (headerExt && headerExt !== ext) {
            const updatedStem = this.makeUniqueStemSync(outputDir, safeStem, headerExt);
            const nextDest = path.join(outputDir, `${updatedStem}.${headerExt}`);
            this.reservedPaths.delete(reservedDest);
            reservedDest = nextDest;
            partPath = `${nextDest}.part`;
          }
          this.updateTask(taskId, { totalBytes, fileName: path.basename(reservedDest) }, true);
          return { partPath };
        },
      }
    );

    const cleanupAndCancel = async () => {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      this.activeControllers.delete(taskId);
      this.reservedPaths.delete(reservedDest);
      this.updateTask(
        taskId,
        {
          status: "canceled",
          speedText: undefined,
          etaText: undefined,
        },
        true
      );
    };

    const startRun = async (): Promise<void> => {
      isRunning = true;
      const abort = new AbortController();
      runAbort = abort;
      const initial = transfer.getProgress();
      lastMeasureAt = Date.now();
      lastMeasureBytes = initial.downloadedBytes;
      currentSpeed = 0;

      try {
        await transfer.run(abort.signal);

        if (stopIntent === "pause") {
          const { downloadedBytes, totalBytes } = transfer.getProgress();
          this.updateTask(
            taskId,
            {
              status: "paused",
              downloadedBytes,
              totalBytes,
              progress: totalBytes ? Math.min(100, (downloadedBytes / totalBytes) * 100) : this.tasks.get(taskId)?.progress ?? null,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return;
        }
        if (stopIntent === "cancel") {
          await cleanupAndCancel();
          return;
        }

        await fs.rename(partPath, reservedDest);
        const { downloadedBytes, totalBytes } = transfer.getProgress();
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedDest);
        this.updateTask(
          taskId,
          {
            status: "completed",
            progress: 100,
            downloadedBytes,
            totalBytes: totalBytes ?? downloadedBytes,
            filePath: reservedDest,
            fileName: path.basename(reservedDest),
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      } catch (error) {
        if (stopIntent === "pause") {
          const { downloadedBytes, totalBytes } = transfer.getProgress();
          this.updateTask(
            taskId,
            {
              status: "paused",
              downloadedBytes,
              totalBytes,
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
          return;
        }
        if (stopIntent === "cancel") {
          await cleanupAndCancel();
          return;
        }

        await fs.rm(partPath, { force: true }).catch(() => undefined);
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(reservedDest);
        const rawMessage = error instanceof Error ? error.message : "下载失败";
        const message = /ERR_BLOCKED_BY_CLIENT/i.test(rawMessage)
          ? "直链请求被安全策略拦截（ERR_BLOCKED_BY_CLIENT），可尝试重新解析该页面"
          : rawMessage;
        this.updateTask(
          taskId,
          {
            status: "failed",
            error: message,
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      } finally {
        isRunning = false;
        runAbort = null;
      }
    };

    this.activeControllers.set(taskId, {
      pause: () => {
        if (stopIntent !== "none") return;
        stopIntent = "pause";
        runAbort?.abort();
        this.updateTask(
          taskId,
          {
            status: "paused",
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      },
      resume: () => {
        void (async () => {
          if (runPromise) await runPromise.catch(() => undefined);
          if (stopIntent === "cancel") return;
          const current = this.tasks.get(taskId);
          if (!current || current.status !== "paused") return;
          stopIntent = "none";
          this.updateTask(taskId, { status: "downloading", error: undefined }, true);
          runPromise = startRun();
        })();
      },
      cancel: () => {
        stopIntent = "cancel";
        runAbort?.abort();
        if (!isRunning) {
          void cleanupAndCancel();
        }
      },
    });

    runPromise = startRun();
    return { ok: true, taskId };
  }

  attachSessionDownloads(targetSession: Session): void {
    if (this.attachedSessions.has(targetSession)) return;
    this.attachedSessions.add(targetSession);

    targetSession.on("will-download", (_event, item, wc) => {
      const outputDir = this.getDownloadDir();
      const rawName = item.getFilename() || "download";
      const savePath = this.makeUniqueFilePathSync(outputDir, rawName);
      item.setSavePath(savePath);

      const taskId = randomUUID();
      const paneId = wc ? this.options.getPaneIdByWebContentsId?.(wc.id) : undefined;
      const totalBytes = item.getTotalBytes() > 0 ? item.getTotalBytes() : null;
      const fileName = path.basename(savePath);

      this.tasks.set(taskId, {
        id: taskId,
        paneId,
        title: fileName,
        fileName,
        qualityLabel: "网页下载",
        source: "browser",
        status: "downloading",
        progress: totalBytes ? 0 : null,
        downloadedBytes: 0,
        totalBytes,
        filePath: savePath,
        outputDir,
        createdAt: Date.now(),
      });
      this.activeControllers.set(taskId, {
        pause: () => {
          try {
            item.pause();
            this.updateTask(taskId, { status: "paused", speedText: undefined, etaText: undefined }, true);
          } catch {
          }
        },
        resume: () => {
          try {
            if (typeof item.canResume !== "function" || item.canResume()) {
              item.resume();
              this.updateTask(taskId, { status: "downloading" }, true);
            }
          } catch {
          }
        },
        cancel: () => {
          try {
            item.cancel();
          } catch {
          }
        },
      });
      this.trimHistory();
      this.emitState();

      let lastMeasureAt = Date.now();
      let lastMeasureBytes = 0;
      let speed = 0;

      item.on("updated", (_updateEvent, state) => {
        const paused = typeof (item as { isPaused?: () => boolean }).isPaused === "function" && item.isPaused();
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes() > 0 ? item.getTotalBytes() : null;
        const now = Date.now();
        const elapsed = (now - lastMeasureAt) / 1000;
        if (elapsed >= 0.4) {
          speed = (received - lastMeasureBytes) / elapsed;
          lastMeasureAt = now;
          lastMeasureBytes = received;
        }
        const etaSeconds = total && speed > 0 ? Math.max(0, (total - received) / speed) : null;
        this.updateTask(taskId, {
          status: paused ? "paused" : state === "interrupted" ? "failed" : "downloading",
          downloadedBytes: received,
          totalBytes: total,
          progress: total ? Math.min(100, (received / total) * 100) : null,
          speedText: !paused && speed > 0 ? formatSpeed(speed) : undefined,
          etaText: !paused && etaSeconds !== null ? formatEta(etaSeconds) : undefined,
        });
      });

      item.once("done", (_doneEvent, state) => {
        this.activeControllers.delete(taskId);
        this.reservedPaths.delete(savePath);
        if (state === "completed") {
          this.updateTask(
            taskId,
            {
              status: "completed",
              progress: 100,
              downloadedBytes: item.getReceivedBytes(),
              totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : item.getReceivedBytes(),
              filePath: item.getSavePath(),
              fileName: path.basename(item.getSavePath()),
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
        } else if (state === "cancelled") {
          this.updateTask(
            taskId,
            {
              status: "canceled",
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
        } else {
          this.updateTask(
            taskId,
            {
              status: "failed",
              error: "网页下载被中断",
              speedText: undefined,
              etaText: undefined,
            },
            true
          );
        }
      });
    });
  }

  pauseTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    const controller = this.activeControllers.get(taskId);
    if (!task || !controller?.pause) return false;
    if (task.status !== "downloading" && task.status !== "queued") return false;
    controller.pause();
    return true;
  }

  resumeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    const controller = this.activeControllers.get(taskId);
    if (!task || !controller?.resume) return false;
    if (task.status !== "paused") return false;
    controller.resume();
    return true;
  }

  cancelTask(taskId: string): boolean {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.cancel();
      return true;
    }
    const task = this.tasks.get(taskId);
    if (task && (task.status === "queued" || task.status === "downloading" || task.status === "paused" || task.status === "merging")) {
      this.updateTask(taskId, { status: "canceled", speedText: undefined, etaText: undefined }, true);
      return true;
    }
    return false;
  }

  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "queued" || task.status === "downloading" || task.status === "paused" || task.status === "merging") {
      this.cancelTask(taskId);
    }
    this.tasks.delete(taskId);
    this.lastBroadcastAt.delete(taskId);
    this.emitState();
    return true;
  }

  clearFinishedTasks(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
        this.tasks.delete(id);
        this.lastBroadcastAt.delete(id);
      }
    }
    this.emitState();
  }

  getTaskFilePath(taskId: string): string | undefined {
    const task = this.tasks.get(taskId);
    if (!task?.filePath) return undefined;
    return existsSync(task.filePath) ? task.filePath : undefined;
  }

  dispose(): void {
    this.installAbort?.abort();
    for (const cancelProbe of this.activeProbes.values()) cancelProbe();
    this.activeProbes.clear();
    for (const controller of this.activeControllers.values()) controller.cancel();
    this.activeControllers.clear();
  }
}

export function extractStdoutLineForTest(streamData: string): string[] {
  return streamData.split(/\r?\n/).filter(Boolean);
}

export const _internal = {
  pipeline,
  Readable,
};
