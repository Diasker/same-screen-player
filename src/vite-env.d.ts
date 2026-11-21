/// <reference types="vite/client" />
import type { AdblockStatus, BlockedNavigation } from "./shared/adblock";
import type { DownloadProbeResult, DownloadStartRequest, DownloadStateSnapshot } from "./shared/downloads";

interface DesktopApi {
  guestPreloadUrl: string;
  getRuntimeFlags: () => Promise<{ debugOverlays: boolean }>;
  setFullscreen: (enabled: boolean) => Promise<boolean>;
  setInteractionMode: (mode: "web" | "app") => Promise<boolean>;
  onFullscreenChange: (callback: (fullscreen: boolean) => void) => void;
  onHtmlFullscreenChange: (callback: (paneId: string, fullscreen: boolean) => void) => void;
  onToggleInteractionMode: (callback: () => void) => void;
  onToggleAppFullscreen: (callback: () => void) => void;
  onEscape: (callback: () => void) => void;
  loadLayout: () => Promise<unknown>;
  saveLayout: (layout: unknown) => Promise<boolean>;
  selectLocalVideo: () => Promise<unknown>;
  loadLocalVideo: (paneId: string, url: string) => Promise<unknown>;
  clearSession: () => Promise<boolean>;
  registerPane: (paneId: string, webContentsId: number, partition: string, pageUrl?: string, proxy?: unknown) => Promise<boolean>;
  getGlobalProxy: () => Promise<unknown>;
  setGlobalProxy: (settings: unknown) => Promise<unknown>;
  setPaneProxy: (paneId: string, settings: unknown) => Promise<unknown>;
  onProxyStatus: (callback: (status: unknown) => void) => void;
  openInChrome: (url: string) => Promise<boolean>;
  openAuthWindow: (url: string, partition: string) => Promise<boolean>;
  exitWebpageFullscreen: (paneId?: string) => Promise<boolean>;
  setAdblock: (paneId: string, host: string, enabled: boolean) => Promise<boolean>;
  getAdblock: (paneId: string, host: string) => Promise<boolean>;
  getAdblockStatus: () => Promise<AdblockStatus>;
  allowBlockedNavigation: (paneId: string, id: string) => Promise<boolean>;
  onAdblockBlocked: (callback: (event: BlockedNavigation) => void) => () => void;
  onAdblockStatus: (callback: (status: AdblockStatus) => void) => () => void;
  setChallengeMode: (paneId: string, enabled: boolean) => Promise<boolean>;
  reportChallengeState: (paneId: string, state: unknown) => Promise<boolean>;
  inspectFingerprint: (paneId: string) => Promise<unknown>;
  openChromeLogin: (url: string) => Promise<unknown>;
  reportPlaybackState: (paneId: string, state: unknown) => Promise<boolean>;
  logFocusDiagnostic: (paneId: string, info: unknown) => Promise<boolean>;
  onChromeSessionError: (callback: (message: string) => void) => void;
  getDownloadState: () => Promise<DownloadStateSnapshot | null>;
  onDownloadStateChanged: (callback: (state: DownloadStateSnapshot) => void) => () => void;
  probePaneDownload: (probeId: string, paneId: string) => Promise<DownloadProbeResult>;
  cancelProbeDownload: (probeId: string) => Promise<boolean>;
  startDownload: (request: DownloadStartRequest) => Promise<{ ok: true; taskId: string } | { ok: false; message: string }>;
  pauseDownloadTask: (taskId: string) => Promise<boolean>;
  resumeDownloadTask: (taskId: string) => Promise<boolean>;
  cancelDownloadTask: (taskId: string) => Promise<boolean>;
  removeDownloadTask: (taskId: string) => Promise<boolean>;
  clearFinishedDownloads: () => Promise<boolean>;
  selectDownloadDir: () => Promise<{ ok: boolean; canceled?: boolean; downloadDir?: string; message?: string }>;
  openDownloadDir: () => Promise<boolean>;
  showDownloadedItem: (taskId: string) => Promise<boolean>;
  installDownloadTools: () => Promise<{ ok: boolean; message?: string }>;
  cancelDownloadToolsInstall: () => Promise<boolean>;
  selectDownloadTool: (tool: "yt-dlp" | "ffmpeg") => Promise<{ ok: boolean; canceled?: boolean; message?: string }>;
}

export {};

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string;
      preload?: string;
      partition?: string;
      allowpopups?: boolean;
      allowfullscreen?: boolean;
      webpreferences?: string;
    };
  }
}
