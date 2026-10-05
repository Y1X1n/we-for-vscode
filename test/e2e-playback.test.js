/**
 * End-to-end smoke test over the REAL local library: discovery → inventory →
 * token minting → HTTP Range streaming of an actual wallpaper video.
 *
 * This is the closest thing to "does the PoC work" that can run without a GUI:
 * every layer below the webview is the compiled production code, driven with a
 * stub logger. It adapts to the machine — with no Wallpaper Engine installed it
 * reports that and returns, so it never turns into a false failure.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MediaServer } = require('../out/media/server.js');
const { WallpaperService } = require('../out/service.js');

const silent = { info() {}, warn() {}, error() {} };

test('real library: scan → playable item → Range-stream its media', async (t) => {
  const media = new MediaServer(() => {});
  const service = new WallpaperService(silent, media, () => []);
  t.after(async () => {
    await media.dispose();
  });

  await media.start();
  const snapshot = await service.scan(true);

  t.diagnostic(`安装目录：${snapshot.installDir ?? '<未找到>'}`);
  t.diagnostic(`壁纸：${snapshot.items.length} 张，可播放 ${snapshot.playableCount} 张`);
  t.diagnostic(`类型分布：${JSON.stringify(snapshot.counts)}`);

  if (!snapshot.installDir) {
    t.diagnostic('本机未安装 Wallpaper Engine —— 跳过端到端流媒体断言');
    return;
  }

  // Every item must carry a usable shape for the webview.
  for (const item of snapshot.items) {
    // scene/web are live modes now (the vendored webwallgl library mounts them);
    // poster and none are the honest fallbacks.
    assert.ok(['video', 'scene', 'web', 'poster', 'none'].includes(item.renderMode), `${item.id} renderMode 非法`);
    if (item.renderMode === 'video') {
      assert.ok(item.media, `${item.id} 可播放却没有媒体 URL`);
      assert.match(item.media, /^http:\/\/127\.0\.0\.1:\d+\/m\/[A-Za-z0-9_-]{24}$/);
      assert.ok(item.mediaExt, `${item.id} 缺少 mediaExt（webview 判断原生可解需要它）`);
    }
    if (item.preview) assert.match(item.preview, /^http:\/\/127\.0\.0\.1:\d+\/m\//);
  }

  // Only the VIDEO payloads are streamed through a media element; Scene payloads are
  // fetched whole by the renderer (it parses the container itself) and a Web payload is
  // the author's HTML — which the server rewrites (shim injection), so it deliberately
  // answers 200 instead of a partial body.
  const videos = service.playableItems().filter((i) => i.renderMode === 'video');
  if (!videos.length) {
    t.diagnostic('本机没有 Video 壁纸 —— 跳过流媒体断言');
    return;
  }

  for (const item of videos) {
    const head = await fetch(item.media, { method: 'HEAD' });
    assert.equal(head.status, 200, `${item.title} HEAD 应 200`);
    const size = Number(head.headers.get('content-length'));
    assert.ok(size > 0, `${item.title} 应有非零长度`);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');

    // The <video> element's opening move: ask for the first slice.
    const first = await fetch(item.media, { headers: { Range: 'bytes=0-8191' } });
    assert.equal(first.status, 206, `${item.title} 首段应 206`);
    assert.equal(first.headers.get('content-range'), `bytes 0-8191/${size}`);
    const buf = Buffer.from(await first.arrayBuffer());
    assert.equal(buf.length, Math.min(8192, size));

    // Container magic: mp4/webm/mkv must actually look like a media container.
    if (item.mediaExt === 'mp4' || item.mediaExt === 'm4v' || item.mediaExt === 'mov') {
      assert.equal(buf.subarray(4, 8).toString('latin1'), 'ftyp', `${item.title} 应是 MP4（ftyp box）`);
    } else if (item.mediaExt === 'webm' || item.mediaExt === 'mkv') {
      assert.equal(buf.readUInt32BE(0), 0x1a45dfa3, `${item.title} 应是 EBML/Matroska`);
    }

    // A mid-file seek, i.e. the thing asWebviewUri cannot be trusted to do.
    if (size > 1_000_000) {
      const start = Math.floor(size / 2);
      const mid = await fetch(item.media, { headers: { Range: `bytes=${start}-${start + 1023}` } });
      assert.equal(mid.status, 206, `${item.title} 中段跳转应 206`);
      assert.equal((await mid.arrayBuffer()).byteLength, 1024);
    }

    t.diagnostic(`流式验证通过：${item.title}（${(size / 1024 / 1024).toFixed(1)} MB, ${item.mediaExt}）`);
  }
});
