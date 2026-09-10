import { describe, expect, it } from "vitest";
import { httpLoadError, networkLoadError, samePageUrl } from "./load-errors";

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
});
