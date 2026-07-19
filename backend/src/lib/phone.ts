const IRAN_MOBILE_RE = /^0?9\d{9}$/;

/** Normalizes Iranian mobile numbers to the "09XXXXXXXXX" form. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "").replace(/^98/, "0");
  const withoutLeadingZero = digits.replace(/^0/, "");
  if (!IRAN_MOBILE_RE.test(digits) && !/^9\d{9}$/.test(withoutLeadingZero)) {
    return null;
  }
  return `0${withoutLeadingZero.slice(-10)}`;
}
