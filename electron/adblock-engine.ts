import { FiltersEngine, Request, evaluatePreprocessor, type RequestType, type CosmeticFilter } from "@ghostery/adblocker";
import { Script } from "node:vm";

const FILTER_ENV = new Map([
  ["env_chromium", true], ["env_firefox", false], ["env_mv3", false],
  ["cap_html_filtering", false], ["env_mobile", false],
]);

// Resolve subscriptions independently before either matcher sees them. A rule
// repeated in a false branch must not exclude its unconditional occurrence.
export function activeFilterText(text: string): string {
  const stack: { parent: boolean; condition: boolean; otherwise: boolean }[] = [];
  const lines: string[] = [];
  let active = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("!#if ")) {
      const condition = evaluatePreprocessor(line.slice(5).replace(/\s/g, ""), FILTER_ENV);
      stack.push({ parent: active, condition, otherwise: false });
      active = active && condition;
    } else if (line === "!#else") {
      const scope = stack.at(-1);
      if (!scope || scope.otherwise) throw new Error("Invalid filter conditional");
      scope.otherwise = true;
      active = scope.parent && !scope.condition;
    } else if (line === "!#endif") {
      const scope = stack.pop();
      if (!scope) throw new Error("Unbalanced filter conditional");
      active = scope.parent;
    } else if (active) lines.push(line);
  }
  if (stack.length) throw new Error("Unclosed filter conditional");
  return lines.join("\n");
}

class ScriptletEngine extends FiltersEngine {
  compileScriptlet(filter: CosmeticFilter): string | undefined {
    const parsed = filter.parseScript();
    if (!parsed) return;
    const template = this.resources.getScriptlet(parsed.name);
    if (!template) return;
    // The pinned resource template decodes URI components, whereas Ghostery's
    // default getScript inserts raw parameters (a literal '%' throws).
    const script = this.resources.getScriptletCanonicalName(parsed.name)
      ? template.replace(/\{\{(\d+)\}\}/g, (placeholder, number: string) => {
        const arg = parsed.args[Number(number) - 1];
        return arg === undefined ? placeholder : encodeURIComponent(arg).replace(/'/g, "%27");
      })
      : filter.getScript(() => template);
    // Keep helper functions and captured native APIs local to each scriptlet.
    return script === undefined ? undefined : `(()=>{${script}\n})()`;
  }

  override injectCosmeticFilters(filters: CosmeticFilter[], options: Parameters<FiltersEngine["injectCosmeticFilters"]>[1]) {
    const result = super.injectCosmeticFilters(filters.filter(filter => !filter.isScriptInject()), options);
    if (options.injectScriptlets) for (const filter of filters) {
      if (!filter.isScriptInject()) continue;
      const script = this.compileScriptlet(filter);
      if (script) result.scripts.push(script);
    }
    return result;
  }
}

export function playbackCompatibility(url: string, sourceUrl: string, topUrl: string, type: RequestType): string | undefined {
  if (!["xhr", "xmlhttprequest", "fetch"].includes(type)) return;
  try {
    const request = new URL(url);
    const onBilibili = (value: string) => {
      const origin = new URL(value);
      return origin.protocol === "https:" && (origin.hostname === "bilibili.com" || origin.hostname.endsWith(".bilibili.com"));
    };
    if (request.origin === "https://api.bilibili.com" && request.pathname === "/x/internal/gaia-gateway/ExClimbWuzhi" && onBilibili(sourceUrl) && onBilibili(topUrl)) return "bilibili-gaia-verification";
  } catch { /* No exception for invalid or opaque origins. */ }
}

// AdBlock's POPUP type is a special type, not an ordinary document request.
// Keep the upstream matcher instead of translating $popup into $document.
type AbpFilter = { text: string; type: string; contentType?: number };
type AbpBlockingFilter = AbpFilter & { readonly blockingBrand: true };
type PopupMatcher = { add(filter: AbpFilter): void; match(url: string, type: number, sourceHost: string, sitekey?: null, specificOnly?: boolean): AbpFilter | null };
const { CombinedMatcher } = require("adblockpluscore/lib/matcher") as { CombinedMatcher: new () => PopupMatcher };
const { Filter, BlockingFilter, URLFilter } = require("adblockpluscore/lib/filterClasses") as {
  Filter: { fromText(text: string): AbpFilter };
  BlockingFilter: new (...args: never[]) => AbpBlockingFilter;
  URLFilter: new (...args: never[]) => AbpFilter;
};
const { contentTypes } = require("adblockpluscore/lib/contentTypes") as { contentTypes: { POPUP: number; DOCUMENT: number; GENERICBLOCK: number } };

export const ENGINE_CONFIG = {
  enableMutationObserver: true,
  loadExtendedSelectors: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadNetworkFilters: true,
  loadCSPFilters: true,
  loadPreprocessors: true,
  debug: true,
};

export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16384) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export class AdblockEngine {
  readonly network: FiltersEngine;
  private readonly popups = new CombinedMatcher();

  constructor(texts: string[], resources?: string) {
    texts = texts.map(activeFilterText);
    const network = ScriptletEngine.parse(texts.join("\n"), ENGINE_CONFIG) as ScriptletEngine;
    this.network = network;
    this.network.updateEnv(FILTER_ENV);
    if (resources) this.network.updateResources(resources, String(resources.length));
    // Reject incompatible resource updates before replacing the working engine.
    if (resources) for (const filter of network.getFilters().cosmeticFilters) {
      if (!filter.isScriptInject() || !/(?:youtube|bilibili)\.com/.test(filter.toString())) continue;
      const script = network.compileScriptlet(filter);
      if (!script) throw new Error(`Missing playback scriptlet: ${filter.parseScript()?.name}`);
      new Script(script);
    }
    for (const text of texts) {
      for (const line of text.split(/\r?\n/)) {
        // Only popup rules and document/generic-block exceptions belong here.
        if (!/\$(?:[^\n]*,)?(?:~?popup|document|genericblock)(?:,|$)/i.test(line)) continue;
        const filter = Filter.fromText(line.trim());
        if (filter instanceof URLFilter) this.popups.add(filter);
      }
    }
  }

  match(url: string, sourceUrl: string, type: RequestType) {
    return this.network.match(Request.fromRawDetails({ url, sourceUrl, type }));
  }

  popup(url: string, sourceUrl: string): { blocked: boolean; rule?: string; excepted: boolean } {
    const sourceHost = new URL(httpUrl(sourceUrl) ?? "https://invalid.local").hostname;
    const document = this.popups.match(sourceUrl, contentTypes.DOCUMENT, sourceHost);
    if (document && !(document instanceof BlockingFilter)) return { blocked: false, excepted: true, rule: document.text };
    const generic = this.popups.match(sourceUrl, contentTypes.GENERICBLOCK, sourceHost);
    const result = this.popups.match(url, contentTypes.POPUP, sourceHost, null, Boolean(generic && !(generic instanceof BlockingFilter)));
    return { blocked: result instanceof BlockingFilter, excepted: Boolean(result && !(result instanceof BlockingFilter)), rule: result?.text };
  }
}
