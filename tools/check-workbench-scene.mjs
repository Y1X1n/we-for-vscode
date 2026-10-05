/**
 * Workbench replica: the whole-window live scene under the REAL workbench CSP —
 * including `require-trusted-types-for 'script'` and the fixed trusted-types
 * policy allowlist, which the panel does not have. Runs the same mountScene code
 * the patch injects (engine fetch → blob import → httpSource mount) cross-origin
 * to the payload, and reports every stage + a canvas frame to /probe.
 *
 *   node tools/check-workbench-scene.mjs
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MediaServer } from '../out/media/server.js';
import { WallpaperService } from '../out/service.js';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
const line = (s) => process.stdout.write(`${s}\n`);

// Payload server (stands in for 127.0.0.1:39127) + host server (the workbench
// document origin — vscode-file://vscode-app in reality).
const payload = new MediaServer(() => {}, { secret: 'wb-scene', preferredPort: 39196 });
const hostServer = new MediaServer(() => {}, { secret: 'wb-scene-host', preferredPort: 39197 });
await payload.start();
await hostServer.start();

const service = new WallpaperService({ info: () => {}, warn: () => {}, error: () => {} }, payload, () => []);
// The real extension wires this at activation; without it /current carries no engine URL.
// setEngineFile only accepts ABSOLUTE paths.
payload.setEngineFile(resolve('media', 'webwallgl', 'webwallgl.min.mjs'));
const snap2 = await service.scan();
const scenes2 = snap2.items.filter((i) => i.renderMode === 'scene');
const item2 = scenes2[Number(process.argv[2] || 1)] ?? scenes2[0];
// And point /current at the live scene, exactly like refreshWorkbenchPatch does.
payload.setCurrent({ url: item2.sceneBase, kind: 'scene', still: item2.preview });
const snap = await service.scan();
const scenes = snap.items.filter((i) => i.renderMode === 'scene');
const item = scenes[Number(process.argv[2] || 1)] ?? scenes[0];
line(`选中：${item.title}  sceneBase=${item.sceneBase}`);

const host = join(tmpdir(), 'we-wb-scene');
rmSync(host, { recursive: true, force: true });
mkdirSync(host, { recursive: true });
hostServer.allowRoot(host);
hostServer.allowRoot('media');
const engineBase = hostServer.registerDir('media');
const pageBase = hostServer.registerDir(host);

// The workbench's REAL CSP, verbatim (cspSource-equivalents: 'self'), from the
// patched workbench.html — including TT enforcement and the policy allowlist.
const csp = [
  "default-src 'none'",
  "img-src 'self' data: blob: vscode-remote-resource: vscode-managed-remote-resource: https: http://127.0.0.1:*",
  "media-src 'self' http://127.0.0.1:*",
  "frame-src 'self' vscode-webview:",
  "script-src 'self' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https: ws: http://127.0.0.1:*",
  "font-src 'self' vscode-remote-resource: vscode-managed-remote-resource: https://*.vscode-unpkg.net",
  "require-trusted-types-for 'script'",
  'trusted-types amdLoader cellRendererEditorText collapsedCellPreview defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer dompurify editorGhostText editorViewLayer notebookRenderer stickyScrollViewLayer tokenizeToString notebookChatEditController richScreenReaderContent chatDebugTokenizer',
].join('; ');

const ORIGIN = payload.origin;
const sceneKey = item.sceneBase;
const ENGINE = `${payload.origin}/engine/webwallgl.mjs`;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>wb-replica</title>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{margin:0;height:100%;background:#1e1e1e;overflow:hidden}
  #we-workbench-wallpaper{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:transparent}
  #we-workbench-scene{position:absolute;inset:0;display:none}
  #we-workbench-scene > canvas{width:100%;height:100%;display:block;object-fit:cover}
  #we-workbench-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}
</style></head>
<body>
<div id="we-workbench-wallpaper">
  <video id="we-workbench-video" style="display:none"></video>
  <img id="we-workbench-image" alt="">
  <div id="we-workbench-scene"></div>
</div>
<script src="./wb.js"></script></body></html>`;

// The probe script must be an EXTERNAL file: the workbench CSP has no
// 'unsafe-inline', so an inline script would be blocked (the real workbench
// loads all of its code from external files too).
const wbJs = `/* workbench-replica scene loader — same code the patch injects */
(function () {
  'use strict';
  var ORIGIN = ${JSON.stringify(ORIGIN)};
  var sceneState = { key: null, instance: null };
  function reportScene(stage, extra) {
    try {
      var tt = 'absent';
      try { tt = (typeof trustedTypes !== 'undefined') ? ('present,default=' + (trustedTypes.defaultPolicy ? 'yes' : 'no') + ',canCreate=' + (typeof trustedTypes.createPolicy)) : 'absent'; } catch (e2) {}
      var body = JSON.stringify({ scene: { stage: stage, key: ${JSON.stringify(sceneKey)}, err: extra ? String(extra) : null, tt: tt } });
      fetch('${hostServer.origin}' + '/probe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body })['catch'](function () {});
    } catch (e) {}
  }
  function mountScene(payload) {
    var key = String(payload.url || '');
    if (sceneState.key === key) return;
    if (!payload.engine) { reportScene('no-engine'); return; }
    reportScene('mount-begin');
    var host = document.getElementById('we-workbench-scene');
    fetch(payload.engine, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('engine http ' + r.status); return r.text(); })
      .then(function (code) {
        reportScene('engine-fetched', code.length + 'B');
        var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        return import(url).then(function (lib) { return { lib: lib, url: url }; });
      })
      .then(function (loaded) {
        reportScene('engine-imported');
        var lib = loaded.lib;
        if (!lib || typeof lib.mount !== 'function' || typeof lib.httpSource !== 'function') {
          throw new Error('engine 缺少 mount/httpSource');
        }
        return lib.mount(host, {
          source: lib.httpSource(key),
          fit: 'cover',
          fps: 30,
          autoplay: true,
          volume: 0,
        });
      })
      .then(function (instance) {
        sceneState.instance = instance;
        host.style.display = 'block';
        var c = host.querySelector('canvas');
        reportScene('mounted', c ? (c.width + 'x' + c.height + ' css ' + c.clientWidth + 'x' + c.clientHeight) : 'no-canvas');
        window.setTimeout(function () {
          var c2 = host.querySelector('canvas');
          if (!c2) return;
          try {
            reportScene('frame-bytes', String(c2.toDataURL('image/jpeg', 0.8).length));
            reportScene('frame', c2.toDataURL('image/jpeg', 0.8));
          } catch (e) {
            reportScene('frame-failed', e.message);
          }
        }, 6000);
      })
      ['catch'](function (err) {
        reportScene('failed', err && err.message ? err.message : err);
      });
  }
  fetch(ORIGIN + '/current', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      reportScene('payload', payload.kind);
      // The still layer first, exactly like the patch.
      var img = document.getElementById('we-workbench-image');
      if (payload.still) img.setAttribute('src', payload.still);
      mountScene(payload);
    })
    ['catch'](function (err) { reportScene('current-failed', err && err.message); });
})();
`;
writeFileSync(join(host, 'wb.js'), wbJs, 'utf8');
writeFileSync(join(host, 'wb.html'), page, 'utf8');

writeFileSync(join(host, 'wb.html'), page, 'utf8');
const url = `${pageBase}/wb.html`;
line(`页面（workbench 同款 CSP + TT）: ${url}`);

const child = spawn(browser, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'we-wb-scene-profile'),
  '--window-size=1280,720',
  '--enable-logging=stderr',
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let consoleErr = '';
child.stderr.on('data', (d) => (consoleErr += d));

const started = Date.now();
let frame = null;
const stages = [];
while (Date.now() - started < 60_000) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const data = await (await fetch(`${hostServer.origin}/probe`)).json();
    if (data && data.scene) {
      if (!stages.length || stages[stages.length - 1] !== data.scene.stage + (data.scene.err ? ' | ' + data.scene.err : '')) {
        stages.push(data.scene.stage + (data.scene.err ? ' | ' + data.scene.err : ''));
      }
      if (data.scene.stage === 'frame') frame = data.scene.err;
    }
  } catch { /* keep waiting */ }
  if (frame) break;
}
child.kill();

const cspBlocked = consoleErr.split('\n').filter((l) => /Content Security Policy|Refused to|TrustedTypes|trustedTypes/i.test(l));
line('--- 场景生命周期 ---');
for (const s of stages) line('  ' + s);
if (cspBlocked.length) {
  line('--- CSP/TT 拦截 ---');
  line(cspBlocked.slice(0, 12).join('\n'));
}
if (frame && frame.startsWith('data:image/')) {
  mkdirSync('tools/.shots', { recursive: true });
  const out = 'tools/.shots/workbench-replica-scene.jpg';
  writeFileSync(out, Buffer.from(/base64,(.+)$/.exec(frame)[1], 'base64'));
  line(`✅ TT 环境下挂载成功，真实帧 → ${out}`);
} else {
  line('❌ workbench 同款环境下场景没有渲染成功（见上面的生命周期与拦截日志）');
}

await payload.dispose();
await hostServer.dispose();
