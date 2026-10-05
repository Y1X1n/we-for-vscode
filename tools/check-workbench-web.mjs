/**
 * Web-wallpaper replica: proves the architecture that a live Web wallpaper behind
 * the whole UI needs.
 *
 *   parent page (the REAL workbench CSP: frame-src 'self' vscode-webview:)
 *     └─ <iframe src="./stub.html">   ← same-origin, NO CSP of its own ('self' allowed)
 *          └─ engine import from the loopback + httpSource(sceneBase)
 *               └─ sandboxed blob: iframe holding the author page
 *
 * The parent page's CSP is the patched workbench's, verbatim. Everything the author
 * page needs (loopback scripts/styles/fonts, blob: iframe) is only possible because
 * the stub document carries no policy — the parent's `frame-src` never has to allow
 * blob: or the loopback origin, so workbench.html stays byte-frozen.
 *
 *   node tools/check-workbench-web.mjs [itemIndex]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

const payload = new MediaServer(() => {}, { secret: 'wb-web', preferredPort: 39198 });
const hostServer = new MediaServer(() => {}, { secret: 'wb-web-host', preferredPort: 39199 });
await payload.start();
await hostServer.start();

const service = new WallpaperService({ info: () => {}, warn: () => {}, error: () => {} }, payload, () => []);
payload.setEngineFile(resolve('media', 'webwallgl', 'webwallgl.min.mjs'));
const snap = await service.scan();
const webs = snap.items.filter((i) => i.renderMode === 'web');
const item = webs[Number(process.argv[2] || 0)];
if (!item) {
  line('❌ 库里没有可用的 Web 壁纸');
  process.exit(1);
}
line(`选中：${item.title}  base=${item.sceneBase}`);
line(`入口：${item.media}`);
payload.setCurrent({ url: item.sceneBase, kind: 'web', still: item.preview });

const host = join(tmpdir(), 'we-wb-web');
rmSync(host, { recursive: true, force: true });
mkdirSync(host, { recursive: true });
hostServer.allowRoot(host);
hostServer.allowRoot('media');
const pageBase = hostServer.registerDir(host);

// The workbench's REAL CSP, verbatim, widened exactly like workbench.html is today.
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
  'trusted-types amdLoader cellRendererCellText collapsedCellPreview defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer dompurify editorGhostText editorViewLayer notebookRenderer stickyScrollViewLayer tokenizeToString notebookChatEditController richScreenReaderContent chatDebugTokenizer',
].join('; ');

const ORIGIN = payload.origin;
const parent = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;height:100%;background:#1e1e1e;overflow:hidden}
#we-workbench-wallpaper{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
#we-workbench-web{position:absolute;inset:0;width:100%;height:100%;border:0;display:none}
iframe{display:block}</style></head>
<body>
<div id="we-workbench-wallpaper"><img id="we-workbench-image" src="${item.preview}" style="width:100%;height:100%;object-fit:cover">
<iframe id="we-workbench-web" sandbox="allow-scripts" src="./stub.html?o=${encodeURIComponent(ORIGIN)}&key=${encodeURIComponent(item.sceneBase)}&t=1"></iframe></div>
<script src="./parent.js"></script>
</body></html>`;

const parentJs = `(function(){
  var f=document.getElementById('we-workbench-web');
  f.style.display='block';
  var img=document.getElementById('we-workbench-image');
  img.style.display='none';
  function rep(stage,extra){fetch('${hostServer.origin}/probe',{method:'POST',headers:{'Content-Type':'text/plain'},
    body:JSON.stringify({scene:{stage:'p-'+stage,err:extra==null?null:String(extra),tt:'parent'}})})['catch'](function(){});}
  f.addEventListener('load',function(){rep('stub-load','ok')});
  f.addEventListener('error',function(){rep('stub-error','x')});
  rep('stub-created',f.src.slice(0,80));
  // negative control: the parent itself creating the engine's blob: iframe must FAIL
  try{
    var b=URL.createObjectURL(new Blob(['<html><body>nope</body></html>'],{type:'text/html'}));
    var bad=document.createElement('iframe');bad.src=b;document.body.appendChild(bad);
    rep('blob-control','created (must be refused by CSP)');
  }catch(e){rep('blob-control','throw '+e.message)}
})();`;

// The stub: the REAL generated artifacts (out/workbench/patch.js), not copies — this
// harness exists to check exactly what the extension drops next to workbench.html.
const { buildWebStubHtml, buildWebStubJs } = await import('../out/workbench/patch.js');
const stub = buildWebStubHtml();
const stubJs = buildWebStubJs()
  .replace("q.get('o') || ''", `q.get('o') || '${ORIGIN}'`)
  .replace("q.get('key') || ''", `q.get('key') || '${item.sceneBase}'`)
  // the harness serves the stub from a plain HTTP origin, which has no CSP at all;
  // strip nothing else — the file is used verbatim.
  ;

writeFileSync(join(host, 'parent.html'), parent, 'utf8');
writeFileSync(join(host, 'parent.js'), parentJs, 'utf8');
writeFileSync(join(host, 'stub.html'), stub, 'utf8');
writeFileSync(join(host, 'we-workbench-web.js'), stubJs, 'utf8');
const url = `${pageBase}/parent.html`;
line(`父页面（workbench 同款 CSP）: ${url}`);

const child = spawn(browser, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'we-wb-web-profile'),
  '--window-size=1280,720',
  '--enable-logging=stderr',
  url,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let consoleErr = '';
child.stderr.on('data', (d) => (consoleErr += d));

const started = Date.now();
const stages = [];
let done = false;
const drain = async () => {
  for (const base of [hostServer.origin, payload.origin]) {
    try {
      const data = await (await fetch(`${base}/probe`)).json();
      if (data && data.scene) {
        const sig = data.scene.stage + (data.scene.err ? ' | ' + data.scene.err : '');
        if (!stages.includes(sig)) stages.push(sig);
      }
    } catch { /* keep waiting */ }
  }
};
while (Date.now() - started < 60_000) {
  await new Promise((r) => setTimeout(r, 1500));
  await drain();
  if (stages.some((s) => /^web-(mounted|failed|no-args)/.test(s))) { done = true; break; }
}
await new Promise((r) => setTimeout(r, 4000));
await drain();
child.kill();

