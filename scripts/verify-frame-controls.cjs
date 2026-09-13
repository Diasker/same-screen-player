const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function launchCheck() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-controls-"));
  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, profile], {
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runCheck() {
  const { app, BrowserWindow, webFrameMain } = require("electron");
  const { frameVideoBridgeScript } = require("../dist-electron/electron/frame-video-bridge.js");
  app.setPath("userData", process.argv[2]);
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => {
    console.error("Timed out verifying frame controls");
    app.exit(1);
  }, 90000);
  await app.whenReady();

  const preload = pathToFileURL(path.join(__dirname, "../dist-electron/electron/guest-preload.js")).href;
  const fixture = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/host") {
      response.end(`<!doctype html><body><script>
        const guest = document.createElement("webview");
        guest.setAttribute("preload", ${JSON.stringify(preload)});
        guest.style.cssText = "width:800px;height:500px";
        window.playback = null;
        window.commandResults = [];
        guest.addEventListener("ipc-message", (event) => {
          if (event.channel === "video-state") window.playback = event.args[0];
          if (event.channel === "focus-diagnostic" && event.args[0].kind === "frame-command") {
            window.commandResults.push(event.args[0].result);
          }
        });
        window.sendVideoCommand = (type, value) => guest.send("video-command", { type, value });
        guest.src = "/parent";
        document.body.appendChild(guest);
      </script>`);
    } else if (request.url === "/parent") {
      response.end(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style>
        <iframe src="http://localhost:${fixture.address().port}/player" allow="autoplay"></iframe>`);
    } else if (request.url === "/nested") {
      response.end(`<!doctype html><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style>
        <iframe src="http://localhost:${fixture.address().port}/parent" allow="autoplay"></iframe>`);
    } else {
      response.end(`<!doctype html><style>body{margin:0}video{width:100vw;height:100vh}</style>
        <video muted autoplay playsinline></video><script>
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext("2d");
          setInterval(() => {
            context.fillStyle = "#184030";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "white";
            context.fillText(String(performance.now()), 20, 30);
          }, 40);
          const video = document.querySelector("video");
          video.srcObject = canvas.captureStream(25);
          video.play().catch(console.error);
        </script>`);
    }
  });
  await new Promise((resolve) => fixture.listen(0, resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const host = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  let guest;
  const injectBridge = (frame) => {
    if (frame && !frame.isDestroyed()) void frame.executeJavaScript(frameVideoBridgeScript()).catch(() => undefined);
  };
  host.webContents.on("will-attach-webview", (_event, preferences) => {
    preferences.backgroundThrottling = false;
  });
  host.webContents.on("did-attach-webview", (_event, contents) => {
    guest = contents;
    contents.on("frame-created", (_frameEvent, details) => injectBridge(details.frame));
    contents.on("did-frame-finish-load", (_frameEvent, _isMainFrame, processId, routingId) => {
      injectBridge(webFrameMain.fromId(processId, routingId));
    });
  });

  const readHost = (expression) => host.webContents.executeJavaScript(expression);
  const eventually = async (probe, message) => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (await probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
  };

  try {
    await host.loadURL(`${origin}/host`);
    for (const route of ["/parent", "/nested", "/player"]) {
      await eventually(() => Boolean(guest), "Guest was not attached");
      await readHost("window.playback = null; window.commandResults = []");
      await guest.loadURL(`${origin}${route}`);
      await eventually(() => readHost("window.playback?.hasVideo && window.playback.playing"), `${route}: initial playback missing`);
      const player = guest.mainFrame.framesInSubtree.find((frame) => frame.url === `${origin}/player` || frame.url === `http://localhost:${fixture.address().port}/player`);
      assert.ok(player, `${route}: player frame missing`);
      assert.equal(await player.executeJavaScript("document.querySelector('video').paused"), false);
      await guest.executeJavaScript("window.lastFramePacket=null;window.addEventListener('message',e=>{if(e.data?.source==='same-screen-frame-video' && e.data.kind==='state')window.lastFramePacket=e.data})");

      await player.executeJavaScript("window.muteChanges=[];document.querySelector('video').addEventListener('volumechange',()=>window.muteChanges.push(document.querySelector('video').muted))");
      for (const muted of [false, true, false]) {
        await readHost(`window.sendVideoCommand('setMuted', ${muted})`);
        await eventually(() => player.executeJavaScript(`document.querySelector('video').muted === ${muted}`), `${route}: mute command not applied`);
        await eventually(() => readHost(`window.playback?.muted === ${muted}`), `${route}: mute acknowledgement missing`);
        const changes = await player.executeJavaScript("window.muteChanges.length");
        await new Promise(resolve => setTimeout(resolve, 1700));
        assert.equal(await player.executeJavaScript("window.muteChanges.length"), changes, `${route}: mute oscillated without user input`);
      }
      await player.executeJavaScript("document.querySelector('video').muted=true");
      await eventually(() => readHost("window.playback?.muted === true"), `${route}: native player mute not reflected`);
      const stale = await guest.executeJavaScript("window.lastFramePacket");
      await readHost("window.sendVideoCommand('setVolume', 0.6)");
      await eventually(() => player.executeJavaScript("!document.querySelector('video').muted && document.querySelector('video').volume===0.6"), `${route}: volume did not unmute`);
      await eventually(() => readHost("window.playback?.muted === false"), `${route}: volume mute state stale`);
      if (stale) {
        await player.executeJavaScript(`window.parent.postMessage(${JSON.stringify(stale)}, '*')`);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await readHost("window.playback.muted"), false, `${route}: stale iframe report overwrote acknowledged mute`);
      }
      console.log(`PASS ${route}: startup mute, repeated commands, native mute and volume, no oscillation`);

      for (const [command, paused] of [["pause", true], ["play", false], ["toggle", true], ["toggle", false]]) {
        await readHost(`window.sendVideoCommand(${JSON.stringify(command)})`);
        await eventually(() => player.executeJavaScript(`document.querySelector('video').paused === ${paused}`), `${route}: ${command} did not change the actual video's paused state`);
        await eventually(() => readHost(`window.playback?.playing === ${!paused} && window.playback?.userPauseIntent === ${paused}`), `${route}: ${command} did not update the host playback state`);
        const initialTime = await player.executeJavaScript("document.querySelector('video').currentTime");
        await new Promise((resolve) => setTimeout(resolve, 800));
        const finalTime = await player.executeJavaScript("document.querySelector('video').currentTime");
        if (paused) assert.ok(Math.abs(finalTime - initialTime) < 0.1, `${route}: time advanced after ${command}`);
        else assert.ok(finalTime > initialTime, `${route}: time did not advance after ${command}`);
        console.log(`PASS ${route}: ${command}, paused=${paused}, host state and media clock verified`);
      }
      await player.executeJavaScript("(()=>{const old=document.querySelector('video');const replacement=old.cloneNode();replacement.srcObject=old.srcObject;old.replaceWith(replacement);replacement.play().catch(()=>{})})()");
      await eventually(() => player.executeJavaScript("!document.querySelector('video').muted"), `${route}: replacement player lost the requested mute setting`);
      await eventually(() => readHost("window.playback?.hasVideo && !window.playback.muted"), `${route}: replacement player did not report`);
      console.log(`PASS ${route}: replacement player reinitialized once`);
      await readHost("window.sendVideoCommand('toggleMuted');window.sendVideoCommand('toggleMuted')");
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await player.executeJavaScript("document.querySelector('video').muted"), false, `${route}: fast toggles used an obsolete snapshot`);
      await player.executeJavaScript("(()=>{const v=document.querySelector('video');v.srcObject=null;v.src='data:video/mp4;base64,AAAA';v.load()})()");
      await eventually(() => player.executeJavaScript("!!document.querySelector('video').error"), `${route}: invalid media fixture did not fail`);
      await readHost("window.sendVideoCommand('play')");
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(await player.executeJavaScript("document.querySelector('video').muted"), false, `${route}: a media error changed the mute setting`);
      console.log(`PASS ${route}: rapid toggles and playback failure preserve mute intent`);
    }
  } finally {
    clearTimeout(deadline);
    host.destroy();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
  app.quit();
}

if (process.versions.electron) {
  runCheck().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
} else {
  launchCheck().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
