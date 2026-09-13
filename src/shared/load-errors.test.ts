import { describe, expect, it } from "vitest";
import { httpLoadError, networkLoadError, samePageUrl, playbackResolvesHttpError } from "./load-errors";
import type { PlaybackSnapshot } from "./types";

const pageUrl = "https://example.com/video";

describe("page load errors", () => {
  it.each([
    [-105, "域名"], [-102, "拒绝连接"], [-118, "超时"], [-7, "超时"],
    [-106, "断开"], [-130, "代理服务器"], [-202, "证书"],
  ])("translates network error %s", (errorCode, text) => {
    const error = networkLoadError({ isMainFrame: true, errorCode, validatedURL: pageUrl }, pageUrl);
    expect(error?.message).toContain(text);
    expect(error?.kind).toBe("network");
  });

  it("retains diagnostic details for unknown errors", () => {
    expect(networkLoadError({ isMainFrame: true, errorCode: -999, errorDescription: "ERR_UNKNOWN", validatedURL: pageUrl }, pageUrl)?.message).toContain("页面加载失败，请检查网址和网络后重试（ERR_UNKNOWN）");
  });

  it("ignores subframes, canceled loads and stale failures", () => {
    const failure = { isMainFrame: true, errorCode: -105, validatedURL: pageUrl };
    expect(networkLoadError({ ...failure, isMainFrame: false }, pageUrl)).toBeNull();
    expect(networkLoadError({ ...failure, errorCode: -3 }, pageUrl)).toBeNull();
    expect(networkLoadError(failure, "https://example.com/new")).toBeNull();
    expect(networkLoadError({ ...failure, validatedURL: undefined }, pageUrl)).toBeNull();
  });

  it.each([400, 401, 403, 404, 412, 429, 451, 500, 502, 503, 504, 599])("reports HTTP %s", (statusCode) => {
    expect(httpLoadError(pageUrl, statusCode, pageUrl)?.message).toContain(`HTTP ${statusCode}`);
  });

  it("ignores successful responses and errors belonging to previous pages", () => {
    for (const statusCode of [undefined, -1, 200, 204, 301, 304]) expect(httpLoadError(pageUrl, statusCode, pageUrl)).toBeNull();
    expect(httpLoadError(pageUrl, 500, "https://example.com/new")).toBeNull();
  });

  it("compares the document URL without confusing query changes with anchors", () => {
    expect(samePageUrl(`${pageUrl}#player`, pageUrl)).toBe(true);
    expect(samePageUrl(`${pageUrl}?id=1`, `${pageUrl}?id=2`)).toBe(false);
    expect(samePageUrl(undefined, pageUrl)).toBe(false);
  });
  it("clears a recovered Bilibili 412 only after actual playback in the same document", () => {
    const url = "https://www.bilibili.com/video/BV123";
    const playback: PlaybackSnapshot = { hasVideo: true, playing: true, readyState: 4, currentTime: 2, duration: 100, videoWidth: 640, videoHeight: 360, buffered: 10, volume: 1, muted: false, playerWidth: 640, playerHeight: 360, rate: 1 };
    const error = httpLoadError(url, 412, url)!;
    expect(playbackResolvesHttpError(error, url, playback)).toBe(true);
    for (const patch of [{ hasVideo: false }, { playing: false }, { currentTime: 0 }, { readyState: 0 }, { videoWidth: 0 }]) expect(playbackResolvesHttpError(error, url, { ...playback, ...patch })).toBe(false);
    expect(playbackResolvesHttpError(error, url + "?p=2", playback)).toBe(false);
    expect(playbackResolvesHttpError(httpLoadError(url, 404, url)!, url, playback)).toBe(false);
    expect(playbackResolvesHttpError(httpLoadError(pageUrl, 412, pageUrl)!, pageUrl, playback)).toBe(false);
    expect(playbackResolvesHttpError({ ...error, kind: "network" }, url, playback)).toBe(false);
  });
});
