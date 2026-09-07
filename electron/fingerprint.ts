import type { Session } from "electron";

const FALLBACK_CHROME_VERSION = "142.0.0.0";

type FingerprintProfile = {
  version: string;
  userAgent: string;
  secPlatform: string;
  navPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  wow64: boolean;
  timeZone: string;
  languages: string[];
  webglVendor: string;
  webglRenderer: string;
};

function runtimeProcess(): (NodeJS.Process & { getSystemVersion?: () => string }) | null {
  return typeof process === "object" && process !== null ? process as NodeJS.Process & { getSystemVersion?: () => string } : null;
}

function runtimeArch(): string {
  return runtimeProcess()?.arch ?? "unknown";
}

function isArmRuntime(): boolean {
  const arch = runtimeArch();
  return arch === "arm64" || arch === "arm";
}

function architectureBitness(): string {
  const arch = runtimeArch();
  return /64$/.test(arch) || arch === "x64" || arch === "arm64" ? "64" : "32";
}

function architectureToken(): string {
  return isArmRuntime() ? "arm" : "x86";
}

function wow64Runtime(): boolean {
  const current = runtimeProcess();
  if (!current || current.platform !== "win32" || architectureBitness() !== "32") return false;
  return typeof current.env?.PROCESSOR_ARCHITEW6432 === "string" && current.env.PROCESSOR_ARCHITEW6432.length > 0;
}

export function chromeFullVersion(): string {
  const version = runtimeProcess()?.versions?.chrome;
  return typeof version === "string" && version.length > 0 ? version : FALLBACK_CHROME_VERSION;
}

export function chromeMajorVersion(): string {
  return chromeFullVersion().split(".")[0] || "142";
}

export function platformToken(): string {
  const current = runtimeProcess();
  if (current?.platform === "win32") {
    if (architectureBitness() === "32") return "Windows NT 10.0; Win32";
    return isArmRuntime() ? "Windows NT 10.0; Win64; ARM64" : "Windows NT 10.0; Win64; x64";
  }
  if (current?.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return isArmRuntime() ? "X11; Linux aarch64" : architectureBitness() === "32" ? "X11; Linux i686" : "X11; Linux x86_64";
}

export function secChUaPlatform(): string {
  const current = runtimeProcess();
  if (current?.platform === "win32") return "Windows";
  if (current?.platform === "darwin") return "macOS";
  return "Linux";
}

function platformVersionValue(): string {
  const current = runtimeProcess();
  const systemVersion = current?.getSystemVersion?.();
  const fallback = current?.platform === "win32" ? "10.0.0" : current?.platform === "darwin" ? "14.0.0" : "";
  const match = (systemVersion || fallback).match(/\d+/g)?.slice(0, 3);
  if (!match?.length) return "";
  return match.map((part) => String(Number(part))).join(".");
}

export function chromeUserAgent(version: string = chromeFullVersion()): string {
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function runtimeLanguages(): string[] {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.replace(/_/g, "-");
    const [language] = locale.split("-");
    if (!locale || !language) return ["en-US", "en"];
    return language.toLowerCase() === locale.toLowerCase() ? [locale] : [locale, language];
  } catch {
    return ["en-US", "en"];
  }
}

export function chromeAcceptLanguage(): string {
  return runtimeLanguages().map((language, index) => index === 0 ? language : `${language};q=${(1 - index / 10).toFixed(1)}`).join(",");
}

function runtimeTimeZone(): string {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.length > 0 ? value : "UTC";
  } catch {
    return "UTC";
  }
}

function navigatorPlatformToken(): string {
  const current = runtimeProcess();
  if (current?.platform === "win32") return "Win32";
  if (current?.platform === "darwin") return "MacIntel";
  const arch = runtimeArch();
  if (arch === "arm64") return "Linux aarch64";
  if (arch === "arm") return "Linux armv7l";
  if (arch === "ia32") return "Linux i686";
  if (arch === "ppc64") return "Linux ppc64";
  if (arch === "s390x") return "Linux s390x";
  if (arch === "riscv64") return "Linux riscv64";
  return "Linux x86_64";
}

