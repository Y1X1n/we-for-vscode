/**
 * Webview entry point.
 *
 * Talks to the extension host over postMessage:
 *   host → webview: init / settings / inventory / item / visibility / library
 *   webview → host: ready / select / next / setting / log
 *
 * State survives the webview being hidden and rebuilt (the panel is created with
 * retainContextWhenHidden:false, so the document is destroyed when the tab goes
 * to the background) via the vscode.setState/getState round trip. Per-item
 * playback flags are deliberately NOT restored — they describe a <video> element
 * that no longer exists.
 *
 * Layer visibility is not decided here: it comes from render-state.mjs, which is
 * unit-tested (`test/render-state.test.mjs`). Do not reintroduce ad-hoc
 * `poster.hidden = ...` logic in this file.
 */

import { buildGlassVars, clamp, LIMITS, renderModeLabel, themeKindFromClassList } from './glass.mjs';
import { contrastFloor as contrastFloorMath, fillChannels, luminanceStats } from './contrast.mjs';
import { computeLayerState, playButtonLabel } from './render-state.mjs';
import { isLive, mountWallpaper } from './renderer.mjs';
import { createPendingSettings } from './settings-sync.mjs';

const vscode = acquireVsCodeApi();

const el = {
  video: document.getElementById('wp-video'),
  live: document.getElementById('wp-live'),
  poster: document.getElementById('wp-poster'),
  stage: document.getElementById('stage'),
  title: document.getElementById('wp-title'),
  meta: document.getElementById('wp-meta'),
  badge: document.getElementById('wp-badge'),
  note: document.getElementById('wp-note'),
  source: document.getElementById('wp-source'),
  play: document.getElementById('btn-play'),
  pick: document.getElementById('btn-pick'),
  next: document.getElementById('btn-next'),
  library: document.getElementById('library'),
  libList: document.getElementById('lib-list'),
  libSearch: document.getElementById('lib-search'),
  libEmpty: document.getElementById('lib-empty'),
  libClose: document.getElementById('btn-lib-close'),
  controls: document.querySelector('.we-controls'),
};

/**
 * Loopback origin of the media server, read from `<body data-media-origin>` (the host
 * only substitutes placeholders in index.html — this file is an external module).
 * Needed to build the renderer URL: `item.media` already carries the origin, but the
 * renderer also wants the `/wallpaper-engine/scene-files` base for a scene's relative
 * textures/materials (upstream passes the same pair).
 */
const MEDIA_ORIGIN = document.body.dataset.mediaOrigin || '';

const SLIDERS = [
  ['blur', 'in-blur', 'out-blur'],
  ['glassAlpha', 'in-glassAlpha', 'out-glassAlpha'],
  ['scrim', 'in-scrim', 'out-scrim'],
  ['chromeGlassAlpha', 'in-chromeGlassAlpha', 'out-chromeGlassAlpha'],
  ['editorGlassAlpha', 'in-editorGlassAlpha', 'out-editorGlassAlpha'],
  ['wallpaperOpacity', 'in-wallpaperOpacity', 'out-wallpaperOpacity'],
  ['border', 'in-border', 'out-border'],
  ['panelWidth', 'in-panelWidth', 'out-panelWidth'],
  ['saturate', 'in-saturate', 'out-saturate'],
];

/**
 * Defaults and display units — one table each, because both are read from three places
 * (the read-outs, the per-row reset and 全部恢复默认).
 *
 * The defaults mirror the host manifest's `weWallpaper.*` defaults, so 「恢复默认」 means
 * the same thing on both sides of the webview. UNITS is what turns a raw slider number
 * into something readable: every read-out used to be `toFixed(2)`, which printed
 * "16.00" for a blur radius measured in px and "1.00" for an opacity.
 */
const DEFAULTS = {
  blur: 16,
  saturate: 1.3,
  wallpaperOpacity: 1,
  scrim: 0.35,
  border: 1,
  glassAlpha: 0.45,
  chromeGlassAlpha: 0.45,
  editorGlassAlpha: 0.72,
  panelWidth: 420,
  glassColor: '#101014',
};

const UNITS = {
  blur: 'px',
  border: 'px',
  panelWidth: 'px',
  saturate: 'x',
  wallpaperOpacity: '%',
  scrim: '%',
  glassAlpha: '%',
  chromeGlassAlpha: '%',
  editorGlassAlpha: '%',
};

/** "16 px" / "45%" / "1.30×" — the one place a control value becomes text. */
function formatValue(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (UNITS[key] === 'px') return `${Math.round(n)} px`;
  if (UNITS[key] === '%') return `${Math.round(n * 100)}%`;
  if (UNITS[key] === 'x') return `${n.toFixed(2)}×`;
  return String(value ?? '');
}

