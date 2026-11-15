import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { extractZipEntry } from "./zip-extract";

function buildTestZip(entries: Array<{ name: string; content: Buffer; deflate: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = entry.deflate ? deflateRawSync(entry.content) : entry.content;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, compressed);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    cdParts.push(cd);
    offset += local.length + compressed.length;
  }

  const cdBuffer = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

describe("extractZipEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-zip-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts a deflated matching entry and ignores unmatched entries", async () => {
    const zipPath = path.join(tmpDir, "ffmpeg.zip");
    const destPath = path.join(tmpDir, "out", "ffmpeg.exe");
    const payload = Buffer.from("fake-ffmpeg-binary-payload-".repeat(200), "utf8");
    const zipBuf = buildTestZip([
      { name: "ffmpeg-master/README.txt", content: Buffer.from("readme"), deflate: false },
      { name: "ffmpeg-master/bin/ffmpeg.exe", content: payload, deflate: true },
    ]);
    await fs.writeFile(zipPath, zipBuf);

    const found = await extractZipEntry(zipPath, (name) => /(?:^|\/)bin\/ffmpeg\.exe$/i.test(name), destPath);
    expect(found).toBe(true);
    expect(await fs.readFile(destPath)).toEqual(payload);

    const missing = await extractZipEntry(zipPath, (name) => name.endsWith("ffprobe.exe"), path.join(tmpDir, "missing.exe"));
    expect(missing).toBe(false);
  });
});
