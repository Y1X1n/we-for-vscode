/**
 * Web wallpaper guards.
 *
 * A Web wallpaper is the author's own HTML; the vendored engine fetches it, injects
 * its own WE web-API shim into the rewritten document, and loads that from a blob:
 * sandbox iframe (`webSandbox: "strict"` here). Author code loads its css/js/audio
 * through RELATIVE paths. What has to hold, and none of it is visible from a unit
 * test of the extension alone:
 *
 *   1. the whole project directory must be addressable (a token per *file* would break
 *      every relative reference) — and `project.json` must be reachable on it, because
 *      that is the file mount() reads to branch a web payload onto the iframe path;
 *   2. the served HTML must be VERBATIM: the engine carries the shim (`data-we-shim-src`
 *      in its bundle) and detects a second one, so a server-side injection is at best
 *      redundant — previously it even pointed at a route that did not exist;
 *   3. a scene directory's loose files are served untouched too;
 *   4. the vendored engine really does bundle the shim — if an upgrade ever drops it,
 *      this fails and server-side injection has to come back with it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MediaServer } from '../out/media/server.js';

const silent = () => {};

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'we-web-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── the server serves web payload files verbatim ─────────────────────────────

test('web payload files are served verbatim — no shim rewriting, no added scripts', async (t) => {
  const root = sandbox(t);
  const web = join(root, 'web');
  const scene = join(root, 'scene');
  const entryHtml = '<!DOCTYPE html><html><head><title>x</title><script src="app.js"></script></head><body>author</body></html>';
  for (const [dir, name, body] of [
    [web, 'index.html', entryHtml],
    [scene, 'loose.html', '<html><head></head><body>scene loose</body></html>'],
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
  }
  writeFileSync(join(web, 'app.js'), 'console.log(1);\n', 'utf8');
  writeFileSync(
    join(web, 'project.json'),
    JSON.stringify({ type: 'web', file: 'index.html', title: 'x' }),
    'utf8',
  );

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();

  const webBase = server.registerDir(web);
  const sceneBase = server.registerDir(scene);
  assert.ok(webBase && sceneBase);

  const entry = await fetch(`${webBase}/index.html`);
  assert.equal(await entry.text(), entryHtml, '入口 HTML 必须逐字节原样（shim 由引擎注入到 blob 文档）');

  // 相对资源照常可达（作者 HTML 靠这个）
  const js = await fetch(`${webBase}/app.js`);
  assert.equal(js.status, 200);
  assert.equal(await js.text(), 'console.log(1);\n', 'JS 不做任何改写');

  // project.json 可达 —— 引擎的 httpSource 靠它判定 type:"web"
  const pj = await fetch(`${webBase}/project.json`);
  assert.equal(pj.status, 200);
  assert.equal((await pj.json()).type, 'web');

  // Scene 目录里的散装文件同样原样
  const loose = await fetch(`${sceneBase}/loose.html`);
  assert.equal(await loose.text(), '<html><head></head><body>scene loose</body></html>');
});

// ── the service contract ─────────────────────────────────────────────────────

test('a web wallpaper is a live mode whose project dir token exposes entry and project.json', async (t) => {
  const root = sandbox(t);
  // The enumerator looks for <install>/projects/{defaultprojects,myprojects}/<id>.
  const project = join(root, 'projects', 'myprojects', 'corsair');
  mkdirSync(join(project, 'assets'), { recursive: true });
  writeFileSync(
    join(project, 'project.json'),
    JSON.stringify({ type: 'web', file: 'index.html', title: 'Corsair', preview: 'preview.jpg' }),
    'utf8',
  );
  writeFileSync(join(project, 'index.html'), '<html><head></head><body>corsair</body></html>', 'utf8');
  writeFileSync(join(project, 'assets', 'style.css'), 'body{color:#fff}', 'utf8');
  writeFileSync(join(project, 'preview.jpg'), 'JPG', 'utf8');

  const { enumerateWallpapers } = await import('../out/we/inventory.js');
  const projects = await enumerateWallpapers(root, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].type, 'web');
  assert.equal(projects[0].dirAbs, project, '清单必须暴露项目目录：Web 的相对资源靠它寻址');
  assert.equal(projects[0].fileAbs, join(project, 'index.html'));

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();

  // Register exactly like the service does for a web item.
  const base = server.registerDir(projects[0].dirAbs);
  assert.ok(base);
  const entry = await fetch(`${base}/index.html`);
  assert.equal(entry.status, 200, '入口 URL 就是 {sceneBase}/{project.file}');
  assert.match(await entry.text(), /corsair/, '作者内容原样保留');
  assert.equal((await fetch(`${base}/project.json`)).status, 200, 'mount() 从这个基址读 project.json');
  assert.equal((await fetch(`${base}/assets/style.css`)).status, 200, '子目录相对资源可达');
});

// ── the vendored engine carries the shim (the assumption behind "verbatim") ──

test('the vendored engine bundles the WE web-API shim it injects into author HTML', async () => {
  // Read the SOURCE tree copy: this is the same file the adapter imports (the VSIX
  // ships media/ verbatim), and out/ has no browser modules.
  const lib = await import('../media/webwallgl/webwallgl.min.mjs').catch(() => null);
  // Importing the engine needs a DOM; under plain node that fails — fall back to a
  // source scan, which is enough for the contract (the shim marker + the API names).
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../media/webwallgl/webwallgl.min.mjs', import.meta.url), 'utf8');
  assert.match(src, /data-we-shim-src/, '引擎自带 shim 注入标记');
  assert.match(src, /wallpaperPropertyListener/, 'shim 覆盖 WE 属性监听 API');
  assert.match(src, /applyUserProperties/, 'shim 覆盖 applyUserProperties');
  assert.ok(lib === null || typeof lib.httpSource === 'function', '引擎可导入时必须导出 httpSource');
});
