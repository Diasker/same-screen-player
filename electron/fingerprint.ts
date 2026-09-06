import type { Session } from "electron";

const FALLBACK_CHROME_VERSION = "142.0.0.0";

export function chromeFullVersion(): string {
  const version = process.versions?.chrome;
  return typeof version === "string" && version.length > 0 ? version : FALLBACK_CHROME_VERSION;
}

export function chromeMajorVersion(): string {
  return chromeFullVersion().split(".")[0] || "142";
}

export function platformToken(): string {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

export function secChUaPlatform(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "macOS";
  return "Linux";
}

function platformVersionValue(): string {
  if (process.platform === "win32") return "10.0.0";
  if (process.platform === "darwin") return "14.0.0";
  return "";
}

function secChUaArch(): string {
  return process.arch === "arm64" ? "arm" : "x86";
}

export function chromeUserAgent(version: string = chromeFullVersion()): string {
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export function chromeAcceptLanguage(): string {
  return "zh-CN,zh;q=0.9,en;q=0.8";
}

export function chromeBrands(major: string): Array<{ brand: string; version: string }> {
  return [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not.A/Brand", version: "99" },
  ];
}

function secChUaBrandList(major: string): string {
  return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`;
}

function secChUaFullVersionList(fullVersion: string): string {
  return `"Chromium";v="${fullVersion}", "Google Chrome";v="${fullVersion}", "Not.A/Brand";v="99.0.0.0"`;
}

export function chromeClientHintHeaders(version: string = chromeFullVersion()): Record<string, string> {
  const major = version.split(".")[0] || "142";
  return {
    "sec-ch-ua": secChUaBrandList(major),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${secChUaPlatform()}"`,
    "sec-ch-ua-full-version-list": secChUaFullVersionList(version),
    "sec-ch-ua-full-version": `"${version}"`,
    "sec-ch-ua-platform-version": `"${platformVersionValue()}"`,
    "sec-ch-ua-arch": `"${secChUaArch()}"`,
    "sec-ch-ua-bitness": `"64"`,
    "sec-ch-ua-model": `""`,
    "sec-ch-ua-wow64": "?0",
  };
}

const fingerprintInstalledSessions = new WeakSet<Session>();
let fingerprintVersion = chromeFullVersion();

export function setFingerprintVersion(version: string): void {
  if (typeof version === "string" && version.length > 0) fingerprintVersion = version;
}

export function applyChromeClientHints(requestHeaders: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!key.toLowerCase().startsWith("sec-ch-ua")) next[key] = value;
  }
  return { ...next, ...chromeClientHintHeaders(fingerprintVersion) };
}

export function applyChromeRequestHeaders(requestHeaders: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("sec-ch-ua") || lower === "user-agent") continue;
    next[key] = value;
  }
  return {
    ...next,
    "User-Agent": chromeUserAgent(fingerprintVersion),
    ...chromeClientHintHeaders(fingerprintVersion),
  };
}

export function installFingerprintForSession(targetSession: Session): void {
  if (fingerprintInstalledSessions.has(targetSession)) return;
  fingerprintInstalledSessions.add(targetSession);
  targetSession.setUserAgent(chromeUserAgent(fingerprintVersion), chromeAcceptLanguage());
  targetSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ requestHeaders: applyChromeRequestHeaders(details.requestHeaders) });
  });
}

