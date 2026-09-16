import { defineConfig, type PluginOption } from "vite";

// The e2e harness page is only built when E2E is set, so production builds
// never include it.
const inputs = process.env.E2E
  ? { main: "index.html", harness: "e2e/harness/index.html" }
  : undefined;

// Mirror of the Cloudflare `_headers` rules for vite preview so a
// freshly-built sw.js bypasses the browser's 24-hour update rule.
export const noCacheForServiceWorker: PluginOption = {
  name: "no-cache-for-sw",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      if (url === "/sw.js" || url === "/index.html" || url === "/") {
        res.setHeader("Cache-Control", "no-cache");
      }
      next();
    });
  },
};

export default defineConfig({
  build: {
    rollupOptions: { input: inputs },
  },
  worker: {
    format: "es",
  },
  plugins: [noCacheForServiceWorker],
});
