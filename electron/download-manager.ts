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
  parseYtDlpProgressLine,
  resolveYtDlpProxyUrl,
  sanitizeDownloadFileName,
  type CookieInput,
  type DownloadProbeResult,
  type DownloadQualityOption,
  type DownloadStartRequest,
  type DownloadStateSnapshot,
  type DownloadTask,
  type DownloadToolStatus,
  type RawYtDlpFormat,
  type ToolBinaryInfo,
} from "../src/shared/downloads";
import type { GlobalProxySettings } from "../src/shared/types";
import { loadDownloadSettings, saveDownloadSettings, type DownloadSettings } from "./download-settings";
import { extractZipEntry } from "./zip-extract";

type DownloadManagerOptions = {
  userDataDir: string;
  defaultDownloadDir: string;
  bundledToolsDir?: string;
  appToolsDir?: string;
  userAgent: string;
  fetchWithProxy: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  getPaneIdByWebContentsId?: (webContentsId: number) => string | undefined;
  onStateChanged: (snapshot: DownloadStateSnapshot) => void;
  spawnProcess?: typeof spawn;
};

type FrameInspection = {
  frameUrl: string;
  title: string;
  videos: Array<{
    src: string;
    area: number;
    duration: number;
  }>;
};

type ActiveController = {
  cancel: () => void;
};

