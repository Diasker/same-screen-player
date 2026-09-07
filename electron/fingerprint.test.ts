import { describe, expect, it } from "vitest";
import {
  applyChromeClientHints,
  applyChromeRequestHeaders,
  chromeClientHintHeaders,
  chromeFullVersion,
  chromeMajorVersion,
  chromeUserAgent,
  mainWorldFingerprintScript,
  secChUaPlatform,
} from "./fingerprint";

describe("Chrome fingerprint helpers", () => {
  it("builds a Chrome-style user agent without the Electron brand", () => {
    const ua = chromeUserAgent();
    expect(ua).toContain("Chrome/");
    expect(ua).toContain(chromeFullVersion());
    expect(ua).not.toContain("Electron");
    if (process.arch === "arm64" || process.arch === "arm") expect(ua).not.toContain("Linux x86_64");
  });

  it("builds Chrome-branded client hint headers without Electron", () => {
    const headers = chromeClientHintHeaders();
    expect(headers["sec-ch-ua"]).toContain("Google Chrome");
    expect(headers["sec-ch-ua"]).not.toContain("Electron");
    expect(headers["sec-ch-ua"]).toContain(`"${chromeMajorVersion()}"`);
    expect(headers["sec-ch-ua-full-version-list"]).toContain("Google Chrome");
    expect(headers["sec-ch-ua-full-version-list"]).not.toContain("Electron");
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBe(`"${secChUaPlatform()}"`);
    const expectedArchitecture = process.arch === "arm64" || process.arch === "arm" ? "arm" : "x86";
    const expectedBitness = process.arch === "x64" || process.arch === "arm64" ? "64" : "32";
    expect(headers["sec-ch-ua-arch"]).toBe(`"${expectedArchitecture}"`);
    expect(headers["sec-ch-ua-bitness"]).toBe(`"${expectedBitness}"`);
  });

  it("replaces client hint headers case-insensitively", () => {
    const input: Record<string, string> = {
      "User-Agent": "keep-me",
      accept: "text/html",
      "Sec-CH-UA": '"Chromium";v="142", "Electron";v="44"',
      "SEC-CH-UA-PLATFORM": '"Windows"',
      "Sec-Ch-Ua-Mobile": "?0",
    };
    const result = applyChromeClientHints(input);
    expect(result["User-Agent"]).toBe("keep-me");
    expect(result["accept"]).toBe("text/html");
    expect(result["Sec-CH-UA"]).toBeUndefined();
    expect(result["SEC-CH-UA-PLATFORM"]).toBeUndefined();
    expect(result["Sec-Ch-Ua-Mobile"]).toBeUndefined();
    expect(result["sec-ch-ua"]).toContain("Google Chrome");
    expect(result["sec-ch-ua"]).not.toContain("Electron");
    expect(result["sec-ch-ua-platform"]).toBe(`"${secChUaPlatform()}"`);
  });

  it("rewrites the User-Agent header to strip the Electron brand on every request", () => {
    const input: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) same-screen-player/0.1.0 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36",
      accept: "text/html",
      "Sec-CH-UA": '"Chromium";v="152", "Electron";v="44"',
    };
    const result = applyChromeRequestHeaders(input);
    expect(result["User-Agent"]).toContain("Chrome/");
    expect(result["User-Agent"]).not.toContain("Electron");
    expect(result["User-Agent"]).not.toContain("same-screen-player");
    expect(result["accept"]).toBe("text/html");
    expect(result["sec-ch-ua"]).toContain("Google Chrome");
    expect(result["sec-ch-ua"]).not.toContain("Electron");
  });

  it("produces a self-contained main-world script without Electron references", () => {
    const script = mainWorldFingerprintScript();
    const expectedArchitecture = process.arch === "arm64" || process.arch === "arm" ? "arm" : "x86";
    const expectedBitness = process.arch === "x64" || process.arch === "arm64" ? "64" : "32";
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(1000);
    for (const marker of ["userAgentData", "plugins", "mimeTypes", "webdriver", "chrome", "outerWidth", "profile.architecture", "profile.languages", "hardwareConcurrency", "patchCanvas", "patchWebGL", "patchAudio", "patchFontMetrics", "patchIntl"]) {
      expect(script).toContain(marker);
    }
    expect(script).not.toContain("Electron");
    expect(script).not.toContain('architecture: "x86"');
    expect(script).toContain(`"architecture":"${expectedArchitecture}"`);
    expect(script).toContain(`"bitness":"${expectedBitness}"`);
    expect(() => new Function(script)).not.toThrow();
  });
});