const state = Object.assign(
  {
    // DEFAULTS is the panel's own copy of the manifest defaults (see above) — keeping the
    // first-run values in one place is what makes 全部恢复默认 exact.
    settings: { ...DEFAULTS, autoContrast: 'balanced' },
    item: null,
    paused: false,
    visible: true,
    focused: true,
    inventory: null,
    /** Host-decided: is THIS panel the surface that renders the wallpaper live? */
    panelLive: true,
  },
  vscode.getState() || {},
);

// Per-item flags always start clean: a restored `hasPaintedFrame` would suppress
// the placeholder for a video that has not decoded anything yet.
state.hasPaintedFrame = false;
state.videoFailed = false;
/** The scene renderer reported a frame (never restored — the iframe is gone). */
state.sceneReady = false;
/** A frame the renderer captured itself, used as the poster once it exists. */
state.sceneShot = null;
/** Media URL currently attached to the <video> element (null = nothing attached). */
let attachedMedia = null;

function persist() {
  vscode.setState({
    settings: state.settings,
    item: state.item,
    paused: state.paused,
  });
}

function log(level, message) {
  vscode.postMessage({ type: 'log', level, message });
}

// ── glass ───────────────────────────────────────────────────────────────────

/**
 * Readability floor for the wallpaper THIS panel shows.
 *
 * Only applied when the panel is the surface rendering the wallpaper: in the default
 * `workbench` mode the panel is transparent over the whole-window layer, which has
 * already raised its own dimming, and dimming twice would just make the window dark.
 */
let contrastFloor = { scrim: 0, fill: '0,0,0', blur: 0 };
let contrastKey = null;
let contrastStats = null;

function measureContrast() {
  const item = state.item;
  if (!item) return;
  const mode = state.settings?.autoContrast || 'balanced';
  const panelOwnsWallpaper = state.panelLive !== false;
  const key = `${item.id}:${panelOwnsWallpaper ? 'panel' : 'workbench'}:${mode}:${
    el.live && el.live.querySelector('canvas') ? 'canvas' : 'image'
  }`;
  if (key === contrastKey) return;
  contrastKey = key;
  if (!panelOwnsWallpaper || mode === 'off') {
    contrastStats = null;
    contrastFloor = { scrim: 0, fill: '0,0,0', blur: 0 };
    applyGlass();
    return;
  }
  // Prefer what is actually on screen: the engine canvas once a Scene has painted, the
  // captured frame, then the preview image the library already uses.
  const canvas = el.live ? el.live.querySelector('canvas') : null;
  const src = canvas && canvas.width ? canvas : state.sceneShot || item.preview;
  if (!src) return;
  const finish = (image) => {
    try {
      const size = 64;
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, size, size);
      contrastStats = luminanceStats({ data: ctx.getImageData(0, 0, size, size).data, width: size, height: size });
      contrastFloor = contrastFloorFor(contrastStats);
      applyGlass();
      log('info', `对比度自动调整: p95=${contrastStats.p95} busy=${contrastStats.busy} → 暗化 ${contrastFloor.scrim} 模糊 ${contrastFloor.blur}px`);
    } catch (err) {
      // A tainted canvas or an unreadable frame: the user's own sliders stay in charge.
      log('info', `对比度采样跳过：${String(err)}`);
    }
  };
  if (typeof src === 'string') {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => finish(image), { once: true });
    image.addEventListener('error', () => log('info', '对比度采样失败：预览图读不到'), { once: true });
    image.src = src;
  } else {
    finish(src);
  }
}

function contrastFloorFor(stats) {
  const themeKind = themeKindFromClassList(document.body.classList);
  const mode = state.settings?.autoContrast || 'balanced';
  const floor = contrastFloorMath(stats, themeKind, mode);
  return { scrim: floor.scrim, fill: fillChannels(floor.fill), blur: floor.blur };
}

function applyGlass() {
  const themeKind = themeKindFromClassList(document.body.classList);
  // The slider values are a FLOOR, not the final word: the wallpaper's own measured
  // brightness can demand more dimming (and, when it is busy, a little blur).
  const effective = {
    ...state.settings,
    scrim: Math.max(Number(state.settings?.scrim) || 0, contrastFloor.scrim),
    blur: Math.max(Number(state.settings?.blur) || 0, contrastFloor.blur),
  };
  const vars = buildGlassVars(effective, themeKind);
  vars['--we-scrim-fill'] = contrastFloor.fill;
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
  const out = document.getElementById('out-scrim');
  if (out) {
    const user = Number(state.settings?.scrim) || 0;
    const shown = effective.scrim;
    // Percent like every other alpha read-out, and the floor is called out: the slider
    // then shows a number the user did not set.
    out.textContent = contrastFloor.scrim > user ? `${formatValue('scrim', shown)}（自动）` : formatValue('scrim', shown);
  }
}

