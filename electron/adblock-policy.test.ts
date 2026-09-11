import { describe, expect, it } from "vitest";
import { hostMatchesAdblockRule, normalizeAdblockHost } from "./adblock-policy";

describe("adblock host policy", () => {
  it("normalizes website hosts", () => {
    expect(normalizeAdblockHost("https://www.Example.com/path")).toBe("example.com");
    expect(normalizeAdblockHost("file:///tmp/video.mp4")).toBeNull();
  });
  it("matches a website and its subdomains only", () => {
    expect(hostMatchesAdblockRule("www.example.com", "example.com")).toBe(true);
    expect(hostMatchesAdblockRule("example.com.evil.test", "example.com")).toBe(false);
  });
});
