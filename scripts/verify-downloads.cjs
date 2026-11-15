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
  global.downloadDialogMock = { next: { canceled: true, filePaths: [] } };
  dialog.showOpenDialog = async (_winOrOpts, maybeOpts) => {
    const options = maybeOpts ?? _winOrOpts;
    if (options && Array.isArray(options.properties) && options.properties.includes("openDirectory")) {
      return global.downloadDialogMock.next;
    }
    return { canceled: true, filePaths: [] };
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
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-dl-ui-"));
  const customDownloadDir = path.join(profile, "custom-downloads");
  await fs.mkdir(customDownloadDir, { recursive: true });

  const sampleMp4 = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
  const bigChunk = Buffer.alloc(64 * 1024, 0x41);
  let slowStreamResponse = null;

  const server = http.createServer((req, res) => {
    if (req.url === "/watch") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><head><title>测试视频标题: Demo</title></head>
        <body>
          <video autoplay muted controls src="/video.mp4" style="width:640px;height:360px"></video>
          <a id="dl-link" href="/attachment.bin" download="网页附件.bin">下载附件</a>
        </body></html>`);
    } else if (req.url === "/video.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(sampleMp4.length),
      });
      res.end(sampleMp4);
    } else if (req.url === "/attachment.bin") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="attachment.bin"; filename*=UTF-8''${encodeURIComponent("网页附件.bin")}`,
        "Content-Length": String(bigChunk.length),
      });
      res.end(bigChunk);
    } else if (req.url === "/slow-watch") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>慢速视频</title></head><body><video src="/slow.mp4" style="width:400px;height:240px"></video></body></html>`);
    } else if (req.url === "/slow.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(1024 * 1024 * 10),
      });
      res.write(bigChunk);
      slowStreamResponse = res;
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let application;

  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;

    application = await electron.launch({
      args: [__filename, profile],
      env,
      timeout: 20000,
    });

    await application.evaluate(async (_electronApi, dir) => {
      global.downloadDialogMock.next = { canceled: false, filePaths: [dir] };
    }, customDownloadDir);

    const page = await application.firstWindow();
    await expect(page.locator(".url-editor input")).toBeVisible();

    // Load test video page
    await page.locator(".url-editor input").fill(`${origin}/watch`);
    await page.locator(".open-button").click();
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview");
      return guest?.getTitle();
    })).toBe("测试视频标题: Demo");

    // Open download popover from top header and change download dir
    await page.getByRole("button", { name: "下载", exact: true }).click();
    const popover = page.locator(".download-popover");
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: "更改", exact: true }).click();
    await expect(popover.locator(".download-dir-path")).toContainText(customDownloadDir);

    // Direct video fallback probe should populate filename & quality dropdown
    await expect(popover.locator('input[aria-label="保存文件名"]')).toHaveValue("测试视频标题_ Demo");
    await expect(popover.locator('select[aria-label="下载清晰度"]')).toContainText("原视频直链");

    await popover.getByRole("button", { name: "开始下载", exact: true }).click();
    const taskItem = popover.locator(".download-task-item").first();
    await expect(taskItem).toContainText("测试视频标题_ Demo.mp4");
    await expect(taskItem).toContainText("已完成");

    const downloadedBytes = await fs.readFile(path.join(customDownloadDir, "测试视频标题_ Demo.mp4"));
    assert.deepEqual(downloadedBytes, sampleMp4);
    console.log("PASS direct video probe, custom folder, and MP4 download verified");

    // Test browser will-download inside webview
    await popover.getByRole("button", { name: "关闭下载面板" }).click();
    await application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview");
      await guest.executeJavaScript("document.getElementById('dl-link').click()", true);
    });
    await page.getByRole("button", { name: "下载", exact: true }).click();
    await expect(popover.locator(".download-task-item", { hasText: "网页附件.bin" })).toContainText("已完成");
    const attachmentBytes = await fs.readFile(path.join(customDownloadDir, "网页附件.bin"));
    assert.equal(attachmentBytes.length, bigChunk.length);
    console.log("PASS browser will-download attachment intercepted and saved cleanly");

    // Test pane control bar download button in app mode + fullscreen visibility + cancel active task
    await popover.getByRole("button", { name: "关闭下载面板" }).click();
    await page.evaluate((url) => {
      void document.querySelector("webview").loadURL(url).catch(() => undefined);
    }, `${origin}/slow-watch`);
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview");
      return guest?.getTitle();
    })).toBe("慢速视频");

    await page.getByRole("button", { name: /切到应用层/ }).click();
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await page.locator(".pane-control-trigger").first().hover();
    await page.locator(".pane-download-button").click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('input[aria-label="保存文件名"]')).toHaveValue("慢速视频");
    await popover.getByRole("button", { name: "开始下载", exact: true }).click();

    const slowTask = popover.locator(".download-task-item", { hasText: "慢速视频.mp4" });
    await expect(slowTask).toBeVisible();
    await slowTask.getByRole("button", { name: "取消", exact: true }).click();
    await expect(slowTask).toContainText("已取消");
    console.log("PASS fullscreen pane download button and active task cancellation verified");
  } finally {
    if (slowStreamResponse && !slowStreamResponse.destroyed) {
      slowStreamResponse.destroy();
    }
    await application?.close().catch(() => undefined);
    server.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
}
