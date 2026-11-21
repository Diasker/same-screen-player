import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session, WebContents } from "electron";
import { DownloadManager } from "./download-manager";
import { loadDownloadSettings, saveDownloadSettings } from "./download-settings";
import { installFingerprintForSession } from "./fingerprint";
import type { DownloadStateSnapshot } from "../src/shared/downloads";

function createMockSession(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): {
  session: Session;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  let beforeSendHandler:
    | ((details: { requestHeaders: Record<string, string> }, callback: (res: { requestHeaders: Record<string, string> }) => void) => void)
    | null = null;
  const mockSession = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    setUserAgent: () => undefined,
    webRequest: {
      onBeforeSendHeaders: (
        _filter: unknown,
        listener: (details: { requestHeaders: Record<string, string> }, callback: (res: { requestHeaders: Record<string, string> }) => void) => void
      ) => {
        beforeSendHandler = listener;
      },
    },
    resolveProxy: async () => "DIRECT",
    cookies: {
      get: async () => [{ domain: ".example.com", path: "/", secure: true, name: "sid", value: "ok" }],
    },
    fetch: async (url: string, init?: RequestInit) => {
      let effectiveInit = init;
      if (beforeSendHandler && init?.headers) {
        const inputHeaders = { ...(init.headers as Record<string, string>) };
        let transformedHeaders = inputHeaders;
        beforeSendHandler({ requestHeaders: inputHeaders }, (res) => {
          transformedHeaders = res.requestHeaders;
        });
        effectiveInit = { ...init, headers: transformedHeaders };
      }
      if (fetchImpl) return fetchImpl(url, effectiveInit);
      return new Response("hello video bytes", {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "17" },
      });
    },
  };
  return { session: mockSession as unknown as Session, emitter };
}

