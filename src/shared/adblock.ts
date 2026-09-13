export type AdblockStatus = {
  state: "ready" | "degraded" | "unavailable";
  source: "bundled" | "cache" | "network";
  updatedAt: string | null;
  message?: string;
};

export type BlockedNavigation = {
  id: string;
  paneId: string;
  host: string;
  kind: "popup" | "navigation";
  reason: "rule" | "playback" | "unexpected";
  canAllow: boolean;
};
