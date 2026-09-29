/** Dark text on a light brand colour (Deep Ink, Technologies CI). */
export const DARK_TEXT = '#1F2823';
export const LIGHT_TEXT = '#FFFFFF';
/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;
/** Upload limit before conversion; the web shrinks photos first (Vercel body limit ~4.5 MB). */
export const LOGO_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** Stored WebP limit (plan §21.3). */
export const FILE_ASSET_MAX_BYTES = 1024 * 1024;

/**
 * "#1a2b3c", "1A2B3C" or "#abc" -> "#1A2B3C"; anything else -> null.
 * @param {unknown} value
 */
export function parseBrandColor(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  const hex = /^[0-9a-f]{3}$/i.test(raw) ? [...raw].map((c) => c + c).join('') : raw;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

/** @param {string} hex "#RRGGBB" */
function luminance(hex) {
  const channel = (/** @type {number} */ i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * WCAG contrast ratio of two "#RRGGBB" colours.
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Text colour for a brand-coloured header: whichever of white / Deep Ink reads better.
 * @param {string} color "#RRGGBB"
 */
export function brandTextColor(color) {
  return contrastRatio(color, LIGHT_TEXT) >= contrastRatio(color, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * A brand colour is accepted only when its text colour reaches WCAG AA.
 * @param {unknown} value
 * @returns {{ color: string, textColor: string } | { error: 'BRAND_COLOR_INVALID' | 'BRAND_COLOR_LOW_CONTRAST' }}
 */
export function brandColorFor(value) {
  const color = parseBrandColor(value);
  if (!color) return { error: 'BRAND_COLOR_INVALID' };
  const textColor = brandTextColor(color);
  if (contrastRatio(color, textColor) < MIN_CONTRAST) return { error: 'BRAND_COLOR_LOW_CONTRAST' };
  return { color, textColor };
}

/**
 * Image type from its first bytes, never from the file name or Content-Type.
 * @param {Uint8Array} bytes
 * @returns {'jpeg' | 'png' | 'webp' | 'heic' | null}
 */
export function detectImageType(bytes) {
  const ascii = (/** @type {number} */ from, /** @type {number} */ to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(8, 12))) return 'heic';
  return null;
}
