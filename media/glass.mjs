/**
 * Pure glass/readability math — no DOM, no vscode API, so `node --test` can
 * import this file directly (Node treats .mjs as ESM; the browser gets it as a
 * module too, served with `text/javascript` by the media server's MIME table).
 *
 * Ported from dsh-wallpaper-engine (MIT) `src/styles.js` + `src/effects.js`:
 *  - the glass recipe is plain CSS `backdrop-filter: blur() saturate()
 *    brightness() contrast()` — upstream measured that a real refraction effect
 *    (SVG displacement / shader / canvas snapshot) was not what shipped;
 *  - the readability floor of the glass alpha (light 0.45 / dark 0.59) is a
 *    measured contrast constraint, not a taste default, so it is enforced here
 *    rather than left to the slider.
 */

/** Measured floors from upstream `src/styles.js` (:56-57). */
export const READABILITY_FLOOR = { light: 0.45, dark: 0.59 };

export const LIMITS = {
  blur: [0, 60],
  saturate: [0, 3],
  wallpaperOpacity: [0.05, 1],
  scrim: [0, 1],
  border: [0, 8],
  glassAlpha: [0, 1],
  chromeGlassAlpha: [0, 1],
  editorGlassAlpha: [0, 1],
  panelWidth: [240, 900],
};

export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** VS Code puts vscode-light / vscode-dark / vscode-high-contrast* on <body>. */
export function themeKindFromClassList(classList) {
  const s = Array.from(classList || []).join(' ');
  if (/vscode-(light|high-contrast-light)/.test(s)) return 'light';
  return 'dark';
}

export function readabilityFloor(themeKind) {
  return themeKind === 'light' ? READABILITY_FLOOR.light : READABILITY_FLOOR.dark;
}

/** Raise the glass alpha to the readability floor; never lower a user's value. */
export function clampGlassAlpha(alpha, themeKind) {
  return clamp(Math.max(Number(alpha) || 0, readabilityFloor(themeKind)), 0, 1);
}

/** Accept #rgb / #rrggbb only; anything else falls back to the default. */
export function resolveGlassColor(value, fallback = '#101014') {
  const s = String(value || '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : fallback;
}

/**
 * Colour channels as "r g b", for `rgb(var(--we-glass-rgb) / <alpha>)`.
 *
 * Deliberately not `color-mix()`: the space-separated rgb() with a slash alpha
 * has been supported far longer, and a silently invalid background would show up
 * as "the glass panel has no tint at all" rather than as an error.
 */
export function resolveGlassChannels(value, fallback = '#101014') {
  const hex = resolveGlassColor(value, fallback).slice(1);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(' ');
}

/** settings + theme → the CSS custom properties style.css consumes. */
export function buildGlassVars(settings, themeKind) {
  const s = settings || {};
  return {
    '--we-blur': `${clamp(s.blur, ...LIMITS.blur)}px`,
    '--we-saturate': String(clamp(s.saturate, ...LIMITS.saturate)),
    '--we-wallpaper-opacity': String(clamp(s.wallpaperOpacity, ...LIMITS.wallpaperOpacity)),
    '--we-scrim': String(clamp(s.scrim, ...LIMITS.scrim)),
    '--we-border': `${clamp(s.border, ...LIMITS.border)}px`,
    '--we-glass-alpha': String(clampGlassAlpha(s.glassAlpha, themeKind)),
    '--we-glass-rgb': resolveGlassChannels(s.glassColor),
    '--we-panel-width': `${clamp(s.panelWidth, ...LIMITS.panelWidth)}px`,
  };
}

/** Short human label for the badge; keeps `application` visibly inert. */
export function renderModeLabel(item) {
  if (!item) return '未选择';
  switch (item.renderMode) {
    case 'video':
      return `Video · 播放中${item.mediaExt ? ` (${item.mediaExt})` : ''}`;
    case 'scene':
      return `Scene · 实时渲染${item.mediaExt ? ` (${item.mediaExt})` : ''}`;
    case 'web':
      return `Web · 实时渲染${item.mediaExt ? ` (${item.mediaExt})` : ''}`;
    case 'poster':
      return `${item.type} · 仅预览`;
    default:
      return `${item.type} · 不渲染`;
  }
}
