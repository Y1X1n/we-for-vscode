/**
 * Functional regression test for the "web wallpaper has no scene.pkg" bug.
 *
 * The old adapter hand-rolled a Source for web items whose `scenePkg` rejected and
 * whose `project` returned null — the engine uses `project()` to read `project.json`
 * and branch on its `type`, so with that Source it could not even tell the payload
 * was a web wallpaper and mount died with "web wallpaper has no scene.pkg". The fix:
 * Scene and Web go through the SAME `httpSource(sceneBase)`; mount() branches on
 * `project.json` itself.
 *
 * The vendored engine imports under plain Node with a handful of DOM stubs (no WebGL,
 * no rendering — only the Source factories are touched here).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const noop = () => {};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.dispatchEvent = noop;
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', hardwareConcurrency: 4, platform: 'win32', maxTouchPoints: 0 },
  configurable: true,
});
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, getContext: () => null }),
  createElementNS: () => ({ style: {} }),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  documentElement: { setAttribute() {}, style: {} },
  querySelectorAll: () => [],
  querySelector: () => null,
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};
globalThis.location = { href: 'http://127.0.0.1:1/x', origin: 'http://127.0.0.1:1', protocol: 'http:' };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { isLive, mountWallpaper, sourceFor } = await import('../media/renderer.mjs');

const SCENE_BASE = 'http://127.0.0.1:39127/wallpaper-engine/scene-files/tok';
const ENTRY_URL = `${SCENE_BASE}/index.html`;

test('web and scene items get the SAME kind of source: the project-directory httpSource', () => {
  const scene = sourceFor({ renderMode: 'scene', media: `${SCENE_BASE}/scene.pkg`, sceneBase: SCENE_BASE });
  const web = sourceFor({ renderMode: 'web', media: ENTRY_URL, sceneBase: SCENE_BASE });

  for (const source of [scene, web]) {
    assert.ok(source, '两种实时壁纸都必须拿到 Source');
    assert.equal(source.key, SCENE_BASE, 'Source 的 key 就是项目目录基址');
    assert.equal(typeof source.project, 'function', 'mount() 靠 project() 读 project.json 分流');
    assert.equal(typeof source.scenePkg, 'function');
    assert.equal(typeof source.webEntry, 'function');
    assert.equal(typeof source.mediaEntry, 'function');
  }
  assert.equal(web.key, scene.key, 'Web 与 Scene 必须同路，不许再为 Web 手写 Source');
});

test('the web source is built from sceneBase, not from the entry URL', () => {
  // The entry URL is what <old webSource> was fed — if sourceFor starts accepting it
  // again, httpSource would append scene.pkg to an HTML file and the branch would break.
  const fromEntry = sourceFor({ renderMode: 'web', media: ENTRY_URL, sceneBase: null });
  assert.equal(fromEntry, null, '没有目录基址就不许猜 Source（降级为预览图）');
});

test('non-live items and missing payloads get no source at all', () => {
  assert.equal(sourceFor(null), null);
  assert.equal(sourceFor({ renderMode: 'video', media: 'http://127.0.0.1:1/m/v' }), null);
  assert.equal(sourceFor({ renderMode: 'poster' }), null);
  assert.equal(sourceFor({ renderMode: 'none' }), null);
  assert.equal(sourceFor({ renderMode: 'scene', sceneBase: null }), null, '载荷没注册成功就不挂载');
});

test('mountWallpaper refuses items without a source (degrade to preview, never black)', async () => {
  await assert.rejects(
    mountWallpaper({}, { renderMode: 'poster' }),
    /没有可挂载的载荷/,
  );
});

test('isLive covers exactly the two live render modes', () => {
  for (const [mode, expected] of [
    ['scene', true],
    ['web', true],
    ['video', false],
    ['poster', false],
    ['none', false],
  ]) {
    assert.equal(isLive({ renderMode: mode }), expected, `isLive(${mode})`);
    assert.equal(isLive(null), false);
  }
});
