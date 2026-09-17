import { defineConfig } from "vite";

// The e2e harness page is only built when E2E is set, so production builds
// never include it.
const inputs = process.env.E2E
  ? { main: "index.html", harness: "e2e/harness/index.html" }
  : undefined;

export default defineConfig({
  build: {
    rollupOptions: { input: inputs },
  },
  worker: {
    format: "es",
  },
});
