/**
 * Media server tests: the Range parser as a unit, then a live server over a
 * throwaway file, exercising the paths a <video> element actually uses
 * (initial GET, mid-file seek, suffix probe, unknown token, out-of-root refusal).
 */

'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { MediaServer, parseRange, mimeFor, isInside } = require('../out/media/server.js');

test('parseRange covers the RFC 7233 cases a <video> triggers', () => {
  assert.equal(parseRange(undefined, 100), null, 'no header → ignore');
  assert.equal(parseRange('bytes=0-', 100).end, 99, 'open-ended');
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=0-10000', 100), { start: 0, end: 99 }, 'clamped to size');
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 }, 'suffix range');
  assert.equal(parseRange('bytes=200-300', 100), 'unsatisfiable', 'start past end');
  assert.equal(parseRange('bytes=5-1', 100), 'unsatisfiable', 'reversed');
  assert.equal(parseRange('items=0-10', 100), null, 'unknown unit → ignore');
  assert.equal(parseRange('bytes=0-10, 20-30', 100), null, 'multi-range → ignore');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
});

test('mimeFor maps the containers and web-wallpaper subresources', () => {
  assert.equal(mimeFor('a.mp4'), 'video/mp4');
  assert.equal(mimeFor('a.MKV'), 'video/x-matroska');
  assert.equal(mimeFor('index.html'), 'text/html');
  assert.equal(mimeFor('main.mjs'), 'text/javascript');
  assert.equal(mimeFor('style.css'), 'text/css');
  assert.equal(mimeFor('x.unknownext'), 'application/octet-stream');
});

test('isInside is boundary-aware', () => {
  assert.equal(isInside('C:\\Steam', 'C:\\Steam\\a\\b.mp4'), true);
  assert.equal(isInside('C:\\Steam', 'C:\\SteamLibrary\\b.mp4'), false);
  assert.equal(isInside('C:\\Steam\\', 'C:\\Steam\\a.mp4'), true);
});