function webglIdentity(): Pick<FingerprintProfile, "webglVendor" | "webglRenderer"> {
  const current = runtimeProcess();
  if (current?.platform === "darwin") {
    return isArmRuntime()
      ? { webglVendor: "Google Inc. (Apple)", webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer, Unspecified Version)" }
      : { webglVendor: "Google Inc. (Apple)", webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer, Unspecified Version)" };
  }
  if (current?.platform === "win32") {
    return isArmRuntime()
      ? { webglVendor: "Google Inc. (Microsoft)", webglRenderer: "ANGLE (Microsoft, Direct3D11)" }
      : { webglVendor: "Google Inc. (ANGLE)", webglRenderer: "ANGLE (Microsoft, Direct3D11)" };
  }
  return isArmRuntime()
    ? { webglVendor: "Google Inc. (Mesa)", webglRenderer: "ANGLE (Mesa, OpenGL ES 3.2)" }
    : { webglVendor: "Google Inc. (Mesa)", webglRenderer: "ANGLE (Mesa, OpenGL ES 3.2)" };
}

function fingerprintProfile(version: string = fingerprintVersion): FingerprintProfile {
  const identity = webglIdentity();
  return {
    version,
    userAgent: chromeUserAgent(version),
    secPlatform: secChUaPlatform(),
    navPlatform: navigatorPlatformToken(),
    platformVersion: platformVersionValue(),
    architecture: architectureToken(),
    bitness: architectureBitness(),
    wow64: wow64Runtime(),
    timeZone: runtimeTimeZone(),
    languages: runtimeLanguages(),
    ...identity,
  };
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
    "sec-ch-ua-arch": `"${architectureToken()}"`,
    "sec-ch-ua-bitness": `"${architectureBitness()}"`,
    "sec-ch-ua-model": `""`,
    "sec-ch-ua-wow64": wow64Runtime() ? "?1" : "?0",
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
  const profile = JSON.stringify(fingerprintProfile(fingerprintVersion)).replace(/</g, "\\u003c");
  return `(function () {
  "use strict";
  if (window.__sameScreenFingerprintApplied) return;
  window.__sameScreenFingerprintApplied = true;

  var profile = ${profile};

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
  var full = profile.version;
  var major = full.split(".")[0] || "142";
  var secPlatform = profile.secPlatform;
  var navPlatform = profile.navPlatform;
  var platformVersion = profile.platformVersion;
  var cleanUa = profile.userAgent;

  function nearestValue(value, values, fallback) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return fallback;
    var nearest = values[0];
    var difference = Math.abs(value - nearest);
    for (var index = 1; index < values.length; index++) {
      var nextDifference = Math.abs(value - values[index]);
      if (nextDifference < difference) { nearest = values[index]; difference = nextDifference; }
    }
    return nearest;
  }

  var languages = profile.languages.length ? profile.languages.slice() : ["en-US", "en"];
  var language = languages[0];
  var hardwareConcurrency = nearestValue(nav && nav.hardwareConcurrency, [2, 4, 8, 16], 4);
  var deviceMemory = nearestValue(nav && nav.deviceMemory, [0.25, 0.5, 1, 2, 4, 8], 8);
  var fingerprintSeed = 0;
  var seedSource = [full, profile.timeZone, profile.architecture, profile.bitness].join("|");
  for (var seedIndex = 0; seedIndex < seedSource.length; seedIndex++) fingerprintSeed = (fingerprintSeed * 31 + seedSource.charCodeAt(seedIndex)) >>> 0;

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
        architecture: profile.architecture,
        bitness: profile.bitness,
        model: "",
        platformVersion: platformVersion,
        uaFullVersion: full,
        fullVersionList: fullVersionList,
        wow64: profile.wow64
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

  function patchCanvas() {
    if (typeof HTMLCanvasElement === "undefined") return;
    var canvasProto = HTMLCanvasElement.prototype;
    var originalToDataURL = canvasProto.toDataURL;
    var originalToBlob = canvasProto.toBlob;
    var copyWithNoise = function (canvas) {
      try {
        if (!canvas || canvas.width < 1 || canvas.height < 1 || typeof document === "undefined") return null;
        var copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        var context = copy.getContext("2d");
        if (!context) return null;
        context.drawImage(canvas, 0, 0);
        var pixel = context.getImageData(0, 0, 1, 1);
        pixel.data[0] = (pixel.data[0] + (fingerprintSeed % 3)) & 255;
        context.putImageData(pixel, 0, 0);
        return copy;
      } catch (e) { return null; }
    };
    canvasProto.toDataURL = function () {
      var copy = copyWithNoise(this);
      return copy ? originalToDataURL.apply(copy, arguments) : originalToDataURL.apply(this, arguments);
    };
    canvasProto.toBlob = function () {
      var copy = copyWithNoise(this);
      return originalToBlob.apply(copy || this, arguments);
    };
  }

  function patchWebGL() {
    var contexts = [];
    if (typeof WebGLRenderingContext !== "undefined") contexts.push(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") contexts.push(WebGL2RenderingContext.prototype);
    contexts.forEach(function (proto) {
      var originalGetParameter = proto.getParameter;
      var originalGetExtension = proto.getExtension;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) return profile.webglVendor;
        if (parameter === 37446) return profile.webglRenderer;
        return originalGetParameter.apply(this, arguments);
      };
      proto.getExtension = function (name) {
        if (name === "WEBGL_debug_renderer_info") return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        return originalGetExtension.apply(this, arguments);
      };
    });
  }

  function patchAudio() {
    if (typeof AnalyserNode !== "undefined") {
      var proto = AnalyserNode.prototype;
      var originalFloat = proto.getFloatFrequencyData;
      var originalByte = proto.getByteFrequencyData;
      proto.getFloatFrequencyData = function (array) {
        originalFloat.apply(this, arguments);
        if (array && array.length) array[0] += (fingerprintSeed % 5) / 1000;
      };
      proto.getByteFrequencyData = function (array) {
        originalByte.apply(this, arguments);
        if (array && array.length) array[0] = Math.min(255, array[0] + (fingerprintSeed % 2));
      };
    }
    if (typeof OfflineAudioContext !== "undefined") {
      var offlineProto = OfflineAudioContext.prototype;
      var originalStartRendering = offlineProto.startRendering;
      if (typeof originalStartRendering === "function") {
        offlineProto.startRendering = function () {
          return originalStartRendering.apply(this, arguments).then(function (buffer) {
            try {
              var channel = buffer && buffer.numberOfChannels ? buffer.getChannelData(0) : null;
              if (channel && channel.length) channel[0] += (fingerprintSeed % 5) / 1000000;
            } catch (e) {}
            return buffer;
          });
        };
      }
    }
  }

  function patchFontMetrics() {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    var proto = CanvasRenderingContext2D.prototype;
    var originalMeasureText = proto.measureText;
    proto.measureText = function () {
      var metrics = originalMeasureText.apply(this, arguments);
      try {
        var originalWidth = metrics.width;
        var normalizedWidth = Math.round(originalWidth * 64) / 64;
        if (normalizedWidth === originalWidth) return metrics;
        var clone = Object.create(metrics);
        defineGetter(clone, "width", function () { return normalizedWidth; });
        return clone;
      } catch (e) { return metrics; }
    };
  }

  function patchIntl() {
    try {
      var originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        var options = originalResolved.apply(this, arguments);
        if (!options.timeZone || options.timeZone === profile.timeZone) options.timeZone = profile.timeZone;
        return options;
      };
    } catch (e) {}
  }

  patchCanvas();
  patchWebGL();
  patchAudio();
  patchFontMetrics();
  patchIntl();

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
    defineGetter(navProto, "languages", function () { return languages.slice(); });
    defineGetter(navProto, "language", function () { return language; });
    defineGetter(navProto, "platform", function () { return navPlatform; });
    defineGetter(navProto, "vendor", function () { return "Google Inc."; });
    defineGetter(navProto, "hardwareConcurrency", function () { return hardwareConcurrency; });
    defineGetter(navProto, "deviceMemory", function () { return deviceMemory; });
    defineGetter(navProto, "appVersion", function () { return cleanUa.replace(/^Mozilla\\//, ""); });
  }

  var frameWidth = Math.max(0, window.outerWidth - window.innerWidth);
  var frameHeight = Math.max(0, window.outerHeight - window.innerHeight);
  defineGetter(window, "outerWidth", function () { return window.innerWidth + frameWidth; });
  defineGetter(window, "outerHeight", function () { return window.innerHeight + frameHeight; });
})();`;
}
