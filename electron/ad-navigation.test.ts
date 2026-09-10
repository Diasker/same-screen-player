import { describe, expect, it } from "vitest";
import { isKnownAdRequest } from "./ad-navigation";

describe("ad navigation detection", () => {
  it("blocks observed advertising hosts", () => {
    expect(isKnownAdRequest("https://static.content-sync.xyz/api/click/123")).toBe(true);
    expect(isKnownAdRequest("https://tsyndicate.com/api/v1/direct/123")).toBe(true);
    expect(isKnownAdRequest("https://wishapptrack.com/click")).toBe(true);
    expect(isKnownAdRequest("https://mengmei8.com/generate/undress")).toBe(true);
    expect(isKnownAdRequest("https://ad.twinrdengine.com/adraw")).toBe(true);
    expect(isKnownAdRequest("https://go.marzaent.com/smartpop/123")).toBe(true);
  });

  it("blocks the observed stripchat popunder redirect", () => {
    expect(isKnownAdRequest("https://zh.stripchat.com/model?trafficType=popunder")).toBe(true);
  });

  it("allows ordinary video and site navigation", () => {
    expect(isKnownAdRequest("https://www.javhdporn.net/video/aran-012/")).toBe(false);
    expect(isKnownAdRequest("https://stripchat.com/model?trafficType=direct")).toBe(false);
    expect(isKnownAdRequest("https://example.com/landing?campaignType=smartpop")).toBe(false);
    expect(isKnownAdRequest("https://example.com/popup-player/video.mp4")).toBe(false);
    expect(isKnownAdRequest("not-a-url")).toBe(false);
  });
});
