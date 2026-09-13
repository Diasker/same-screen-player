const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function launch() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-adblock-"));
  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, profile], { env: environment, stdio: "inherit", windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    assert.equal(code, 0, "Electron integration process failed");
    assert.equal(await fs.readFile(path.join(profile, "passed"), "utf8"), "passed", "Electron exited before all checks completed");
  } finally {
    // mkdtemp returns the exact, task-owned directory; no user profile is touched.
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function run() {
  const { app, BrowserWindow, session } = require("electron");
  const { AdblockService } = require("../dist-electron/electron/adblock-service.js");
  const { AdblockEngine } = require("../dist-electron/electron/adblock-engine.js");
  const { readSnapshot } = require("../dist-electron/electron/adblock-subscriptions.js");
  app.setPath("userData", process.argv[2]);
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error("Adblock integration timed out"); app.exit(1); }, 90000);
  await app.whenReady();
  const requests = [];
  const notices = [];
  const disabled = new Set();
  const preload = path.join(__dirname, "../dist-electron/electron/adblock-preload.js");
  const guestPreload = pathToFileURL(path.join(__dirname, "../dist-electron/electron/guest-preload.js")).href;
  const snapshot = await readSnapshot(path.join(__dirname, "../electron/adblock-assets/snapshot.json.gz"));
  let origin;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    requests.push(url.pathname);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/host") {
      response.end(`<!doctype html><body style="margin:0"><script>
        window.playback = {};
        for(let i=1;i<=2;i++) {
          const view = document.createElement('webview');
          view.id='pane'+i; view.partition='persist:adblock-test'; view.preload=${JSON.stringify(guestPreload)};
          view.setAttribute('allowpopups',''); view.src='about:blank';
          view.style='width:800px;height:550px;display:flex';
          view.addEventListener('ipc-message',event=>{if(event.channel==='video-state') window.playback[i]=event.args[0]});
          document.body.append(view);
        }
      </script>`);
    } else if (url.pathname === "/ads.js") {
      response.setHeader("Content-Type", "application/javascript"); response.end("window.adRan=true;");
    } else if (url.pathname === "/ad-pixel" || url.pathname === "/ad-api" || url.pathname === "/ad-media") {
      response.end("advertisement");
    } else if (url.pathname === "/redirect-ad") {
      response.writeHead(302, { Location: "/advert-destination" }); response.end();
    } else if (url.pathname === "/redirect-normal") {
      response.writeHead(302, { Location: "/next" }); response.end();
    } else if (url.pathname === "/csp") {
      response.setHeader("Content-Security-Policy", "object-src 'none'");
      response.end("<!doctype html><p>CSP check</p>");
    } else if (url.pathname === "/next" || url.pathname === "/advert-destination" || url.pathname === "/unknown" || url.pathname === "/popup-only" || url.pathname === "/search") {
      response.end("<!doctype html><p id='destination'>Destination</p>");
    } else {
      const nested = url.pathname === "/page" ? `<iframe id="nested" src="http://localhost:${server.address().port}/frame" style="width:500px;height:200px"></iframe>` : url.pathname === "/frame" ? `<iframe src="${origin}/inner" style="width:400px;height:160px"></iframe>` : "";
      response.end(`<!doctype html><html><head><script>window.earlyScriptlet=window.__adblockEarly===true;</script></head>
        <body style="margin:0"><div class="banner">Banner advertisement</div><div class="sponsor">Sponsored content</div>
        <script src="/ads.js"></script><img src="/ad-pixel"><script>fetch('/ad-api').catch(()=>{});</script>
        <a id="next" href="${origin}/next" target="_blank">Next video</a>
        <a id="cross" href="http://localhost:${server.address().port}/next" target="_blank">Cross-site video</a>
        <a id="popup-rule" href="${origin}/popup-only" target="_blank">Popup rule</a>
        <a id="normal-redirect" href="/redirect-normal">Canonical URL</a>
        <a id="ad-redirect" href="/redirect-ad">Ad redirect</a>
        <form action="/search" target="_blank"><input name="q" value="video"><button id="search">Search</button></form>
        <div class="plyr" style="position:relative;width:320px;height:120px">
          <video id="video" muted autoplay style="width:320px;height:120px"></video>
          <button id="play-ad" style="position:absolute;top:0;left:0" onclick="window.open('/advert-destination')">Play ad</button>
          <button id="play-unknown" style="position:absolute;top:25px;left:0" onclick="window.open('/unknown')">Unknown popup</button>
          <button id="play-nav" style="position:absolute;top:50px;left:0" onclick="location.href='/unknown'">Same page</button>
          <button id="play-blank" style="position:absolute;top:75px;left:0" onclick="const w=window.open('about:blank');if(w)setTimeout(()=>w.location='/unknown',100)">Delayed popup</button>
        </div>${nested}
        <script>
          const canvas=document.createElement('canvas');canvas.width=320;canvas.height=120;
          const context=canvas.getContext('2d');
          setInterval(()=>{context.fillStyle='green';context.fillRect(0,0,320,120);context.fillText(Date.now(),10,10)},40);
          video.srcObject=canvas.captureStream(20);video.play().catch(()=>{});
          setTimeout(()=>{const ad=document.createElement('div');ad.className='banner';ad.id='dynamic-ad';ad.textContent='Dynamic ad';document.body.append(ad)},100);
        </script></body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const rules = [
    "/ads.js$script", "/ad-api$xmlhttprequest", "/ad-pixel$image", "/ad-media$media", "/advert-destination$document",
    "/popup-only$popup", "127.0.0.1,localhost##.banner", "127.0.0.1,localhost##.sponsor:has-text(Sponsored)",
    "127.0.0.1,localhost##+js(set-constant, __adblockEarly, true)", "/csp$csp=script-src 'none'",
    "||api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi", "||cm.bilibili.com/cm/api/",
  ];
  const engine = new AdblockEngine([rules.join("\n")], snapshot.resources.text);
  const service = new AdblockService({ engine: () => engine, enabled: pane => !disabled.has(pane), notify: notice => notices.push(notice), authenticate: () => false });
  service.registerIpc();
  const targetSession = session.fromPartition("persist:adblock-test");
  await targetSession.setProxy({ mode: "direct" });
  service.prepareSession(targetSession, preload);
  const host = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } });
  const guests = [];
  const guestReady = [];
  host.webContents.on("will-attach-webview", (_event, preferences) => {
    preferences.nodeIntegration = false; preferences.nodeIntegrationInSubFrames = true;
    preferences.sandbox = true; preferences.contextIsolation = true;
  });
  host.webContents.on("did-attach-webview", (_event, contents) => {
    guests.push(contents);
    guestReady.push(new Promise(resolve => contents.once("did-finish-load", resolve)));
    service.attach(`pane-${guests.length}`, contents, `${origin}/page`);
    contents.on("preload-error", (_event, file, error) => console.error("Preload error", file, error.message));
  });
  const eventually = async (probe, message, timeout = 6000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await probe()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(message);
  };
  const load = async (guest, route = "/page") => {
    await guest.loadURL(origin + route);
    await eventually(async () => guest.executeJavaScript("document.readyState==='complete'"), "Document did not complete");
  };
  const click = async (guest, selector) => {
    const point = await guest.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    guest.focus();
    guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  let exitCode = 0;
  try {
    await host.loadURL(origin + "/host");
    await eventually(() => guests.length === 2, "Webviews did not attach");
    await Promise.all(guestReady);
    const guest = guests[0];
    await load(guest);
    await eventually(async () => guest.mainFrame.framesInSubtree.length >= 3 && guest.mainFrame.framesInSubtree.every(frame => /\/(page|frame|inner)$/.test(frame.url)), "Nested frames did not load");
    for (const frame of guest.mainFrame.framesInSubtree) {
      await eventually(() => frame.executeJavaScript("document.querySelector('#dynamic-ad') && getComputedStyle(document.querySelector('#dynamic-ad')).display==='none'"), "Dynamic ad visible in " + frame.url);
      assert.equal(await frame.executeJavaScript("getComputedStyle(document.querySelector('.sponsor')).display"), "none", "Extended selector not applied");
      assert.equal(await frame.executeJavaScript("window.earlyScriptlet"), true, "Scriptlet missed the first inline script");
      assert.equal(await frame.executeJavaScript("typeof require + ':' + typeof process"), "undefined:undefined", "Node APIs leaked into a page");
      await frame.executeJavaScript("document.querySelector('.sponsor').textContent='Ordinary video information'");
      await eventually(() => frame.executeJavaScript("getComputedStyle(document.querySelector('.sponsor')).display !== 'none'"), "Reused content remained incorrectly hidden");
    }
    assert(!requests.includes("/ads.js") && !requests.includes("/ad-api") && !requests.includes("/ad-pixel"), "Ad resources reached the server");
    await guest.executeJavaScript("const adMedia=document.createElement('video');adMedia.src='/ad-media';adMedia.preload='auto';document.body.append(adMedia);adMedia.load();");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(!requests.includes("/ad-media"), "Media advertisement reached the server");
    console.log("PASS: network, document-start scriptlets, CSS, extended selectors, dynamic and nested frames, sandbox");

    for (const [selector, reason] of [["#play-ad", "rule"], ["#play-unknown", "playback"], ["#play-nav", "playback"], ["#play-blank", "playback"], ["#popup-rule", "rule"]]) {
      const count = notices.length;
      const previousTime = await guest.executeJavaScript("video.currentTime");
      await click(guest, selector);
      await eventually(() => notices.length > count, "No notice for " + selector);
      assert.equal(notices.at(-1).reason, reason, selector);
      assert.equal(guest.getURL(), origin + "/page", "Playback page was replaced");
      assert(!requests.includes("/advert-destination") && !requests.includes("/unknown") && !requests.includes("/popup-only"), "Popup destination reached server");
      await eventually(() => guest.executeJavaScript(`video.currentTime > ${previousTime}`), "Video stopped after popup blocking");
      assert(BrowserWindow.getAllWindows().every(window => window === host || !window.isVisible()), "Ad popup became visible");
    }
    const blocked = notices.at(-1);
    assert.equal(service.allow("pane-2", blocked.id), false, "Another pane consumed the permission");
    assert.equal(service.allow("pane-1", blocked.id), true);
    await eventually(() => guest.getURL().endsWith("/popup-only"), "One-time permission did not navigate");
    assert.equal(service.allow("pane-1", blocked.id), false, "One-time permission was reusable");
    console.log("PASS: playback popups, same-page hijack, delayed blank popups, native POPUP rules, one-time permission");

    for (const [selector, suffix] of [["#next", "/next"], ["#cross", "/next"], ["#normal-redirect", "/next"], ["#search", "/search?q=video"]]) {
      await load(guest);
      await click(guest, selector);
      await eventually(() => guest.getURL().endsWith(suffix), "Normal navigation blocked: " + selector);
      assert(guest.canGoBack(), "Navigation lost browser history");
    }
    await load(guest);
    const beforeRedirect = notices.length;
    await click(guest, "#ad-redirect");
    await eventually(() => notices.length > beforeRedirect, "Ad redirect was not blocked");
    assert(!requests.includes("/advert-destination"), "Ad redirect reached the server");
    console.log("PASS: normal links, cross-site links, new-tab routing, search, history, redirects");

    await load(guest, "/csp");
    const csp = await guest.executeJavaScript("fetch(location.href).then(r=>r.headers.get('content-security-policy'))");
    // fetch is an XHR and receives the site's original policy; inspect the actual
    // document via Chromium as well to prove both restrictions are enforced.
    assert(csp.includes("object-src 'none'"));
    assert.equal(await guest.executeJavaScript("new Promise(resolve=>{const s=document.createElement('script');s.textContent='window.cspBypassed=true';document.head.append(s);setTimeout(()=>resolve(window.cspBypassed===true),40)})"), false);
    await load(guest);
    console.log("PASS: existing CSP preserved and filter CSP enforced");

    disabled.add("pane-2");
    await load(guests[1]);
    assert.equal(await guests[1].executeJavaScript("getComputedStyle(document.querySelector('.banner')).display"), "block");
    assert.equal(await guests[1].executeJavaScript("window.adRan"), true);
    assert.equal(await guest.executeJavaScript("getComputedStyle(document.querySelector('.banner')).display"), "none");
    disabled.delete("pane-2");
    await load(guests[1]);
    assert.equal(await guests[1].executeJavaScript("getComputedStyle(document.querySelector('.banner')).display"), "none");
    console.log("PASS: switches remain independent in a shared Session");

    // A local HTTPS protocol fixture exercises the service's real request owner,
    // frame source and resource type checks without contacting Bilibili.
    const verificationRequests = [];
    const verification = "https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi";
    targetSession.protocol.handle("https", request => {
      const url = new URL(request.url);
      verificationRequests.push(url.hostname + url.pathname);
      const headers = { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" };
      if (url.hostname === "unrelated.example") return new Response('<iframe src="https://www.bilibili.com/verification"></iframe>', { headers });
      if (url.hostname === "www.bilibili.com") return new Response(`<script>
        window.done=false;
        Promise.all([fetch('${verification}').then(r=>window.verified=r.ok).catch(()=>window.verified=false),fetch('https://cm.bilibili.com/cm/api/ad').catch(()=>{})]).then(()=>window.done=true);
        </script><img src="${verification}?image">`, { headers });
      return new Response("{}", { headers });
    });
    await guest.loadURL("https://www.bilibili.com/verification");
    await eventually(() => guest.executeJavaScript("window.done"), "Verification request did not complete");
    assert.equal(await guest.executeJavaScript("window.verified"), true, "Bilibili verification was blocked");
    assert.equal(verificationRequests.filter(value => value.startsWith("api.bilibili.com")).length, 1, "Exception leaked to the image request");
    assert(!verificationRequests.some(value => value.startsWith("cm.bilibili.com")), "Bilibili ad API was exempted");
    verificationRequests.length = 0;
    await guest.loadURL("https://unrelated.example/verification");
    await eventually(async () => {
      const frame = guest.mainFrame.frames.find(frame => frame.url.startsWith("https://www.bilibili.com"));
      return frame && frame.executeJavaScript("window.done");
    }, "Embedded verification fixture did not finish");
    assert(!verificationRequests.some(value => value.startsWith("api.bilibili.com")), "Another top-level site borrowed Bilibili's exception");
    targetSession.protocol.unhandle("https");
    console.log("PASS: exact verification exception, ad blocking, request types and top-level ownership");
    console.log("Adblock integration passed");
    await fs.writeFile(path.join(process.argv[2], "passed"), "passed");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    service.dispose();
    host.destroy();
    await new Promise(resolve => server.close(resolve));
    app.exit(exitCode);
  }
}

if (process.versions.electron) run().catch(error => { console.error(error); require("electron").app.exit(1); });
else launch().catch(error => { console.error(error); process.exitCode = 1; });
