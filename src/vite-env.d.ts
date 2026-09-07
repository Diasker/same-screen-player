/// <reference types="vite/client" />

interface DesktopApi {
  guestPreloadUrl: string;
  setFullscreen: (enabled: boolean) => Promise<boolean>;
  setInteractionMode: (mode: "web" | "app") => Promise<boolean>;
  onFullscreenChange: (callback: (fullscreen: boolean) => void) => void;
  onHtmlFullscreenChange: (callback: (paneId: string, fullscreen: boolean) => void) => void;
  onToggleInteractionMode: (callback: () => void) => void;
  onToggleAppFullscreen: (callback: () => void) => void;
  onEscape: (callback: () => void) => void;
  onPaneBlocked: (callback: (paneId: string, statusCode: number, challenge: boolean) => void) => void;
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
  setChallengeMode: (paneId: string, enabled: boolean) => Promise<boolean>;
  reloadChallenge: (paneId: string) => Promise<boolean>;
  reportChallengeState: (paneId: string, state: unknown) => Promise<boolean>;
  inspectFingerprint: (paneId: string) => Promise<unknown>;
  openChromeLogin: (url: string) => Promise<unknown>;
  reportPlaybackState: (paneId: string, state: unknown) => Promise<boolean>;
  logFocusDiagnostic: (paneId: string, info: unknown) => Promise<boolean>;
  onChromeSessionError: (callback: (message: string) => void) => void;
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
