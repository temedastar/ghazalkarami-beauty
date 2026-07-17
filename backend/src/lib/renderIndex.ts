import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { env } from "./env";

const indexHtmlPath = path.join(__dirname, "..", "..", "..", "public", "index.html");

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Fills in og:image/og:url/og:site_name and the JSON-LD telephone/address/
 * image server-side, before the HTML ever leaves the server. The same
 * values were previously only patched in by client-side JS (see
 * loadSiteContent/loadContactInfo in index.html), which works fine for real
 * browsers but leaves them blank for link-preview bots (Telegram, WhatsApp,
 * Instagram, ...) that fetch the raw HTML without executing JavaScript.
 * The client-side JS still runs too — it just re-applies the same values,
 * which is harmless.
 */
export async function renderIndexHtml(): Promise<string> {
  let html = fs.readFileSync(indexHtmlPath, "utf8");

  const [siteContentRows, contact] = await Promise.all([
    prisma.siteContent.findMany(),
    prisma.contactInfo.findUnique({ where: { id: "singleton" } }),
  ]);
  const siteContent: Record<string, string> = {};
  siteContentRows.forEach((r) => {
    siteContent[r.key] = r.value;
  });

  // same fallback order as the client-side loadSiteContent()
  const rawOgImage = siteContent.ghazal_photo_url || siteContent.logo_url || "";
  const ogImage = rawOgImage ? new URL(rawOgImage, env.frontendBaseUrl).href : "";
  const pageUrl = `${env.frontendBaseUrl}/`;
  const siteName = "غزل کرمی";

  if (ogImage) {
    html = html.replace(
      '<meta property="og:image" content="" id="ogImageMeta">',
      `<meta property="og:image" content="${escapeAttr(ogImage)}" id="ogImageMeta">`
    );
  }
  html = html.replace(
    '<meta property="og:locale" content="fa_IR">',
    `<meta property="og:locale" content="fa_IR">\n<meta property="og:url" content="${escapeAttr(pageUrl)}">\n<meta property="og:site_name" content="${escapeAttr(siteName)}">`
  );

  // same fields the client-side loadContactInfo() patches, plus "image"
  // (which client JS never actually touched — filled in here too, same fix)
  html = html.replace(
    /(<script type="application\/ld\+json" id="ldJsonSchema">)([\s\S]*?)(<\/script>)/,
    (_match, open, jsonText, close) => {
      try {
        const ld = JSON.parse(jsonText);
        if (ogImage) ld.image = ogImage;
        if (contact?.phone) ld.telephone = contact.phone.startsWith("+") ? contact.phone : "+98" + contact.phone.replace(/^0/, "");
        if (contact?.address && ld.address) ld.address.streetAddress = contact.address;
        return `${open}\n${JSON.stringify(ld)}\n${close}`;
      } catch {
        return `${open}${jsonText}${close}`; // malformed JSON-LD would already be a bug in the static markup
      }
    }
  );

  return html;
}