function syncInputs() {
  for (const [key, inputId, outId] of SLIDERS) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(outId);
    if (!input) continue;
    input.value = String(state.settings[key]);
    // scrim keeps its own read-out: the readability floor can raise it above what the
    // slider says, and that number has to admit it (see applyGlass).
    if (out && key !== 'scrim') out.textContent = formatValue(key, state.settings[key]);
    syncFill(input);
    syncReset(key);
  }
  const color = document.getElementById('in-glassColor');
  if (color) color.value = state.settings.glassColor;
  const colorOut = document.getElementById('out-glassColor');
  if (colorOut) colorOut.textContent = String(state.settings.glassColor ?? '');
  syncReset('glassColor');
}

/** Track fill: the range is painted with a gradient whose stop is the value's position. */
function syncFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const value = Number(input.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
}

/** A reset button is useless while the value already IS the default — hide it. */
function syncReset(key) {
  const btn = document.querySelector(`[data-reset="${key}"]`);
  if (!btn) return;
  btn.disabled = String(state.settings[key]) === String(DEFAULTS[key]);
  btn.title = `恢复默认（${formatValue(key, DEFAULTS[key])}）`;
}

// ── the <video> element ─────────────────────────────────────────────────────

function attachVideo(item) {
  if (attachedMedia === item.media) return;
  attachedMedia = item.media;
  state.hasPaintedFrame = false;
  state.videoFailed = false;
  el.video.hidden = false;
  el.video.setAttribute('src', item.media);
  // No `poster` attribute on purpose: Chromium keeps showing it under conditions
  // we do not control, and the <img> placeholder behind the video already covers
  // the pre-first-frame case deterministically.
}

function detachVideo() {
  if (attachedMedia === null) return;
  attachedMedia = null;
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  el.video.hidden = true;
}

// ── the live layer (Scene / Web, via the vendored webwallgl library) ────────

/** Mounted SceneInstance for the current wallpaper (null = nothing mounted). */
let liveInstance = null;
/** What is mounted, so re-picking the same wallpaper does not remount it. */
let attachedLive = null;
/**
 * Bumped by every detach: a mount that finishes under an older generation parks itself
 * instead of claiming the container. Comparing keys is not enough — re-attaching the
 * SAME wallpaper while its first mount is still in flight would let the stale mount
 * adopt itself as the live instance.
 */
let liveGen = 0;
/**
 * Mounts are serialised. Parking a cancelled instance clears the container, and doing
 * that while another mount is mid-flight would delete the canvas the new mount just
 * appended — with mount() resolving asynchronously there is no ordering otherwise.
 */
let mountChain = Promise.resolve();

/** Pause a mount nobody wants any more and drop what it put in the container. */
function parkLiveInstance(instance) {
  try {
    instance.pause();
  } catch {
    /* already gone */
  }
  try {
    el.live.replaceChildren();
    el.live.hidden = true;
  } catch {
    /* ignore */
  }
}

/**
 * Mount or swap the live wallpaper.
 *
 * The engine is imported directly (same origin, MIT — see media/renderer.mjs), so
 * there is no iframe and no bridge: we hold the instance and its canvas. The old
 * arrangement needed a cross-origin iframe plus an injected postMessage bridge because
 * `contentWindow.__wp` is unreachable across origins; none of that is needed now.
 */
async function attachLive(item) {
  const key = `${item.renderMode}:${item.media}`;
  if (attachedLive === key) return;
  detachLive();
  attachedLive = key;
  const gen = liveGen;
  el.live.hidden = false;
  log('info', `实时挂载开始：${item.renderMode} ${item.media ?? '(无载荷)'}`);
  const attempt = mountChain.then(() =>
    mountWallpaper(el.live, item, {
      fps: 30,
      // The engine's own reporting (silent-failure one-shots, WebGL context loss,
      // watchdog). Without this, a dead render loop is indistinguishable from
      // "still loading" — the exact shape of the invisible-scene bug report.
      onDiagnostic: (msg, level) => log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `[引擎] ${msg}`),
      onError: (err) => log('error', `[引擎] ${err && err.message ? err.message : String(err)}`),
    }),
  );
  mountChain = attempt.then(
    () => undefined,
    () => undefined,
  );
  try {
    const instance = await attempt;
    // The mount may have been cancelled WHILE it was in flight — the host switched the
    // live surface to the whole-window layer, or the item changed. mount() has no
    // destroy(), so a late instance has to be parked right here: pause the loop and
    // drop the canvas. Skipping this leaves the panel rendering a detached, 0x0 canvas
    // at full frame rate — invisible, and worse than the duplicate it replaced.
    if (gen !== liveGen) {
      parkLiveInstance(instance);
      log('info', '实时挂载已被取消（实时面已切换），实例已释放');
      return;
    }
    liveInstance = instance;
    log(
      'info',
      `实时挂载成功：canvas=${liveInstance && liveInstance.canvas ? `${liveInstance.canvas.width}x${liveInstance.canvas.height}` : 'n/a'}`,
    );
    // mount() resolves after the first frame is actually painted (upstream contract),
    // which is the readiness the layer state machine has been waiting for — drop the
    // placeholder at the earliest moment it is safe, not on a timer.
    state.sceneReady = true;
    applyLayerState();
    // Keep one frame the renderer drew as the poster for the next mount (scene only:
    // a web wallpaper's `canvas` is the container div, there is nothing to grab).
    window.setTimeout(captureLiveFrame, 2500);
  } catch (err) {
    if (gen !== liveGen) return; // a cancelled mount must not report or clear anything
    attachedLive = null;
    el.live.hidden = true;
    const message = String(err && err.message ? err.message : err);
    log('error', `实时渲染失败（${item.renderMode}）：${message}`);
    el.badge.textContent = '实时渲染失败（见输出通道）';
    // No applyLayerState() here: the item is still live, so it would remount and
    // loop. The placeholder from the last applyLayerState() stays on screen — that
    // IS the graceful degradation.
  }
}