export function mainWorldFingerprintScript(): string {
  return `(function () {
  "use strict";
  if (window.__sameScreenFingerprintApplied) return;
  window.__sameScreenFingerprintApplied = true;

  function defineGetter(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { configurable: true, enumerable: true, get: getter });
    } catch (e) { /* non-configurable property; leave the native value */ }
  }

  function setGlobal(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { configurable: true, enumerable: true, writable: true, value: value });
    } catch (e) {
      try { obj[prop] = value; } catch (e2) { /* ignore */ }
    }
  }

  var nav = typeof navigator !== "undefined" ? navigator : null;
  var navProto = nav ? Object.getPrototypeOf(nav) : null;
  var ua = nav ? (nav.userAgent || "") : "";
  var chromeMatch = ua.match(/Chrome\\/([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)/);
  var full = chromeMatch ? chromeMatch[1] : "142.0.0.0";
  var major = full.split(".")[0] || "142";
  var secPlatform = /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "macOS" : "Linux";
  var navPlatform = /Windows/.test(ua) ? "Win32" : /Macintosh/.test(ua) ? "MacIntel" : "Linux x86_64";
  var platformVersion = /Windows/.test(ua) ? "10.0.0" : /Macintosh/.test(ua) ? "14.0.0" : "";
  var osToken = /Windows/.test(ua) ? "Windows NT 10.0; Win64; x64" : /Macintosh/.test(ua) ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  var cleanUa = "Mozilla/5.0 (" + osToken + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + full + " Safari/537.36";

  var brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not.A/Brand", version: "99" }
  ];
  var fullVersionList = [
    { brand: "Chromium", version: full },
    { brand: "Google Chrome", version: full },
    { brand: "Not.A/Brand", version: "99.0.0.0" }
  ];

  var uaData = {
    brands: brands,
    mobile: false,
    platform: secPlatform,
    getHighEntropyValues: function (hints) {
      var all = {
        brands: brands,
        mobile: false,
        platform: secPlatform,
        architecture: "x86",
        bitness: "64",
        model: "",
        platformVersion: platformVersion,
        uaFullVersion: full,
        fullVersionList: fullVersionList,
        wow64: false
      };
      var result = {};
      if (hints && hints.forEach) {
        hints.forEach(function (hint) {
          if (Object.prototype.hasOwnProperty.call(all, hint)) result[hint] = all[hint];
        });
      } else {
        result = all;
      }
      return Promise.resolve(result);
    },
    toJSON: function () {
      return { brands: brands, mobile: false, platform: secPlatform };
    }
  };

  function freshMime(spec) {
    return { type: spec.type, suffixes: spec.suffixes, description: spec.description, enabledPlugin: null };
  }

  var pdfSpecs = [
    { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
    { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" }
  ];
  var naclSpecs = [
    { type: "application/x-nacl", suffixes: "", description: "Native Client Executable" },
    { type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable" }
  ];

  function buildPlugin(def, specs, description) {
    var mimes = specs.map(freshMime);
    var plugin = {
      name: def.name,
      filename: def.filename,
      description: description,
      length: mimes.length
    };
    plugin.item = function (i) { return mimes[i] || null; };
    plugin.namedItem = function (name) {
      for (var i = 0; i < mimes.length; i++) if (mimes[i].type === name) return mimes[i];
      return null;
    };
    mimes.forEach(function (mime) { mime.enabledPlugin = plugin; });
    return plugin;
  }

  var pdfPluginDefs = [
    { name: "PDF Viewer", filename: "internal-pdf-viewer" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
    { name: "Chromium PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
    { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" }
  ];

  var pluginList = pdfPluginDefs.map(function (def) {
    return buildPlugin(def, pdfSpecs, "Portable Document Format");
  });
  var naclPlugin = buildPlugin({ name: "Native Client", filename: "internal-nacl-plugin" }, naclSpecs, "Native Client Executable");
  pluginList.push(naclPlugin);

  var globalMimes = [];
  var pdfMime0 = freshMime(pdfSpecs[0]); pdfMime0.enabledPlugin = pluginList[0];
  var pdfMime1 = freshMime(pdfSpecs[1]); pdfMime1.enabledPlugin = pluginList[0];
  var naclMime0 = freshMime(naclSpecs[0]); naclMime0.enabledPlugin = naclPlugin;
  var naclMime1 = freshMime(naclSpecs[1]); naclMime1.enabledPlugin = naclPlugin;
  globalMimes = [pdfMime0, pdfMime1, naclMime0, naclMime1];

  function arrayLike(items, className) {
    var obj = { length: items.length };
    obj.item = function (i) { return items[i] || null; };
    obj.namedItem = function (name) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item && (item.name === name || item.type === name)) return item;
      }
      return null;
    };
    obj.refresh = function () {};
    obj[Symbol.iterator] = function () {
      var index = 0;
      return { next: function () { return index < items.length ? { value: items[index++], done: false } : { done: true }; } };
    };
    obj.toString = function () { return className; };
    return obj;
  }

  var fakePlugins = arrayLike(pluginList, "[object PluginArray]");
  var fakeMimeTypes = arrayLike(globalMimes, "[object MimeTypeArray]");

  var chromeObj = {
    loadTimes: function () {
      var now = Date.now() / 1000;
      return {
        requestTime: now,
        startLoadTime: now,
        commitLoadTime: now,
        finishDocumentLoadTime: now,
        finishLoadTime: now,
        firstPaintTime: now,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: true,
        connectionInfo: "h2"
      };
    },
    csi: function () {
      return { startE: Date.now() / 1000, onloadT: 0, pageT: 0, tran: 15 };
    },
    app: {
      isInstalled: false,
      InstallState: { DISABLED: 1, INSTALLED: 2, NOT_INSTALLED: 3 },
      RunningState: { CANNOT_RUN: 1, READY_TO_RUN: 2, RUNNING: 3 }
    },
    runtime: {
      OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
      RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" }
    },
    webstore: {}
  };

  setGlobal(window, "chrome", chromeObj);

  if (navProto) {
    defineGetter(navProto, "userAgent", function () { return cleanUa; });
    defineGetter(navProto, "userAgentData", function () { return uaData; });
    defineGetter(navProto, "webdriver", function () { return false; });
    defineGetter(navProto, "plugins", function () { return fakePlugins; });
    defineGetter(navProto, "mimeTypes", function () { return fakeMimeTypes; });
    defineGetter(navProto, "languages", function () { return ["zh-CN", "zh", "en"]; });
    defineGetter(navProto, "language", function () { return "zh-CN"; });
    defineGetter(navProto, "platform", function () { return navPlatform; });
    defineGetter(navProto, "vendor", function () { return "Google Inc."; });
    defineGetter(navProto, "deviceMemory", function () { return 8; });
    defineGetter(navProto, "appVersion", function () { return cleanUa.replace(/^Mozilla\\//, ""); });
  }

  defineGetter(window, "outerWidth", function () { return window.innerWidth; });
  defineGetter(window, "outerHeight", function () { return window.innerHeight + 120; });
})();`;
}
