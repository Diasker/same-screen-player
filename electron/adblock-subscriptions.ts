import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { AdblockEngine } from "./adblock-engine";
import type { AdblockStatus } from "../src/shared/adblock";

export type Subscription = { url: string; text: string };
export type RuleSnapshot = { version: 1; engineVersion: "ghostery-2.18.2/abp-0.11.1/v1"; updatedAt: string; lists: Subscription[]; resources: Subscription; checksum: string };
export const SNAPSHOT_VERSION = "ghostery-2.18.2/abp-0.11.1/v1";
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
export const CHINA_LIST = "https://easylist-downloads.adblockplus.org/easylistchina.txt";
export const RESOURCE_URL = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json";

export function snapshotChecksum(snapshot: Pick<RuleSnapshot, "lists" | "resources">): string {
  return createHash("sha256").update(JSON.stringify([snapshot.lists, snapshot.resources])).digest("hex");
}

export function validateSnapshot(value: unknown): RuleSnapshot {
  const snapshot = value as RuleSnapshot;
  if (!snapshot || snapshot.version !== 1 || snapshot.engineVersion !== SNAPSHOT_VERSION || !Number.isFinite(Date.parse(snapshot.updatedAt)) || !Array.isArray(snapshot.lists) || snapshot.lists.length === 0) throw new Error("规则快照版本无效");
  for (const list of [...snapshot.lists, snapshot.resources]) {
    if (!list || typeof list.url !== "string" || !list.url.startsWith("https://") || typeof list.text !== "string" || list.text.length === 0) throw new Error("规则快照内容不完整");
  }
  if (snapshot.checksum !== snapshotChecksum(snapshot)) throw new Error("规则快照校验失败");
  JSON.parse(snapshot.resources.text);
  return snapshot;
}

export async function readSnapshot(file: string): Promise<RuleSnapshot> {
  return validateSnapshot(JSON.parse(gunzipSync(await fs.readFile(file), { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8")));
}

export class AdblockSubscriptions {
  engine: AdblockEngine | null = null;
  status: AdblockStatus = { state: "unavailable", source: "bundled", updatedAt: null };
  private snapshot: RuleSnapshot | null = null;
  private updating = false;

  constructor(private readonly options: {
    bundledPath: string;
    cachePath: string;
    fetch: (url: string, options: { signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;
    changed?: (status: AdblockStatus) => void;
  }) {}

  async initialize(): Promise<void> {
    // Always read the bundled source manifest: a cache cannot replace subscriptions.
    let bundled: RuleSnapshot;
    try { bundled = await readSnapshot(this.options.bundledPath); }
    catch { this.status.message = "内置规则无法加载，请重新安装应用"; this.options.changed?.(this.status); return; }
    let snapshot = bundled;
    let source: AdblockStatus["source"] = "bundled";
    try {
      const cached = await readSnapshot(this.options.cachePath);
      if (JSON.stringify(cached.lists.map(list => list.url)) === JSON.stringify(bundled.lists.map(list => list.url)) && cached.resources.url === bundled.resources.url && Date.parse(cached.updatedAt) >= Date.parse(bundled.updatedAt)) {
        // Compile before choosing a cached snapshot; unusable script resources fall back.
        this.engine = new AdblockEngine(cached.lists.map(list => list.text), cached.resources.text);
        snapshot = cached;
        source = "cache";
      }
    } catch { /* Missing, corrupt, or incompatible caches use the shipped rules. */ }
    try {
      this.engine ??= new AdblockEngine(snapshot.lists.map(list => list.text), snapshot.resources.text);
      this.snapshot = snapshot;
      this.status = { state: "ready", source, updatedAt: snapshot.updatedAt };
    } catch {
      this.status = { state: "unavailable", source, updatedAt: null, message: "广告过滤规则无法解析" };
    }
    this.options.changed?.(this.status);
  }

  async update(now = Date.now()): Promise<void> {
    if (this.updating || !this.snapshot || now - Date.parse(this.snapshot.updatedAt) < UPDATE_INTERVAL) return;
    this.updating = true;
    try {
      const download = async ({ url }: Subscription, resource = false): Promise<Subscription> => {
        const response = await this.options.fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("规则服务器请求失败");
        const text = await response.text();
        if (text.length < 100 || text.length > 20 * 1024 * 1024 || /^\s*</.test(text)) throw new Error("规则服务器返回了无效内容");
        if (resource) JSON.parse(text);
        return { url, text };
      };
      const [lists, resources] = await Promise.all([
        Promise.all(this.snapshot.lists.map(list => download(list))),
        download(this.snapshot.resources, true),
      ]);
      const snapshot: RuleSnapshot = { version: 1, engineVersion: SNAPSHOT_VERSION, updatedAt: new Date(now).toISOString(), lists, resources, checksum: snapshotChecksum({ lists, resources }) };
      const engine = new AdblockEngine(lists.map(list => list.text), resources.text);
      const temporary = `${this.options.cachePath}.tmp`;
      await fs.mkdir(path.dirname(temporary), { recursive: true });
      await fs.writeFile(temporary, gzipSync(JSON.stringify(snapshot)));
      await fs.rename(temporary, this.options.cachePath);
      this.snapshot = snapshot;
      this.engine = engine;
      this.status = { state: "ready", source: "network", updatedAt: snapshot.updatedAt };
    } catch {
      this.status = { ...this.status, state: "degraded", message: "规则更新失败，继续使用已有规则" };
    } finally {
      this.updating = false;
      this.options.changed?.(this.status);
    }
  }
}
