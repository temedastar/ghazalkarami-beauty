import express from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import path from "path";
import { env } from "./lib/env";
import { errorHandler } from "./middleware/errorHandler";
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
        imgSrc: ["'self'", "data:"],
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

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

// serve the (design-untouched) public frontend + admin dashboard
const publicDir = path.join(__dirname, "..", "..", "public");
app.use(express.static(publicDir));
app.use("/admin", express.static(path.join(__dirname, "..", "..", "admin-panel")));

app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`Server listening on http://localhost:${env.port}`);
  startExpireHoldsJob();
  startReminderJob();
});
