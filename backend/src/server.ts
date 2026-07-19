import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import path from "path";
import { env } from "./lib/env";
import { prisma } from "./lib/prisma";
import { errorHandler } from "./middleware/errorHandler";
import { renderIndexHtml } from "./lib/renderIndex";
import { startExpireHoldsJob } from "./jobs/expireHolds";
import { startReminderJob } from "./jobs/sendReminders";

import authRoutes from "./routes/auth";
import catalogRoutes from "./routes/catalog";
import availabilityRoutes from "./routes/availability";
import bookingRoutes from "./routes/bookings";
import paymentRoutes from "./routes/payments";
import reviewRoutes from "./routes/reviews";
import classRequestRoutes from "./routes/classRequests";
import adminRoutes from "./routes/admin";

const app = express();

// uploaded images (gallery/logo/profile) are served from object storage,
// which is a different origin than the app itself — CSP img-src must
// explicitly allow it or every uploaded photo silently fails to render
function objectStorageOrigin(): string | null {
  const url = env.objectStorage.publicUrlBase || env.objectStorage.endpoint;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const uploadsOrigin = objectStorageOrigin();

app.use(compression());
app.use(
  // the frontend is a hand-authored single HTML file with inline <script>,
  // inline <style>, and inline onclick/onchange/onerror="..." attributes
  // (design/markup is intentionally kept as-is — see project README) rather
  // than bundled assets, so script-src/script-src-attr/style-src all need
  // 'unsafe-inline'; the only third-party resource in use is Google Fonts,
  // and the favicon is an inline data: URI. CSP is defense-in-depth here —
  // it does not itself stop injected <script> content (that's handled by
  // escaping user data with textContent/esc() everywhere it's rendered),
  // but it still buys real protection: no object-src, no cross-origin
  // form submission, frame-ancestors clickjacking protection, etc.
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", ...(uploadsOrigin ? [uploadsOrigin] : [])],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(
  cors({
    origin: env.frontendBaseUrl,
  })
);
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/class-requests", classRequestRoutes);
app.use("/api/admin", adminRoutes);

// actually checks the database, not just "is the Node process alive" — a
// static {ok:true} would keep reporting healthy even if Postgres were
// unreachable, which is exactly the failure an uptime monitor needs to catch
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (err) {
    console.error("Health check failed — database unreachable:", err);
    res.status(503).json({ ok: false, error: "database unreachable" });
  }
});

// generated (not a static file) so it always reflects FRONTEND_BASE_URL —
// once the real domain is set in .env this is automatically correct, no
// separate file to remember to update
app.get("/sitemap.xml", (_req, res) => {
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>${env.frontendBaseUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
      `</urlset>\n`
  );
});

// server-rendered (not static) so og:image/og:url/og:site_name and the
// JSON-LD telephone/address/image are already correct in the very first
// response — link-preview bots (Telegram, WhatsApp, Instagram, ...) fetch
// raw HTML and never run the client-side JS that used to be the only thing
// filling these in
app.get("/", async (_req, res, next) => {
  try {
    const html = await renderIndexHtml();
    res.type("html").send(html);
  } catch (err) {
    next(err);
  }
});

// serve the (design-untouched) public frontend + admin dashboard
const publicDir = path.join(__dirname, "..", "..", "public");
app.use(
  express.static(publicDir, {
    setHeaders: (res, filePath) => {
      // local-disk uploads are dev-only (production uses object storage —
      // see lib/objectStorage.ts) but filenames are random UUIDs, so it's
      // still safe to cache them aggressively even here
      if (filePath.includes(`${path.sep}uploads${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);
app.use("/admin", (_req, res, next) => {
  // belt-and-suspenders alongside robots.txt and the <meta robots> tag —
  // this is the one that actually can't be missed by a crawler
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.use("/admin", express.static(path.join(__dirname, "..", "..", "admin-panel")));

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`Server listening on http://localhost:${env.port}`);
  startExpireHoldsJob();
  startReminderJob();
});
