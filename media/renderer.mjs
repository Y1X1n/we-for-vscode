/**
 * Live-wallpaper mounting — a thin adapter over the vendored `webwallgl` library.
 *
 * Why a library import instead of the previous arrangement (serve the user's built
 * renderer page from the loopback origin, embed it in a cross-origin iframe, inject a
 * postMessage bridge because `contentWindow.__wp` is unreachable): the engine is
 * published on npm as **MIT** (`media/webwallgl/`, vendored with its LICENSE and
 * UPSTREAM.json), so it can be imported directly. That gives us, in our own origin:
 *
 *   · `mount(el, { source })` → a `SceneInstance` we hold directly, with
 *     `pause/resume/setFit/setFps/setVolume/setQuality/setProperties`;
 *   · `instance.canvas` → first-frame capture with plain `toDataURL()` (no bridge,
 *     no `/scene-frame` round trip);
 *   · one engine for Scene and Web — mount() fetches `project.json` itself and
 *     branches on its `type`.
 *
 * Only the payload side is ours: the media server serves a wallpaper's directory
 * under a path-addressable token, which is what `httpSource` needs (it appends the
 * fixed `scene.pkg` name itself — the media server aliases a differently-named pkg
 * onto it).
 */

import { httpSource, mount, sniffMediaType } from './webwallgl/webwallgl.min.mjs';

/**
 * Source for a Scene **or** a Web wallpaper: the project directory token, same path
 * for both kinds. mount() fetches `project.json` from the base and branches on its
 * `type` — `web` becomes a sandbox iframe pointing at `{base}/{project.file or
 * index.html}`, `video/gif/image` a media path, everything else the scene assembly.
 * Hand-rolling a Source whose `scenePkg` rejects and whose `project` returns null
 * (the first attempt here) does NOT take that branch: the library cannot tell a web
 * wallpaper from a broken one, and mount dies with "web wallpaper has no scene.pkg".
 *
 * The media server serves the whole project directory under the token, so
 * `project.json`, the entry HTML and every author-relative css/js/audio resolve
 * exactly as they do in Wallpaper Engine.
 */
export function sourceFor(item) {
  if (!item) return null;
  if (item.renderMode === 'scene' || item.renderMode === 'web') {
    return item.sceneBase ? httpSource(item.sceneBase) : null;
  }
  return null;
}

/**
 * Mount a wallpaper into `el`.
 *
 * `el` must be a container (the panel passes the `#wp-live` div): a web wallpaper's
 * sandbox iframe is appended INTO it, and a canvas cannot hold children. For scenes
 * the library builds its own canvas inside the same way.
 *
 * `volume: 0` because the panel exposes no audio control — unmuting would play a
 * wallpaper's sound with no way to stop it (upstream mutes under the same condition).
 *
 * `onDiagnostic` / `onError` are the engine's own reporting channels (2.1.0 attaches
 * one-shot diagnostics to its four silent-failure paths and reports WebGL context
 * loss as a visible event) — without forwarding them, a dead render loop in the
 * webview looks exactly like "mounted but nothing on screen".
 *
 * `mountTimeoutMs` keeps the upstream default (60s): mount() resolves only on the
 * first frame or an error, so a silently-dead render loop would otherwise leave the
 * caller hanging forever; the watchdog turns that into a reject we can log and
 * degrade from.
 *
 * `webSandbox: 'strict'` is passed per the documented contract so author web code
 * stays out of the panel's origin once the engine honors it. NOTE: 2.1.0 (like
 * 1.4.2) drops the option when projecting the mount config, so the iframe currently
 * comes up legacy (`allow-scripts allow-same-origin`). Containment therefore rests
 * on the sandboxed blob document plus the panel CSP — which is also why the panel's
 * script-src carries 'unsafe-inline' + the loopback origin: the blob iframe inherits
 * that policy.
 */
export async function mountWallpaper(el, item, options = {}) {
  const source = sourceFor(item);
  if (!source) throw new Error('这个壁纸没有可挂载的载荷');
  return mount(el, {
    source,
    fit: options.fit ?? 'cover',
    fps: options.fps ?? 30,
    autoplay: true,
    volume: 0,
    renderDpr: options.renderDpr ?? 0,
    webSandbox: options.webSandbox ?? 'strict',
    mountTimeoutMs: options.mountTimeoutMs,
    onDiagnostic: options.onDiagnostic,
    onError: options.onError,
    onReady: options.onReady,
  });
}

/** True when the item is something the library can mount live. */
export function isLive(item) {
  return Boolean(item && (item.renderMode === 'scene' || item.renderMode === 'web'));
}

/** Exported for the panel's own diagnostics: does this URL look like media? */
export { sniffMediaType };
