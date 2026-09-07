import { describe, expect, it } from "vitest";
import { isSupportedLocalVideoFile, normalizeNetworkUrl } from "./types";

describe("local video helpers", () => {
  it("accepts supported local video extensions only for files", () => {
    expect(isSupportedLocalVideoFile("movie.MP4")).toBe(true);
    expect(isSupportedLocalVideoFile("clip.webm")).toBe(true);
    expect(isSupportedLocalVideoFile("archive.mov")).toBe(true);
    expect(isSupportedLocalVideoFile("image.png")).toBe(false);
    expect(isSupportedLocalVideoFile("folder.mp4", false)).toBe(false);
  });

  it("keeps manual address input limited to network URLs", () => {
    expect(normalizeNetworkUrl("example.com/video")).toBe("https://example.com/video");
    expect(normalizeNetworkUrl("file:///C:/Videos/movie.mp4")).toBeNull();
    expect(normalizeNetworkUrl("C:\\Videos\\movie.mp4")).toBeNull();
    expect(normalizeNetworkUrl("\\\\server\\share\\movie.mp4")).toBeNull();
    expect(normalizeNetworkUrl("/home/user/movie.mp4")).toBeNull();
  });
});
