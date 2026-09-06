import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  test: {
    exclude: ["dist-electron/**", "node_modules/**"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
