import { ipcRenderer, webFrame } from "electron";
import { DOMMonitor, type IMessageFromBackground } from "@ghostery/adblocker-content";
import { querySelectorAll, handlePseudoDirective } from "@ghostery/adblocker-extended-selectors";

// A dedicated sandboxed preload runs in every frame. No API is exposed to page JS.
if (/^(?:https?:|about:)/.test(location.protocol)) {
  let monitor: DOMMonitor | null = null;
  let extended: IMessageFromBackground["extended"] = [];
  let extendedTimer: ReturnType<typeof setTimeout> | undefined;
  let extendedObserver: MutationObserver | undefined;
  const seenStyles = new Set<string>();
  const seenScripts = new Set<string>();
  let active = false;
  let attributed = new Map<string, Set<Element>>();

  const applyExtended = () => {
    extendedTimer = undefined;
    if (!document.documentElement) return;
    const next = new Map<string, Set<Element>>();
    for (const rule of extended) {
      try {
        for (const node of querySelectorAll(document.documentElement, rule.ast)) {
          if (rule.directive) handlePseudoDirective(node, rule.directive);
          else if (rule.attribute) {
            const matches = next.get(rule.attribute) ?? new Set<Element>();
            matches.add(node);
            next.set(rule.attribute, matches);
            if (!node.hasAttribute(rule.attribute)) node.setAttribute(rule.attribute, "");
          }
        }
      } catch { /* Invalid/unsupported selectors must not interrupt the player. */ }
    }
    for (const [attribute, elements] of attributed) {
      for (const element of elements) if (!next.get(attribute)?.has(element)) element.removeAttribute(attribute);
    }
    attributed = next;
  };
  const scheduleExtended = () => {
    if (extended.length && !extendedTimer) extendedTimer = setTimeout(applyExtended, 100);
  };
  const apply = (result: (IMessageFromBackground & { scriptIds?: string[] }) | undefined) => {
    if (!result?.active) return;
    active = true;
    if (result.styles && !seenStyles.has(result.styles)) {
      seenStyles.add(result.styles);
      webFrame.insertCSS(result.styles, { cssOrigin: "user" });
    }
    for (const [index, script] of result.scripts.entries()) {
      if (seenScripts.has(script)) continue;
      seenScripts.add(script);
      void webFrame.executeJavaScript(script, false).catch((error: unknown) => {
        ipcRenderer.send("adblock:scriptlet-error", { id: result.scriptIds?.[index], name: error instanceof Error ? error.name : "Error" });
      });
    }
    if (result.extended.length) {
      const previous = new Set(extended.map(rule => rule.id));
      extended.push(...result.extended.filter(rule => !previous.has(rule.id)));
      scheduleExtended();
    }
  };

  // Synchronous initialization is local/in-memory only. It closes the race with
  // the document's first inline script and never waits for subscription downloads.
  try { apply(ipcRenderer.sendSync("adblock:frame-rules")); } catch { /* host is closing */ }

  const start = () => {
    if (!active) return;
    monitor = new DOMMonitor(update => {
      if (update.type === "features") void ipcRenderer.invoke("adblock:frame-rules-update", update).then(apply).catch(() => undefined);
    });
    monitor.queryAll(window);
    monitor.start(window);
    extendedObserver = new MutationObserver(scheduleExtended);
    extendedObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "id", "href"] });
    applyExtended();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  const recordIntent = (event: Event) => {
    if (!event.isTrusted) return;
    const element = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    if (!element) return;
    const anchor = element.closest<HTMLAnchorElement>("a[href],area[href]");
    const form = event.type === "submit" && element instanceof HTMLFormElement ? element : null;
    const target = anchor?.href;
    let media = Boolean(element.closest("video,audio,.plyr,.video-js,.jwplayer,.dplayer,.artplayer-app,[data-plyr]"));
    if (!media && event instanceof MouseEvent) {
      media = Array.from(document.querySelectorAll("video,audio")).some(video => {
        const box = video.getBoundingClientRect();
        return box.width > 100 && box.height > 60 && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      });
    }
    const kind = form ? "form" : target && /^https?:/.test(target) && anchor?.getAttribute("href")?.startsWith("#") !== true ? "link" : media ? "media" : "other";
    ipcRenderer.sendSync("adblock:intent", { kind, target: form?.action ?? target });
  };
  for (const type of ["pointerdown", "click", "auxclick", "submit", "keydown"]) {
    window.addEventListener(type, event => {
      if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
      recordIntent(event);
    }, true);
  }
  window.addEventListener("pagehide", () => {
    monitor?.stop();
    extendedObserver?.disconnect();
    if (extendedTimer) clearTimeout(extendedTimer);
  }, { once: true });
}
