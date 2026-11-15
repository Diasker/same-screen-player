import { constants, promises as fs } from "node:fs";
import path from "node:path";

export type DownloadSettings = {
  downloadDir?: string;
  ytDlpPath?: string;
  ffmpegPath?: string;
};

async function isAccessibleDirectory(dirPath: unknown): Promise<string | undefined> {
  if (typeof dirPath !== "string" || !path.isAbsolute(dirPath)) return undefined;
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return undefined;
    await fs.access(dirPath, constants.W_OK);
    return dirPath;
  } catch {
    return undefined;
  }
}

async function isAccessibleFile(filePath: unknown): Promise<string | undefined> {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return undefined;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return undefined;
    await fs.access(filePath, constants.R_OK);
    return filePath;
  } catch {
    return undefined;
  }
}

export async function loadDownloadSettings(settingsFile: string): Promise<DownloadSettings> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(settingsFile, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const record = raw as Record<string, unknown>;
    const [downloadDir, ytDlpPath, ffmpegPath] = await Promise.all([
      isAccessibleDirectory(record.downloadDir),
      isAccessibleFile(record.ytDlpPath),
      isAccessibleFile(record.ffmpegPath),
    ]);
    return {
      ...(downloadDir ? { downloadDir } : {}),
      ...(ytDlpPath ? { ytDlpPath } : {}),
      ...(ffmpegPath ? { ffmpegPath } : {}),
    };
  } catch {
    return {};
  }
}

export async function saveDownloadSettings(settingsFile: string, settings: DownloadSettings): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
}
