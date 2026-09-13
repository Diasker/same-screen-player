import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { AdblockSubscriptions, readSnapshot, snapshotChecksum, SNAPSHOT_VERSION, type RuleSnapshot } from "./adblock-subscriptions";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "adblock-rules-test-"));
  directories.push(dir);
  const lists = [{ url: "https://lists.example/ads.txt", text: "! Test subscription\n".repeat(8) + "||ads.example^" }];
  const resources = { url: "https://lists.example/resources.json", text: JSON.stringify({ resources: [], scriptlets: [] }) + " ".repeat(100) };
  const snapshot: RuleSnapshot = { version: 1, engineVersion: SNAPSHOT_VERSION, updatedAt: "2026-01-01T00:00:00.000Z", lists, resources, checksum: snapshotChecksum({ lists, resources }) };
  const bundledPath = path.join(dir, "bundled.gz");
  const cachePath = path.join(dir, "cache.gz");
  await writeFile(bundledPath, gzipSync(JSON.stringify(snapshot)));
  return { bundledPath, cachePath, snapshot };
}

describe("subscription lifecycle", () => {
  it("starts offline without attempting any network request", async () => {
    const files = await fixture();
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const store = new AdblockSubscriptions({ ...files, fetch });
    await store.initialize();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.status.source).toBe("bundled");
    expect(store.engine?.match("https://ads.example/ad", "https://site.example/", "script").match).toBe(true);
    const before = store.engine;
    await store.update(Date.parse("2026-01-03"));
    expect(store.engine).toBe(before);
    expect(store.status.state).toBe("degraded");
  });
  it("falls back from corrupt and incompatible cached snapshots", async () => {
    const files = await fixture();
    for (const buffer of [Buffer.from("corrupt"), gzipSync(JSON.stringify({ ...files.snapshot, engineVersion: "old" }))]) {
      await writeFile(files.cachePath, buffer);
      const store = new AdblockSubscriptions({ ...files, fetch: vi.fn() });
      await store.initialize();
      expect(store.status).toMatchObject({ source: "bundled", state: "ready" });
    }
  });
  it("swaps a complete valid update and reuses it after restarting", async () => {
    const files = await fixture();
    const fetch = vi.fn(async (url: string) => ({ ok: true, text: async () => url.endsWith(".json") ? files.snapshot.resources.text : files.snapshot.lists[0].text + "\n||new-ad.example^" }));
    const store = new AdblockSubscriptions({ ...files, fetch });
    await store.initialize();
    const before = store.engine;
    await store.update(Date.parse("2026-01-03"));
    expect(store.engine).not.toBe(before);
    expect(store.engine?.match("https://new-ad.example/", "https://site.example/", "media").match).toBe(true);
    expect((await readSnapshot(files.cachePath)).lists[0].text).toContain("new-ad");
    const next = new AdblockSubscriptions({ ...files, fetch });
    await next.initialize();
    expect(next.status.source).toBe("cache");
    fetch.mockClear();
    await next.update(Date.parse("2026-01-03T01:00:00Z"));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects HTML error pages without replacing working rules", async () => {
    const files = await fixture();
    const store = new AdblockSubscriptions({ ...files, fetch: async () => ({ ok: true, text: async () => "<html>" + "error".repeat(100) }) });
    await store.initialize();
    const before = store.engine;
    await store.update(Date.parse("2026-01-03"));
    expect(store.engine).toBe(before);
    expect(store.status.state).toBe("degraded");
  });
  it("retains working rules when an update needs unavailable playback scriptlets", async () => {
    const files = await fixture();
    const store = new AdblockSubscriptions({ ...files, fetch: async (url: string) => ({ ok: true, text: async () => url.endsWith(".json") ? files.snapshot.resources.text : files.snapshot.lists[0].text + "\nyoutube.com##+js(missing-playback-helper, player)" }) });
    await store.initialize();
    const before = store.engine;
    await store.update(Date.parse("2026-01-03"));
    expect(store.engine).toBe(before);
    expect(store.status.state).toBe("degraded");
  });
});