const MAX_TASKS_HISTORY = 40;
const PROGRESS_THROTTLE_MS = 160;
const PROBE_TIMEOUT_MS = 25000;

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
          if (!writer.write(value)) {
            await new Promise<void>((resolve, reject) => {
              writer.once("drain", resolve);
              writer.once("error", reject);
            });
          }
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
        const rect = video.getBoundingClientRect();
        const src = video.currentSrc || video.src || '';
        return {
          src: /^https?:/i.test(src) ? src : '',
          area: Math.max(0, rect.width * rect.height),
          duration: Number.isFinite(video.duration) ? video.duration : 0,
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

    let bestVideoUrl: string | undefined;
    let bestVideoArea = -1;
    let videoFrameUrl: string | undefined;
    let bestFrameArea = -1;

    for (const item of inspections) {
      if (!item || !Array.isArray(item.videos)) continue;
      for (const video of item.videos) {
        if (video.src && isHttpUrl(video.src) && video.area >= bestVideoArea) {
          bestVideoArea = video.area;
          bestVideoUrl = video.src;
        }
        if (item.frameUrl !== pageUrl && isHttpUrl(item.frameUrl) && video.area >= bestFrameArea) {
          bestFrameArea = video.area;
          videoFrameUrl = item.frameUrl;
        }
      }
    }

    return {
      pageUrl,
      pageTitle,
      videoFrameUrl,
      directVideoUrl: bestVideoUrl,
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

    if (!tools.ytDlp.path) {
      if (inspected.directVideoUrl) {
        const suggestedName = sanitizeDownloadFileName(
          inspected.pageTitle || path.basename(new URL(inspected.directVideoUrl).pathname) || "video"
        );
        const ext = inferExtensionFromUrl(inspected.directVideoUrl, "mp4");
        return {
          ok: true,
          paneId,
          pageUrl: inspected.pageUrl,
          probeUrl: inspected.directVideoUrl,
          title: inspected.pageTitle || suggestedName,
          suggestedName,
          sourceType: "direct",
          directUrl: inspected.directVideoUrl,
          qualities: [
            {
              id: "direct",
              label: `原视频直链 (.${ext}) · 无需外部组件`,
              selector: "direct",
              ext,
              isDirect: true,
            },
          ],
          hasYtDlp: false,
          hasFfmpeg,
        };
      }
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

    const candidates = [inspected.pageUrl];
    if (inspected.videoFrameUrl && inspected.videoFrameUrl !== inspected.pageUrl) {
      candidates.push(inspected.videoFrameUrl);
    }

    let lastErrorMessage = "无法解析当前页面的视频流";
    for (const candidateUrl of candidates) {
      const result = await this.runYtDlpProbe(
        probeId,
        tools.ytDlp.path,
        candidateUrl,
        inspected.pageUrl,
        targetSession,
        proxySettings,
        hasFfmpeg
      );
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
        const title = result.title || inspected.pageTitle || "video";
        const suggestedName = sanitizeDownloadFileName(title, "video");
        return {
          ok: true,
          paneId,
          pageUrl: inspected.pageUrl,
          probeUrl: candidateUrl,
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

    if (inspected.directVideoUrl) {
      const suggestedName = sanitizeDownloadFileName(inspected.pageTitle || "video");
      const ext = inferExtensionFromUrl(inspected.directVideoUrl, "mp4");
      return {
        ok: true,
        paneId,
        pageUrl: inspected.pageUrl,
        probeUrl: inspected.directVideoUrl,
        title: inspected.pageTitle || suggestedName,
        suggestedName,
        sourceType: "direct",
        directUrl: inspected.directVideoUrl,
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

    return {
      ok: false,
      code: "failed",
      message: lastErrorMessage,
      paneId,
      pageUrl: inspected.pageUrl,
      hasYtDlp: true,
      hasFfmpeg,
    };
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
    | { ok: true; canceled?: false; title?: string; duration?: number; qualities: DownloadQualityOption[] }
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
          | { ok: true; canceled?: false; title?: string; duration?: number; qualities: DownloadQualityOption[] }
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
            formats?: RawYtDlpFormat[];
          };
          const title = typeof parsed.title === "string" ? parsed.title : undefined;
          const duration = typeof parsed.duration === "number" && Number.isFinite(parsed.duration) ? parsed.duration : undefined;
          const qualities = buildQualityOptions(Array.isArray(parsed.formats) ? parsed.formats : [], hasFfmpeg, duration);
          finish({ ok: true, title, duration, qualities });
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

  async startDownload(
    request: DownloadStartRequest,
    targetSession: Session,
    proxySettings: GlobalProxySettings
  ): Promise<{ ok: true; taskId: string } | { ok: false; message: string }> {
    if (!isHttpUrl(request.pageUrl) || !isHttpUrl(request.probeUrl)) {
      return { ok: false, message: "无效的视频网址" };
    }
    if (request.sourceType === "direct") {
      if (!isHttpUrl(request.directUrl)) return { ok: false, message: "无效的直链地址" };
      return this.startDirectDownload(request, targetSession);
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

    void this.executeYtDlpTask(
      taskId,
      tools.ytDlp.path,
      tools.ffmpeg.path,
      request,
      outputTemplate,
      reservedPath,
      targetSession,
      proxySettings
    );
    return { ok: true, taskId };
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
    const helpers = await this.prepareSessionHelpers(targetSession, request.probeUrl, proxySettings);
    const task = this.tasks.get(taskId);
    if (!task || task.status === "canceled") {
      this.reservedPaths.delete(reservedPath);
      if (helpers.cookieFile) void fs.rm(helpers.cookieFile, { force: true }).catch(() => undefined);
      return;
    }

    const args = [
      "--newline",
      "--no-colors",
      "--encoding",
      "utf-8",
      "--no-playlist",
      "--no-overwrites",
      "--progress-template",
      "download:__SSDL__|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s",
      "--progress-template",
      "postprocess:__SSPP__|%(progress.status)s",
      "--print",
      "after_move:__SSFILE__|%(filepath)s",
      "--user-agent",
      this.options.userAgent,
      "--referer",
      request.pageUrl,
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

    let canceled = false;
    let finalFilePath: string | undefined;
    let stdoutBuffer = "";
    const stderrLines: string[] = [];

    this.activeControllers.set(taskId, {
      cancel: () => {
        canceled = true;
        killProcessTree(child);
      },
    });
    this.updateTask(taskId, { status: "downloading" }, true);

    const handleStdoutLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("__SSFILE__|")) {
        const filePath = trimmed.slice("__SSFILE__|".length).trim();
        if (filePath) {
          finalFilePath = filePath;
          this.updateTask(taskId, {
            filePath,
            fileName: path.basename(filePath),
          });
        }
        return;
      }
      const parsed = parseYtDlpProgressLine(trimmed);
      if (!parsed) return;
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
        return;
      }
      if (parsed.status === "finished") {
        this.updateTask(
          taskId,
          {
            downloadedBytes: parsed.totalBytes ?? parsed.downloadedBytes,
            totalBytes: parsed.totalBytes ?? parsed.downloadedBytes,
            progress: 100,
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
        return;
      }
      this.updateTask(taskId, {
        status: "downloading",
        downloadedBytes: parsed.downloadedBytes,
        totalBytes: parsed.totalBytes,
        progress: parsed.progress,
        speedText: parsed.speedBytesPerSec ? formatSpeed(parsed.speedBytesPerSec) : undefined,
        etaText: parsed.etaSeconds !== null ? formatEta(parsed.etaSeconds) : undefined,
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleStdoutLine(line);
    });
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stderrLines.push(trimmed);
        if (stderrLines.length > 30) stderrLines.shift();
      }
    });

    child.on("error", (error) => {
      this.activeControllers.delete(taskId);
      this.reservedPaths.delete(reservedPath);
      if (helpers.cookieFile) void fs.rm(helpers.cookieFile, { force: true }).catch(() => undefined);
      this.updateTask(
        taskId,
        {
          status: canceled ? "canceled" : "failed",
          error: canceled ? undefined : `启动 yt-dlp 失败：${error.message}`,
          speedText: undefined,
          etaText: undefined,
        },
        true
      );
    });

    child.on("close", (code) => {
      if (stdoutBuffer) handleStdoutLine(stdoutBuffer);
      this.activeControllers.delete(taskId);
      this.reservedPaths.delete(reservedPath);
      if (helpers.cookieFile) void fs.rm(helpers.cookieFile, { force: true }).catch(() => undefined);

      if (canceled) {
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
        this.updateTask(
          taskId,
          {
            status: "canceled",
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
        return;
      }

      if (code === 0) {
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
            fileName: resolvedPath ? path.basename(resolvedPath) : task.fileName,
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
    const destPath = reservedDest;

    const taskId = randomUUID();
    const abort = new AbortController();
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
    this.activeControllers.set(taskId, {
      cancel: () => abort.abort(),
    });
    this.trimHistory();
    this.emitState();

    void (async () => {
      let partPath = `${destPath}.part`;
      try {
        const response = await targetSession.fetch(directUrl, {
          headers: {
            Referer: request.pageUrl,
            "User-Agent": this.options.userAgent,
          },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`服务器返回 HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type");
        if (contentType && /text\/html|application\/vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(contentType)) {
          throw new Error("当前地址是网页或流媒体列表而非视频文件，请安装 yt-dlp 后下载");
        }
        const headerExt = inferExtensionFromContentType(contentType);
        if (headerExt && headerExt !== ext) {
          const updatedStem = this.makeUniqueStemSync(outputDir, safeStem, headerExt);
          const nextDest = path.join(outputDir, `${updatedStem}.${headerExt}`);
          this.reservedPaths.delete(reservedDest);
          reservedDest = nextDest;
          partPath = `${nextDest}.part`;
        }
        const totalHeader = Number(response.headers.get("content-length") ?? "0");
        const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
        this.updateTask(taskId, { totalBytes, fileName: path.basename(reservedDest) }, true);

        let downloaded = 0;
        let lastMeasureAt = Date.now();
        let lastMeasureBytes = 0;
        let currentSpeed = 0;
        const reader = response.body.getReader();
        const writer = createWriteStream(partPath);
        try {
          while (true) {
            if (abort.signal.aborted) throw new Error("Aborted");
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            downloaded += value.byteLength;
            if (!writer.write(value)) {
              await new Promise<void>((resolve, reject) => {
                writer.once("drain", resolve);
                writer.once("error", reject);
              });
            }
            const now = Date.now();
            const elapsed = (now - lastMeasureAt) / 1000;
            if (elapsed >= 0.4) {
              currentSpeed = (downloaded - lastMeasureBytes) / elapsed;
              lastMeasureAt = now;
              lastMeasureBytes = downloaded;
            }
            const etaSeconds =
              totalBytes && currentSpeed > 0 ? Math.max(0, (totalBytes - downloaded) / currentSpeed) : null;
            this.updateTask(taskId, {
              downloadedBytes: downloaded,
              totalBytes,
              progress: totalBytes ? Math.min(100, (downloaded / totalBytes) * 100) : null,
              speedText: currentSpeed > 0 ? formatSpeed(currentSpeed) : undefined,
              etaText: etaSeconds !== null ? formatEta(etaSeconds) : undefined,
            });
          }
          await new Promise<void>((resolve, reject) => {
            writer.end(() => resolve());
            writer.once("error", reject);
          });
        } catch (err) {
          writer.destroy();
          throw err;
        }
        await fs.rename(partPath, reservedDest);
        this.reservedPaths.delete(reservedDest);
        this.updateTask(
          taskId,
          {
            status: "completed",
            progress: 100,
            downloadedBytes: downloaded,
            totalBytes: totalBytes ?? downloaded,
            filePath: reservedDest,
            fileName: path.basename(reservedDest),
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      } catch (error) {
        await fs.rm(partPath, { force: true }).catch(() => undefined);
        this.reservedPaths.delete(reservedDest);
        const canceled = abort.signal.aborted;
        this.updateTask(
          taskId,
          {
            status: canceled ? "canceled" : "failed",
            error: canceled ? undefined : error instanceof Error ? error.message : "下载失败",
            speedText: undefined,
            etaText: undefined,
          },
          true
        );
      } finally {
        this.activeControllers.delete(taskId);
      }
    })();

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
          status: state === "interrupted" ? "failed" : "downloading",
          downloadedBytes: received,
          totalBytes: total,
          progress: total ? Math.min(100, (received / total) * 100) : null,
          speedText: speed > 0 ? formatSpeed(speed) : undefined,
          etaText: etaSeconds !== null ? formatEta(etaSeconds) : undefined,
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

  cancelTask(taskId: string): boolean {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.cancel();
      return true;
    }
    const task = this.tasks.get(taskId);
    if (task && (task.status === "queued" || task.status === "downloading" || task.status === "merging")) {
      this.updateTask(taskId, { status: "canceled", speedText: undefined, etaText: undefined }, true);
      return true;
    }
    return false;
  }

  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "queued" || task.status === "downloading" || task.status === "merging") {
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
