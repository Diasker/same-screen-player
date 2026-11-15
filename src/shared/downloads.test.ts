import { describe, expect, it } from "vitest";
import {
  buildNetscapeCookieFile,
  buildQualityOptions,
  formatBytes,
  formatEta,
  formatSpeed,
  parseYtDlpProgressLine,
  resolveYtDlpProxyUrl,
  sanitizeDownloadFileName,
} from "./downloads";

describe("download helpers", () => {
  it("sanitizes filenames safely for Windows and preserves CJK characters", () => {
    expect(sanitizeDownloadFileName('测试:视频 <4K>? "Part 1"/demo')).toBe("测试_视频 _4K__ _Part 1__demo");
    expect(sanitizeDownloadFileName("CON")).toBe("_CON");
    expect(sanitizeDownloadFileName("nul.txt")).toBe("_nul.txt");
    expect(sanitizeDownloadFileName("  ...   ")).toBe("video");
    expect(sanitizeDownloadFileName("a".repeat(200)).length).toBeLessThanOrEqual(120);
  });

  it("formats bytes, speed, and ETA concisely", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
    expect(formatSpeed(2 * 1024 * 1024)).toBe("2.0 MB/s");
    expect(formatEta(75)).toBe("01:15");
    expect(formatEta(3665)).toBe("1:01:05");
  });

  it("builds deduplicated quality options for DASH formats with and without ffmpeg", () => {
    const formats = [
      { format_id: "18", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 360, filesize: 10 * 1024 * 1024 },
      { format_id: "136", ext: "mp4", vcodec: "avc1", acodec: "none", height: 720, tbr: 1500 },
      { format_id: "137", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1080, filesize: 80 * 1024 * 1024 },
      { format_id: "313", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160, filesize: 200 * 1024 * 1024 },
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a", filesize: 5 * 1024 * 1024 },
    ];

    const withFfmpeg = buildQualityOptions(formats, true, 120);
    expect(withFfmpeg.map((item) => item.id)).toEqual(["best", "h:2160", "h:1080", "h:720", "h:360", "audio"]);
    expect(withFfmpeg[0].needsFfmpeg).toBe(false);
    expect(withFfmpeg[1].label).toContain("2160p (4K)");
    expect(withFfmpeg[1].label).toContain("205 MB");
    expect(withFfmpeg[5].ext).toBe("mp3");

    const withoutFfmpeg = buildQualityOptions(formats, false, 120);
    expect(withoutFfmpeg.find((item) => item.id === "h:1080")?.needsFfmpeg).toBe(true);
    expect(withoutFfmpeg.find((item) => item.id === "h:360")?.needsFfmpeg).toBe(false);
    expect(withoutFfmpeg.find((item) => item.id === "best")?.selector).toBe("best[vcodec!=none][acodec!=none]/best");
  });

  it("parses structured yt-dlp progress and postprocess lines", () => {
    const dl = parseYtDlpProgressLine("__SSDL__|downloading|5242880|10485760|NA|1048576|5| 50.0%");
    expect(dl).toEqual({
      kind: "download",
      status: "downloading",
      downloadedBytes: 5242880,
      totalBytes: 10485760,
      speedBytesPerSec: 1048576,
      etaSeconds: 5,
      progress: 50,
    });

    const pp = parseYtDlpProgressLine("__SSPP__|started");
    expect(pp?.kind).toBe("postprocess");
    expect(pp?.status).toBe("started");

    expect(parseYtDlpProgressLine("[youtube] Extracting URL")).toBeNull();
  });

  it("resolves yt-dlp proxy arguments across direct, custom, bypass rules, and system PAC", () => {
    const custom = { host: "127.0.0.1", port: 7890, bypassList: "localhost;*.internal.local", bypassLocal: true };
    expect(resolveYtDlpProxyUrl({ mode: "direct", custom }, "https://www.youtube.com/watch?v=1")).toBeNull();
    expect(resolveYtDlpProxyUrl({ mode: "custom", custom }, "https://www.youtube.com/watch?v=1")).toBe("http://127.0.0.1:7890");
    expect(resolveYtDlpProxyUrl({ mode: "custom", custom }, "http://api.internal.local/v.mp4")).toBeNull();
    expect(resolveYtDlpProxyUrl({ mode: "custom", custom }, "http://127.0.0.1:8080/v.mp4")).toBeNull();
    expect(resolveYtDlpProxyUrl({ mode: "system", custom }, "https://www.youtube.com/watch?v=1", "PROXY 127.0.0.1:7890; DIRECT")).toBe("http://127.0.0.1:7890");
    expect(resolveYtDlpProxyUrl({ mode: "system", custom }, "https://www.youtube.com/watch?v=1", "SOCKS5 127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(resolveYtDlpProxyUrl({ mode: "system", custom }, "https://www.youtube.com/watch?v=1", "DIRECT")).toBeNull();
  });

  it("exports only target-domain and companion-domain Netscape cookies safely", () => {
    const content = buildNetscapeCookieFile(
      [
        { domain: ".youtube.com", path: "/", secure: true, expirationDate: 1900000000, name: "VISITOR", value: "abc" },
        { domain: ".google.com", path: "/", secure: true, expirationDate: 1900000000, name: "SID", value: "xyz" },
        { domain: ".bank.co.uk", path: "/", secure: true, expirationDate: 1900000000, name: "SECRET", value: "123" },
        { domain: ".youtube.com", path: "/", secure: false, name: "BAD\nNAME", value: "skip" },
      ],
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(content).toContain("# Netscape HTTP Cookie File");
    expect(content).toContain("VISITOR\tabc");
    expect(content).toContain("SID\txyz");
    expect(content).not.toContain("SECRET");
    expect(content).not.toContain("BAD");

    const ukContent = buildNetscapeCookieFile(
      [
        { domain: ".bank.co.uk", path: "/", name: "BANK", value: "secret" },
        { domain: ".video.co.uk", path: "/", name: "PLAY", value: "ok" },
      ],
      "https://www.video.co.uk/watch/1"
    );
    expect(ukContent).toContain("PLAY\tok");
    expect(ukContent).not.toContain("BANK");
  });
});