/** One frame from the mounted instance, kept as the poster. */
function captureLiveFrame() {
  try {
    const canvas = liveInstance && liveInstance.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width) return;
    const shot = canvas.toDataURL('image/jpeg', 0.85);
    if (typeof shot === 'string' && shot.startsWith('data:image/')) {
      state.sceneShot = shot;
      state.sceneReady = true;
      applyLayerState();
    }
  } catch (err) {
    log('info', `抓帧失败：${String(err)}`);
  }
}

function detachLive() {
  // Invalidate any in-flight mount FIRST: it will park itself when it resolves.
  liveGen += 1;
  if (!attachedLive) return;
  attachedLive = null;
  state.sceneReady = false;
  if (liveInstance) {
    try {
      liveInstance.pause();
    } catch {
      /* the instance may already be gone */
    }
    liveInstance = null;
  }
  // The library exposes no destroy(): pausing the loop and dropping the canvas is what
  // releases the WebGL context.
  try {
    el.live.replaceChildren();
  } catch {
    /* ignore */
  }
  el.live.hidden = true;
}

function markPainted() {
  if (state.hasPaintedFrame) return;
  state.hasPaintedFrame = true;
  applyLayerState();
}

el.video.addEventListener('loadeddata', markPainted);
el.video.addEventListener('playing', markPainted);
el.video.addEventListener('error', () => {
  const err = el.video.error;
  state.videoFailed = true;
  log('error', `视频加载失败 code=${err ? err.code : '?'} ${err && err.message ? err.message : ''}`);
  el.badge.textContent = '视频加载失败（见输出通道）';
  applyLayerState();
});

// ── rendering ───────────────────────────────────────────────────────────────

function applyLayerState() {
  const layer = computeLayerState(state);

  // Poster layer: behind the live layer, placeholder only. For a Scene it upgrades to
  // the frame the renderer captured itself (see the message handler).
  const posterSrc = state.sceneShot && state.item?.renderMode === 'scene' ? state.sceneShot : state.item?.preview;
  if (layer.showPoster && posterSrc) {
    if (el.poster.getAttribute('src') !== posterSrc) el.poster.setAttribute('src', posterSrc);
    el.poster.hidden = false;
  } else {
    el.poster.hidden = true;
  }

  // Video layer.
  if (layer.showVideo && state.item?.media) {
    attachVideo(state.item);
    el.video.hidden = false;
    if (layer.shouldPlay) {
      el.video.play().catch((err) => log('info', `play() 被拒绝：${String(err)}`));
    } else {
      el.video.pause();
    }
  } else {
    detachVideo();
  }

  // Scene layer (WebWallGL iframe). Only one live layer exists at a time.
  //
  // ...and only one across BOTH surfaces: when the whole-window layer is the live one
  // (weWallpaper.liveSurface = workbench, the default), the host tells us so and we
  // keep the poster instead of mounting a second engine. Two instances would render
  // the same wallpaper twice on the same renderer main thread — the thread the editor
  // UI runs on — with nothing visible to show for it.
  const panelLive = state.panelLive !== false;
  if (layer.showScene && isLive(state.item) && panelLive) {
    void attachLive(state.item);
    // Occlusion pause: the instance is ours, so this is a direct call.
    if (liveInstance) {
      try {
        if (layer.shouldPlay) liveInstance.resume();
        else liveInstance.pause();
      } catch (err) {
        log('info', `暂停/恢复失败：${String(err)}`);
      }
    }
  } else {
    detachLive();
  }

  if (el.stage) el.stage.dataset.mode = state.item ? state.item.renderMode : 'none';
  if (el.play) el.play.textContent = playButtonLabel(layer);
  if (el.play) el.play.dataset.reason = layer.reason;

  // The badge would otherwise be overwritten by the render-mode label after an error.
  if (state.item && !state.videoFailed) {
    el.badge.textContent =
      !panelLive && isLive(state.item) ? `${state.item.type} · 整窗层实时渲染` : renderModeLabel(state.item);
  }
}

