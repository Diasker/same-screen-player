// Opt-in live playback check. Uses a disposable profile and the app's proxy
// setting; never reads cookies or records complete browsing/request URLs.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function launch() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-live-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, profile, ...process.argv.slice(2)], { env, windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function run() {
  const { app, BrowserWindow, session, webFrameMain } = require("electron");
  const { AdblockEngine } = require("../dist-electron/electron/adblock-engine");
  const { AdblockService } = require("../dist-electron/electron/adblock-service");
  const { readSnapshot } = require("../dist-electron/electron/adblock-subscriptions");
  const { frameVideoBridgeScript } = require("../dist-electron/electron/frame-video-bridge");
  const { installFingerprintForSession, mainWorldFingerprintScript } = require("../dist-electron/electron/fingerprint");
  const { toElectronProxySettings } = require("../dist-electron/src/shared/types");
  app.setPath("userData", process.argv[2]);
  const deadline = setTimeout(() => app.exit(1), 180000);
  await app.whenReady();
  const snapshot = await readSnapshot(path.join(__dirname, "../electron/adblock-assets/snapshot.json.gz"));
  const engine = new AdblockEngine(snapshot.lists.map(list => list.text), snapshot.resources.text);
  const mode = process.argv[4] || "full";
  const cosmetics = engine.network.getCosmeticsFilters.bind(engine.network);
  engine.network.getCosmeticsFilters = (...args) => {
    const result = cosmetics(...args);
    if (mode === "network") return { ...result, scripts: [], styles: "", extended: [] };
    if (mode === "no-scripts") return { ...result, scripts: [] };
    return result;
  };
  const diagnostics = [];
  const service = new AdblockService({ engine: () => engine, enabled: () => mode !== "off", notify: event => diagnostics.push({ kind: "navigation", host: event.targetHost }), authenticate: () => false, diagnostic: entry => diagnostics.push(entry) });
  service.registerIpc();
  const targetSession = session.fromPartition("live-playback-check");
  let proxy = { mode: "system" };
  try { proxy = toElectronProxySettings(JSON.parse(await fs.readFile(path.join(app.getPath("appData"), "same-screen-player/proxy-settings.json"), "utf8"))); } catch { }
  await targetSession.setProxy(proxy);
  installFingerprintForSession(targetSession);
  service.prepareSession(targetSession, path.join(__dirname, "../dist-electron/electron/adblock-preload.js"));
  const responses = [];
  targetSession.webRequest.onCompleted(details => {
    if (details.statusCode >= 400 || /\/youtubei\/v1\/player|gaia-gateway|\/x\/player\//.test(details.url)) {
      const url = new URL(details.url);
      responses.push({ host: url.hostname, path: url.pathname, status: details.statusCode, type: details.resourceType });
    }
  });
  const host = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  let guest;
  host.webContents.on("will-attach-webview", (_event, preferences) => {
    Object.assign(preferences, { nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: true, contextIsolation: true, backgroundThrottling: false });
  });
  host.webContents.on("did-attach-webview", (_event, contents) => {
    guest = contents;
    service.attach("live-pane", guest, "https://www.youtube.com/");
    const inject = frame => { if (frame && !frame.isDestroyed()) void frame.executeJavaScript(mainWorldFingerprintScript() + "\n" + frameVideoBridgeScript()).catch(() => {}); };
    contents.on("frame-created", (_event, details) => inject(details.frame));
    contents.on("did-frame-finish-load", (_event, _top, processId, routingId) => inject(webFrameMain.fromId(processId, routingId)));
  });
  const preload = pathToFileURL(path.join(__dirname, "../dist-electron/electron/guest-preload.js")).href;
  await host.loadURL("data:text/html," + encodeURIComponent(`<webview partition="live-playback-check" preload="${preload}" src="about:blank" allowpopups style="width:1200px;height:780px"></webview>`));
  while (!guest || guest.isLoading()) await new Promise(resolve => setTimeout(resolve, 50));
  const site = process.argv[3] || "youtube";
  let url = site === "bilibili" ? "https://www.bilibili.com/video/BV1GJ411x7h7/" : "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  if (site === "bilibili" && process.argv.includes("--warm")) {
    await guest.loadURL("https://www.bilibili.com/");
    await new Promise(resolve => setTimeout(resolve, 5000));
    const candidate = await guest.executeJavaScript("Array.from(document.querySelectorAll('a[href]')).map(a=>a.href).find(href=>href.startsWith('https://www.bilibili.com/video/BV'))");
    if (candidate) url = candidate;
  }
  const samples = [];
  const controls = {};
  let loadError;
  await Promise.race([guest.loadURL(url, { httpReferrer: site === "bilibili" ? "https://www.bilibili.com/" : "https://www.youtube.com/" }).catch(error => { loadError = error.code || error.name; }), new Promise(resolve => setTimeout(resolve, 30000))]);
  for (let i = 0; i < 12; i++) {
    try {
      samples.push(await guest.executeJavaScript(`(()=>{const v=document.querySelector('video');if(v?.paused && !v.ended) v.play().catch(()=>{});return {video:!!v,time:v?.currentTime,paused:v?.paused,ready:v?.readyState,muted:v?.muted,ad:!!document.querySelector('.ad-showing'),mediaError:v?.error?.code,message:(document.querySelector('.ytp-error-content-wrap,.bpx-player-error-message,.error-text')?.textContent||'').trim().slice(0,250),title:document.title}})()`, true));
    } catch { }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const played = samples.filter((sample, i) => i > 0 && sample.video && !sample.ad && !sample.paused && sample.time > (samples[i - 1].time || 0) + 0.3).length >= 4;
  if (played && process.argv.includes("--extended")) {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const state = () => guest.executeJavaScript("(()=>{const v=document.querySelector('video');return {time:v?.currentTime,paused:v?.paused,muted:v?.muted,ready:v?.readyState}})()");
    guest.send("video-command", { type: "pause" });
    await wait(700);
    const paused = await state();
    await wait(1000);
    controls.pause = paused.paused && Math.abs((await state()).time - paused.time) < 0.1;
    guest.send("video-command", { type: "play" });
    await wait(1600);
    controls.resume = (await state()).time > paused.time + 0.3;
    guest.send("video-command", { type: "seek", value: 3 });
    await wait(2000);
    const sought = await state();
    controls.seek = sought.time >= 3 && sought.time < 7 && !sought.paused;
    guest.send("video-command", { type: "setMuted", value: true });
    await wait(700);
    controls.mute = (await state()).muted === true;
    guest.send("video-command", { type: "setMuted", value: false });
    await wait(1200);
    controls.unmute = (await state()).muted === false;
    if (site === "youtube") {
      const timeOrigin = await guest.executeJavaScript("performance.timeOrigin");
      const nextLink = await guest.executeJavaScript(`(()=>{
        const link=Array.from(document.querySelectorAll('#related a[href],a.ytp-next-button[href]')).find(a=>{try{return new URL(a.href).pathname==='/watch' && new URL(a.href).searchParams.get('v')!==new URL(location.href).searchParams.get('v') && a.getBoundingClientRect().width>5}catch{return false}});
        if(!link) throw new Error('No next-video link');link.scrollIntoView({block:'center'});
        const rect=link.getBoundingClientRect();return {id:new URL(link.href).searchParams.get('v'),x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
      })()`);
      guest.focus();
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: nextLink.x, y: nextLink.y });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: nextLink.x, y: nextLink.y });
      await wait(12000);
      const next = await state();
      await wait(2000);
      controls.spaNext = await guest.executeJavaScript(`new URL(location.href).searchParams.get('v')===${JSON.stringify(nextLink.id)} && performance.timeOrigin===${timeOrigin} && !document.querySelector('.ad-showing')`);
      controls.nextPlayback = !next.paused && (await state()).time > next.time + 0.3;
    }
  }
  console.log(JSON.stringify({ site, mode, electron: process.versions.electron, snapshot: snapshot.updatedAt, loadError, played, controls, samples: samples.filter((_sample, i) => i % 5 === 0 || i === samples.length - 1), responses: responses.slice(-20), diagnostics: [...new Map(diagnostics.map(entry => [entry.kind + entry.host + entry.rule, entry])).values()].slice(-30) }, null, 2));
  clearTimeout(deadline);
  service.dispose();
  host.destroy();
  app.exit(played && Object.values(controls).every(Boolean) ? 0 : 2);
}

if (process.versions.electron) run().catch(error => { console.error(error); require("electron").app.exit(1); });
else launch().catch(error => { console.error(error); process.exitCode = 1; });
