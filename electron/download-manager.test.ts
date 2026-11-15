import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session, WebContents } from "electron";
import { DownloadManager } from "./download-manager";
import { loadDownloadSettings, saveDownloadSettings } from "./download-settings";
import type { DownloadStateSnapshot } from "../src/shared/downloads";

function createMockSession(fetchImpl?: (url: string) => Promise<Response>): {
  session: Session;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const mockSession = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    resolveProxy: async () => "DIRECT",
    cookies: {
      get: async () => [{ domain: ".example.com", path: "/", secure: true, name: "sid", value: "ok" }],
    },
    fetch: async (url: string) => {
      if (fetchImpl) return fetchImpl(url);
      return new Response("hello video bytes", {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "17" },
      });
    },
  };
  return { session: mockSession as unknown as Session, emitter };
}

function createMockWebContents(pageUrl: string, title = "Sample Video", directVideoUrl?: string): WebContents {
  const mockFrame = {
    isDestroyed: () => false,
    executeJavaScript: async () => ({
      frameUrl: pageUrl,
      title,
      videos: directVideoUrl ? [{ src: directVideoUrl, area: 640 * 360, duration: 90 }] : [],
    }),
  };
  return {
    getURL: () => pageUrl,
    getTitle: () => title,
    mainFrame: { framesInSubtree: [mockFrame] },
  } as unknown as WebContents;
}