function renderMeta() {
  const item = state.item;
  if (!item) {
    el.title.textContent = 'Wallpaper Engine';
    el.meta.textContent = state.inventory
      ? `壁纸库 ${state.inventory.items?.length ?? '?'} 张`
      : '正在扫描本地壁纸库…';
    el.badge.textContent = '空';
    el.note.hidden = true;
    el.source.textContent = '';
    return;
  }
  el.title.textContent = item.title;
  const rating = item.contentrating ? ` · 分级 ${item.contentrating}` : '';
  const sourceLabel = item.source === 'workshop' ? '创意工坊' : item.source === 'myprojects' ? '我的项目' : '官方默认';
  el.meta.textContent = `${item.type}${rating} · ${sourceLabel}`;
  el.badge.textContent = renderModeLabel(item);
  el.note.hidden = !item.note;
  el.note.textContent = item.note || '';
  el.source.textContent = item.id;
}

function setItem(item) {
  // Only re-arm the first-frame flags when the media actually changes: re-picking
  // the wallpaper that is already playing would otherwise leave the placeholder
  // "shown" behind the video for good (visible as ghosting at opacity < 1).
  const mediaChanged = (state.item?.media ?? null) !== (item?.media ?? null);
  state.item = item || null;
  if (mediaChanged) {
    state.hasPaintedFrame = false;
    state.videoFailed = false;
    state.sceneReady = false;
    state.sceneShot = null;
  }
  renderMeta();
  applyLayerState();
  persist();
}

// ── the wallpaper library (in-panel selection) ──────────────────────────────
//
// The library lives INSIDE this panel. It used to be a `showQuickPick` at the top of
// the window, which meant choosing a wallpaper took the user's eyes (and the keyboard)
// out of the view they were looking at — and the picker could not show a single
// thumbnail. The inventory snapshot has carried every item (with its preview URL) all
// along, so the list is built locally: no round trip to open it, and clicking a row
// posts one `select` message.
//
// Rows are built with createElement/textContent, never innerHTML: item titles and
// notes come from third-party project.json files.

let libraryOpen = false;

function setLibraryOpen(open) {
  libraryOpen = !!open;
  if (el.library) el.library.hidden = !libraryOpen;
  if (el.controls) el.controls.hidden = libraryOpen;
  if (el.pick) el.pick.textContent = libraryOpen ? '返回设置' : '选择壁纸…';
  if (libraryOpen) {
    renderLibrary();
    el.libSearch?.focus();
  }
}

// ── category filters ────────────────────────────────────────────────────────
//
// The inventory carries four things worth filtering on, and they answer different
// questions: 类型 (what it is), 标签 (WE's own categories — Anime / Girls / Landscape…),
// 来源 (workshop vs my projects vs the bundled defaults) and 分级 (content rating).
// 类型 and 标签 are what one actually hunts by, so each gets its own row; 来源 and 分级
// share the last one.
//
// The filter state is deliberately NOT persisted across panel rebuilds: reopening the
// picker on a stale "Anime only" filter reads as "my workshop wallpapers are gone".
const FILTER_ROWS = [
  [['type', '类型']],
  [['tag', '标签']],
  [
    ['source', '来源'],
    ['rating', '分级'],
  ],
];

const FILTER_LABELS = {
  type: { all: '全部', video: '视频', scene: '场景', web: '网页', application: '应用' },
  source: { all: '全部', workshop: '创意工坊', myprojects: '我的项目', defaultprojects: '官方默认' },
  rating: { all: '全部', Everyone: '全年龄', PG13: '13+', Mature: '成人' },
};

/** Fixed display order per group; tags have none and are ordered by count. */
const FILTER_ORDER = {
  type: ['video', 'scene', 'web', 'application'],
  source: ['workshop', 'myprojects', 'defaultprojects'],
  rating: ['Everyone', 'PG13', 'Mature'],
};

let libFilter = { type: 'all', tag: 'all', source: 'all', rating: 'all' };

/** The values one item carries for a filter group ([] when it has none). */
function filterValuesOf(item, group) {
  if (group === 'type') return [String(item.type || '').toLowerCase()].filter(Boolean);
  if (group === 'tag') return Array.isArray(item.tags) ? item.tags : [];
  if (group === 'source') return [item.source].filter(Boolean);
  if (group === 'rating') return [item.contentrating].filter(Boolean);
  return [];
}

function filterMatch(item, group, value) {
  return value === 'all' || filterValuesOf(item, group).includes(value);
}