test('preferred port: fall back when taken, take over when it frees up', async (t) => {
  // Pick a free port, then let the first server claim it.
  const probe = new MediaServer(() => {});
  await probe.start();
  const preferred = Number(new URL(probe.origin).port);
  await probe.dispose();

  const dir = await mkdtemp(join(tmpdir(), 'we-port-'));
  const file = join(dir, 'clip.mp4');
  await writeFile(file, Buffer.from('0123456789'));

  const owner = new MediaServer(() => {}, { preferredPort: preferred });
  await owner.start();
  t.after(async () => {
    await owner.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(new URL(owner.origin).port, String(preferred), '第一个实例应拿到首选端口');

  const other = new MediaServer(() => {}, { preferredPort: preferred });
  await other.start();
  other.allowRoot(dir);
  t.after(() => other.dispose());
  assert.notEqual(new URL(other.origin).port, String(preferred), '端口被占用时应回退到随机端口');
  assert.equal(await other.claimPreferredPort(), false, '占用期间不得抢端口');

  const url = other.register(file);
  assert.ok(url, '回退期间仍应能注册文件');

  await owner.dispose();
  assert.equal(await other.claimPreferredPort(), true, '占用者退出后应接管');
  assert.equal(other.origin, `http://127.0.0.1:${preferred}`, 'origin 应变为首选端口');
  // Same port, same token: pages already loaded against this URL keep working.
  assert.equal(other.register(file), `http://127.0.0.1:${preferred}/m/${url.split('/m/')[1]}`);

  const res = await fetch(other.register(file));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '0123456789');
  assert.equal(await other.claimPreferredPort(), false, '已在首选端口上时是空操作');
});

test('/current + /status + /beacon: the routes the patched workbench relies on', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'we-current-'));
  const file = join(dir, 'clip.mp4');
  await writeFile(file, Buffer.from('0123456789'));
  const server = new MediaServer(() => {});
  await server.start();
  server.allowRoot(dir);
  t.after(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  // Nothing selected yet: the page must not be told to play something random.
  const empty = await (await fetch(`${server.origin}/current`)).json();
  assert.deepEqual(empty.url, null);
  assert.equal(empty.port, Number(new URL(server.origin).port));

  const url = server.register(file);
  assert.ok(url);
  server.setCurrent({ url, kind: 'video' });
  const current = await (await fetch(`${server.origin}/current`)).json();
  assert.equal(current.url, url, '页面据此在运行时取到壁纸地址');
  assert.equal(current.kind, 'video', '页面据此决定用 <video> 还是 <img>');

  // Beacon: counts distinct documents, ignores missing/oversized ids.
  assert.equal((await fetch(`${server.origin}/beacon?doc=doc-a`)).status, 204);
  assert.equal((await fetch(`${server.origin}/beacon?doc=doc-b`)).status, 204);
  await fetch(`${server.origin}/beacon?doc=doc-a`);
  assert.equal(server.patchedWindows, 2, '同一文档重复上报只算一个窗口');
  await fetch(`${server.origin}/beacon`);
  assert.equal(server.patchedWindows, 2, '没有 doc 参数的 beacon 不应计入');

  const status = await (await fetch(`${server.origin}/status`)).json();
  assert.equal(status.patchedWindows, 2);
  assert.equal(status.port, Number(new URL(server.origin).port));
  assert.equal(typeof status.activeStreams, 'number');

  // /probe round-trip. The page posts as text/plain (a "simple" request, so no
  // preflight), but a JSON content type must work too — browsers preflight it, and
  // a server that answers OPTIONS with a bare 200 makes them drop the request
  // silently. That is how the style probe managed to report nothing, ever.
  const report = JSON.stringify({ doc: 'doc-a', iconCount: 3, styles: { '.monaco-workbench': { bg: 'rgba(0, 0, 0, 0)' } } });
  const plain = await fetch(`${server.origin}/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: report,
  });
  assert.equal(plain.status, 204);
  // Style reports and live-scene lifecycle reports live in SEPARATE slots: the
  // style probe fires on a timer and must never overwrite the scene report (that
  // overwrite is exactly how the whole-window scene failure stayed invisible).
  const styleBack = await (await fetch(`${server.origin}/probe`)).json();
  assert.deepEqual({ ...styleBack, scene: undefined }, { ...JSON.parse(report), scene: undefined });
  assert.equal(styleBack.scene, null);

  const sceneReport = JSON.stringify({ scene: { stage: 'mounted', key: 'k', err: null, tt: 'present' } });
  const scenePost = await fetch(`${server.origin}/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: sceneReport,
  });
  assert.equal(scenePost.status, 204);
  const sceneBack = await (await fetch(`${server.origin}/probe`)).json();
  assert.deepEqual(sceneBack.scene, { stage: 'mounted', key: 'k', err: null, tt: 'present' }, 'scene 报告独立保存');
  assert.ok(sceneBack.styles, 'scene 上报不得覆盖 style 探针');

  const preflight = await fetch(`${server.origin}/probe`, {
    method: 'OPTIONS',
    headers: { Origin: 'vscode-file://vscode-app', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204, 'OPTIONS 必须被正确应答，否则浏览器会丢掉探针');
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /content-type/i);

  const jsonPost = await fetch(`${server.origin}/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: 'doc-b' }),
  });
  assert.equal(jsonPost.status, 204);
  assert.equal((await (await fetch(`${server.origin}/probe`)).json()).doc, 'doc-b');
});

test('live server: token gate, Range, HEAD, method and root fencing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'we-media-'));
  const outside = await mkdtemp(join(tmpdir(), 'we-outside-'));
  const payload = Buffer.from('0123456789abcdefghij', 'utf8');
  const file = join(dir, 'clip.mp4');
  const stray = join(outside, 'secret.mp4');
  await writeFile(file, payload);
  await writeFile(stray, payload);

  const server = new MediaServer(() => {});
  await server.start();
  server.allowRoot(dir);
  t.after(async () => {
    await server.dispose();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const url = server.register(file);
  assert.ok(url, 'file inside an allowed root must register');
  assert.equal(server.register(stray), null, 'file outside every root must be refused');
  assert.equal(server.register('relative/path.mp4'), null, 'relative paths must be refused');

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('access-control-allow-origin'), '*');
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), payload.toString());

  const partial = await fetch(url, { headers: { Range: 'bytes=5-9' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 5-9/${payload.length}`);
  assert.equal(await partial.text(), '56789');

  const suffix = await fetch(url, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'ghij');

  const bad = await fetch(url, { headers: { Range: 'bytes=999-1000' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${payload.length}`);

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(payload.length));

  const posted = await fetch(url, { method: 'POST' });
  assert.equal(posted.status, 405);

  const unknown = await fetch(`http://127.0.0.1:${new URL(url).port}/m/${'a'.repeat(24)}`);
  assert.equal(unknown.status, 404, 'unknown token → 404');

  const traversal = await fetch(`http://127.0.0.1:${new URL(url).port}/m/..%2f..%2fetc%2fpasswd`);
  assert.equal(traversal.status, 404, 'path-shaped token → 404');
});
