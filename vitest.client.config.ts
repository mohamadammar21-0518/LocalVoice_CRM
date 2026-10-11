import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  plugins: [react()],
  root,
  resolve: {
    alias: {
      "@": path.resolve(root, "client", "src"),
      "@shared": path.resolve(root, "shared"),
      "@assets": path.resolve(root, "attached_assets"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./client/src/test/setup.ts"],
    include: ["client/src/**/*.test.tsx", "client/src/**/*.test.ts"],
  },
});