function libraryMatches(item, query = '') {
  for (const [group, value] of Object.entries(libFilter)) {
    if (!filterMatch(item, group, value)) return false;
  }
  if (!query) return true;
  // Tags belong in the haystack: "anime" in the search box should find what the 标签 row
  // would, and a tag that has no chip yet (single-item tag) is still reachable this way.
  const hay = `${item.title || ''} ${item.id || ''} ${item.type || ''} ${item.renderMode || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
  return hay.includes(query);
}

/**
 * Chip counts are computed with the OTHER groups applied: a count that ignored them
 * would promise wallpapers the current combination cannot actually show.
 */
function filterPool(items, group) {
  const others = Object.entries(libFilter).filter(([g]) => g !== group);
  const pool = items.filter((i) => others.every(([g, v]) => filterMatch(i, g, v)));
  const counts = new Map();
  for (const item of pool) {
    for (const value of filterValuesOf(item, group)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return { pool, counts };
}

function filterChip(group, value, label, count, active) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = active ? 'we-chip we-chip--on' : 'we-chip';
  chip.dataset.group = group;
  chip.dataset.value = value;
  chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  chip.title = count === null ? label : `${label}（${count} 张）`;
  const name = document.createElement('span');
  name.textContent = label;
  chip.append(name);
  if (count !== null) {
    const badge = document.createElement('span');
    badge.className = 'we-chip-count';
    badge.textContent = String(count);
    chip.append(badge);
  }
  return chip;
}

/** Rebuild the chip rows. Values come from the inventory, so the chips always match it. */
function renderFilters() {
  const host = document.getElementById('lib-filters');
  if (!host) return;
  const items = state.inventory?.items || [];
  if (!items.length) {
    host.replaceChildren();
    return;
  }
  const rows = [];
  for (const groups of FILTER_ROWS) {
    const row = document.createElement('div');
    row.className = 'we-filter-row';
    groups.forEach(([group, label], index) => {
      if (index > 0) {
        const sep = document.createElement('span');
        sep.className = 'we-filter-sep';
        row.append(sep);
      }
      const title = document.createElement('span');
      title.className = 'we-filter-label';
      title.textContent = label;
      row.append(title);

      const { pool, counts } = filterPool(items, group);
      // A SELECTED value is always rendered, even at count 0: faceted counts hide the
      // values that would yield nothing, and hiding the chip the user is currently
      // filtered by would leave them with no way to switch it off.
      const values = FILTER_ORDER[group]
        ? FILTER_ORDER[group].filter((v) => counts.has(v) || libFilter[group] === v)
        : [...new Set([...counts.keys(), ...(libFilter[group] === 'all' ? [] : [libFilter[group]])])].sort(
            (a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b),
          );
      const labels = FILTER_LABELS[group] || {};
      row.append(filterChip(group, 'all', '全部', pool.length, libFilter[group] === 'all'));
      for (const value of values) {
        row.append(filterChip(group, value, labels[value] || value, counts.get(value) || 0, libFilter[group] === value));
      }
    });
    rows.push(row);
  }
  host.replaceChildren(...rows);
}

function libraryRow(item, selected) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'we-lib-item';
  row.dataset.id = item.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (item.note) row.title = item.note;

  const thumb = document.createElement('span');
  thumb.className = 'we-lib-thumb';
  // The project's own scheme colour paints the tile until (or instead of) the preview:
  // previews are 256px GIFs, and a list of 30 of them is worth loading lazily.
  if (item.schemeColor) thumb.style.background = item.schemeColor;
  if (item.preview) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = item.preview;
    thumb.appendChild(img);
  }

  const text = document.createElement('span');
  text.className = 'we-lib-text';
  const name = document.createElement('span');
  name.className = 'we-lib-name';
  name.textContent = item.title || item.id;
  const meta = document.createElement('span');
  meta.className = 'we-lib-meta';
  const playable = item.renderMode === 'video' || item.renderMode === 'scene' || item.renderMode === 'web';
  meta.textContent = `${playable ? renderModeLabel(item) : `${item.type} · 仅预览`}${item.contentrating ? ` · ${item.contentrating}` : ''}`;
  text.append(name, meta);

  row.append(thumb, text);
  if (!playable) row.classList.add('we-lib-item--inert');
  if (selected) row.classList.add('we-lib-item--current');
  row.addEventListener('click', () => {
    vscode.postMessage({ type: 'select', id: item.id });
    // Optimistic marker: the host's `item` push confirms it a moment later.
    markCurrentLibraryRow(item.id);
    renderMeta();
  });
  return row;
}

/** Move the "current" marker without rebuilding the list (keeps scroll + focus). */
function markCurrentLibraryRow(id) {
  if (!el.libList) return;
  for (const row of el.libList.querySelectorAll('.we-lib-item')) {
    const on = row.dataset.id === id;
    row.classList.toggle('we-lib-item--current', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function renderLibrary() {
  if (!el.libList) return;
  const items = state.inventory?.items || [];
  // A rescan can drop the wallpaper a chip was filtering by. Reset those groups first —
  // otherwise the list goes empty with a chip that no longer exists to click off.
  for (const group of Object.keys(libFilter)) {
    if (libFilter[group] === 'all') continue;
    const available = new Set(items.flatMap((i) => filterValuesOf(i, group)));
    if (!available.has(libFilter[group])) libFilter[group] = 'all';
  }
  renderFilters();
  const query = (el.libSearch?.value || '').trim().toLowerCase();
  const shown = items.filter((i) => libraryMatches(i, query));
  el.libList.replaceChildren(...shown.map((i) => libraryRow(i, i.id === state.item?.id)));
  if (el.libEmpty) {
    el.libEmpty.hidden = shown.length > 0;
    el.libEmpty.textContent = !items.length
      ? '正在扫描本地壁纸库…'
      : query
        ? `没有匹配「${el.libSearch?.value || ''}」的壁纸`
        : '没有符合当前筛选的壁纸';
  }
}

el.pick?.addEventListener('click', () => setLibraryOpen(!libraryOpen));
el.libClose?.addEventListener('click', () => setLibraryOpen(false));
el.libSearch?.addEventListener('input', () => renderLibrary());

// One delegated handler for every chip. The chips are rebuilt by renderLibrary, so the
// clicked button is gone by the time focus would return to it — put the keyboard back on
// the equivalent chip, or the next Tab restarts from the top of the panel.
document.getElementById('lib-filters')?.addEventListener('click', (event) => {
  const chip = event.target instanceof Element ? event.target.closest('.we-chip') : null;
  if (!chip) return;
  const { group, value } = chip.dataset;
  if (!group || !value) return;
  libFilter[group] = value;
  renderLibrary();
  document.querySelector(`.we-chip[data-group="${group}"][data-value="${value}"]`)?.focus();
});

// ── controls ────────────────────────────────────────────────────────────────

let settingTimer = null;
/**
 * Values this panel has changed but the host has not confirmed yet (see
 * media/settings-sync.mjs for the race it guards, and its tests).
 *
 * Two races made 「立即生效」 look broken without this (both reproduced by the user):
 *  - the write is debounced by 150 ms, so a click right after a drag asked the host for
 *    a config that did not contain the new value yet — it echoed the old one back and
 *    syncInputs() snapped the slider back;
 *  - the host's write is async, so even past the debounce the echo could still be the
 *    previous value.
 * A pending value wins over the echo until the host reports it back, and the apply
 * button sends the whole map so the host writes the real values before pushing.
 */
const pendingSettings = createPendingSettings();
function pushSetting(key, value) {
  pendingSettings.set(key, value);
  clearTimeout(settingTimer);
  settingTimer = setTimeout(() => {
    vscode.postMessage({ type: 'setting', key, value });
    persist();
  }, 150);
}

/**
 * The single write path for a control: slider, colour picker, per-row reset, 恢复默认.
 *
 * The limits fall back to the input's own min/max — a slider whose key is missing from
 * LIMITS used to throw on `clamp(raw, ...undefined)`, which killed the rest of the
 * handler: the slider moved, nothing was written, and it looked like a slider that
 * simply does not work (侧边栏磨砂 and 代码区底衬 until 0.1.7).
 *
 * `immediate` posts at once instead of riding the shared debounce — 「全部恢复默认」
 * would otherwise lose nine of its ten writes to `settingTimer`.
 */
function commitSetting(key, value, input, immediate = false) {
  try {
    if (key === 'glassColor') {
      state.settings.glassColor = String(value);
    } else {
      const limits = LIMITS[key] || [Number(input?.min) || 0, Number(input?.max) || 1];
      const raw = Number(value);
      state.settings[key] =
        key === 'border' || key === 'blur' || key === 'panelWidth' ? Math.round(raw) : clamp(raw, limits[0], limits[1]);
    }
    applyGlass();
    syncInputs();
    if (immediate) pushSettingNow(key, state.settings[key]);
    else pushSetting(key, state.settings[key]);
  } catch (err) {
    log('error', `设置 ${key} 处理失败：${err && err.message ? err.message : String(err)}`);
  }
}

function pushSettingNow(key, value) {
  pendingSettings.set(key, value);
  clearTimeout(settingTimer);
  vscode.postMessage({ type: 'setting', key, value });
  persist();
}

for (const [key, inputId] of SLIDERS) {
  const input = document.getElementById(inputId);
  if (!input) continue;
  input.addEventListener('input', () => commitSetting(key, input.value, input));
}

// Anything thrown at the top level of the panel used to be invisible: the panel simply
// stopped responding and the extension log stayed clean. Surface it instead.
window.addEventListener('error', (e) => log('error', `面板脚本异常：${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  log('error', `面板 Promise 异常：${e.reason && e.reason.message ? e.reason.message : String(e.reason)}`),
);

document.getElementById('in-glassColor')?.addEventListener('input', (event) =>
  commitSetting('glassColor', event.target.value, event.target),
);

// 「立即生效」: settings already reach the windows on their own (the host pushes, and
// the patched page applies it from the /events stream), so this button is the explicit
// fallback — a dropped stream, or the asset-update case where only a reload helps.
// The label flips for a moment because otherwise a working button and a dead one look
// exactly the same.
const applyBtn = document.getElementById('btn-apply');
const applyHint = document.getElementById('apply-hint');
applyBtn?.addEventListener('click', () => {
  // The panel's own values go with the click: they are the ones the user just set, and
  // the host writes them before pushing (the debounced write may not have landed yet).
  clearTimeout(settingTimer);
  vscode.postMessage({ type: 'apply', settings: { ...state.settings } });
  applyGlass();
  applyBtn.textContent = '已发送 ✓';
  applyBtn.disabled = true;
  window.setTimeout(() => {
    applyBtn.textContent = '立即生效';
    applyBtn.disabled = false;
    if (applyHint) applyHint.hidden = true;
  }, 2600);
});

// ── reset ───────────────────────────────────────────────────────────────────
//
// One delegated handler covers every per-row ↺: rows are static markup, but delegation
// keeps the wiring in one place and makes the colour row (a string value, not a number)
// no special case. The button lives OUTSIDE the <label>, so clicking it cannot also
// nudge the slider it belongs to.
document.querySelector('.we-controls')?.addEventListener('click', (event) => {
  const btn = event.target instanceof Element ? event.target.closest('[data-reset]') : null;
  if (!btn) return;
  const key = btn.dataset.reset;
  if (!key || !(key in DEFAULTS)) return;
  commitSetting(key, DEFAULTS[key], document.getElementById(`in-${key}`));
});

document.getElementById('btn-reset-all')?.addEventListener('click', () => {
  // Immediate per key: the debounced path shares one timer, so a loop over ten keys
  // would post only the last one and quietly leave nine settings changed.
  for (const [key] of SLIDERS) commitSetting(key, DEFAULTS[key], document.getElementById(`in-${key}`), true);
  commitSetting('glassColor', DEFAULTS.glassColor, document.getElementById('in-glassColor'), true);
  if (applyHint) {
    applyHint.hidden = false;
    applyHint.textContent = '已恢复默认值';
    window.setTimeout(() => {
      applyHint.hidden = true;
    }, 2600);
  }
});

el.play?.addEventListener('click', () => {
  state.paused = !state.paused;
  applyLayerState();
  persist();
});

el.next?.addEventListener('click', () => vscode.postMessage({ type: 'next' }));

// ── host messages ───────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      if (msg.settings) state.settings = { ...state.settings, ...msg.settings };
      applyGlass();
      syncInputs();
      break;
    case 'settings':
      // A slider the user just moved must not snap back to a value the host has not
      // written yet — that is what made 「立即生效」 look like it reverted the change.
      state.settings = pendingSettings.merge(state.settings, msg.settings);
      measureContrast();
      applyGlass();
      syncInputs();
      break;
    case 'inventory':
      state.inventory = msg.snapshot || null;
      if (!state.item) renderMeta();
      // Keep an open library in step: the first scan often lands while it is open.
      if (libraryOpen) renderLibrary();
      break;
    case 'item':
      setItem(msg.item || null);
      measureContrast();
      if (libraryOpen) markCurrentLibraryRow(state.item?.id);
      break;
    case 'library':
      setLibraryOpen(!!msg.open);
      break;
    case 'live':
      // Who renders the wallpaper live: this panel, or the whole-window layer.
      state.panelLive = msg.panelLive !== false;
      measureContrast();
      applyLayerState();
      break;
    case 'applied':
      // The host answered 「立即生效」. `reload` means the assets are newer than what this
      // window loaded — the one case a button cannot fix on its own.
      if (applyHint) {
        applyHint.hidden = false;
        applyHint.textContent = msg.reload ? '资源已更新，需要重载窗口（已弹出提示）' : '已应用到所有窗口';
      }
      break;
    case 'visibility':
      state.visible = !!msg.visible;
      applyLayerState();
      break;
    case 'focus':
      state.focused = !!msg.focused;
      applyLayerState();
      break;
    default:
      log('warn', `未知消息 ${JSON.stringify(msg)}`);
  }
});

