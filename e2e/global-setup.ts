import fs from "node:fs";
import path from "node:path";
import { type PreviewServer, preview } from "vite";
import { noCacheForServiceWorker } from "../vite.config.ts";

const PORT = 4174;
const FIXTURES_DIR = path.resolve("e2e/fixtures");
const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
};

let server: PreviewServer;

export async function setup() {
  server = await preview({
    preview: { port: PORT, strictPort: true },
    plugins: [
      noCacheForServiceWorker,
      {
        name: "e2e-fixtures",
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            // Requests under /hang/ are never answered, for timeout tests.
            if (url.pathname.startsWith("/hang/")) return;
            if (!url.pathname.startsWith("/fixtures/")) return next();
            const file = path.join(
              FIXTURES_DIR,
              path.normalize(url.pathname.slice("/fixtures/".length)),
            );
            if (!file.startsWith(FIXTURES_DIR) || !fs.existsSync(file)) {
              res.statusCode = 404;
              return res.end();
            }
            const type = CONTENT_TYPES[path.extname(file)];
            if (type) res.setHeader("Content-Type", type);
            fs.createReadStream(file).pipe(res);
          });
        },
      },
    ],
  });
  console.log(`Preview server started at http://localhost:${PORT}`);
}

export async function teardown() {
  await server?.close();
}
