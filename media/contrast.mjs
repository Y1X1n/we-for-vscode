/**
 * Contrast math — pure, no DOM and no vscode API, so `node --test` imports it
 * directly while the panel gets it as a module from the media server.
 *
 * Why this exists: the whole point of this extension is that the wallpaper shows
 * THROUGH the UI, which means VS Code's text sits on an arbitrary photograph. For
 * a dark, low-contrast wallpaper that is fine even with the dimming slider at 0.
 * For a bright or busy one it is not: white text on a snow scene is roughly 1.1:1,
 * i.e. invisible, and no amount of "taste" in a default fixes it. So the dimming
 * gets a measured floor — the wallpaper itself says how much it needs.
 *
 * The same math runs in two places (the panel, and the patched workbench page,
 * which cannot import this file because the workbench CSP only allows scripts from
 * 'self'): `test/contrast.test.mjs` pins the two copies to the same answers.
 */

/** Rec. 709 luma on sRGB bytes, 0..1. Good enough to decide a scrim by. */
export function luma(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Brightness/clutter statistics of one frame.
 *
 * `p95` is what a dark theme cares about (the brightest area is the one white text
 * disappears into) and `p05` is what a light theme cares about. `busy` is the share
 * of neighbouring pixels whose luma jumps by more than a quarter — high-frequency
 * detail behind text, which is what blur is for.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 */
export function luminanceStats(image) {
  const data = image && image.data;
  const width = Math.max(1, Math.floor(image && image.width) || 1);
  const height = Math.max(1, Math.floor(image && image.height) || 1);
  if (!data || !data.length) return emptyStats();

  const lumas = [];
  let sum = 0;
  let bright = 0;
  let dark = 0;
  let edges = 0;
  let edgeSamples = 0;
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return luma(data[i], data[i + 1], data[i + 2]);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] !== undefined && data[i + 3] < 200) continue;
      const v = luma(data[i], data[i + 1], data[i + 2]);
      lumas.push(v);
      sum += v;
      if (v > 0.6) bright += 1;
      if (v < 0.25) dark += 1;
      // Right and down neighbours: cheap 2x edge sampling, enough for "is it busy".
      if (x + 1 < width) {
        edgeSamples += 1;
        if (Math.abs(v - at(x + 1, y)) > 0.25) edges += 1;
      }
      if (y + 1 < height) {
        edgeSamples += 1;
        if (Math.abs(v - at(x, y + 1)) > 0.25) edges += 1;
      }
    }
  }
  if (!lumas.length) return emptyStats();

  lumas.sort((a, b) => a - b);
  const pick = (q) => lumas[Math.min(lumas.length - 1, Math.max(0, Math.round(q * (lumas.length - 1))))];
  return {
    samples: lumas.length,
    mean: round3(sum / lumas.length),
    p05: round3(pick(0.05)),
    p50: round3(pick(0.5)),
    p95: round3(pick(0.95)),
    bright: round3(bright / lumas.length),
    dark: round3(dark / lumas.length),
    busy: edgeSamples ? round3(edges / edgeSamples) : 0,
  };
}

function emptyStats() {
  return { samples: 0, mean: 0, p05: 0, p50: 0, p95: 0, bright: 0, dark: 0, busy: 0 };
}

/** The luminance the brightest (dark theme) / darkest (light theme) area may keep. */
const TARGET = {
  dark: { balanced: 0.26, strong: 0.16 },
  light: { balanced: 0.58, strong: 0.7 },
};
/** Caps, so a white wallpaper does not end up as a black window. */
const SCRIM_CAP = { balanced: 0.75, strong: 0.88 };
const BLUR = { balanced: 7, strong: 13 };
const BUSY = { balanced: 0.34, strong: 0.24 };

/**
 * How much the background has to move for the UI text to survive.
 *
 * A dark theme draws light text, so the BRIGHT areas are the problem and the answer
 * is a dark scrim; a light theme draws dark text, so the DARK areas are, and the
 * answer is a white wash. The result is a *floor*: callers take the max of this and
 * whatever the user asked for, so a slider can always dim more, never less.
 *
 * @param {ReturnType<typeof luminanceStats>} stats
 * @param {'dark'|'light'} themeKind
 * @param {'off'|'balanced'|'strong'} mode
 */