// Theme switches (light/dark) move the readability floor — recompute, and re-measure
// because the direction of the correction flips with the theme.
new MutationObserver(() => {
  contrastKey = null;
  measureContrast();
  applyGlass();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// Self-report (info level): the one lifecycle the host cannot see. If the panel
// shows nothing but the log is silent, these lines say which layer broke —
// webview dead (no reports at all), item never pushed (item=null), mount hung
// (children=0), or a mounted canvas that renders nothing visible.
window.setInterval(() => {
  const canvas = el.live ? el.live.querySelector('canvas') : null;
  log(
    'info',
    `面板状态: item=${state.item ? state.item.id : 'null'} mode=${state.item ? state.item.renderMode : '-'} ` +
      `badge=${el.badge.textContent} liveHidden=${el.live ? el.live.hidden : '?'} ` +
      `children=${el.live ? el.live.childElementCount : '?'} ` +
      `canvas=${canvas ? `${canvas.width}x${canvas.height} css ${canvas.clientWidth}x${canvas.clientHeight}` : 'none'} ` +
      `poster=${el.poster && el.poster.hidden ? 'hidden' : 'shown'}`,
  );
}, 5000);

applyGlass();
syncInputs();
renderMeta();
applyLayerState();
vscode.postMessage({ type: 'ready' });
