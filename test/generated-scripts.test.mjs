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
  // Sidebar / activity bar / title bar / status bar / panel: frosted.
  const chrome = ruleFor('.monaco-workbench .part.sidebar,');
  assert.match(chrome, /backdrop-filter:\s*blur\(/, '侧栏必须保留高斯模糊（磨砂玻璃）');
  assert.match(chrome, /background-color:\s*rgba\(var\(--we-wb-glass-rgb\)/, '侧栏要有主题色调的半透明底');
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
  const applyView = js.slice(js.indexOf('function applyView('), js.indexOf('function applyView(') + 2000);
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
