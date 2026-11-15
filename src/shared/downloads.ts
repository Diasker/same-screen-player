import type { GlobalProxySettings } from "./types";

export type DownloadSourceType = "yt-dlp" | "direct" | "browser";

export type DownloadQualityOption = {
  id: string;
  label: string;
  selector: string;
  height?: number;
  ext?: string;
  filesizeApprox?: number;
  needsFfmpeg?: boolean;
  isAudioOnly?: boolean;
  isDirect?: boolean;
};

export type DownloadProbeResult =
  | {
      ok: true;
      paneId: string;
      pageUrl: string;
      probeUrl: string;
      title: string;
      suggestedName: string;
      sourceType: "yt-dlp" | "direct";
      directUrl?: string;
      duration?: number;
      qualities: DownloadQualityOption[];
      hasYtDlp: boolean;
      hasFfmpeg: boolean;
    }
  | {
      ok: false;
      code: "missing-yt-dlp" | "invalid-url" | "canceled" | "failed";
      message: string;
      paneId?: string;
      pageUrl?: string;
      hasYtDlp: boolean;
      hasFfmpeg: boolean;
    };

export type DownloadTaskStatus =
  | "queued"
  | "downloading"
  | "merging"
  | "completed"
  | "failed"
  | "canceled";

export type DownloadTask = {
  id: string;
  paneId?: string;
  title: string;
  fileName: string;
  qualityLabel: string;
  source: DownloadSourceType;
  status: DownloadTaskStatus;
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  speedText?: string;
  etaText?: string;
  filePath?: string;
  outputDir: string;
  error?: string;
  createdAt: number;
};

export type ToolBinaryInfo = {
  available: boolean;
  path?: string;
  source?: "custom" | "bundled" | "local" | "path";
};

export type DownloadToolStatus = {
  ytDlp: ToolBinaryInfo;
  ffmpeg: ToolBinaryInfo;
  installing: boolean;
  installStage?: string;
  installProgress?: number | null;
  installError?: string;
  downloadDir: string;
};

export type DownloadStateSnapshot = {
  tools: DownloadToolStatus;
  tasks: DownloadTask[];
};

export type DownloadStartRequest = {
  paneId: string;
  pageUrl: string;
  probeUrl: string;
  sourceType: "yt-dlp" | "direct";
  directUrl?: string;
  fileName: string;
  qualityId: string;
  selector: string;
  qualityLabel: string;
  ext?: string;
  isAudioOnly?: boolean;
};

export type RawYtDlpFormat = {
  format_id?: unknown;
  ext?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  height?: unknown;
  width?: unknown;
  fps?: unknown;
  tbr?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
  format_note?: unknown;
};

export type ParsedYtDlpProgress = {
  kind: "download" | "postprocess";
  status: string;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
  progress: number | null;
};

