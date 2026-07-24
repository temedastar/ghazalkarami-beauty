import { chromium } from "@playwright/test";
import sharp from "sharp";
import path from "path";

// rendered at 2x and downsampled to the final 1200x630 for crisper
// anti-aliasing on the Persian text than a native 1x capture would give
async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });

  // og-card.html references /fonts/fonts.css root-relative (same as the
  // real site) — a file:// document resolves that against the filesystem
  // root, not ../public/fonts/, so intercept and serve straight from disk
  // instead. Keeps this script self-contained: no dev server, no network.
  const fontsDir = path.resolve("../public/fonts");
  await page.route("**/fonts/**", (route) => {
    const url = new URL(route.request().url());
    route.fulfill({ path: path.join(fontsDir, path.basename(url.pathname)) });
  });

  await page.goto("file://" + path.resolve("og-card.html"));
  await page.waitForTimeout(300); // let the self-hosted @font-face swap in
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();

  await sharp(buffer).resize(1200, 630).png({ quality: 90 }).toFile("../public/og-image.png");
  console.log("wrote public/og-image.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
