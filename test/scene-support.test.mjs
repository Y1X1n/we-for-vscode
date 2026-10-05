/**
 * Scene/Web payload guards (the engine itself is the vendored npm library now).
 *
 * The engine is imported directly by the webview, so what is left for us to get right
 * is the **payload side**, and none of it is visible from a unit test of the
 * extension alone:
 *
 *   1. the media server must expose a wallpaper's directory under a path-addressable
 *      token, because `httpSource(base)` appends the fixed name `scene.pkg` itself;
 *   2. a pkg stored under another name must be aliased onto the names the engine tries
 *      (our resolver accepts any single *.pkg, the engine does not);
 *   3. the fence must hold (no crawling out of the registered directory);
 *   4. big payloads must revalidate (ETag/304) instead of being re-downloaded;
 *   5. the workbench background layer is a single <video>, so it must be TOLD what
 *      kind of thing it is getting — a pkg or a JPEG in a video element renders
 *      nothing, which is what made Scene wallpapers look broken there.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MediaServer } from '../out/media/server.js';
import { WallpaperService } from '../out/service.js';

const silent = () => {};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'we-scene-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scene payloads are path-addressable, and the fence stops escapes', async (t) => {
  const root = sandbox(t);
  const project = join(root, 'project');
  mkdirSync(join(project, 'textures'), { recursive: true });
  writeFileSync(join(project, 'scene.pkg'), 'PKG-BYTES', 'utf8');
  writeFileSync(join(project, 'textures', 'a.tex'), 'TEX', 'utf8');
  writeFileSync(join(root, 'secret.txt'), 'SECRET', 'utf8');

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();
  const base = server.registerDir(project);
  assert.ok(base, '目录应当注册成功');
  assert.match(base, /\/wallpaper-engine\/scene-files\/[A-Za-z0-9_-]{16,64}$/);

  // 引擎的 httpSource(base) 会自己拼 scene.pkg —— base 必须是目录，不是文件
  const pkg = await fetch(`${base}/scene.pkg`);
  assert.equal(pkg.status, 200);
  assert.equal(await pkg.text(), 'PKG-BYTES');
  assert.equal(pkg.headers.get('access-control-allow-origin'), '*', '跨源 fetch 需要 CORS');

  // 兄弟文件按相对路径可达（Web 壁纸的作者 HTML 靠这个）
  const tex = await fetch(`${base}/textures/a.tex`);
  assert.equal(tex.status, 200);
  assert.equal(await tex.text(), 'TEX');

  // pkg 支持 Range（大包必须能断点续传）
  const ranged = await fetch(`${base}/scene.pkg`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), 'PKG');
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-2/9');

  // 围栏：不许爬出注册目录
  for (const evil of ['../secret.txt', '..%2Fsecret.txt', '%2e%2e%2fsecret.txt', 'textures/../../secret.txt']) {
    const res = await fetch(`${base}/${evil}`);
    assert.equal(res.status, 404, `${evil} 必须 404`);
  }
  assert.equal((await fetch(`${base.replace(/[^/]+$/, 'x'.repeat(24))}/scene.pkg`)).status, 404);

  // 目录必须在允许根之内：允许根本身可以，根之外不行
  const outside = mkdtempSync(join(tmpdir(), 'we-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(server.registerDir(outside), null, '不允许把允许根之外的目录注册进来');
  assert.ok(server.registerDir(root), '允许根本身应当可注册');
});

test('a pkg stored under another name is aliased onto the fixed names the engine asks for', async (t) => {
  // 引擎只试 scene.pkg / scenes/scene.pkg / gifscene.pkg（写死在它的 HTTP source 里），
  // 而我们的解析器接受目录里任意唯一的 *.pkg —— 不做别名，这类壁纸必然 404。
  const root = sandbox(t);
  const project = join(root, 'mypkg-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'my-scene.pkg'), 'PKG-UNDER-OTHER-NAME', 'utf8');

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();
  const base = server.registerDir(project);
  assert.ok(base);

  const aliased = await fetch(`${base}/scene.pkg`);
  assert.equal(aliased.status, 200, 'scene.pkg 必须命中目录里唯一的那个 pkg');
  assert.equal(await aliased.text(), 'PKG-UNDER-OTHER-NAME');
  assert.equal((await fetch(`${base}/my-scene.pkg`)).status, 200, '原名也仍然可取');

  // 目录里有多个 pkg 时不许猜：宁可 404，也不要静默挑一个错的
  writeFileSync(join(project, 'second.pkg'), 'OTHER', 'utf8');
  assert.equal((await fetch(`${base}/scene.pkg`)).status, 404, '多个 pkg 时不得随便挑');
});

test('scene payloads revalidate instead of re-downloading hundreds of MB', async (t) => {
  const root = sandbox(t);
  const project = join(root, 'p');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'scene.pkg'), 'PKG', 'utf8');
  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();
  const base = server.registerDir(project);

  const first = await fetch(`${base}/scene.pkg`);
  assert.equal(first.headers.get('cache-control'), 'no-cache', '大包必须可重校验，而不是 no-store 每次重下');
  const etag = first.headers.get('etag');
  assert.ok(etag, '没有 ETag 就没法 304');
  const again = await fetch(`${base}/scene.pkg`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '', '304 不能带 body');

  // 普通 token 文件仍然是 no-store：token 不描述内容，陈旧命中会是静默错误
  const opaque = await fetch(server.register(join(project, 'scene.pkg')));
  assert.equal(opaque.headers.get('cache-control'), 'no-store');
});

test('the workbench background layer is told what kind of element it needs', async (t) => {
  // 方案 B 的那层只有一个 <video>，而 video 元素播不了 scene.pkg、也显示不了 JPEG
  // 预览 —— 选中 Scene 壁纸后整窗背景全黑，就是这里没有区分类型造成的。
  const media = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => media.dispose());
  const service = new WallpaperService(silent, media, () => []);

  assert.deepEqual(
    service.workbenchTargetFor({ renderMode: 'video', media: 'http://x/m/v', preview: 'http://x/m/p' }),
    { url: 'http://x/m/v', kind: 'video' },
    '视频走 video',
  );
  assert.deepEqual(
    service.workbenchTargetFor({
      renderMode: 'scene',
      media: 'http://x/wallpaper-engine/scene-files/t/scene.pkg',
      preview: 'http://x/m/p',
    }),
    { url: 'http://x/m/p', kind: 'image' },
    'Scene 在整窗层是静图，绝不能把 pkg 塞给 <video>',
  );
  assert.deepEqual(service.workbenchTargetFor({ renderMode: 'poster', media: null, preview: 'http://x/m/p' }), {
    url: 'http://x/m/p',
    kind: 'image',
  });
  assert.equal(service.workbenchTargetFor({ renderMode: 'none', media: null, preview: null }), null);
  assert.equal(service.workbenchTargetFor(undefined), null);
});

test('/current reports the kind, so the injected script can pick <video> or <img>', async (t) => {
  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  await server.start();
  assert.equal((await (await fetch(`${server.origin}/current`)).json()).url, null);
  server.setCurrent({ url: 'http://x/m/p', kind: 'image' });
  const payload = await (await fetch(`${server.origin}/current`)).json();
  assert.equal(payload.kind, 'image');
  assert.equal(payload.url, 'http://x/m/p');
});

test('the whole-window live scene is opt-in, and carries its still as a fallback', async (t) => {
  const media = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => media.dispose());
  const service = new WallpaperService(silent, media, () => []);
  const scene = {
    renderMode: 'scene',
    media: 'http://x/wallpaper-engine/scene-files/t/scene.pkg',
    sceneBase: 'http://x/wallpaper-engine/scene-files/t',
    preview: 'http://x/m/p',
  };

  // Default: a still. A full-screen WebGL canvas behind the whole UI is exactly the
  // arrangement that produced the stale-layer artifacts, so it must not be the default.
  assert.deepEqual(service.workbenchTargetFor(scene), { url: 'http://x/m/p', kind: 'image' });
  // Opt-in: the engine mounts live, and the still is what shows while it loads.
  assert.deepEqual(service.workbenchTargetFor(scene, true), {
    url: 'http://x/wallpaper-engine/scene-files/t',
    kind: 'scene',
    still: 'http://x/m/p',
  });
  // Videos and poster items are unaffected by the switch.
  assert.deepEqual(service.workbenchTargetFor({ renderMode: 'video', media: 'http://x/m/v' }, true), {
    url: 'http://x/m/v',
    kind: 'video',
  });
});

test('a loose (source-form) scene is a live mode whose entry json and materials are reachable by name', async (t) => {
  // Engine ≥2.1.0 renders WE editor projects WITHOUT a packed scene.pkg: project.json
  // declares `file: "scene.json"` and the engine fetches scene.json / materials/ /
  // models/ / shaders/ BY NAME from the directory token. The service must classify
  // these as live (they used to degrade to poster) and the wire must serve every
  // relative name — otherwise the loose chain dies mid-assembly.
  const root = sandbox(t);
  // Make the sandbox a real Steam library the service can discover: a
  // libraryfolders.vdf whose path block mentions 431960, plus the workshop content
  // root the enumerator walks.
  const steamRoot = join(root, 'steam');
  mkdirSync(join(steamRoot, 'steamapps'), { recursive: true });
  writeFileSync(
    join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n  "0"\n  {\n    "path"    "${steamRoot.replace(/\\/g, '\\\\')}"\n    "431960"  "1"\n  }\n}\n`,
    'utf8',
  );
  const project = join(steamRoot, 'steamapps', 'workshop', 'content', '431960', 'loose-project');
  mkdirSync(join(project, 'materials'), { recursive: true });
  writeFileSync(
    join(project, 'project.json'),
    JSON.stringify({ type: 'scene', file: 'scene.json', title: 'Loose', preview: 'preview.jpg' }),
    'utf8',
  );
  writeFileSync(join(project, 'scene.json'), JSON.stringify({ camera: 'default', objects: [] }), 'utf8');
  writeFileSync(join(project, 'materials', 'solid.json'), JSON.stringify({ shader: 'generic' }), 'utf8');
  writeFileSync(join(project, 'preview.jpg'), 'JPG', 'utf8');

  const { enumerateWallpapers } = await import('../out/we/inventory.js');
  const projects = await enumerateWallpapers(null, [steamRoot]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].type, 'scene');
  assert.equal(projects[0].fileAbs, join(project, 'scene.json'));

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.allowRoot(root);
  await server.start();
  const service = new WallpaperService({ info: () => {}, warn: () => {}, error: () => {} }, server, () => [steamRoot]);
  const snapshot = await service.scan();

  const item = snapshot.items.find((i) => i.id === 'loose-project');
  assert.ok(item, '松散工程应当出现在清单里');
  assert.equal(item.renderMode, 'scene', '散装 scene.json 源码工程现在是实时渲染（引擎 ≥2.1.0 松散形态）');
  assert.ok(item.sceneBase);
  assert.equal(item.media, `${item.sceneBase}/scene.json`, '载荷 URL 指向引擎最先读取的入口 json');
  assert.equal((await fetch(item.media)).status, 200, '入口 json 必须可达');
  assert.equal((await fetch(`${item.sceneBase}/materials/solid.json`)).status, 200, '装配期按名取的材质必须可达');
  assert.ok(snapshot.playableCount >= 1);
});

test('the vendored engine carries the loose-form reader (sceneDir) it needs for source-form projects', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../media/webwallgl/webwallgl.min.mjs', import.meta.url), 'utf8');
  assert.match(lib, /sceneDir/, 'httpSource 必须实现 sceneDir（松散形态）');
  assert.match(lib, /data-we-shim-src/, '引擎自带 shim 注入标记');
});

test('the engine file is served for the workbench blob-import, and 404s when unset', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'we-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = join(dir, 'webwallgl.min.mjs');
  writeFileSync(engine, 'export const mount = () => {};\n', 'utf8');

  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  await server.start();

  // Nothing configured: no engine URL, and the route must not leak anything.
  assert.equal(server.engineUrl, null);
  assert.equal((await fetch(`${server.origin}/engine/webwallgl.mjs`)).status, 404);

  server.setEngineFile(engine);
  assert.equal(server.engineUrl, `${server.origin}/engine/webwallgl.mjs`);
  const res = await fetch(server.engineUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', 'workbench 页跨源取引擎需要 CORS');
  assert.match(await res.text(), /export const mount/);
});

test('the injected script carries the blob-import scene branch', async () => {
  // The workbench CSP allows blob: scripts but not the loopback origin, so the engine
  // has to arrive as a blob URL — and the still must stay until the canvas is mounted.
  const js = readFileSync(join(root, 'out/workbench/patch.js'), 'utf8');
  assert.match(js, /payload\.kind === 'scene'/);
  assert.match(js, /URL\.createObjectURL\(new Blob\(\[code\], \{ type: 'text\/javascript' \}\)\)/);
  assert.match(js, /lib\.mount\(host, \{/);
  assert.match(js, /lib\.httpSource\(key\)/);
  assert.match(js, /退回静图/);
  const css = readFileSync(join(root, 'out/workbench/patch.js'), 'utf8');
  assert.match(css, /#we-workbench-scene > canvas/);
  // The whole-window scene was invisible despite a successful mount: the stylesheet
  // hides <img> and the scene host with display:none, and setMode('scene') set an
  // EMPTY inline display — which falls back to the stylesheet — so the engine
  // measured the container at 0x0 and the mounted canvas stayed invisible. Guards
  // for both halves of that fix, plus the /probe lifecycle report:
  assert.match(js, /scene\.style\.display = mode === 'scene' \? 'block' : 'none'/, 'setMode 必须显式 block（\'\' 回落到样式表 display:none，整窗层永远不可见）');
  assert.match(js, /host\.style\.display = 'block'/, '挂载前容器必须参与布局（引擎在挂载时测量尺寸）');
  assert.match(js, /host\.style\.visibility = 'hidden'/, '加载期用 visibility 隐藏，静图继续覆盖（空 canvas 是不透明黑块）');
  assert.match(js, /reportLayer\(/, '整窗层挂载生命周期必须回报到 /probe（黑屏不能再是无声的）');
});

test('a live Web wallpaper behind the whole UI is opt-in, and keeps its still as fallback', async (t) => {
  // A Web wallpaper is an author HTML app: the workbench layer used to degrade it to
  // the project's 256x256 preview, which reads as "Web 壁纸没法良好显示" once it is
  // stretched over a 4K window. It is now a live kind too — the engine mounts it, and
  // the preview stays underneath as the fallback.
  const media = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => media.dispose());
  const service = new WallpaperService(silent, media, () => []);
  const web = {
    renderMode: 'web',
    media: 'http://x/wallpaper-engine/scene-files/t/index.html',
    sceneBase: 'http://x/wallpaper-engine/scene-files/t',
    preview: 'http://x/m/p',
  };

  assert.deepEqual(service.workbenchTargetFor(web), { url: 'http://x/m/p', kind: 'image' }, '默认仍是静图');
  assert.deepEqual(
    service.workbenchTargetFor(web, true),
    { url: 'http://x/wallpaper-engine/scene-files/t', kind: 'web', still: 'http://x/m/p' },
    '开启后整窗层拿到的应是项目目录（引擎自己读 project.json 分流）',
  );
  // A web item without a registered directory cannot be mounted live — fall back.
  assert.deepEqual(service.workbenchTargetFor({ renderMode: 'web', sceneBase: null, preview: 'http://x/m/p' }, true), {
    url: 'http://x/m/p',
    kind: 'image',
  });
});

test('/current hands the engine to every live kind, and only to those', async (t) => {
  const server = new MediaServer(silent, { secret: 'test-secret' });
  t.after(() => server.dispose());
  server.setEngineFile(join(root, 'media/webwallgl/webwallgl.min.mjs'));
  await server.start();

  server.setCurrent({ url: 'http://x/wallpaper-engine/scene-files/t', kind: 'web', still: 'http://x/m/p' });
  const web = await (await fetch(`${server.origin}/current`)).json();
  assert.equal(web.kind, 'web');
  assert.equal(web.engine, `${server.origin}/engine/webwallgl.mjs`, 'Web 壁纸的实时层同样要拿引擎 URL');
  assert.equal(web.still, 'http://x/m/p');

  server.setCurrent({ url: 'http://x/m/p', kind: 'image' });
  const still = await (await fetch(`${server.origin}/current`)).json();
  assert.equal(still.engine, null, '静图不该把引擎递过去');
});
