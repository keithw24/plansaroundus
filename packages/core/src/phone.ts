/**
 * "+1 (917) 555-0142", "917-555-0142" → "+19175550142". Returns null unless it's
 * a plausible E.164 number; +1 numbers must be valid NANP (10 digits, area code
 * and exchange not starting with 0 or 1).
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.trim().replace(/[\s().-]/g, "");
  let e164: string;
  if (digits.startsWith("+")) e164 = digits;
  else if (/^\d{10}$/.test(digits)) e164 = `+1${digits}`;
  else if (/^1\d{10}$/.test(digits)) e164 = `+${digits}`;
  else return null;

  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  if (e164.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) return null;
  return e164;
}

/**
 * Canonical form of a chat sender. iMessage senders are phone numbers or Apple
 * ID emails, so emails are lower-cased and phones normalized. Null if neither.
 */
export function normalizeSender(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
  }
  return normalizePhone(trimmed);
}