function createMockWebContents(pageUrl: string, title = "Sample Video", directVideoUrl?: string, id = 101): WebContents {
  const mockFrame = {
    isDestroyed: () => false,
    executeJavaScript: async () => ({
      frameUrl: pageUrl,
      title,
      videos: directVideoUrl
        ? [{ src: directVideoUrl, isBlob: false, width: 640, height: 360, area: 640 * 360, duration: 90, visible: true }]
        : [],
    }),
  };
  return {
    id,
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

    const spawnArgs: string[][] = [];
    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((_cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) => {
        spawnArgs.push([...args]);
        return spawn(process.execPath, [mockScript, ...args], opts);
      }) as typeof spawn,
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
    expect(snapshots.some((snap) => (snap.tasks[0]?.progress ?? 0) >= 50 && snap.tasks[0]?.status === "downloading")).toBe(true);
    const dlArgs = spawnArgs.find((args) => args.includes("-o"));
    expect(dlArgs).toContain("--progress");
    expect(dlArgs).toContain("--no-quiet");
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

  it("normalizes localized bilibili URLs before probing and rejects html-only generic results", async () => {
    const mockScript = path.join(rootDir, "mock-ytdlp-bili.js");
    await fs.writeFile(
      mockScript,
      `
      const args = process.argv.slice(2);
      const url = args[args.length - 1];
      if (url.includes("/zh-Hans/")) {
        console.log(JSON.stringify({ title: "Generic HTML", ext: "html" }));
        process.exit(0);
      }
      if (url === "https://www.bilibili.com/video/BV1test/?p=2") {
        console.log(JSON.stringify({
          title: "B站测试视频",
          duration: 30,
          formats: [
            { format_id: "30080", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080 },
            { format_id: "30064", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720 },
            { format_id: "30280", ext: "m4a", vcodec: "none", acodec: "mp4a" }
          ]
        }));
        process.exit(0);
      }
      console.log(JSON.stringify({ title: "Only HTML", ext: "html" }));
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
    const biliContents = createMockWebContents("https://www.bilibili.com/zh-Hans/video/BV1test/?p=2", "B站测试视频");
    const biliProbe = await manager.probePane("p-bili", "pane-1", biliContents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(biliProbe.ok).toBe(true);
    if (biliProbe.ok) {
      expect(biliProbe.probeUrl).toBe("https://www.bilibili.com/video/BV1test/?p=2");
      expect(biliProbe.qualities.some((q) => q.height === 1080)).toBe(true);
      expect(biliProbe.qualities.some((q) => q.height === 720)).toBe(true);
    }

    const htmlOnlyContents = createMockWebContents("https://example.com/page.html", "HTML Page");
    const htmlProbe = await manager.probePane("p-html", "pane-1", htmlOnlyContents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(htmlProbe.ok).toBe(false);
    manager.dispose();
  });

  it("prioritizes master playlists over sub-playlists and ad streams, injects Referer safely, and falls back on 403", async () => {
    const mockScript = path.join(rootDir, "mock-ytdlp-hls.js");
    await fs.writeFile(
      mockScript,
      `
      const args = process.argv.slice(2);
      const url = args[args.length - 1];
      if (url.endsWith("playlist.m3u8")) {
        console.log(JSON.stringify({
          title: "playlist",
          duration: 3600,
          formats: [
            { format_id: "hls-720", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 },
            { format_id: "hls-480", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 480 }
          ]
        }));
        process.exit(0);
      }
      if (url.includes("480p/video.m3u8")) {
        console.log(JSON.stringify({
          title: "video",
          duration: 3600,
          formats: [{ format_id: "hls-480", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 480 }]
        }));
        process.exit(0);
      }
      process.exit(1);
      `,
      "utf8"
    );

    const fakeExePath = path.join(rootDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    await fs.writeFile(fakeExePath, "mock", "utf8");

    const fetchCalls: Array<{ url: string; referer?: string; token?: string; rawReferrer?: string }> = [];
    const { session } = createMockSession(async (url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      fetchCalls.push({
        url,
        referer: headers?.Referer,
        token: headers?.["X-SameScreen-Header-Token"],
        rawReferrer: init?.referrer,
      });
      // First attempt uses iframe referer -> simulate CDN rejecting third-party embed referer with 403
      if (headers?.Referer === "https://video.example.com/embed/1") {
        return new Response("forbidden", { status: 403 });
      }
      // Second attempt uses pageUrl referer -> succeeds!
      if (headers?.Referer === "https://www.example.com/watch/123") {
        return new Response("recovered-direct-mp4", {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "20" },
        });
      }
      return new Response("unexpected", { status: 400 });
    });
    installFingerprintForSession(session);

    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      isAdUrl: (url) => url.includes("ad-cam.invalid"),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((_cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, [mockScript, ...args], opts)) as typeof spawn,
    });
    await manager.initialize();
    await manager.setCustomToolPath("yt-dlp", fakeExePath);

    // Observe an ad banner video (ignored), master playlist, variant playlist, fMP4 segment, and repeated live-cam ad polls
    manager.observeCompletedRequest({
      url: "https://cdn.pornfhd.com/files/Top_Banner/300x250/18983.mp4",
      webContentsId: 77,
      resourceType: "media",
      statusCode: 206,
      referrer: "https://cdn.pornfhd.com/banner.html",
    });
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/stream/playlist.m3u8",
      webContentsId: 77,
      resourceType: "xhr",
      statusCode: 200,
      referrer: "https://www.example.com/watch/123",
      frameUrl: "https://www.example.com/watch/123",
    });
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/stream/480p/video.m3u8",
      webContentsId: 77,
      resourceType: "xhr",
      statusCode: 200,
      referrer: "https://www.example.com/watch/123",
      frameUrl: "https://www.example.com/watch/123",
    });
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/stream/480p/seg_init_1.mp4",
      webContentsId: 77,
      resourceType: "xhr",
      statusCode: 200,
      responseHeaders: { "content-type": ["video/mp4"], "content-length": ["524288"] },
    });
    for (let i = 0; i < 4; i += 1) {
      manager.observeCompletedRequest({
        url: "https://ad-cam.invalid/hls/999_240p.m3u8?playlistType=standard",
        webContentsId: 77,
        resourceType: "xhr",
        statusCode: 200,
        referrer: "",
      });
    }

    const contents = {
      id: 77,
      getURL: () => "https://www.example.com/watch/123",
      getTitle: () => "Real Movie Title",
      mainFrame: {
        framesInSubtree: [
          {
            isDestroyed: () => false,
            executeJavaScript: async () => ({
              frameUrl: "https://cdn.pornfhd.com/banner.html",
              title: "Ad",
              videos: [{ src: "https://cdn.pornfhd.com/files/Top_Banner/300x250/18983.mp4", isBlob: false, width: 300, height: 250, area: 75000, duration: 8, visible: true }],
            }),
          },
          {
            isDestroyed: () => false,
            executeJavaScript: async () => ({
              frameUrl: "https://video.example.com/embed/1",
              title: "Player",
              videos: [{ src: "", isBlob: true, width: 1280, height: 720, area: 921600, duration: 1800, visible: true }],
            }),
          },
        ],
      },
    } as unknown as WebContents;

    const probe = await manager.probePane("p-hls", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.sourceType).toBe("yt-dlp");
      expect(probe.probeUrl).toBe("https://cdn.example.com/stream/playlist.m3u8");
      expect(probe.title).toBe("Real Movie Title");
      expect(probe.qualities.some((q) => q.height === 720)).toBe(true);
    }

    // Hash-only navigation preserves observed media; path change clears it
    manager.handlePaneNavigation(77, "https://www.example.com/watch/123#section");
    const stillHasProbe = await manager.probePane("p-hls-hash", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(stillHasProbe.ok).toBe(true);

    manager.handlePaneNavigation(77, "https://www.example.com/watch/456");
    const clearedProbe = await manager.probePane("p-hls-next", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(clearedProbe.ok).toBe(false);

    // Verify direct fetch injects Referer via onBeforeSendHeaders, never passes RequestInit.referrer, and retries on 403
    const started = await manager.startDownload(
      {
        paneId: "pane-1",
        pageUrl: "https://www.example.com/watch/123",
        probeUrl: "https://cdn.example.com/movie.mp4",
        refererUrl: "https://video.example.com/embed/1",
        sourceType: "direct",
        directUrl: "https://cdn.example.com/movie.mp4",
        fileName: "DirectFallback",
        qualityId: "direct",
        selector: "direct",
        qualityLabel: "原视频直链 (.mp4)",
        ext: "mp4",
      },
      session,
      { mode: "direct", custom: { host: "", port: 8080, bypassList: "", bypassLocal: true } }
    );
    expect(started.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const directTask = manager.getSnapshot().tasks[0];
    expect(directTask?.status).toBe("completed");
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].rawReferrer).toBeUndefined();
    expect(fetchCalls[0].token).toBeUndefined();
    expect(fetchCalls[0].referer).toBe("https://video.example.com/embed/1");
    expect(fetchCalls[1].referer).toBe("https://www.example.com/watch/123");
    manager.dispose();
  });

  it("downloads DASH video and audio concurrently with multi-threaded Range chunks, supports pause/resume with URL refresh, and merges via ffmpeg", async () => {
    // 5 MB video and 4.5 MB audio so both exceed the 2 MB initial chunk and split into multiple Range chunks
    const videoPayload = Buffer.alloc(5 * 1024 * 1024, 0x56); // 'V'
    const audioPayload = Buffer.alloc(4_500_000, 0x41); // 'A'
    for (let i = 0; i < videoPayload.length; i += 4096) videoPayload[i] = i & 0xff;
    for (let i = 0; i < audioPayload.length; i += 4096) audioPayload[i] = (i * 3) & 0xff;

    let tokenGen = 1;
    let expiredGen = 0;
    const requestedRanges: Array<{ kind: "video" | "audio"; range: string; gen: number }> = [];
    let maxConcurrentRequests = 0;
    let currentInFlight = 0;
    let sawVideoAndAudioOverlap = false;
    let inFlightVideo = 0;
    let inFlightAudio = 0;

    const { session } = createMockSession(async (url, init) => {
      const parsed = new URL(url);
      const gen = Number(parsed.searchParams.get("gen") ?? "1");
      const kind = parsed.pathname.includes("video") ? "video" : "audio";
      const payload = kind === "video" ? videoPayload : audioPayload;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers.Range ?? headers.range ?? "";

      if (gen <= expiredGen) {
        return new Response("expired", { status: 403 });
      }

      requestedRanges.push({ kind, range, gen });
      currentInFlight += 1;
      if (kind === "video") inFlightVideo += 1;
      else inFlightAudio += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, currentInFlight);
      if (inFlightVideo > 0 && inFlightAudio > 0) {
        sawVideoAndAudioOverlap = true;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 90);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        });

        const match = range.match(/^bytes=(\d+)-(\d*)$/);
        if (!match) {
          return new Response(payload, {
            status: 200,
            headers: { "Content-Type": "video/mp4", "Content-Length": String(payload.length) },
          });
        }
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
        const slice = payload.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${payload.length}`,
            "Content-Length": String(slice.length),
          },
        });
      } finally {
        currentInFlight -= 1;
        if (kind === "video") inFlightVideo -= 1;
        else inFlightAudio -= 1;
      }
    });
    installFingerprintForSession(session);

    const mockYtdlp = path.join(rootDir, "mock-ytdlp-dash.js");
    const mockFfmpeg = path.join(rootDir, "mock-ffmpeg.js");
    const genFile = path.join(rootDir, "gen.txt");
    await fs.writeFile(genFile, "1", "utf8");

    await fs.writeFile(
      mockYtdlp,
      `
      const fs = require("node:fs");
      const gen = fs.readFileSync(${JSON.stringify(genFile)}, "utf8").trim();
      console.log(JSON.stringify({
        title: "并发测试视频",
        duration: 120,
        http_headers: { Referer: "https://www.bilibili.com/" },
        formats: [
          {
            format_id: "30080",
            ext: "mp4",
            protocol: "https",
            url: "https://cdn.example.com/video.m4s?gen=" + gen,
            vcodec: "avc1",
            acodec: "none",
            height: 1080,
            filesize: ${videoPayload.length}
          },
          {
            format_id: "30280",
            ext: "m4a",
            protocol: "https",
            url: "https://cdn.example.com/audio.m4s?gen=" + gen,
            vcodec: "none",
            acodec: "mp4a",
            filesize: ${audioPayload.length}
          }
        ]
      }));
      `,
      "utf8"
    );

    await fs.writeFile(
      mockFfmpeg,
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      const inputs = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "-i") inputs.push(args[i + 1]);
      }
      const outPath = args[args.length - 1];
      const vBuf = fs.readFileSync(inputs[0]);
      const aBuf = fs.readFileSync(inputs[1]);
      fs.writeFileSync(outPath, Buffer.concat([vBuf, aBuf]));
      `,
      "utf8"
    );

    const fakeYtDlp = path.join(rootDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    const fakeFfmpeg = path.join(rootDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    await fs.writeFile(fakeYtDlp, "mock", "utf8");
    await fs.writeFile(fakeFfmpeg, "mock", "utf8");

    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) => {
        const script = cmd === fakeFfmpeg ? mockFfmpeg : mockYtdlp;
        return spawn(process.execPath, [script, ...args], opts);
      }) as typeof spawn,
    });
    await manager.initialize();
    await manager.setCustomToolPath("yt-dlp", fakeYtDlp);
    await manager.setCustomToolPath("ffmpeg", fakeFfmpeg);

    const contents = createMockWebContents("https://www.bilibili.com/video/BV1concurrent", "并发测试视频");
    const probe = await manager.probePane("p-conc", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const started = await manager.startDownload(
      {
        paneId: "pane-1",
        pageUrl: probe.pageUrl,
        probeUrl: probe.probeUrl,
        refererUrl: probe.refererUrl,
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
    if (!started.ok) return;

    // Wait until both streams overlap and at least one chunk has written bytes
    await expect
      .poll(
        () =>
          sawVideoAndAudioOverlap &&
          requestedRanges.length >= 4 &&
          (manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.downloadedBytes ?? 0) > 0,
        { timeout: 3000 }
      )
      .toBe(true);
    expect(maxConcurrentRequests).toBeGreaterThanOrEqual(2);

    // Pause mid-download and verify .part files remain intact
    expect(manager.pauseTask(started.taskId)).toBe(true);
    await expect
      .poll(() => manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.status, { timeout: 2000 })
      .toBe("paused");
    const pausedTask = manager.getSnapshot().tasks.find((t) => t.id === started.taskId);
    expect(pausedTask?.status).toBe("paused");
    expect(pausedTask!.downloadedBytes).toBeGreaterThan(0);

    // Simulate signed URL expiry while paused -> gen=1 returns 403, refresh fetches gen=2
    expiredGen = 1;
    tokenGen = 2;
    await fs.writeFile(genFile, String(tokenGen), "utf8");

    expect(manager.resumeTask(started.taskId)).toBe(true);
    await expect
      .poll(() => manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.status, { timeout: 5000 })
      .toBe("completed");

    const completedTask = manager.getSnapshot().tasks.find((t) => t.id === started.taskId)!;
    const mergedBytes = await fs.readFile(completedTask.filePath!);
    expect(mergedBytes.equals(Buffer.concat([videoPayload, audioPayload]))).toBe(true);
    expect(requestedRanges.some((r) => r.gen === 2)).toBe(true);
    // Ensure temp .part files are cleaned up
    const remainingFiles = await fs.readdir(downloadsDir);
    expect(remainingFiles.filter((name) => name.endsWith(".part"))).toEqual([]);
    manager.dispose();
  });

  it("supports pause and resume on yt-dlp fallback tasks and browser will-download items", async () => {
    const mockScript = path.join(rootDir, "mock-ytdlp-pause.js");
    const runCountFile = path.join(rootDir, "yt-runs.txt");
    await fs.writeFile(runCountFile, "0", "utf8");
    await fs.writeFile(
      mockScript,
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (args.includes("--dump-single-json")) {
        console.log(JSON.stringify({
          title: "HLS Pause Demo",
          duration: 60,
          formats: [{ format_id: "hls-720", ext: "mp4", protocol: "m3u8_native", vcodec: "avc1", acodec: "mp4a", height: 720 }]
        }));
        process.exit(0);
      }
      const count = Number(fs.readFileSync(${JSON.stringify(runCountFile)}, "utf8").trim()) + 1;
      fs.writeFileSync(${JSON.stringify(runCountFile)}, String(count), "utf8");
      const outIdx = args.indexOf("-o");
      const finalPath = args[outIdx + 1].replace("%(ext)s", "mp4");
      const partPath = finalPath + ".part";
      if (count === 1) {
        fs.writeFileSync(partPath, "partial-");
        console.log("__SSDL__|downloading|8|16|16|8|1| 50.0%");
        setInterval(() => {}, 1000);
      } else {
        const prev = fs.existsSync(partPath) ? fs.readFileSync(partPath, "utf8") : "";
        fs.writeFileSync(finalPath, prev + "resumed");
        try { fs.unlinkSync(partPath); } catch {}
        console.log("__SSDL__|finished|15|15|15|0|0|100.0%");
        console.log("__SSFILE__|" + finalPath);
        process.exit(0);
      }
      `,
      "utf8"
    );

    const fakeYtDlp = path.join(rootDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    await fs.writeFile(fakeYtDlp, "mock", "utf8");
    const spawnArgs: string[][] = [];

    const manager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((_cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) => {
        spawnArgs.push([...args]);
        return spawn(process.execPath, [mockScript, ...args], opts);
      }) as typeof spawn,
    });
    await manager.initialize();
    await manager.setCustomToolPath("yt-dlp", fakeYtDlp);

    const { session, emitter } = createMockSession();
    const contents = createMockWebContents("https://example.com/hls", "HLS Pause Demo");
    const probe = await manager.probePane("p-yt-pause", "pane-1", contents, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

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
    if (!started.ok) return;

    await expect
      .poll(() => manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.downloadedBytes, { timeout: 3000 })
      .toBe(8);

    expect(manager.pauseTask(started.taskId)).toBe(true);
    await expect
      .poll(() => manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.status, { timeout: 3000 })
      .toBe("paused");
    // .part file must still exist while paused
    expect(await fs.readFile(path.join(downloadsDir, "HLS Pause Demo.mp4.part"), "utf8")).toBe("partial-");

    expect(manager.resumeTask(started.taskId)).toBe(true);
    await expect
      .poll(() => manager.getSnapshot().tasks.find((t) => t.id === started.taskId)?.status, { timeout: 3000 })
      .toBe("completed");
    expect(await fs.readFile(path.join(downloadsDir, "HLS Pause Demo.mp4"), "utf8")).toBe("partial-resumed");
    const dlArgs = spawnArgs.find((args) => args.includes("-o"));
    expect(dlArgs).toContain("--continue");
    expect(dlArgs).toContain("--concurrent-fragments");

    // Browser will-download pause/resume
    manager.attachSessionDownloads(session);
    const item = new EventEmitter() as EventEmitter & {
      getFilename: () => string;
      getTotalBytes: () => number;
      getReceivedBytes: () => number;
      setSavePath: (p: string) => void;
      getSavePath: () => string;
      pause: () => void;
      resume: () => void;
      canResume: () => boolean;
      isPaused: () => boolean;
      cancel: () => void;
    };
    let savedPath = "";
    let pausedFlag = false;
    let received = 0;
    item.getFilename = () => "browser-pause.bin";
    item.getTotalBytes = () => 100;
    item.getReceivedBytes = () => received;
    item.setSavePath = (p) => { savedPath = p; };
    item.getSavePath = () => savedPath;
    item.pause = () => { pausedFlag = true; };
    item.resume = () => { pausedFlag = false; };
    item.canResume = () => true;
    item.isPaused = () => pausedFlag;
    item.cancel = () => undefined;

    emitter.emit("will-download", {}, item, { id: 88 });
    const browserTaskId = manager.getSnapshot().tasks[0].id;
    received = 40;
    item.emit("updated", {}, "progressing");
    expect(manager.pauseTask(browserTaskId)).toBe(true);
    expect(pausedFlag).toBe(true);
    expect(manager.getSnapshot().tasks[0].status).toBe("paused");
    expect(manager.resumeTask(browserTaskId)).toBe(true);
    expect(pausedFlag).toBe(false);
    expect(manager.getSnapshot().tasks[0].status).toBe("downloading");
    received = 100;
    item.emit("done", {}, "completed");
    expect(manager.getSnapshot().tasks[0].status).toBe("completed");
    manager.dispose();
  });

  it("prefers the latest switched episode playlist or live video src over stale Ep1 HTML/streams on generic pages", async () => {
    const mockScript = path.join(rootDir, "mock-ytdlp-episodes.js");
    await fs.writeFile(
      mockScript,
      `
      const args = process.argv.slice(2);
      const url = args[args.length - 1];
      if (url === "https://drama.example.com/watch/99" || url === "https://drama.example.com/watch/99#ep2") {
        // Static page HTML always defaults to Ep1
        console.log(JSON.stringify({
          title: "Static Page Ep1",
          duration: 1800,
          formats: [{ format_id: "ep1", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 }]
        }));
        process.exit(0);
      }
      if (url.includes("ep1/index.m3u8")) {
        console.log(JSON.stringify({
          title: "Stream Ep1",
          duration: 1800,
          formats: [{ format_id: "ep1-720", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 }]
        }));
        process.exit(0);
      }
      if (url.includes("ep2/index.m3u8")) {
        console.log(JSON.stringify({
          title: "Stream Ep2",
          duration: 2400,
          formats: [{ format_id: "ep2-1080", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 1080 }]
        }));
        process.exit(0);
      }
      process.exit(1);
      `,
      "utf8"
    );

    const fakeYtDlp = path.join(rootDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    await fs.writeFile(fakeYtDlp, "mock", "utf8");

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
    await manager.setCustomToolPath("yt-dlp", fakeYtDlp);

    const { session } = createMockSession();

    // Ep1 loads first, then user clicks #Ep2 quickly (< 15s) and Ep2's playlist is fetched 3 times
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/ep1/index.m3u8",
      webContentsId: 501,
      resourceType: "xhr",
      statusCode: 200,
      referrer: "https://drama.example.com/watch/99",
      frameUrl: "https://drama.example.com/watch/99",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (let i = 0; i < 3; i += 1) {
      manager.observeCompletedRequest({
        url: "https://cdn.example.com/ep2/index.m3u8",
        webContentsId: 501,
        resourceType: "xhr",
        statusCode: 200,
        referrer: "https://drama.example.com/watch/99",
        frameUrl: "https://drama.example.com/watch/99",
      });
    }

    const contentsEp2 = createMockWebContents("https://drama.example.com/watch/99#ep2", "剧集 Demo - Ep2", undefined, 501);
    const probeEp2 = await manager.probePane("p-ep2", "pane-1", contentsEp2, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probeEp2.ok).toBe(true);
    if (probeEp2.ok) {
      expect(probeEp2.probeUrl).toBe("https://cdn.example.com/ep2/index.m3u8");
      expect(probeEp2.duration).toBe(2400);
      expect(probeEp2.qualities.some((q) => q.height === 1080)).toBe(true);
    }

    // Switching from HLS Ep1 to direct MP4 Ep2 inside live <video> should resolve direct MP4 Ep2
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/ep2.mp4",
      webContentsId: 501,
      resourceType: "media",
      statusCode: 206,
      referrer: "https://drama.example.com/watch/99",
      frameUrl: "https://drama.example.com/watch/99",
      responseHeaders: { "content-type": ["video/mp4"], "content-range": ["bytes 0-1023/10485760"] },
    });
    const contentsDirectEp2 = createMockWebContents(
      "https://drama.example.com/watch/99#ep2",
      "剧集 Demo - Ep2",
      "https://cdn.example.com/ep2.mp4",
      501
    );
    const probeDirectEp2 = await manager.probePane("p-ep2-direct", "pane-1", contentsDirectEp2, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probeDirectEp2.ok).toBe(true);
    if (probeDirectEp2.ok) {
      expect(probeDirectEp2.sourceType).toBe("direct");
      expect(probeDirectEp2.directUrl).toBe("https://cdn.example.com/ep2.mp4");
    }

    // Switching an embedded player iframe from Ep1 to Ep2 should ignore Ep1's stale iframe playlist
    // and probe Ep2's live iframe/playlist before the static parent pageUrl
    manager.observeCompletedRequest({
      url: "https://cdn.example.com/ep1/master.m3u8",
      webContentsId: 502,
      resourceType: "xhr",
      statusCode: 200,
      referrer: "https://video.example.com/embed/ep1",
      frameUrl: "https://video.example.com/embed/ep1",
    });
    const iframeContentsEp2 = {
      id: 502,
      getURL: () => "https://drama.example.com/watch/99",
      getTitle: () => "Iframe Ep2",
      mainFrame: {
        framesInSubtree: [
          {
            isDestroyed: () => false,
            executeJavaScript: async () => ({
              frameUrl: "https://drama.example.com/watch/99",
              title: "Iframe Ep2",
              videos: [],
            }),
          },
          {
            isDestroyed: () => false,
            executeJavaScript: async () => ({
              frameUrl: "https://video.example.com/embed/ep2",
              title: "Player",
              videos: [{ src: "", isBlob: true, width: 1280, height: 720, area: 921600, duration: 2400, visible: true, playing: true }],
            }),
          },
        ],
      },
    } as unknown as WebContents;

    // Even before Ep2's playlist is observed, live videoFrameUrl (embed/ep2) must be probed before static pageUrl!
    const mockIframeProbeScript = path.join(rootDir, "mock-ytdlp-iframe-ep.js");
    await fs.writeFile(
      mockIframeProbeScript,
      `
      const args = process.argv.slice(2);
      const url = args[args.length - 1];
      if (url === "https://drama.example.com/watch/99") {
        console.log(JSON.stringify({ title: "Static Ep1", duration: 1800, formats: [{ format_id: "ep1", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 }] }));
        process.exit(0);
      }
      if (url === "https://video.example.com/embed/ep2") {
        console.log(JSON.stringify({ title: "Iframe Ep2", duration: 2400, formats: [{ format_id: "ep2", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 1080 }] }));
        process.exit(0);
      }
      if (url.includes("ep1/master.m3u8")) {
        console.log(JSON.stringify({ title: "Stale Ep1 Stream", duration: 1800, formats: [{ format_id: "ep1-m", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720 }] }));
        process.exit(0);
      }
      process.exit(1);
      `,
      "utf8"
    );

    const iframeManager = new DownloadManager({
      userDataDir,
      defaultDownloadDir: downloadsDir,
      userAgent: "TestAgent",
      fetchWithProxy: async () => new Response("", { status: 404 }),
      onStateChanged: (snap) => snapshots.push(snap),
      spawnProcess: ((_cmd: string, args: readonly string[], opts: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, [mockIframeProbeScript, ...args], opts)) as typeof spawn,
    });
    await iframeManager.initialize();
    await iframeManager.setCustomToolPath("yt-dlp", fakeYtDlp);
    iframeManager.observeCompletedRequest({
      url: "https://cdn.example.com/ep1/master.m3u8",
      webContentsId: 502,
      resourceType: "xhr",
      statusCode: 200,
      referrer: "https://video.example.com/embed/ep1",
      frameUrl: "https://video.example.com/embed/ep1",
    });
    const probeIframeEp2 = await iframeManager.probePane("p-iframe-ep2", "pane-1", iframeContentsEp2, session, {
      mode: "direct",
      custom: { host: "", port: 8080, bypassList: "", bypassLocal: true },
    });
    expect(probeIframeEp2.ok).toBe(true);
    if (probeIframeEp2.ok) {
      expect(probeIframeEp2.probeUrl).toBe("https://video.example.com/embed/ep2");
      expect(probeIframeEp2.duration).toBe(2400);
    }
    iframeManager.dispose();

    manager.dispose();
  });
});