const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizeDownloadFileName(raw: string, fallback = "video"): string {
  const safeFallback = fallback.trim() || "video";
  let cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return safeFallback;
  const stem = cleaned.split(".")[0] ?? cleaned;
  if (WINDOWS_RESERVED_NAMES.test(stem)) cleaned = `_${cleaned}`;
  if (cleaned.length > 120) {
    cleaned = cleaned.slice(0, 120).replace(/[.\s]+$/g, "");
  }
  return cleaned || safeFallback;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hasCodec(codec: unknown): boolean {
  return typeof codec === "string" && codec.trim().length > 0 && codec !== "none";
}

function heightBadge(height: number): string {
  if (height >= 4320) return `${height}p (8K)`;
  if (height >= 2160) return `${height}p (4K)`;
  if (height >= 1440) return `${height}p (2K)`;
  return `${height}p`;
}

export function buildQualityOptions(
  formats: RawYtDlpFormat[],
  hasFfmpeg: boolean,
  durationSeconds?: number
): DownloadQualityOption[] {
  const validFormats = Array.isArray(formats) ? formats : [];
  const videoFormats = validFormats.filter((item) => hasCodec(item.vcodec));
  const audioFormats = validFormats.filter((item) => !hasCodec(item.vcodec) && hasCodec(item.acodec));
  const combinedFormats = videoFormats.filter((item) => hasCodec(item.acodec));
  const separatedOnly = videoFormats.length > 0 && combinedFormats.length === 0 && audioFormats.length > 0;

  let bestAudioSize = 0;
  let bestAudioTbr = 0;
  for (const audio of audioFormats) {
    const size = positiveNumber(audio.filesize) ?? positiveNumber(audio.filesize_approx) ?? 0;
    const tbr = positiveNumber(audio.tbr) ?? 0;
    if (size > bestAudioSize) bestAudioSize = size;
    if (tbr > bestAudioTbr) bestAudioTbr = tbr;
  }

  const estimateFormatSize = (item: RawYtDlpFormat): number | undefined => {
    const explicit = positiveNumber(item.filesize) ?? positiveNumber(item.filesize_approx);
    if (explicit) return explicit;
    const tbr = positiveNumber(item.tbr);
    if (tbr && durationSeconds && durationSeconds > 0) {
      return Math.round((tbr * 1000 / 8) * durationSeconds);
    }
    return undefined;
  };

  const bestAudioEstimate = bestAudioSize || (bestAudioTbr && durationSeconds ? Math.round((bestAudioTbr * 1000 / 8) * durationSeconds) : 0);

  const byHeight = new Map<
    number,
    {
      height: number;
      hasCombined: boolean;
      bestScore: number;
      filesizeApprox?: number;
    }
  >();

  for (const item of videoFormats) {
    const height = positiveNumber(item.height);
    if (!height) continue;
    const roundedHeight = Math.round(height);
    const isCombined = hasCodec(item.acodec);
    const tbr = positiveNumber(item.tbr) ?? 0;
    const fps = positiveNumber(item.fps) ?? 30;
    const videoSize = estimateFormatSize(item);
    const approxSize = isCombined ? videoSize : videoSize ? videoSize + bestAudioEstimate : undefined;
    const score = (isCombined && !hasFfmpeg ? 1_000_000 : 0) + tbr + fps * 2;
    const current = byHeight.get(roundedHeight);
    if (!current) {
      byHeight.set(roundedHeight, {
        height: roundedHeight,
        hasCombined: isCombined,
        bestScore: score,
        filesizeApprox: approxSize,
      });
    } else {
      current.hasCombined = current.hasCombined || isCombined;
      if (score > current.bestScore) {
        current.bestScore = score;
        if (approxSize) current.filesizeApprox = approxSize;
      }
    }
  }

  const options: DownloadQualityOption[] = [
    {
      id: "best",
      label: hasFfmpeg || !separatedOnly ? "最佳画质（自动）" : "最佳画质（需 ffmpeg 合并音轨）",
      selector: hasFfmpeg
        ? "bestvideo+bestaudio/best"
        : combinedFormats.length > 0
          ? "best[vcodec!=none][acodec!=none]/best"
          : "bestvideo+bestaudio/best",
      ext: "mp4",
      needsFfmpeg: !hasFfmpeg && separatedOnly,
    },
  ];

  const heights = [...byHeight.values()].sort((a, b) => b.height - a.height).slice(0, 8);
  for (const entry of heights) {
    const needsMerge = !entry.hasCombined;
    const needsFfmpeg = !hasFfmpeg && needsMerge;
    const sizeLabel = entry.filesizeApprox ? ` · 约 ${formatBytes(entry.filesizeApprox)}` : "";
    const mergeHint = needsFfmpeg ? " · 需 ffmpeg 合并" : "";
    const selector = hasFfmpeg || needsMerge
      ? `bestvideo[height=${entry.height}]+bestaudio/best[height=${entry.height}]/bestvideo[height<=${entry.height}]+bestaudio/best[height<=${entry.height}]`
      : `best[height=${entry.height}][vcodec!=none][acodec!=none]/best[height<=${entry.height}][vcodec!=none][acodec!=none]/best[height<=${entry.height}]`;

    options.push({
      id: `h:${entry.height}`,
      label: `${heightBadge(entry.height)}${sizeLabel}${mergeHint}`,
      selector,
      height: entry.height,
      ext: "mp4",
      filesizeApprox: entry.filesizeApprox,
      needsFfmpeg,
    });
  }

  if (audioFormats.length > 0 || videoFormats.length > 0) {
    const audioSizeLabel = bestAudioEstimate > 0 ? ` · 约 ${formatBytes(bestAudioEstimate)}` : "";
    options.push({
      id: "audio",
      label: `仅音频 (${hasFfmpeg ? "MP3" : "M4A/原音频"})${audioSizeLabel}`,
      selector: "bestaudio/best",
      ext: hasFfmpeg ? "mp3" : "m4a",
      isAudioOnly: true,
      filesizeApprox: bestAudioEstimate > 0 ? bestAudioEstimate : undefined,
    });
  }

  return options;
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "NA" || trimmed === "None") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseYtDlpProgressLine(line: string): ParsedYtDlpProgress | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("__SSPP__|")) {
    const status = trimmed.slice("__SSPP__|".length).trim() || "started";
    return {
      kind: "postprocess",
      status,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSec: null,
      etaSeconds: null,
      progress: null,
    };
  }
  if (!trimmed.startsWith("__SSDL__|")) return null;
  const parts = trimmed.slice("__SSDL__|".length).split("|");
  if (parts.length < 7) return null;
  const status = parts[0].trim() || "downloading";
  const downloadedBytes = Math.max(0, parseFiniteNumber(parts[1]) ?? 0);
  const exactTotal = parseFiniteNumber(parts[2]);
  const estimatedTotal = parseFiniteNumber(parts[3]);
  const totalBytes = exactTotal ?? estimatedTotal;
  const speedBytesPerSec = parseFiniteNumber(parts[4]);
  const etaSeconds = parseFiniteNumber(parts[5]);
  const percentMatch = parts[6].match(/(\d+(?:\.\d+)?)\s*%/);
  let progress = percentMatch ? Number(percentMatch[1]) : null;
  if (progress === null && totalBytes && totalBytes > 0) {
    progress = Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100));
  }
  if (progress !== null) {
    progress = Math.min(100, Math.max(0, progress));
  }
  return {
    kind: "download",
    status,
    downloadedBytes,
    totalBytes,
    speedBytesPerSec,
    etaSeconds,
    progress,
  };
}

