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
  }, 45000);
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
        window.sendVideoCommand = (type) => guest.send("video-command", { type });
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