describe("download settings and manager", () => {
  let rootDir: string;
  let userDataDir: string;
  let downloadsDir: string;
  let snapshots: DownloadStateSnapshot[];

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-dl-"));
    userDataDir = path.join(rootDir, "userData");
    downloadsDir = path.join(rootDir, "downloads");
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(downloadsDir, { recursive: true });
    snapshots = [];
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("persists valid download settings and ignores corrupt/missing entries", async () => {
    const file = path.join(userDataDir, "download-settings.json");
    expect(await loadDownloadSettings(file)).toEqual({});

    const fakeBin = path.join(rootDir, "yt-dlp.exe");
    await fs.writeFile(fakeBin, "x");
    await saveDownloadSettings(file, { downloadDir: downloadsDir, ytDlpPath: fakeBin });
    expect(await loadDownloadSettings(file)).toEqual({ downloadDir: downloadsDir, ytDlpPath: fakeBin });

    await fs.writeFile(file, "{bad json");
    expect(await loadDownloadSettings(file)).toEqual({});
  });

  it("falls back to direct video download when yt-dlp is unavailable", async () => {
    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
    });
    await manager.initialize();

    const { session } = createMockSession();
    const contents = createMockWebContents("https://example.com/watch", "测试直链视频", "https://cdn.example.com/clip.mp4");
    const probe = await manager.probePane("p1", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.sourceType).toBe("direct");
    expect(probe.qualities[0].id).toBe("direct");

    const started = await manager.startDownload(
      {
        paneId: "pane-1",
        pageUrl: probe.pageUrl,
        probeUrl: probe.probeUrl,
        sourceType: "direct",
        directUrl: probe.directUrl,
        fileName: probe.suggestedName,
        qualityId: probe.qualities[0].id,
        selector: probe.qualities[0].selector,
        qualityLabel: probe.qualities[0].label,
        ext: "mp4",
      },
      session,
      { mode: "direct", custom: { host: "", port: 8080, bypassList: "", bypassLocal: true } }
    );
    expect(started.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const latest = manager.getSnapshot();
    expect(latest.tasks[0]?.status).toBe("completed");
    expect(latest.tasks[0]?.filePath).toBe(path.join(downloadsDir, "测试直链视频.mp4"));
    expect(await fs.readFile(latest.tasks[0]!.filePath!, "utf8")).toBe("hello video bytes");
    manager.dispose();
  });

  it("probes qualities, tracks progress, completes, and avoids overwrite using yt-dlp binary", async () => {
    const mockScript = path.join(rootDir, "mock-ytdlp.js");
    await fs.writeFile(
      mockScript,
      `
      const fs = require("node:fs");
      const path = require("node:path");
      const args = process.argv.slice(2);
      if (args.includes("--dump-single-json")) {
        console.log(JSON.stringify({
          title: "演示视频: HD",
          duration: 60,
          formats: [
            { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, filesize: 5000000 },
            { format_id: "137", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, filesize: 20000000 },
            { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a", filesize: 2000000 }
          ]
        }));
        process.exit(0);
      }
      const outIdx = args.indexOf("-o");
      const template = args[outIdx + 1];
      const finalPath = template.replace("%(ext)s", "mp4");
      console.log("__SSDL__|downloading|500|1000|1000|250|2| 50.0%");
      setTimeout(() => {
        console.log("__SSDL__|finished|1000|1000|1000|0|0|100.0%");
        console.log("__SSPP__|started");
        fs.writeFileSync(finalPath, "merged-video");
        console.log("__SSFILE__|" + finalPath);
        process.exit(0);
      }, 60);
      `,
      "utf8"
    );

    const fakeExePath = path.join(rootDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    await fs.writeFile(fakeExePath, "mock", "utf8");

    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((_cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, [mockScript, ...args], opts)) as typeof spawn,
    });
    await manager.initialize();
    await manager.setCustomToolPath("yt-dlp", fakeExePath);

    const { session } = createMockSession();
    const contents = createMockWebContents("https://www.youtube.com/watch?v=123", "Fallback");

    const probe = await manager.probePane("p1", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.sourceType).toBe("yt-dlp");
    expect(probe.suggestedName).toBe("演示视频_ HD");
    expect(probe.qualities.some((q) => q.height === 1080)).toBe(true);

    // Pre-create collision file to verify auto-increment "(1)"
    await fs.writeFile(path.join(downloadsDir, "演示视频_ HD.mp4"), "existing");

    const started = await manager.startDownload(
      {
        paneId: "pane-1",
        pageUrl: probe.pageUrl,
        probeUrl: probe.probeUrl,
        sourceType: "yt-dlp",
        fileName: probe.suggestedName,
        qualityId: "best",
        selector: probe.qualities[0].selector,
        qualityLabel: probe.qualities[0].label,
        ext: "mp4",
      },
      session,
      { mode: "direct", custom: { host: "", port: 8080, bypassList: "", bypassLocal: true } }
    );
    expect(started.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const finalSnap = manager.getSnapshot();
    const task = finalSnap.tasks[0];
    expect(task?.status).toBe("completed");
    expect(task?.fileName).toBe("演示视频_ HD (1).mp4");
    expect(await fs.readFile(task!.filePath!, "utf8")).toBe("merged-video");
    expect(snapshots.some((snap) => snap.tasks[0]?.status === "merging")).toBe(true);
    manager.dispose();
  });

  it("handles browser will-download events cleanly", async () => {
    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      getPaneIdByWebContentsId: () => "pane-2",
      onStateChanged: (snap) => snapshots.push(snap),
    });
    await manager.initialize();

    const { session, emitter } = createMockSession();
    manager.attachSessionDownloads(session);

    const item = new EventEmitter() as EventEmitter & {
      getFilename: () => string;
      getURL: () => string;
      getTotalBytes: () => number;
      getReceivedBytes: () => number;
      setSavePath: (p: string) => void;
      getSavePath: () => string;
      cancel: () => void;
    };
    let savedPath = "";
    let received = 0;
    item.getFilename = () => "sample-file.zip";
    item.getURL = () => "https://example.com/sample-file.zip";
    item.getTotalBytes = () => 1000;
    item.getReceivedBytes = () => received;
    item.setSavePath = (p) => { savedPath = p; };
    item.getSavePath = () => savedPath;
    item.cancel = () => undefined;

    emitter.emit("will-download", {}, item, { id: 99 });
    expect(savedPath).toBe(path.join(downloadsDir, "sample-file.zip"));

    received = 500;
    item.emit("updated", {}, "progressing");
    expect(manager.getSnapshot().tasks[0]?.progress).toBe(50);

    received = 1000;
    item.emit("done", {}, "completed");
    const completed = manager.getSnapshot().tasks[0];
    expect(completed?.status).toBe("completed");
    expect(completed?.paneId).toBe("pane-2");
    manager.dispose();
  });
});
