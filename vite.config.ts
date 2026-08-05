import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const IS_MOBILE = process.env.TAURI_MOBILE === "1";

export default defineConfig({
  plugins: [react()],

  root: IS_MOBILE ? "src-mobile" : ".",
  build: {
    outDir: "dist",
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port: 9998,
    strictPort: false,
    host: "127.0.0.1",
    hmr: IS_MOBILE ? undefined : {
      protocol: "ws",
      host: "127.0.0.1",
      port: 9998,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