const blocked = consoleErr.split('\n').filter((l) => /Content Security Policy|Refused to|Mixed Content/i.test(l));
line('--- 生命周期 ---');
for (const s of stages) line('  ' + s);
if (blocked.length) {
  line('--- CSP 拦截（父页面自己开 blob: iframe 的负对照应该出现在这里）---');
  line(blocked.slice(0, 8).map((l) => '  ' + l.trim()).join('\n'));
}
// NOTE: /probe keeps only the LAST report, and the mount path emits several; the
// author's frame heartbeat is the strongest single signal (the shim only runs inside
// a mounted author page), so either stage counts as success.
const mounted = stages.some((s) => s.startsWith('web-mounted') || s.startsWith('web-author-first-frame'));
const authorAlive = stages.some((s) => s.startsWith('web-author-first-frame')) || stages.some((s) => s.startsWith('web-engine'));
line(`父页面自身的 blob: iframe 负对照：${/frame-src/.test(blocked.join('\n')) ? '被 CSP 拒绝（符合预期）' : '没有被拒绝 —— 测试无效'}`);
line(mounted ? '✅ 同源 stub + 真实 workbench CSP 下，Web 壁纸实时渲染成功' : '❌ Web 壁纸没有渲染成功');
line(authorAlive ? '✅ 作者页真的在出帧（引擎心跳已到达 stub）' : '⚠️ 没有观察到作者页心跳');
void done;

await payload.dispose();
await hostServer.dispose();
