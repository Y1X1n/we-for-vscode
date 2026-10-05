/**
 * The generated workbench scripts must COMPILE.
 *
 * Why this exists: the contrast work once shipped a stray line into the generated
 * core (`reportContrast(...));` followed by a dangling `+ (...)`) — a syntax error that
 * killed the whole injected script, so the wallpaper silently disappeared and /probe
 * went quiet. The rest of the suite did not catch it because it only evaluated the
 * marked contrast block and pattern-matched the rest as text. `node --check` on the
 * installed file found it in seconds, so this test does the same thing in-process:
 * compile the entire script, run nothing.
 *
 * (The browser modules get the same treatment in webview-contract.test.mjs, which is
 * why a syntax error in media/*.mjs has never reached a user.)
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildBootJs, buildCss, buildJs, buildWebStubHtml, buildWebStubJs } from '../out/workbench/patch.js';

const ORIGIN = 'http://127.0.0.1:39127';
const dir = mkdtempSync(join(tmpdir(), 'we-gen-'));
/** Read a repo file (the panel and the host are pinned here too, see below). */
const read = (p) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

/**
 * Compile without executing, as a MODULE: the generated core legitimately uses
 * `import.meta.url` (it imports the engine from a blob URL), which is module-only
 * syntax, so a classic-script parse would reject valid code.
 *
 * Spawned with stdio redirected to files rather than pipes — this environment denies
 * named pipes to child processes, and `--check` only needs the exit status.
 */
function compiles(name, code) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, code, 'utf8');
  const errFile = join(dir, `${name}.err`);
  const fd = openSync(errFile, 'w');
  const res = spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);
  if (res.status !== 0) {
    assert.fail(`${name} 无法编译：${readFileSync(errFile, 'utf8').split('\n').slice(0, 6).join('\n')}`);
  }
}

test('every generated workbench script compiles', () => {
  compiles('we-workbench-core', buildJs(ORIGIN));
  compiles('we-workbench-boot', buildBootJs());
  compiles('we-workbench-web', buildWebStubJs());
  // The stub page is HTML with a script tag; the page must reference the stub script.
  const stub = buildWebStubHtml();
  assert.match(stub, /we-workbench-web\.js/, '中转页必须引用同源脚本');
});

test('the generated CSS is balanced and carries the surfaces the JS drives', () => {
  const css = buildCss(ORIGIN);
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'CSS 花括号必须配平（不平衡的样式表会让后面的规则全部失效）');
  // Every custom property the runtime writes has to be consumed somewhere, otherwise a
  // slider silently does nothing.
  for (const v of [
    '--we-wb-opacity',
    '--we-wb-scrim',
    '--we-wb-scrim-rgb',
    '--we-wb-glass-rgb',
    '--we-wb-glass-alpha',
    '--we-wb-editor-rgb',
    '--we-wb-editor-alpha',
    '--we-wb-glass-blur',
  ]) {
    assert.ok(css.includes(v), `CSS 必须消费 ${v}`);
  }
  // The wallpaper layer is deliberately unfiltered, and the code surface deliberately
  // has no backdrop blur: a blurred backdrop behind the editor smears what the user
  // reads. Frosting belongs to the chrome (and the panel), which is what the next test
  // pins.
  assert.ok(!css.includes('--we-wb-blur'), '壁纸层不得再有可读性模糊变量');
  assert.ok(!css.includes('--we-wb-scale'), '壁纸层不得再有模糊补偿缩放');
});

