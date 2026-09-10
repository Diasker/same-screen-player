import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocalVideoDirectory, saveLocalVideoPath } from "./local-video-preferences";

describe("local video directory preference", () => {
  let directory: string;
  let preferenceFile: string;
  let videoFile: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "same-screen-local-video-"));
    preferenceFile = path.join(directory, "settings", "last-local-video.json");
    videoFile = path.join(directory, "视频 sample.MP4");
    await fs.writeFile(videoFile, "test");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("persists the selected file and returns its directory on a fresh read", async () => {
    await saveLocalVideoPath(preferenceFile, videoFile);
    expect(JSON.parse(await fs.readFile(preferenceFile, "utf8"))).toEqual({ filePath: videoFile });
    expect(await loadLocalVideoDirectory(preferenceFile)).toBe(directory);
  });

  it("uses the latest selection", async () => {
    await saveLocalVideoPath(preferenceFile, videoFile);
    const nextDirectory = path.join(directory, "next");
    await fs.mkdir(nextDirectory);
    const nextFile = path.join(nextDirectory, "clip.webm");
    await fs.writeFile(nextFile, "test");
    await saveLocalVideoPath(preferenceFile, nextFile);
    expect(await loadLocalVideoDirectory(preferenceFile)).toBe(nextDirectory);
  });

  it("falls back to the system default when the file was moved or deleted", async () => {
    await saveLocalVideoPath(preferenceFile, videoFile);
    await fs.rename(videoFile, path.join(directory, "moved.mp4"));
    expect(await loadLocalVideoDirectory(preferenceFile)).toBeUndefined();
  });

  it("ignores missing, corrupt, relative, and non-file preferences", async () => {
    expect(await loadLocalVideoDirectory(preferenceFile)).toBeUndefined();
    await fs.mkdir(path.dirname(preferenceFile));
    for (const content of ["broken JSON", "null", JSON.stringify({ filePath: "relative.mp4" }), JSON.stringify({ filePath: directory })]) {
      await fs.writeFile(preferenceFile, content);
      expect(await loadLocalVideoDirectory(preferenceFile)).toBeUndefined();
    }
  });
});
