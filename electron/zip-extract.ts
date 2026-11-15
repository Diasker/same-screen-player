import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export async function extractZipEntry(
  zipPath: string,
  matcher: (entryName: string) => boolean,
  destinationPath: string
): Promise<boolean> {
  const handle = await fs.open(zipPath, "r");
  let tempPath: string | null = null;
  try {
    const stats = await handle.stat();
    const fileSize = stats.size;
    if (fileSize < 22) return false;

    const tailSize = Math.min(fileSize, 65557);
    const tailOffset = fileSize - tailSize;
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, tailOffset);

    let eocdPos = -1;
    for (let i = tailSize - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tailSize) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos < 0) {
      throw new Error("无效的 ZIP 归档文件（缺少目录尾）");
    }

    const cdSize = tail.readUInt32LE(eocdPos + 12);
    const cdOffset = tail.readUInt32LE(eocdPos + 16);
    if (cdOffset + cdSize > fileSize) {
      throw new Error("ZIP 目录偏移超出文件范围");
    }

    const cdBuffer = Buffer.alloc(cdSize);
    await handle.read(cdBuffer, 0, cdSize, cdOffset);

    let cursor = 0;
    let found: {
      method: number;
      compressedSize: number;
      localHeaderOffset: number;
    } | null = null;

    while (cursor + 46 <= cdBuffer.length) {
      if (cdBuffer.readUInt32LE(cursor) !== CD_SIGNATURE) break;
      const method = cdBuffer.readUInt16LE(cursor + 10);
      const compressedSize = cdBuffer.readUInt32LE(cursor + 20);
      const nameLen = cdBuffer.readUInt16LE(cursor + 28);
      const extraLen = cdBuffer.readUInt16LE(cursor + 30);
      const commentLen = cdBuffer.readUInt16LE(cursor + 32);
      const localHeaderOffset = cdBuffer.readUInt32LE(cursor + 42);
      const entryName = cdBuffer.toString("utf8", cursor + 46, cursor + 46 + nameLen);
      cursor += 46 + nameLen + extraLen + commentLen;
      if (!entryName.endsWith("/") && matcher(entryName)) {
        found = { method, compressedSize, localHeaderOffset };
        break;
      }
    }

    if (!found) return false;
    if (found.method !== 0 && found.method !== 8) {
      throw new Error(`不支持的 ZIP 压缩方式: ${found.method}`);
    }

    const localHeader = Buffer.alloc(30);
    await handle.read(localHeader, 0, 30, found.localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new Error("无效的 ZIP 本地文件头");
    }
    const localNameLen = localHeader.readUInt16LE(26);
    const localExtraLen = localHeader.readUInt16LE(28);
    const dataStart = found.localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + found.compressedSize > fileSize) {
      throw new Error("ZIP 数据区超出文件范围");
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    tempPath = `${destinationPath}.part-${Date.now()}`;

    if (found.compressedSize === 0 && found.method === 0) {
      await fs.writeFile(tempPath, Buffer.alloc(0));
    } else {
      const source = createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + found.compressedSize - 1,
      });
      const sink = createWriteStream(tempPath);
      if (found.method === 8) {
        await pipeline(source, createInflateRaw(), sink);
      } else {
        await pipeline(source, sink);
      }
    }

    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
