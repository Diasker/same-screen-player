import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";

type HelperCommand =
  | { action: "style" | "show" | "hide"; hwnd: number }
  | { action: "stylePid"; pid: number }
  | { action: "bounds"; hwnd: number; x: number; y: number; width: number; height: number };

export class WindowsWindowHelper {
  private process: ChildProcess | null = null;
  private readonly pending: Array<(value: { ok: boolean; error?: string }) => void> = [];

  constructor(private readonly scriptPath: string) {}

  start(): boolean {
    if (process.platform !== "win32" || this.process) return process.platform !== "win32";
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      this.process = child;
      if (!child.stdout) return false;
      const reader = readline.createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        const resolve = this.pending.shift();
        if (!resolve) return;
        try {
          resolve(JSON.parse(line) as { ok: boolean; error?: string });
        } catch {
          resolve({ ok: false, error: "Windows helper returned invalid data" });
        }
      });
      this.process.once("exit", () => {
        this.process = null;
        while (this.pending.length) this.pending.shift()?.({ ok: false, error: "Windows helper exited" });
      });
      return true;
    } catch {
      this.process = null;
      return false;
    }
  }

  send(command: HelperCommand): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "Windows helper is only available on Windows" });
    if (!this.process && !this.start()) return Promise.resolve({ ok: false, error: "Unable to start Windows window helper" });
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.process?.stdin?.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.pending.splice(0).forEach((resolve) => resolve({ ok: false, error: "Windows helper stopped" }));
  }
}

export function helperPath(root: string): string {
  return path.join(root, "windows-window-helper.ps1");
}
