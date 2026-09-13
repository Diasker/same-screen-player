// Deliberate maintenance command; normal builds never require network access.
const { adsAndTrackingLists } = require("@ghostery/adblocker");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

async function main() {
  // The library's GitHub assets are test snapshots (some dated 2024), not live
  // subscriptions. Keep the selected lists but subscribe to their publishers.
  const urls = [...adsAndTrackingLists.map(url => {
    if (url.includes("/ublock-origin/")) return "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/" + url.split("/").at(-1);
    if (url.includes("/easylist/")) return "https://easylist-downloads.adblockplus.org/" + url.split("/").at(-1);
    if (url.includes("/peter-lowe/")) return "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext";
    throw new Error("Unrecognized subscription: " + url);
  }),
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt",
    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt",
    "https://easylist-downloads.adblockplus.org/easylistchina.txt",
  ];
  const resourcesUrl = "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json";
  const download = async (url) => {
    if (process.argv.includes("--windows-proxy")) {
      const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Invoke-WebRequest -UseBasicParsing -Uri '${url.replaceAll("'", "''")}' -TimeoutSec 30).Content`;
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, maxBuffer: 24 * 1024 * 1024 });
      if (stdout.length < 100 || /^\s*</.test(stdout)) throw new Error(`Invalid response: ${url}`);
      return { url, text: stdout };
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    const text = await response.text();
    if (text.length < 100 || /^\s*</.test(text)) throw new Error(`Invalid response: ${url}`);
    return { url, text };
  };
  const [lists, resources] = await Promise.all([Promise.all(urls.map(download)), download(resourcesUrl)]);
  JSON.parse(resources.text);
  const snapshot = {
    version: 1,
    engineVersion: "ghostery-2.18.2/abp-0.11.1/v1",
    updatedAt: new Date().toISOString(),
    lists, resources,
    checksum: createHash("sha256").update(JSON.stringify([lists, resources])).digest("hex"),
  };
  const output = path.join(__dirname, "../electron/adblock-assets/snapshot.json.gz");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, gzipSync(JSON.stringify(snapshot)));
  console.log(`Bundled ${lists.length} subscriptions and script resources (${snapshot.updatedAt})`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
