const esbuild = require("esbuild");
const path = require("path");

const root = path.join(__dirname, "..");

async function main() {
  const targets = [
    { in: "electron/guest-preload.ts", out: "dist-electron/electron/guest-preload.js" },
    { in: "electron/fingerprint-preload.ts", out: "dist-electron/electron/fingerprint-preload.js" },
  ];
  await Promise.all(
    targets.map((t) =>
      esbuild.build({
        entryPoints: [path.join(root, t.in)],
        outfile: path.join(root, t.out),
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "es2022",
        external: ["electron"],
        logLevel: "warning",
      })
    )
  );
  console.log("preloads bundled");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
