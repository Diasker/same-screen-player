(() => {
  "use strict";

  let enabled = true;
  let target = null;
  let ancestors = [];
  let hidden = [];
  let scheduled = false;
  let nativeFullscreen = false;

  const deepRoots = (root = document) => {
    const roots = [];
    root.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    });
    return roots;
  };

  const allDeep = (selector) => {
    const results = [];
    const seen = new Set();
    const queue = [document];
    while (queue.length) {
      const root = queue.shift();
      root.querySelectorAll(selector).forEach((element) => {
        if (!seen.has(element)) {
          seen.add(element);
          results.push(element);
        }
      });
      deepRoots(root).forEach((shadowRoot) => queue.push(shadowRoot));
    }
    return results;
  };

  const visible = (element) => {
    if (!(element instanceof HTMLElement) || element.hidden) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 2 && rect.height > 2;
  };

  const challenge = () => {
    const text = document.body?.innerText || "";
    return /verify you are human|checking your browser|just a moment|验证你是真人|检查你的浏览器|请完成安全验证/i.test(text)
      || /\/cdn-cgi\/challenge|challenge-platform|turnstile/i.test(location.href)
      || Boolean(document.querySelector("iframe[src*='turnstile'], iframe[title*='challenge' i], input[name='cf-turnstile-response']"));
  };

  const removeFocus = () => {
    target?.classList.remove("same-screen-focus-target");
    ancestors.forEach((element) => element.classList.remove("same-screen-focus-ancestor"));
    hidden.forEach((element) => element.classList.remove("same-screen-focus-hidden"));
    ancestors = [];
    hidden = [];
    target = null;
    document.documentElement.classList.remove("same-screen-focus-mode");
  };

  const findTarget = () => {
    const hostname = location.hostname.toLowerCase();
    const selectors = hostname.includes("youtube")
      ? ["#movie_player", ".html5-video-player", ".html5-video-container"]
      : hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")
        ? [".bpx-player-container", ".bilibili-player-container", ".bpx-player-video-wrap"]
        : [];
    const roots = selectors.flatMap((selector) => allDeep(selector)).filter(visible);
    const videos = allDeep("video").filter(visible).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    const video = videos[0] || null;
    if (!video) return null;
    const root = roots[0] || (() => {
      let current = video.parentElement;
      let fallback = video;
      for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
        if (current.getBoundingClientRect().width > 2 && current.getBoundingClientRect().height > 2) fallback = current;
        const hint = `${current.id} ${typeof current.className === "string" ? current.className : ""}`.toLowerCase();
        if (/player|video|media|control|container/.test(hint) || current.querySelector("button, input[type=range], [role=button]")) return current;
        current = current.parentElement;
      }
      return fallback;
    })();
    return { root, video };
  };

  const applyFocus = (next) => {
    if (!enabled || nativeFullscreen || challenge()) {
      removeFocus();
      return;
    }
    if (target?.root === next.root) return;
    removeFocus();
    target = next;
    target.root.classList.add("same-screen-focus-target");
    let child = target.root;
    let ancestor = target.root.parentElement;
    while (ancestor) {
      ancestor.classList.add("same-screen-focus-ancestor");
      ancestors.push(ancestor);
      Array.from(ancestor.children).forEach((sibling) => {
        if (sibling !== child && sibling instanceof HTMLElement) {
          sibling.classList.add("same-screen-focus-hidden");
          hidden.push(sibling);
        }
      });
      child = ancestor;
      if (ancestor === document.body) break;
      ancestor = ancestor.parentElement;
    }
    document.documentElement.classList.add("same-screen-focus-mode");
    window.postMessage({ source: "same-screen-player-focus", type: "status", enabled: true }, "*");
  };

  const detect = () => {
    scheduled = false;
    if (challenge()) {
      removeFocus();
      window.postMessage({ source: "same-screen-player-focus", type: "challenge" }, "*");
      return;
    }
    const next = findTarget();
    if (next) applyFocus(next);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(detect);
  };

  window.addEventListener("message", (event) => {
    const value = event.data;
    if (!value || value.source !== "same-screen-player") return;
    if (value.type === "focus:enable") { enabled = true; schedule(); }
    if (value.type === "focus:disable" || value.type === "focus:restore") { enabled = false; removeFocus(); }
  });
  document.addEventListener("fullscreenchange", () => {
    nativeFullscreen = Boolean(document.fullscreenElement);
    schedule();
  }, true);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", schedule, { passive: true });
  schedule();
})();