test('the runtime writes exactly the variables the CSS declares', () => {
  const js = buildJs(ORIGIN);
  const written = new Set(
    [...js.matchAll(/setProperty\('(--we-wb-[a-z-]+)'/g)].map((m) => m[1]),
  );
  const css = buildCss(ORIGIN);
  for (const name of written) {
    assert.ok(css.includes(name), `${name} 被 JS 写入但 CSS 从未使用`);
  }
  assert.ok(written.has('--we-wb-editor-alpha'), '代码区不透明度必须由运行时驱动（自动求解会抬高它）');
  assert.ok(written.has('--we-wb-glass-alpha'), '侧栏磨砂不透明度必须由运行时驱动');
  assert.ok(!written.has('--we-wb-blur'), '运行时不得再给壁纸层写模糊');
});

test('frosting stays on the chrome: the code area is never blurred', () => {
  const css = buildCss(ORIGIN);
  const ruleFor = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `找不到规则 ${selector}`);
    const open = css.indexOf('{', at);
    return css.slice(open, css.indexOf('}', open));
  };
  // Sidebar / activity bar / title bar / status bar / panel: frosted — on a
  // pseudo-element, see the next assertions for why it cannot be the part itself.
  const chrome = ruleFor('.monaco-workbench .part.sidebar::before');
  assert.match(chrome, /backdrop-filter:\s*blur\(/, '侧栏必须保留高斯模糊（磨砂玻璃）');
  assert.match(chrome, /background-color:\s*rgba\(var\(--we-wb-glass-rgb\)/, '侧栏要有主题色调的半透明底');
  assert.match(chrome, /z-index: -1/, '玻璃层必须在内容之下');
  assert.match(chrome, /pointer-events: none/, '玻璃层不得吃掉鼠标事件');
  // The parts themselves must NOT be filtered: `backdrop-filter` creates a stacking
  // context, and the chrome hosts popups. Trapped in it, a popup's z-index stops
  // mattering and later-painted siblings cover it — measured: the File menu rendered
  // under the wallpaper with no background at all. So no rule that targets a part
  // (without ::before) may set a filter or a z-index.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
  const parts = ['.part.activitybar', '.part.sidebar', '.part.auxiliarybar', '.part.titlebar', '.part.statusbar', '.part.panel'];
  const bare = rules.filter(
    (r) => parts.some((p) => r.selector.includes(p)) && !r.selector.includes('::before'),
  );
  assert.ok(bare.length > 0, '必须能找到针对 part 的规则（否则这个断言是空转的）');
  for (const rule of bare) {
    assert.ok(!/backdrop-filter/.test(rule.body), `${rule.selector} 不得有 backdrop-filter（会困住菜单浮层）`);
    assert.ok(!/(^|[^-\w])filter:/.test(rule.body), `${rule.selector} 不得有 filter`);
    assert.ok(!/(^|[^-\w])z-index:/.test(rule.body), `${rule.selector} 不得被强制成层叠上下文`);
    // Every other way to create a stacking context has the same effect on popups.
    for (const trap of ['transform:', 'opacity:', 'isolation:', 'contain:', 'will-change:', 'perspective:']) {
      assert.ok(!rule.body.includes(trap), `${rule.selector} 不得用 ${trap} 创建层叠上下文`);
    }
  }
  // ...and the probe has to be able to prove it without opening a menu.
  const js = buildJs(ORIGIN);
  assert.match(js, /backdrop: cs\.backdropFilter \|\| cs\.webkitBackdropFilter/, '样式回报要带元素自身的 backdrop-filter');
  assert.match(js, /backdropBefore: \(function \(\)/, '样式回报要带 ::before 的 backdrop-filter');
  // The code surface: translucent, no filter of any kind.
  const editor = ruleFor('.monaco-workbench .part.editor > .content {');
  assert.match(editor, /background-color:\s*rgba\(var\(--we-wb-editor-rgb\)/, '代码区要有底衬');
  assert.ok(!/backdrop-filter/.test(editor), '代码区不得有 backdrop-filter（用户明确要求不模糊）');
  assert.ok(!/filter:/.test(editor), '代码区不得有任何 filter');
  // And the wallpaper layer behind both of them stays sharp.
  const layer = ruleFor('#we-workbench-wallpaper {');
  assert.ok(!/filter:/.test(layer), '壁纸层不得被模糊，否则代码区跟着糊');
});

test('the readability readout follows the settings, not just the pixels', () => {
  const js = buildJs(ORIGIN);
  // The pixels are only re-read when the wallpaper changes; the NUMBER must still follow
  // a slider, otherwise /probe describes a configuration that is no longer in force
  // (measured: flipping autoContrast off left the old 4.51:1 in the probe slot).
  assert.match(js, /function reportMeasurement\(\)/, '上报要独立成函数');
  const applyView = js.slice(js.indexOf('function applyView('), js.indexOf('function applyView(') + 3200);
  assert.match(applyView, /reportMeasurement\(\)/, '滑块变化后必须重算并上报');
  const schedule = js.slice(js.indexOf('function scheduleContrast('), js.indexOf('function scheduleContrast(') + 1200);
  assert.match(schedule, /if \(key === contrastKey && contrastStats\) return;/, '像素采样仍只在壁纸变化时做（不能每轮都读回）');
  // Every kind must re-apply the view on each poll: the live kinds mount once and
  // otherwise never look at /current again (measured: sliders had no effect on a
  // mounted Scene, and the readout kept describing the boot configuration).
  const refresh = js.slice(js.indexOf('function refresh(video)'), js.indexOf('function refresh(video)') + 4200);
  assert.match(refresh, /mountScene\(payload\);\s*[\s\S]*?applyView\(payload, active\);/, 'Scene 分支每轮都要重新应用视图');
  assert.match(refresh, /mountWeb\(payload\);\s*[\s\S]*?applyView\(payload, active\);/, 'Web 分支每轮都要重新应用视图');
  assert.match(refresh, /setMode\('image'\);[\s\S]*?applyView\(lastPayload, img\);/, 'image 分支保持原样');
});

test('the page applies view pushes from /events, with the poll as the fallback', () => {
  const js = buildJs(ORIGIN);
  // One payload handler for both paths, so the stream and the poll can never disagree.
  assert.match(js, /function applyPayload\(payload, video\)/, '载荷处理要抽出来共用');
  assert.match(js, /\.then\(function \(payload\) \{ applyPayload\(payload, video\); \}\)/, '轮询走同一个处理函数');
  // The stream: EventSource on /events, applying `view` frames immediately.
  assert.match(js, /function openViewStream\(video\)/, '页面要订阅 /events');
  assert.match(js, /new EventSource\(ORIGIN \+ '\/events'\)/, 'EventSource 指向 /events');
  assert.match(js, /addEventListener\('view', function \(ev\)/, '要处理 view 事件');
  assert.match(js, /JSON\.parse\(ev\.data\)/, '事件体就是 /current 的载荷');
  // The fallback stays: if the stream never opens (or dies), the poll still drives it.
  assert.match(js, /window\.setInterval\(function \(\) \{ refresh\(video\); \}, POLL_MS\)/, '轮询必须保留为兜底');
  assert.match(js, /if \(viewStream \|\| typeof EventSource !== 'function'\) return;/, '没有 EventSource 时要安静退回轮询');
});

test('every slider reaches the window: one knob, no silent floor', () => {
  const ext = read('src/extension.ts');
  const push = ext.slice(ext.indexOf('const pushWorkbenchView'), ext.indexOf('const autoContrastMode'));
  // The alphas go out raw. `glassAlphaFloor` used to raise any positive value to the
  // theme floor, so 0.2 showed up as 0.59 — reported as "任何参数调节之后都没有用".
  assert.ok(!/glassAlphaFloor/.test(ext), '不得再有会覆盖滑块的玻璃下限');
  for (const key of ['chromeGlassAlpha', 'editorGlassAlpha', 'saturate', 'glassColor']) {
    assert.ok(push.includes(key), `pushWorkbenchView 必须推送 ${key}`);
  }
  // Panel-only keys are mirrored onto the window's key, so either slider moves both.
  const pairs = ext.slice(ext.indexOf('const SETTING_PAIRS'), ext.indexOf('const mirrorPairedSettings'));
  for (const pair of ['scrim', 'glassAlpha', 'wallpaperOpacity']) {
    assert.ok(pairs.includes(`'${pair}'`), `${pair} 必须与整窗键镜像`);
  }
  assert.match(ext, /void mirrorPairedSettings\(e\)/, '配置变化时要执行镜像');
  // Every view key must be in the push condition: a key that is missing is a slider
  // that changes the configuration and nothing else (how 暗化层/壁纸不透明度 behaved).
  for (const key of ['scrim', 'glassAlpha', 'wallpaperOpacity', 'saturate', 'glassColor']) {
    assert.ok(
      ext.includes(`e.affectsConfiguration('weWallpaper.${key}')`),
      `${key} 变化后必须推送视图`,
    );
  }
  // The readability floor is opt-in: with autoContrast off the slider is the value.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.contributes.configuration.properties['weWallpaper.autoContrast'].default, 'off', 'autoContrast 默认必须是 off');
  assert.match(ext, /get<string>\('autoContrast', 'off'\)/, '读取默认值也要是 off');
});

test('the window consumes the saturation and glass colour it is sent', () => {
  const css = buildCss(ORIGIN);
  assert.match(css, /saturate\(var\(--we-wb-glass-saturate, 1\.25\)\)/, '侧栏饱和度必须可调');
  const js = buildJs(ORIGIN);
  assert.match(js, /function wbGlassRgb\(color\)/, '要有十六进制转 rgb 的助手');
  assert.match(js, /setProperty\('--we-wb-glass-saturate'/, '运行时写入饱和度');
  assert.match(js, /setProperty\('--we-wb-glass-rgb', glassRgb\)/, '运行时写入玻璃颜色');
  // The default colour means "follow the theme tone", so a light theme is not forced
  // into the dark default by a picker that cannot express "unset".
  assert.match(js, /return rgb === '16,16,20' \? null : rgb;/, '默认色 = 跟随主题');
});

test('the panel has an apply button and the host answers it', () => {
  const html = read('media/index.html');
  assert.match(html, /id="btn-apply"[\s\S]*?立即生效/, '面板要有「立即生效」按钮');
  assert.match(html, /id="apply-hint"/, '按钮旁要有结果提示位');
  const main = read('media/main.mjs');
  // The click carries the panel's CURRENT values: the configuration may still hold the
  // previous ones (the webview debounces its writes by 150 ms and a config write is
  // async), and asking the host to read the config is what made the button revert a
  // slider and push the old value — reported as "点了立即生效会回弹，也没生效".
  assert.match(main, /vscode\.postMessage\(\{ type: 'apply', settings: \{ \.\.\.state\.settings \} \}\)/, '点击要带上面板当前值');
  assert.match(main, /const pendingSettings = createPendingSettings\(\);/, '要记录未落地的设置（纯模块，见 settings-sync.test.mjs）');
  assert.match(main, /pendingSettings\.merge\(state\.settings, msg\.settings\)/, '主机回显要经过 pending 合并');
  assert.match(read('media/settings-sync.mjs'), /export function createPendingSettings/, '回弹竞态必须由可测的纯模块承载');
  // The webview → host API is `vscode.postMessage`; there is no bare `post()` helper.
  // A call to one would throw at click time and look exactly like a dead button
  // (measured: the button did nothing at all until this was fixed).
  assert.ok(!/(^|[^\w.])post\(/.test(main), '面板必须用 vscode.postMessage(...)，没有 post() 助手');
  assert.match(main, /case 'applied':/, '要处理主机回执');
  assert.match(main, /资源已更新，需要重载窗口/, '资源过期时要如实说需要重载');
  assert.match(read('src/panel/panel.ts'), /onApplyRequest\(settings\?: Record<string, unknown>\): void/, 'PanelHooks 要能接收面板值');
  assert.match(read('src/panel/panel.ts'), /case 'apply':/, 'panel.ts 要转发 apply 消息');
  const ext = read('src/extension.ts');
  assert.match(ext, /const applyNow = async \(settings\?: Record<string, unknown>\)/, '主机要接收面板值');
  assert.match(ext, /const writePanelSettings = async/, '要先写未落地的设置再推送');
  assert.match(ext, /if \(status\.assetsUpdated\)/, '资源过期时要提示重载，而不是假装成功');
});