export function contrastFloor(stats, themeKind = 'dark', mode = 'balanced') {
  if (mode !== 'balanced' && mode !== 'strong') return { scrim: 0, fill: '#000', blur: 0 };
  const s = stats && stats.samples ? stats : null;
  if (!s) return { scrim: 0, fill: '#000', blur: 0 };
  const dark = themeKind !== 'light';
  const target = TARGET[dark ? 'dark' : 'light'][mode];
  // Worst case for the theme: the area the text has to survive on.
  const worst = dark ? s.p95 : s.p05;
  // Compositing in sRGB: out = worst*(1-a) [+ target*a], so a = 1 - target/worst.
  const needed = dark
    ? 1 - target / Math.max(worst, 0.04)
    : 1 - (1 - target) / Math.max(1 - worst, 0.04);
  const scrim = clamp(needed, 0, SCRIM_CAP[mode]);
  const blur = s.busy >= BUSY[mode] ? BLUR[mode] : 0;
  return { scrim: round2(scrim), fill: dark ? '#000' : '#fff', blur };
}

/** `#rgb` / `#rrggbb` → "r,g,b" (both surfaces build rgb()/rgba() from it). */
export function fillChannels(fill, fallback = '0,0,0') {
  const m = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(fill || ''));
  if (!m) return fallback;
  const hex = m[0].slice(1);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(',');
}

/** WCAG contrast ratio between two relative luminances (0..1). */
export function contrastRatio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Luminance the code surface has to stay under/over for `fg` to be readable at
 * `target`:1. Everything above (dark theme) or below (light theme) this bound is a
 * failure, so it is the number the editor opacity is solved against.
 */
export function textBackdropBound(fg, target) {
  const dark = fg > 0.5;
  return dark ? (fg + 0.05) / target - 0.05 : target * (fg + 0.05) - 0.05;
}

/**
 * How opaque the code surface has to be.
 *
 * The wallpaper is behind the text no matter what the dimming does, so the only
 * remaining lever is the editor's own backdrop: blending toward the theme's editor
 * background moves the composite luma away from the glyphs. Solved, not guessed —
 * `bg(a) = a*surface + (1-a)*wallpaper`, inverted for the bound above.
 *
 * Returns 0 when the dimming alone is already enough (the common case for a dark
 * wallpaper), and the caller takes max(user slider, this) so the slider stays a floor.
 */
export function editorAlphaFor(input) {
  const { wallpaperLuma = 0, surfaceLuma = 0.1, fgLuma = 0.8, target = 4.5 } = input || {};
  const bound = textBackdropBound(fgLuma, target);
  const dark = fgLuma > 0.5;
  if (dark ? wallpaperLuma <= bound : wallpaperLuma >= bound) return 0;
  if (dark ? wallpaperLuma <= surfaceLuma : wallpaperLuma >= surfaceLuma) return 0;
  const needed = dark
    ? (wallpaperLuma - bound) / (wallpaperLuma - surfaceLuma)
    : (bound - wallpaperLuma) / (surfaceLuma - wallpaperLuma);
  // Capped just under opaque: 0.95 still lets the blurred wallpaper tint the code area,
  // and with a mid-tone theme that cap is what makes 4.5:1 reachable at all.
  return Math.min(0.95, Math.max(0, Math.round(needed * 100) / 100));
}

/** The wallpaper's luma after the dimming/wash is composited over it. */
export function dimmedLuma(stats, scrim, themeKind) {
  const s = Math.max(0, Math.min(1, Number(scrim) || 0));
  if (themeKind === 'light') {
    const worst = stats && stats.p05 !== undefined ? stats.p05 : 0;
    return worst * (1 - s) + s; // white wash
  }
  const worst = stats && stats.p95 !== undefined ? stats.p95 : 0;
  return worst * (1 - s); // black scrim
}

/** Which side the text is on, from the same classes VS Code puts on <body>. */
export function themeKindFromClassList(classList) {
  const s = Array.from(classList || []).join(' ');
  return /vscode-(light|high-contrast-light)/.test(s) ? 'light' : 'dark';
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
