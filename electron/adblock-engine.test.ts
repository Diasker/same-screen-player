import { describe, expect, it } from "vitest";
import { AdblockEngine, activeFilterText, playbackCompatibility } from "./adblock-engine";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

describe("real filtering engines", () => {
  const engine = new AdblockEngine([
    "||ads.example^\n@@||ads.example/player.js$script\n||popup.example^$popup,domain=video.example\n@@||popup.example/login$popup\nvideo.example##.banner\nvideo.example##div:has-text(Sponsored)",
  ]);
  it("filters scripts, interfaces and media without blanket playback bypasses", () => {
    for (const type of ["script", "xhr", "media", "image", "subFrame"] as const) {
      expect(engine.match("https://ads.example/ad", "https://video.example/", type).match).toBe(true);
      expect(engine.match("https://cdn.example/video.mp4", "https://video.example/", type).match).toBe(false);
    }
    expect(engine.match("https://ads.example/player.js", "https://video.example/", "script").match).toBe(false);
  });
  it("matches native POPUP rules and their source-domain restrictions and exceptions", () => {
    expect(engine.popup("https://popup.example/ad", "https://video.example/").blocked).toBe(true);
    expect(engine.popup("https://popup.example/ad", "https://other.example/").blocked).toBe(false);
    expect(engine.popup("https://popup.example/login", "https://video.example/").excepted).toBe(true);
    expect(engine.match("https://popup.example/ad", "https://video.example/", "mainFrame").match).toBe(false);
  });
  it("keeps third-party popup rules and document exceptions", () => {
    const value = new AdblockEngine(["||popup.example^$popup,third-party\n@@||allowed.example^$document"]);
    expect(value.popup("https://popup.example/ad", "https://popup.example/").blocked).toBe(false);
    expect(value.popup("https://popup.example/ad", "https://video.example/").blocked).toBe(true);
    expect(value.popup("https://popup.example/ad", "https://allowed.example/").blocked).toBe(false);
  });
  it("returns both ordinary CSS and executable extended selectors", () => {
    const result = engine.network.getCosmeticsFilters({ url: "https://video.example/", hostname: "video.example", domain: "video.example" });
    expect(result.styles).toContain(".banner");
    expect(result.extended.length).toBeGreaterThan(0);
  });
});

describe("playback compatibility", () => {
  it("limits Gaia verification to the precise API, request type, source and owning site", () => {
    const endpoint = "https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi";
    const source = "https://www.bilibili.com/video/test";
    expect(playbackCompatibility(endpoint + "?token=test", source, source, "xhr")).toBe("bilibili-gaia-verification");
    for (const url of [endpoint + "/ad", endpoint.replace("api.", "cm."), endpoint.replace("https:", "http:"), "https://api.bilibili.com/x/ad/banner"]) {
      expect(playbackCompatibility(url, source, source, "xhr")).toBeUndefined();
    }
    for (const origin of ["https://bilibili.com.evil.example", "https://other.example", "about:blank"]) {
      expect(playbackCompatibility(endpoint, origin, source, "xhr")).toBeUndefined();
      expect(playbackCompatibility(endpoint, source, origin, "xhr")).toBeUndefined();
    }
    expect(playbackCompatibility(endpoint, source, source, "script")).toBeUndefined();
  });

  it("resolves Chromium and capability branches for both network and popup matchers", () => {
    const text = "!#if env_firefox\n||firefox.example^\n||popup.example^$popup\n!#else\n!#if !cap_html_filtering && env_chromium\n||chromium.example^\n!#endif\n!#endif\n||shared.example^\n!#if env_firefox\n||shared.example^\n!#endif";
    const engine = new AdblockEngine([text]);
    expect(engine.match("https://firefox.example/", "https://video.example", "xhr").match).toBe(false);
    expect(engine.popup("https://popup.example/", "https://video.example").blocked).toBe(false);
    expect(engine.match("https://chromium.example/", "https://video.example", "xhr").match).toBe(true);
    expect(engine.match("https://shared.example/", "https://video.example", "xhr").match).toBe(true);
    expect(() => activeFilterText("!#if env_chromium\n||ads.example^")).toThrow();
  });

  it("preserves literal URI escapes, template literals and regex arguments without leaking helpers", () => {
    const resources = JSON.stringify({ redirects: [], scriptlets: [{ name: "capture.js", aliases: [], dependencies: [], body: "function capture(...args){window.args=args}" }] });
    const engine = new AdblockEngine(["video.example##+js(capture, 100%, %2F, '${value}`', /a\\.b/, '{{2}}')"], resources);
    const result = engine.network.getCosmeticsFilters({ url: "https://video.example/", hostname: "video.example", domain: "video.example" });
    const context = { window: {} as { args?: string[] } };
    runInNewContext(result.scripts[0], context);
    expect(context.window.args).toEqual(["100%", "%2F", "${value}`", "/a\\.b/", "{{2}}"]);
    expect(context).not.toHaveProperty("scriptletGlobals");
  });

  it("compiles shipped YouTube rules and leaves player requests available while blocking ads", () => {
    const snapshot = JSON.parse(gunzipSync(readFileSync("electron/adblock-assets/snapshot.json.gz")).toString());
    const engine = new AdblockEngine(snapshot.lists.map((list: { text: string }) => list.text), snapshot.resources.text);
    const page = "https://www.youtube.com/watch?v=test";
    expect(engine.match("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", page, "xhr").match).toBe(false);
    expect(engine.match("https://www.youtube.com/pagead/adview", page, "xhr").match).toBe(true);
    expect(engine.match("https://cm.bilibili.com/cm/api/test", "https://www.bilibili.com/video/test", "xhr").match).toBe(true);
    const scripts = engine.network.getCosmeticsFilters({ url: page, hostname: "www.youtube.com", domain: "youtube.com" }).scripts;
    expect(scripts.length).toBeGreaterThan(10);
  });
});
