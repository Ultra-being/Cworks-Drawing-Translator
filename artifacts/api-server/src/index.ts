// Cworks Drawing Translator — API server entry point.
//
// Split out of the Navigator monorepo on 2026-09-14. This server hosts only
// the standalone translator: `/api/cworks-translator/*` (password gate is
// enforced inside the router) plus the background translation worker.
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "node:url";
import cworksTranslationRouter from "./routes/cworksTranslation";
import { startCworksTranslationWorker } from "./cworks-translator/worker";
import { serveStatic } from "./static";
import { logger } from "./lib/logger";

const app = express();
const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Replit routes requests through a reverse proxy in all environments
app.set("trust proxy", 1);
const httpServer = createServer(app);

declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
    userId: string;
    username: string;
    clientId: string;
    role: string;
    loginAt: number;
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set");
}

const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({
      conString: process.env.DATABASE_URL,
      // Own table so translator sessions never mix with Navigator's.
      tableName: "cworks_translator_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
    proxy: process.env.NODE_ENV === "production",
  }),
);

// Health checks must be before anything else so the platform can probe them.
app.get(["/health", "/api/healthz"], (_req, res) => {
  res.status(200).json({ status: "ok", ts: Date.now() });
});

// Request log: metadata only. Responses carry client drawing content and
// must never reach application logs.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }, "request");
    }
  });
  next();
});

app.use("/api/cworks-translator", cworksTranslationRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  logger.error({ err, status }, "unhandled error");
  res.status(status).json({ message: status === 500 ? "Internal Server Error" : err.message });
});

if (process.env.NODE_ENV === "production") {
  serveStatic(app, path.resolve(artifactRoot, "..", "cworks-drawing-translator", "dist", "public"));
}

startCworksTranslationWorker();

const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen({ port, host: "0.0.0.0" }, () => {
  logger.info(`Cworks Drawing Translator API serving on port ${port}`);
});
