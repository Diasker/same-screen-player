const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { _electron: electron } = require("playwright");

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-playback-ui-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({ args: [path.join(__dirname, ".."), `--user-data-dir=${profile}`], env });
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath("userData"))), path.resolve(profile), "UI test must use a disposable profile");
    const page = await application.firstWindow();
    await application.evaluate(({ session }) => {
      session.fromPartition("persist:shared").protocol.handle("https", request => {
        const url = new URL(request.url);
        if (url.hostname === "api.bilibili.com") return new Response("{}", { headers: { "Access-Control-Allow-Origin": "*" } });
        const html = `<!doctype html><style>body{margin:0}video{width:100vw;height:100vh}</style><script>
          window.muteChanges=[];
          fetch('https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi').then(r=>{window.verified=r.status;if(!r.ok)throw new Error('verification');setTimeout(()=>{
            const video=document.createElement('video');video.muted=true;video.autoplay=true;
            const root=document.createElement('div');root.className='bpx-player-container';root.append(video);document.body.append(root);
            const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const context=canvas.getContext('2d');
            setInterval(()=>{context.fillStyle='green';context.fillRect(0,0,640,360);context.fillText(Date.now(),10,10)},40);
            video.srcObject=canvas.captureStream(20);video.addEventListener('volumechange',()=>window.muteChanges.push(video.muted));video.play().catch(e=>window.fixtureError=e.name);
          },2200)}).catch(e=>window.fixtureError=e.name);
          </script>`;
        return new Response(html, { status: 412, headers: { "Content-Type": "text/html; charset=utf-8" } });
      });
    });
    const input = page.getByPlaceholder("粘贴视频网址…").first();
    await input.fill("https://www.bilibili.com/video/verification-fixture");
    await input.press("Enter");
    await page.locator("webview").first().evaluate(view => { window.playbackRecords = []; view.addEventListener("ipc-message", event => { if (event.channel === "video-state") window.playbackRecords.push(event.args[0]); }); });
    await page.waitForFunction(() => document.querySelector('.pane-notice[role="alert"]')?.textContent.includes("412"));
    await page.waitForFunction(() => !document.querySelector('.pane-notice[role="alert"]'));
    const videoState = () => application.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getType() === "webview").executeJavaScript("({muted:document.querySelector('video').muted,time:document.querySelector('video').currentTime,changes:window.muteChanges.length})"));
    assert((await videoState()).time > 0.2, "412 cleared without real playback");
    await page.evaluate(() => {
      const view = document.querySelector("webview");
      const send = view.send.bind(view);
      window.muteCommands = 0;
      view.send = (channel, ...args) => { if (channel === "set-mute") window.muteCommands++; return send(channel, ...args); };
    });
    await page.getByRole("button", { name: /切到应用层/ }).click();
    await page.locator(".pane-control-trigger").first().hover();
    const mute = page.getByRole("button", { name: "切换静音" }).first();
    await mute.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="切换静音"]')?.textContent === "有声");
    await new Promise(resolve => setTimeout(resolve, 500));
    const initial = await videoState();
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal((await videoState()).muted, false);
    assert.equal((await videoState()).changes, initial.changes, "Mute changed without input");
    await application.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getType() === "webview").executeJavaScript("document.querySelector('video').muted=true"));
    await page.locator(".pane-control-trigger").first().hover();
    await page.waitForFunction(() => document.querySelector('[aria-label="切换静音"]')?.textContent === "静音");
    assert.equal(await page.evaluate(() => window.muteCommands), 0, "Host echoed observed mute state as a command");
    console.log("PASS: actual React UI recovers verified 412 playback, mute stays stable, native state never echoes commands");
  } catch (error) {
    if (application) {
      console.error(await application.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(contents => contents.getType() === "webview");
        return guest?.executeJavaScript("(()=>{const v=document.querySelector('video');return {verified:window.verified,error:window.fixtureError,video:!!v,time:v?.currentTime,ready:v?.readyState,width:v?.videoWidth,paused:v?.paused}})()");
      }).catch(() => null));
      const page = await application.firstWindow();
      console.error(await page.evaluate(() => ({ notice: document.querySelector('.pane-notice')?.textContent, playback: window.playbackRecords?.slice(-2) })).catch(() => null));
    }
    throw error;
  } finally {
    await application?.close();
    // The exact directory returned by mkdtemp is owned by this test.
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
