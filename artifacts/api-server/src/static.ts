import express, { type Express } from "express";
import fs from "fs";
import path from "path";

// Serves the built translator UI under its base path in production. In
// development the Vite dev server serves the UI on its own port.
export function serveStatic(app: Express, distPath: string, basePath = "/cworks-drawing-translator") {
  if (!fs.existsSync(distPath)) {
    throw new Error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
  }

  app.use(
    basePath,
    express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // SPA fallback: always serve a fresh index.html so new asset hashes are picked up.
  app.get(`${basePath}/{*splat}`, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
  app.get("/", (_req, res) => res.redirect(`${basePath}/`));
}
