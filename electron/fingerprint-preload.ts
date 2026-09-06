import { webFrame } from "electron";
import { mainWorldFingerprintScript } from "./fingerprint";

try {
  void webFrame.executeJavaScript(mainWorldFingerprintScript(), false).catch(() => undefined);
} catch {
  // Fingerprint injection is best-effort; the auth window still loads normally.
}
