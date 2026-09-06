import { describe, expect, it } from "vitest";
import {
  defaultGlobalProxySettings,
  defaultHttpProxyEndpoint,
  defaultPaneProxySettings,
  normalizeHttpProxyEndpoint,
  normalizeGlobalProxySettings,
  normalizePaneProxySettings,
  resolvePaneProxySession,
  resolveProxySettings,
  toElectronProxySettings,
} from "./types";

describe("proxy settings", () => {
  it("validates and normalizes Windows-style HTTP proxy input", () => {
    expect(normalizeHttpProxyEndpoint({ host: " 127.0.0.1 ", port: "16996", bypassList: "localhost; 192.168.*;", bypassLocal: true })).toEqual({
      host: "127.0.0.1",
      port: 16996,
      bypassList: "localhost;192.168.*",
      bypassLocal: true,
    });
    expect(normalizeHttpProxyEndpoint({ host: "http://127.0.0.1", port: 8080, bypassList: "", bypassLocal: true })).toBeNull();
    expect(normalizeHttpProxyEndpoint({ host: "127.0.0.1", port: 0, bypassList: "", bypassLocal: true })).toBeNull();
    expect(normalizeHttpProxyEndpoint({ host: "127.0.0.1", port: 8080, bypassList: "https://example.com", bypassLocal: true })).toBeNull();
  });

  it("builds system, direct, and fixed HTTP Electron proxy configurations", () => {
    const custom = { host: "127.0.0.1", port: 16996, bypassList: "localhost;192.168.*", bypassLocal: true };
    expect(toElectronProxySettings({ mode: "system", custom })).toEqual({ mode: "system" });
    expect(toElectronProxySettings({ mode: "direct", custom })).toEqual({ mode: "direct" });
    expect(toElectronProxySettings({ mode: "custom", custom })).toEqual({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:16996;https=127.0.0.1:16996",
      proxyBypassRules: "localhost;192.168.*;<local>",
    });
  });

  it("resolves pane overrides above the global proxy", () => {
    const global = { mode: "custom" as const, custom: { host: "global", port: 8080, bypassList: "", bypassLocal: true } };
    const inherited = defaultPaneProxySettings();
    const direct = { mode: "direct" as const, custom: defaultHttpProxyEndpoint() };
    const custom = { mode: "custom" as const, custom: { host: "pane", port: 9000, bypassList: "", bypassLocal: true } };
    expect(resolveProxySettings(global, inherited)).toEqual(global);
    expect(resolveProxySettings(global, direct).mode).toBe("direct");
    expect(resolveProxySettings(global, custom)).toEqual({ mode: "custom", custom: custom.custom });
  });

  it("validates persisted global and pane settings", () => {
    const global = defaultGlobalProxySettings();
    const pane = defaultPaneProxySettings();
    expect(normalizeGlobalProxySettings(global)).toEqual(global);
    expect(normalizePaneProxySettings(pane)).toEqual(pane);
    expect(normalizeGlobalProxySettings({ mode: "custom", custom: { ...global.custom, port: 70000 } })).toBeNull();
    expect(normalizePaneProxySettings({ mode: "unknown", custom: pane.custom })).toBeNull();
  });

  it("auto-isolates shared panes and only auto-restores sessions it changed", () => {
    expect(resolvePaneProxySession("shared", false, "direct")).toEqual({ sessionMode: "isolated", proxyAutoIsolated: true });
    expect(resolvePaneProxySession("shared", false, "custom")).toEqual({ sessionMode: "isolated", proxyAutoIsolated: true });
    expect(resolvePaneProxySession("isolated", true, "inherit")).toEqual({ sessionMode: "shared", proxyAutoIsolated: false });
    expect(resolvePaneProxySession("isolated", false, "inherit")).toEqual({ sessionMode: "isolated", proxyAutoIsolated: false });
  });
});
