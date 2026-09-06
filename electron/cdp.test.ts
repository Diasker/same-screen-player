import { describe, expect, it } from "vitest";
import { isValidChromeUrl } from "./cdp";

describe("Chrome backend URL validation", () => {
  it("accepts only bounded http and https URLs", () => {
    expect(isValidChromeUrl("https://www.youtube.com/watch?v=test")).toBe(true);
    expect(isValidChromeUrl("http://localhost:5173/video.html")).toBe(true);
    expect(isValidChromeUrl("file:///C:/video.html")).toBe(false);
    expect(isValidChromeUrl("javascript:alert(1)")).toBe(false);
    expect(isValidChromeUrl("about:blank")).toBe(false);
    expect(isValidChromeUrl("https://example.com/" + "x".repeat(4097))).toBe(false);
  });
});
