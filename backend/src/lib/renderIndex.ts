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
// Schema.org's DayOfWeek enumeration wants full URIs, not bare day names —
// index matches WorkingDay.dayOfWeek's convention (0=Sunday..6=Saturday,
// the same as JS Date#getDay(), see lib/dates.ts)
const SCHEMA_DAY_OF_WEEK = [
  "https://schema.org/Sunday",
  "https://schema.org/Monday",
  "https://schema.org/Tuesday",
  "https://schema.org/Wednesday",
  "https://schema.org/Thursday",
  "https://schema.org/Friday",
  "https://schema.org/Saturday",
];

// sameAs is for entity-identity profile pages — WhatsApp is a contact
// channel, not a profile, so it's deliberately left out here even though
// it's a valid SocialLink platform elsewhere in the app
const SAME_AS_HREF_BUILDERS: Record<string, (value: string) => string> = {
  INSTAGRAM: (v) => `https://instagram.com/${v.replace(/^@/, "")}`,
  TELEGRAM: (v) => `https://t.me/${v.replace(/^@/, "")}`,
  BALEH: (v) => `https://bale.ai/${v.replace(/^@/, "")}`,
};

export async function renderIndexHtml(): Promise<string> {
  let html = fs.readFileSync(indexHtmlPath, "utf8");

  const [contact, workingDays, reviewAgg, socialLinks] = await Promise.all([
    prisma.contactInfo.findUnique({ where: { id: "singleton" } }),
    prisma.workingDay.findMany({ where: { isOpen: true } }),
    prisma.review.aggregate({ where: { status: "APPROVED" }, _avg: { rating: true }, _count: true }),
    prisma.socialLink.findMany(),
  ]);

  // a dedicated, fixed 1200x630 asset (public/og-image.png — see
  // backend/og-card.html + render-og.mjs for how it's generated) rather than
  // whatever the admin last uploaded as the About-section profile/logo photo:
  // those are uncontrolled aspect ratios and were previously left blank
  // whenever site_content simply had no ghazal_photo_url/logo_url row yet,
  // which is exactly why link previews on Telegram/WhatsApp/Instagram were
  // showing no image at all — this is always resolvable, never empty.
  //
  // env.ts already normalizes frontendBaseUrl to always include a protocol,
  // but a page that exists to serve the whole site's homepage must not be
  // able to hard-crash over an SEO tag's URL construction regardless — a
  // missing/wrong og:image is a worse-looking share card, not a 500 for
  // every visitor, so this falls back to a relative path (still valid
  // HTML, just not spec-ideal for link-preview bots) rather than throwing
  let ogImage = "/og-image.png";
  let pageUrl = "/";
  try {
    ogImage = new URL("/og-image.png", env.frontendBaseUrl).href;
    pageUrl = new URL("/", env.frontendBaseUrl).href;
  } catch (err) {
    console.error("renderIndexHtml: FRONTEND_BASE_URL produced an invalid URL, falling back to relative paths:", err);
  }
  const siteName = "غزل کرمی";

  // regex (not an exact-string match on the placeholder) so this keeps
  // working even if the static markup's default content ever changes —
  // an exact-match replace that silently no-ops is how the previous version
  // of this tag could go stale without anyone noticing
  html = html.replace(
    /<meta property="og:image" content="[^"]*" id="ogImageMeta">/,
    `<meta property="og:image" content="${escapeAttr(ogImage)}" id="ogImageMeta">`
  );
  html = html.replace(
    /<meta name="twitter:image" content="[^"]*" id="twitterImageMeta">/,
    `<meta name="twitter:image" content="${escapeAttr(ogImage)}" id="twitterImageMeta">`
  );
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
        ld.url = pageUrl;
        ld.image = ogImage;
        if (contact?.phone) ld.telephone = contact.phone.startsWith("+") ? contact.phone : "+98" + contact.phone.replace(/^0/, "");
        if (contact?.address && ld.address) ld.address.streetAddress = contact.address;
        // admin-editable via ContactInfo.lat/lng (see the "مسیریابی" feature) —
        // both null until she sets them, so this stays omitted rather than
        // ever emitting a fabricated location
        if (contact?.lat != null && contact?.lng != null) {
          ld.geo = { "@type": "GeoCoordinates", latitude: contact.lat, longitude: contact.lng };
        }

        // real weekly hours (WorkingDay, admin-editable — same source the
        // "کی می‌تونید بیایید؟" section is meant to reflect) instead of no
        // opening-hours signal at all
        if (workingDays.length) {
          ld.openingHoursSpecification = workingDays
            .filter((d) => d.openTime && d.closeTime)
            .map((d) => ({
              "@type": "OpeningHoursSpecification",
              dayOfWeek: SCHEMA_DAY_OF_WEEK[d.dayOfWeek],
              opens: d.openTime,
              closes: d.closeTime,
            }));
        }

        // Google requires reviewCount >= 1 for AggregateRating — omit
        // entirely rather than ever emit a zero/fake one
        if (reviewAgg._count > 0 && reviewAgg._avg.rating) {
          ld.aggregateRating = {
            "@type": "AggregateRating",
            ratingValue: Math.round(reviewAgg._avg.rating * 10) / 10,
            reviewCount: reviewAgg._count,
          };
        }

        const sameAs = socialLinks
          .map((link) => SAME_AS_HREF_BUILDERS[link.platform]?.(link.value))
          .filter((href): href is string => Boolean(href));
        if (sameAs.length) ld.sameAs = [...new Set(sameAs)];

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
