import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { env } from "./env";

const indexHtmlPath = path.join(__dirname, "..", "..", "..", "public", "index.html");

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// same href-building rule as loadContactInfo()'s applyContactLink() in
// index.html — kept in sync deliberately, not derived, since one is JS
// running in the browser and the other runs here before any JS exists
function telHref(value: string): string {
  return `tel:${value.replace(/[^\d+]/g, "")}`;
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
 *
 * The footer's phone/whatsapp/address text (also normally patched in by
 * loadContactInfo()) gets the same server-side treatment for the same
 * reason: a crawler that never runs JS would otherwise see whatever
 * placeholder text was in the file at seed time, forever, even after the
 * real values are edited in the admin panel.
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
  // the static markup ships a relative canonical ("/"), which is valid but
  // vague — now that FRONTEND_BASE_URL is a real, stable production domain
  // rather than a placeholder, an absolute canonical is the clearer signal
  html = html.replace(
    '<link rel="canonical" href="/">',
    `<link rel="canonical" href="${escapeAttr(pageUrl)}">`
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

  // there are TWO tel: links marked data-contact="phone" (the footer one,
  // and a standalone "call the salon instead" CTA near the booking widget —
  // see .phone-alt in index.html) with different surrounding markup, so the
  // href fix runs globally across the whole document rather than assuming
  // one fixed structure; only the footer's link also carries a visible
  // data-contact-label span, handled as a separate, more targeted pass
  function replaceTelHrefs(sourceHtml: string, dataContact: string, rawValue: string): string {
    const hrefRe = new RegExp(`(<a href=")tel:[^"]*("[^>]*data-contact="${dataContact}")`, "g");
    return sourceHtml.replace(hrefRe, (_m, pre, post) => `${pre}${escapeAttr(telHref(rawValue))}${post}`);
  }

  // same conditional-only-if-set behavior as applyContactLink() in
  // index.html (an unset field leaves the seed-time placeholder in place
  // rather than blanking it out)
  if (contact?.phone) {
    html = replaceTelHrefs(html, "phone", contact.phone);
    html = html.replace(
      /(data-contact="phone">[\s\S]*?<span data-contact-label>)[^<]*(<\/span>)/,
      (_m, prefix, suffix) => `${prefix}${escapeAttr(contact.phone!)}${suffix}`
    );
  }
  if (contact?.whatsapp) {
    html = replaceTelHrefs(html, "whatsapp", contact.whatsapp);
    html = html.replace(
      /(data-contact="whatsapp">[\s\S]*?<span data-contact-label>)[^<]*(<\/span>)/,
      (_m, prefix, suffix) => `${prefix}${escapeAttr(contact.whatsapp!)}${suffix}`
    );
  }
  if (contact?.address) {
    html = html.replace(
      /(<div class="f-social" style="align-items:flex-start;" data-contact="address">[\s\S]*?<span>)[^<]*(<\/span><\/div>)/,
      (_m, prefix, suffix) => `${prefix}${escapeAttr(contact.address!)}${suffix}`
    );
  }

  return html;
}
