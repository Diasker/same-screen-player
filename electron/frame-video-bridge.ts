export function frameVideoBridgeScript(): string {
  return String.raw`(() => {
    if (window.top === window || window.__sameScreenFrameVideoBridge) return;
    window.__sameScreenFrameVideoBridge = true;
    const source = "same-screen-frame-video";
    const nativePlay = HTMLMediaElement.prototype.play;
    const nativePause = HTMLMediaElement.prototype.pause;
    const boundVideos = new WeakSet();
    const childStates = new Map();
    let lastState = "";
    let lastSentAt = 0;
    let commandVersion = 0;
    let pauseLocked = false;
    let lastFrameInteractionAt = 0;
    let lastCleanupAt = 0;

    function isVisible(video) {
      const style = window.getComputedStyle(video);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = video.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    }

    function collectVideos(root) {
      const direct = Array.from(root.querySelectorAll("video"));
      const largestDirectArea = direct.reduce((largest, video) => {
        const rect = video.getBoundingClientRect();
        return Math.max(largest, rect.width * rect.height);
      }, 0);
      if (direct.length > 0 && largestDirectArea > 4000) return direct;
      const videos = [];
      const seen = new Set(direct);
      videos.push(...direct);
      const queue = [root];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        current.querySelectorAll("video").forEach((video) => {
          if (!seen.has(video)) {
            seen.add(video);
            videos.push(video);
          }
        });
        current.querySelectorAll("*").forEach((element) => {
          if (element.shadowRoot) queue.push(element.shadowRoot);
        });
      }
      return videos;
    }

    function pickVideo() {
      const videos = collectVideos(document);
      const visible = videos.filter(isVisible).sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      });
      return visible[0] || videos.find((video) => video.readyState >= 1) || videos[0] || null;
    }

    function numberOr(value, fallback) {
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    }

    function snapshot() {
      const video = pickVideo();
      if (!video) return { playing: false, currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: true, hasVideo: false, videoWidth: 0, videoHeight: 0, readyState: 0, rate: 1 };
      let buffered = 0;
      try {
        if (video.buffered.length > 0) buffered = Math.max(0, video.buffered.end(video.buffered.length - 1));
      } catch {
      }
      return {
        playing: !video.paused && !video.ended,
        currentTime: Math.max(0, numberOr(video.currentTime, 0)),
        duration: Math.max(0, numberOr(video.duration, 0)),
        buffered,
        volume: Math.min(1, Math.max(0, numberOr(video.volume, 1))),
        muted: Boolean(video.muted),
        hasVideo: true,
        videoWidth: Math.max(0, Number(video.videoWidth) || 0),
        videoHeight: Math.max(0, Number(video.videoHeight) || 0),
        readyState: Math.max(0, Number(video.readyState) || 0),
        rate: Math.max(0.25, Math.min(4, numberOr(video.playbackRate, 1))),
      };
    }

    function publish(force) {
      const state = snapshot();
      if (!state.hasVideo) {
        lastState = "";
        return;
      }
      const serialized = JSON.stringify(state);
      const now = Date.now();
      if (!force && serialized === lastState && now - lastSentAt < 1000) return;
      lastState = serialized;
      lastSentAt = now;
      window.parent.postMessage({ source, kind: "state", state }, "*");
    }

    function attach(video) {
      if (boundVideos.has(video)) return;
      boundVideos.add(video);
      ["durationchange", "progress", "timeupdate", "volumechange", "ratechange", "loadedmetadata", "canplay", "pause", "ended"].forEach((eventName) => video.addEventListener(eventName, () => publish(true)));
      video.addEventListener("play", () => {
        if (pauseLocked && Date.now() - lastFrameInteractionAt >= 900) pauseVideo(video, commandVersion);
        publish(true);
      });
    }

    function isAdHint(element, rect, videoRect) {
      const identity = [element.id || "", typeof element.className === "string" ? element.className : "", element.getAttribute("src") || "", element.getAttribute("href") || "", element.getAttribute("aria-label") || "", element.getAttribute("title") || ""].join(" ");
      if (/\b(?:ad|ads|advert|advertisement|banner|sponsor|promo|promotion|popunder|popup|commercial)\b|广告|赞助|推广|优惠|折扣|弹窗/i.test(identity)) return true;
      if (/content-sync\.xyz|tsyndicate\.com|wishapptrack\.com|mengmei8\.com|twinrdengine\.com|marzaent\.com|trafficType=popunder/i.test(identity)) return true;
      const text = (element.textContent || "").trim().slice(0, 500);
      const interactive = /^(?:A|IFRAME|IMG|BUTTON)$/.test(element.tagName) || Boolean(element.querySelector("a, iframe, img, button"));
      return /discount|special offer|limited offer|click here|广告|赞助|推广|优惠|折扣|免费|casino|singtel/i.test(text)
        && interactive;
    }

    function isPlayerControl(element) {
      const identity = [element.id || "", typeof element.className === "string" ? element.className : ""].join(" ");
      return /(?:^|[-_\s])(?:control|controls|progress|volume|fullscreen|settings?|seek|timeline|tooltip)(?:$|[-_\s])/i.test(identity);
    }

    function intersects(left, right) {
      return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    }

    function cleanupAdOverlays() {
      const now = Date.now();
      if (now - lastCleanupAt < 800) return;
      lastCleanupAt = now;
      const video = pickVideo();
      if (!video) return;
      const videoRect = video.getBoundingClientRect();
      if (videoRect.width <= 2 || videoRect.height <= 2) return;
      let candidates = [];
      try {
        candidates = Array.from(document.querySelectorAll("[id], [class], [src], [href], [role='dialog'], iframe"));
      } catch {
        return;
      }
      candidates.forEach((element) => {
        if (element === video || element.contains(video) || video.contains(element) || isPlayerControl(element)) return;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
        if (style.position !== "absolute" && style.position !== "fixed" && style.position !== "sticky") return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2 || !intersects(rect, videoRect)) return;
        if (rect.width * rect.height > videoRect.width * videoRect.height * 0.85) return;
        if (!isAdHint(element, rect, videoRect)) return;
        element.style.setProperty("display", "none", "important");
      });
    }

    function childFrames() {
      try { return Array.from(document.querySelectorAll("iframe")); } catch { return []; }
    }

    function forwardCommand(command) {
      if (!command || typeof command !== "object") return;
      childFrames().forEach((frame) => {
        try { frame.contentWindow?.postMessage({ source, command }, "*"); } catch { }
      });
    }

    function playVideo(video, version) {
      try {
        const pending = nativePlay.call(video);
        pending?.catch(() => {
          if (version !== commandVersion || !video.paused) return;
          video.muted = true;
          void nativePlay.call(video).catch(() => undefined);
        });
      } catch {
      }
    }

    function pauseVideo(video, version) {
      try { nativePause.call(video); } catch { }
      [80, 220, 500].forEach((delay) => {
        window.setTimeout(() => {
          if (version !== commandVersion || video.ended || video.paused) return;
          try { nativePause.call(video); } catch { }
          publish(true);
        }, delay);
      });
    }

    function recentChildPlaying() {
      const now = Date.now();
      return childFrames().some((frame) => {
        const state = childStates.get(frame);
        return Boolean(state && state.hasVideo && now - state.receivedAt < 3000 && state.playing);
      });
    }

    function reportCommandResult(command, version) {
      const report = () => {
        const videos = collectVideos(document);
        window.parent.postMessage({
          source,
          kind: "command-result",
          result: {
            command: command.type,
            version,
            host: window.location.hostname,
            videoCount: videos.length,
            playingCount: videos.filter((candidate) => !candidate.paused && !candidate.ended).length,
            pauseLocked,
          },
        }, "*");
      };
      window.setTimeout(report, 120);
      window.setTimeout(report, 700);
    }

    function scan() {
      const videos = collectVideos(document);
      videos.forEach(attach);
      if (pauseLocked) videos.forEach((candidate) => {
        if (!candidate.paused && !candidate.ended) {
          try { nativePause.call(candidate); } catch { }
        }
      });
      cleanupAdOverlays();
      publish(false);
    }

    function runCommand(command) {
      if (!command || typeof command !== "object") return;
      commandVersion += 1;
      const version = commandVersion;
      const videos = collectVideos(document);
      const video = pickVideo();
      const localPlaying = videos.some((candidate) => !candidate.paused && !candidate.ended);
      try {
        if (command.type === "play") {
          pauseLocked = false;
          if (video) playVideo(video, version);
          forwardCommand(command);
        }
        else if (command.type === "pause") {
          pauseLocked = true;
          videos.forEach((candidate) => pauseVideo(candidate, version));
          forwardCommand(command);
        }
        else if (command.type === "toggle") {
          const shouldPause = recentChildPlaying() || (!childFrames().some((frame) => childStates.has(frame)) && localPlaying);
          const action = shouldPause ? { type: "pause" } : { type: "play" };
          pauseLocked = shouldPause;
          if (shouldPause) videos.forEach((candidate) => pauseVideo(candidate, version));
          else if (video) playVideo(video, version);
          forwardCommand(action);
        } else {
          if (command.type === "seek" && Number.isFinite(command.value) && video) video.currentTime = Math.max(0, command.value);
          else if (command.type === "setVolume" && Number.isFinite(command.value) && video) video.volume = Math.min(1, Math.max(0, command.value));
          else if (command.type === "toggleMuted" && video) video.muted = !video.muted;
          else if (command.type === "setMuted" && typeof command.value === "boolean" && video) video.muted = command.value;
          else if (command.type === "setRate" && Number.isFinite(command.value) && video) video.playbackRate = Math.min(4, Math.max(0.25, command.value));
          forwardCommand(command);
        }
      } catch {
      }
      publish(true);
      reportCommandResult(command, version);
    }

    window.addEventListener("message", (event) => {
      const value = event.data;
      if (!value || value.source !== source) return;
      if (event.source !== window.parent) {
        if (value.kind === "state") {
          const frame = childFrames().find((candidate) => candidate.contentWindow === event.source);
          if (frame && value.state && typeof value.state === "object") childStates.set(frame, { ...value.state, receivedAt: Date.now() });
        }
        window.parent.postMessage(value, "*");
        return;
      }
      runCommand(value.command);
    });
    function start() {
      window.addEventListener("pointerdown", () => { lastFrameInteractionAt = Date.now(); if (pauseLocked) pauseLocked = false; }, true);
      scan();
      const observer = new MutationObserver(scan);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.setInterval(scan, 500);
    }

    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  })();`;
}
