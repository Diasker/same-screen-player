import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isSupportedLocalVideoFile } from "../src/shared/types";

export async function loadLocalVideoDirectory(preferenceFile: string): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await fs.readFile(preferenceFile, "utf8"));
    if (!saved || typeof saved !== "object") return undefined;
    const filePath = (saved as { filePath?: unknown }).filePath;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return undefined;
    const metadata = await fs.stat(filePath);
    if (!isSupportedLocalVideoFile(filePath, metadata.isFile())) return undefined;
    await fs.access(filePath, constants.R_OK);
    return path.dirname(filePath);
  } catch {
    return undefined;
  }
}

export async function saveLocalVideoPath(preferenceFile: string, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(preferenceFile), { recursive: true });
  await fs.writeFile(preferenceFile, JSON.stringify({ filePath }, null, 2), "utf8");
}
