const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

if (process.versions.electron) {
  const { app, dialog } = require("electron");
  app.setAppPath(projectRoot);
  app.setPath("userData", process.argv[2]);
  global.localVideoPicker = { next: { canceled: true, filePaths: [] }, options: [] };
  dialog.showOpenDialog = async (options) => {
    global.localVideoPicker.options.push(options);
    return global.localVideoPicker.next;
  };
  require(path.join(projectRoot, "dist-electron/electron/main.js"));
} else {
  runChecks().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function runChecks() {
  const { _electron: electron, expect } = require("@playwright/test");
  const temporaryRoot = path.resolve(os.tmpdir());
  const profile = await fs.mkdtemp(path.join(temporaryRoot, "same-screen-load-check-"));
  let retrySucceeds = false;
  let pendingResponse;
  const videoPage = `<!doctype html><body><video autoplay muted></video><script>
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext("2d");
    setInterval(() => { context.fillStyle = "green"; context.fillRect(0, 0, 320, 180); }, 40);
    document.querySelector("video").srcObject = canvas.captureStream(25);
  </script>`;
  const fixture = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/status/500" });
      response.end();
    } else if (request.url === "/slow") {
      pendingResponse = response;
    } else if (request.url === "/challenge") {
      response.writeHead(403);
      response.end('<!doctype html><title>Just a moment...</title><input name="cf-turnstile-response">');
    } else if (request.url === "/frames") {
      response.end(`${videoPage}<iframe src="/status/403"></iframe><img src="/status/404">`);
    } else {
      const statusCode = request.url.startsWith("/status/") ? Number(request.url.split("/").pop()) : request.url === "/retry" && !retrySucceeds ? 500 : 200;
      response.writeHead(statusCode);
      response.end(statusCode >= 400 ? `<!doctype html><title>Failure</title>HTTP ${statusCode}` : videoPage);
    }
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  let application;
  const launch = async () => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.VITE_DEV_SERVER_URL;
    application = await electron.launch({ args: [__filename, profile], env: environment, timeout: 20000 });
    const page = await application.firstWindow();
    await expect(page.locator(".url-editor input")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.desktop.getRuntimeFlags()), { debugOverlays: false });
    return page;
  };

  try {
    let page = await launch();
    await page.locator(".url-editor input").fill(`${origin}/status/404`);
    await page.locator(".open-button").click();
    const alert = page.locator('.pane-notice[role="alert"]');
    await expect(alert).toContainText("HTTP 404");
    const navigate = (url) => page.evaluate((target) => { void document.querySelector("webview").loadURL(target).catch(() => undefined); }, url);
    for (const statusCode of [401, 403, 451, 500, 502, 503, 504]) {
      await navigate(`${origin}/status/${statusCode}`);
      await expect(alert).toContainText(`HTTP ${statusCode}`);
    }
    await page.waitForTimeout(2200);
    await expect(alert).toContainText("HTTP 504");
    await page.getByRole("button", { name: "切到应用层 · F8", exact: true }).click();
    await expect(alert).toBeVisible();
    await page.getByRole("button", { name: "切回网页层 · F8", exact: true }).click();
    console.log("PASS HTTP errors remain visible in production and both interaction modes");

    await navigate(`${origin}/retry`);
    await expect(alert).toContainText("HTTP 500");
    retrySucceeds = true;
    await alert.getByRole("button", { name: "重试", exact: true }).click();
    await expect(alert).toHaveCount(0);
    const guestPlaying = () => application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
      return guest?.executeJavaScript("Boolean(document.querySelector('video') && !document.querySelector('video').paused)");
    });
    await expect.poll(guestPlaying).toBe(true);
    console.log("PASS retry clears the error and restores actual video playback");

    await navigate(`${origin}/redirect`);
    await expect(alert).toContainText("HTTP 500");
    await navigate(`${origin}/frames`);
    await expect(alert).toHaveCount(0);
    await expect.poll(guestPlaying).toBe(true);
    await page.waitForTimeout(2200);
    await expect(alert).toHaveCount(0);
    await navigate(`${origin}/challenge`);
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
      return guest?.getTitle();
    })).toBe("Just a moment...");
    await expect(alert).toHaveCount(0);
    console.log("PASS redirect errors, subframe isolation and Cloudflare challenge handling");

    const closedServer = http.createServer();
    await new Promise((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    const closedUrl = `http://127.0.0.1:${closedServer.address().port}/missing`;
    await new Promise((resolve) => closedServer.close(resolve));
    await navigate(closedUrl);
    await expect(alert).toContainText("拒绝连接");
    await navigate(`${origin}/slow`);
    await expect.poll(() => Boolean(pendingResponse)).toBe(true);
    await navigate(`${origin}/good`);
    await expect.poll(guestPlaying).toBe(true);
    pendingResponse.writeHead(500);
    pendingResponse.end("old response");
    await page.evaluate((oldUrl) => {
      const event = new Event("did-fail-load");
      Object.assign(event, { isMainFrame: true, errorCode: -105, validatedURL: oldUrl });
      document.querySelector("webview").dispatchEvent(event);
    }, closedUrl);
    await expect(alert).toHaveCount(0);
    console.log("PASS connection failure and stale navigation errors");

    for (const [errorCode, errorDescription, expectedText] of [
      [-105, "ERR_NAME_NOT_RESOLVED", "域名"],
      [-106, "ERR_INTERNET_DISCONNECTED", "断开"],
      [-118, "ERR_CONNECTION_TIMED_OUT", "超时"],
    ]) {
      await page.evaluate(({ errorCode, errorDescription, url }) => {
        const event = new Event("did-fail-load");
        Object.assign(event, { isMainFrame: true, errorCode, errorDescription, validatedURL: url });
        document.querySelector("webview").dispatchEvent(event);
      }, { errorCode, errorDescription, url: `${origin}/good` });
      await expect(alert).toContainText(expectedText);
      await alert.getByRole("button", { name: "重试", exact: true }).click();
      await expect.poll(guestPlaying).toBe(true);
      await expect(alert).toHaveCount(0);
    }

    await page.getByRole("button", { name: "2 格", exact: true }).click();
    const panes = page.locator(".video-pane");
    await panes.nth(1).locator(".url-editor input").fill(`${origin}/status/404`);
    await panes.nth(1).locator(".open-button").click();
    await expect(panes.nth(1).locator('[role="alert"]')).toContainText("HTTP 404");
    await expect(panes.nth(0).locator('[role="alert"]')).toHaveCount(0);
    await page.getByRole("button", { name: "切到应用层 · F8", exact: true }).click();
    await panes.nth(1).locator(".pane-badge").click();
    await panes.nth(1).getByRole("textbox", { name: "视频网址", exact: true }).fill(`${origin}/good`);
    await panes.nth(1).getByRole("button", { name: "打开", exact: true }).click();
    await expect(panes.nth(1).locator('[role="alert"]')).toHaveCount(0);
    await page.getByRole("button", { name: "单屏", exact: true }).click();
    await page.getByRole("button", { name: "切回网页层 · F8", exact: true }).click();
    console.log("PASS simulated DNS, offline and timeout errors, pane isolation and address changes");

    const videoData = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(25);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();
      const timer = setInterval(() => { context.fillStyle = "green"; context.fillRect(0, 0, 320, 180); }, 40);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    const videoFile = path.join(profile, "本地视频 sample.webm");
    await fs.writeFile(videoFile, Buffer.from(videoData));
    await application.evaluate((_electron, filePath) => { global.localVideoPicker.next = { canceled: false, filePaths: [filePath] }; }, videoFile);
    await page.getByRole("button", { name: "切到应用层 · F8", exact: true }).click();
    await page.locator(".pane-badge").click();
    await page.getByRole("button", { name: "本地视频", exact: true }).click();
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === "webview");
      return guest?.executeJavaScript("Boolean(document.querySelector('video')?.videoWidth > 0)");
    })).toBe(true);
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, "last-local-video.json"), "utf8")).filePath, videoFile);
    await application.close();
    application = null;

    page = await launch();
    await expect(page.locator("webview")).toHaveCount(0);
    await page.getByRole("button", { name: "打开本地视频", exact: true }).click();
    await expect.poll(() => application.evaluate(() => global.localVideoPicker.options.length)).toBe(1);
    assert.equal(await application.evaluate(() => global.localVideoPicker.options[0].defaultPath), profile);
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, "last-local-video.json"), "utf8")).filePath, videoFile);
    await fs.rename(videoFile, path.join(profile, "moved.webm"));
    await page.getByRole("button", { name: "打开本地视频", exact: true }).click();
    await expect.poll(() => application.evaluate(() => global.localVideoPicker.options.length)).toBe(2);
    assert.equal(await application.evaluate(() => global.localVideoPicker.options[1].defaultPath), undefined);
    console.log("PASS local decoding, directory persistence across restart, cancellation and missing-file fallback");
  } finally {
    if (application) await application.close();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), temporaryRoot);
    assert.ok(path.basename(profile).startsWith("same-screen-load-check-"));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