function matchesBypassRule(hostname: string, rule: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedRule = rule.trim().toLowerCase();
  if (!normalizedRule) return false;
  if (normalizedRule === "<local>") {
    return (
      normalizedHost === "localhost" ||
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1" ||
      normalizedHost === "[::1]" ||
      !normalizedHost.includes(".")
    );
  }
  if (normalizedRule.startsWith("*.")) {
    const suffix = normalizedRule.slice(1);
    return normalizedHost.endsWith(suffix) || normalizedHost === normalizedRule.slice(2);
  }
  if (normalizedRule.includes("*")) {
    const escaped = normalizedRule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(normalizedHost);
  }
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

export function resolveYtDlpProxyUrl(
  proxy: GlobalProxySettings,
  targetUrl: string,
  systemResolvedProxy?: string
): string | null {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (proxy.mode === "direct") return null;
  if (proxy.mode === "custom") {
    const entries = proxy.custom.bypassList
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (proxy.custom.bypassLocal) entries.push("<local>");
    if (entries.some((rule) => matchesBypassRule(hostname, rule))) return null;
    return `http://${proxy.custom.host}:${proxy.custom.port}`;
  }
  if (!systemResolvedProxy) return null;
  const directives = systemResolvedProxy
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const directive of directives) {
    if (/^DIRECT$/i.test(directive)) return null;
    const proxyMatch = directive.match(/^PROXY\s+([^\s;]+)$/i);
    if (proxyMatch) return `http://${proxyMatch[1]}`;
    const httpsMatch = directive.match(/^HTTPS\s+([^\s;]+)$/i);
    if (httpsMatch) return `https://${httpsMatch[1]}`;
    const socks5Match = directive.match(/^SOCKS5?\s+([^\s;]+)$/i);
    if (socks5Match) return `socks5://${socks5Match[1]}`;
  }
  return null;
}

export type CookieInput = {
  domain: string;
  hostOnly?: boolean;
  path: string;
  secure?: boolean;
  expirationDate?: number;
  name: string;
  value: string;
};

const SECOND_LEVEL_PUBLIC_PREFIXES = new Set(["co", "com", "net", "org", "edu", "gov", "ac", "ne", "or", "go"]);

function registrableDomainApprox(hostname: string): string {
  const lower = hostname.toLowerCase();
  const parts = lower.split(".").filter(Boolean);
  if (parts.length <= 2) return lower;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last.length === 2 && SECOND_LEVEL_PUBLIC_PREFIXES.has(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function relatedCookieDomains(hostname: string): string[] {
  const lower = hostname.toLowerCase();
  const candidates = new Set<string>([registrableDomainApprox(lower)]);
  if (lower === "youtu.be" || lower.endsWith(".youtube.com") || lower === "youtube.com") {
    candidates.add("youtube.com");
    candidates.add("google.com");
    candidates.add("googlevideo.com");
  }
  if (lower.endsWith(".bilibili.com") || lower === "bilibili.com" || lower === "b23.tv") {
    candidates.add("bilibili.com");
    candidates.add("bilivideo.com");
  }
  return [...candidates];
}

function cookieMatchesAllowedDomains(cookieDomain: string, allowedRoots: string[]): boolean {
  const normalized = cookieDomain.trim().toLowerCase().replace(/^\./, "");
  if (!normalized) return false;
  return allowedRoots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

export function buildNetscapeCookieFile(cookies: CookieInput[], targetUrl: string): string {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
  const allowedRoots = relatedCookieDomains(hostname);
  const lines = ["# Netscape HTTP Cookie File"];
  for (const cookie of cookies) {
    if (!cookie.name || /[\r\n\t]/.test(cookie.name) || /[\r\n\t]/.test(cookie.value)) continue;
    if (!cookieMatchesAllowedDomains(cookie.domain, allowedRoots)) continue;
    const domain = cookie.domain.startsWith(".") ? cookie.domain : cookie.hostOnly ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry =
      typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0
        ? Math.floor(cookie.expirationDate)
        : 0;
    lines.push([domain, includeSubdomains, path, secure, String(expiry), cookie.name, cookie.value].join("\t"));
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : "";
}
