/**
 * Workbench patch tests (方案 B).
 *
 * These run against a **copy of the real VS Code installation** (`workbench.html`
 * + `product.json`) placed in a temp directory, so the live install is never
 * touched. If no installation is found, a synthetic fixture with the same shape
 * is used instead and only the fixture-dependent assertions are skipped.
 *
 * The two claims worth defending:
 *   1. `stripPatch(injectPatch(x)) === x` — byte-exact, so a failed experiment is
 *      always recoverable;
 *   2. the checksum we write is the one the integrity service expects — verified
 *      against the vendor's own `product.json` entry, which is what keeps the
 *      "安装似乎已损坏" toast from ever appearing.
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ASSETS_FILE,
  CORE_FILE,
  CSS_FILE,
  BOOT_FILE,
  WEB_STUB_FILE,
  WEB_STUB_JS_FILE,
  MARKER_END,
  MARKER_START,
  assetVersionFor,
  buildBlock,
  buildBootJs,
  buildCss,
  buildJs,
  buildWebStubHtml,
  buildWebStubJs,
  checksum,
  checksumKeyFor,
  injectPatch,
  isPatched,
  stripPatch,
  widenCsp,
} from '../out/workbench/patch.js';
import { WorkbenchInstaller, resolveTargets, setChecksumValue, stateFilePath, status } from '../out/workbench/installer.js';

const HTML_REL = 'out/vs/code/electron-browser/workbench/workbench.html';
const CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';

/** Locate a real VS Code app root, or null. Never modified — only read/copied. */
function findRealAppRoot() {
  const candidates = [process.env.WE_VSCODE_APP_ROOT, 'C:\\Program Files\\Microsoft VS Code\\resources\\app', join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'resources', 'app')];
  // Installs keep the app under <install root>\<commit>\resources\app. The user install
  // is the one this box runs since 2026-10-09 (the old E: install was retired then).
  for (const base of [join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'), 'C:\\Program Files\\Microsoft VS Code']) {
    try {
      for (const entry of readdirSync(base)) candidates.push(join(base, entry, 'resources', 'app'));
    } catch {
      /* not there */
    }
  }
  for (const c of candidates) {
    if (c && existsSync(join(c, HTML_REL)) && existsSync(join(c, 'product.json'))) return c;
  }
  return null;
}

const SYNTHETIC_HTML = `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="
				default-src 'none';
				img-src 'self' data: blob: https:;
				media-src 'self';
				script-src 'self' 'unsafe-eval' blob:;
				style-src 'self' 'unsafe-inline';
				connect-src 'self' https: ws:;
			" />
		<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">
	</head>
	<body aria-label="">
	</body>
	<script src="./workbench.js" type="module"></script>
</html>
`;

/** Build a throwaway app root that mimics the real layout, in a healthy unpatched state. */
function makeSandbox() {
  const appRoot = mkdtempSync(join(tmpdir(), 'we-app-'));
  const htmlPath = join(appRoot, HTML_REL);
  mkdirSync(join(htmlPath, '..'), { recursive: true });
  const real = findRealAppRoot();
  let originalHtml;
  let originalProduct;
  let wasPatched = false;
  if (real) {
    // The live installation may be patched right now (the user enabled it), so the
    // fixture is normalised to the unpatched baseline: these tests must describe
    // the patch, not inherit whatever state the machine happens to be in.
    const raw = readFileSync(join(real, HTML_REL), 'utf8');
    wasPatched = isPatched(raw);
    originalHtml = stripPatch(raw);
    originalProduct = setChecksumValue(
      readFileSync(join(real, 'product.json'), 'utf8'),
      CHECKSUM_KEY,
      checksum(originalHtml),
    );
  } else {
    originalHtml = SYNTHETIC_HTML;
    originalProduct = JSON.stringify({ nameShort: 'Code', checksums: { [CHECKSUM_KEY]: checksum(SYNTHETIC_HTML) } }, null, '\t');
  }
  writeFileSync(htmlPath, originalHtml, 'utf8');
  writeFileSync(join(appRoot, 'product.json'), originalProduct, 'utf8');
  return { appRoot, htmlPath, originalHtml, originalProduct, real: Boolean(real), wasPatched };
}

const settings = (origin = 'http://127.0.0.1:39127') => ({ origin });

test('checksum uses standard base64 without padding (not base64url)', () => {
  // Pinned with a vector whose digest contains both `+` and `/`: with base64url it
  // would read LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ. Getting this wrong
  // gives a checksum the integrity service never accepts — i.e. the
  // "installation appears to be corrupt" toast.
  assert.equal(checksum('hello'), 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
  assert.doesNotMatch(checksum('hello'), /[-_]/);
  assert.doesNotMatch(checksum('hello'), /=/, 'padding 必须去掉');
  assert.equal(checksum('hello').length, 43);
});

test('every live checksum entry matches the vendor table (encoding guard)', (t) => {
  const real = findRealAppRoot();
  if (!real) {
    t.diagnostic('本机没找到真实 VS Code 安装，跳过');
    return;
  }
  const product = JSON.parse(readFileSync(join(real, 'product.json'), 'utf8'));
  const entries = Object.entries(product.checksums || {});
  assert.ok(entries.length >= 10, `校验表应有多项，实际 ${entries.length}`);
  const mismatched = entries
    .filter(([rel, expect]) => {
      const file = join(real, 'out', rel);
      return !existsSync(file) || checksum(readFileSync(file)) !== expect;
    })
    .map(([rel]) => rel);
  t.diagnostic(`本机安装当前状态：${isPatched(readFileSync(join(real, HTML_REL), 'utf8')) ? '已注入补丁' : '原厂未打补丁'}`);
  // This is the assertion that would have caught the base64url bug: it covers all
  // ten entries, including the one the installer rewrites.
  assert.deepEqual(mismatched, [], `这些文件的校验和与 product.json 不一致：${mismatched.join(', ')}`);
});

test('patch round-trips byte-exactly on the real workbench.html', (t) => {
  const sandbox = makeSandbox();
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const before = sandbox.originalHtml;
  assert.equal(isPatched(before), false);

  const patched = injectPatch(before);
  assert.equal(isPatched(patched), true);
  assert.ok(patched.includes(MARKER_START) && patched.includes(MARKER_END));
  assert.ok(patched.includes('./workbench.js'), '原始启动脚本必须还在');
  assert.ok(patched.includes(`./${BOOT_FILE}`), 'HTML 只引用冻结加载器');
  // The HTML must stay version-free: any `?v=` here means every asset update would
  // rewrite a checksummed file — which is what pops "安装似乎已损坏。请重新安装。".
  assert.doesNotMatch(patched, /\?v=/, '注入块不得带版本号（否则每次更新都会重写受校验的 HTML）');
  assert.doesNotMatch(patched, new RegExp(`\\./${CSS_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '样式表由加载器在运行时注入，不写进 HTML');
  assert.equal(patched.split(MARKER_START).length - 1, 1, '只有一个补丁块');
  // The block must land inside <body>, before its close tag.
  assert.ok(patched.indexOf(MARKER_START) > patched.indexOf('<body'));
  assert.ok(patched.indexOf(MARKER_START) < patched.lastIndexOf('</body>'));

  assert.equal(stripPatch(patched), before, '剥离补丁后必须与原文逐字节相同');
});

test('re-enabling never changes workbench.html again (the toast fix)', async (t) => {
  // workbench.html is a checksummed file that VS Code compares against the table
  // its main process read at startup, so rewriting it while VS Code runs raises
  // the "installation appears to be corrupt" toast until the next full restart.
  // The block is therefore static: wallpaper and settings live in the css/js.
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: () => {}, warn: () => {} }, { statePath });

  await installer.enable(settings());
  const first = readFileSync(sandbox.htmlPath, 'utf8');
  const firstHash = checksum(first);

  // Different settings, "different wallpaper" — the HTML must not move.
  await installer.enable(settings());
  const second = readFileSync(sandbox.htmlPath, 'utf8');
  assert.equal(second, first, 'workbench.html 不得因换壁纸/改设置而被重写');
  assert.equal(checksum(second), firstHash, '哈希不变 -> 不会与主进程内存里的校验表冲突');

  // ...and neither must the recorded checksum.
  const product = JSON.parse(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'));
  assert.equal(product.checksums[CHECKSUM_KEY], firstHash);

  // The moving parts are in the non-checksummed files — but the sliders are NOT
  // among them any more: opacity/scrim are pushed to the page at runtime through
  // /current precisely so that moving one never rewrites a checksummed file. The
  // CSS only carries the defaults those variables fall back to.
  const w = join(sandbox.appRoot, 'out/vs/code/electron-browser/workbench');
  const css = readFileSync(join(w, CSS_FILE), 'utf8');
  const boot = readFileSync(join(w, BOOT_FILE), 'utf8');
  const core = readFileSync(join(w, CORE_FILE), 'utf8');
  assert.match(css, /:root \{\s*\n\t--we-wb-opacity: 1;\s*\n\t--we-wb-scrim: 0\.35;/, 'CSS 只留默认值');
  assert.match(css, /opacity: var\(--we-wb-opacity, 1\)/, 'video 图层必须消费该变量');
  assert.match(core, /127\.0\.0\.1:39127/, '核心脚本里应带上媒体服务 origin');
  assert.match(core, /\/current/, '核心脚本应通过 /current 运行时取壁纸地址');
  assert.match(core, /'--we-wb-opacity'/, '滑块的运行时会写进该变量');
  // The loader is the only thing the HTML names, and it must be version-free too.
  assert.match(boot, /we-workbench-assets\.json/);
  assert.match(boot, /we-workbench-core\.js/);
  assert.doesNotMatch(boot, /127\.0\.0\.1/, '加载器里不烘焙媒体地址');
  // The CSP must mention the loopback origin; the *block* must not carry a media
  // token URL — that is what keeps the file's bytes stable.
  assert.doesNotMatch(first, /\/m\/[A-Za-z0-9_-]{16,}/, 'workbench.html 里不应出现媒体 token URL');
  const blockText = first.slice(first.indexOf(MARKER_START), first.indexOf(MARKER_END));
  assert.doesNotMatch(blockText, /http:\/\/127\.0\.0\.1/, '补丁块里不应出现任何媒体地址');
});

test('the loader is frozen and Trusted-Types-safe, and the version rides in a side file', () => {
  const boot = buildBootJs();
  // Pinned digest: if the loader has to change, this test fails ON PURPOSE and the
  // file name must be bumped (which rewrites workbench.html exactly once). Silently
  // editing it would leave already-cached copies running the old loader forever,
  // because the HTML cannot version-bust the one file it references.
  assert.equal(
    checksum(boot),
    'hzdl3ZeDxfLmX7LYzFoUrkaxECZD4UY2Fh/VbymCaP4',
    '加载器内容变了 -> 必须换文件名（例如 we-workbench-boot2.js），并同步更新这条摘要',
  );
  assert.match(boot, /import\(CORE_FILE \+ q\)/, '核心脚本必须用动态 import 载入（不是 Trusted Types 的 sink）');
  assert.match(boot, /el\.textContent = css/, '样式必须以 textContent 注入，避免 TT 的 script sink');
  assert.doesNotMatch(boot, /\beval\(|new Function\(/, '不得使用 eval / new Function');
  assert.doesNotMatch(boot, /\.src\s*=/, '不得直接给 script/link 赋 src（Trusted Types 会拦）');
  assert.match(boot, /\?t=' \+ Date\.now\(\)/, 'assets.json 必须用随机 nonce 绕开协议缓存');
  assert.match(boot, /MAX_TRIES/, '扩展宿主还没起来时要重试');

  // Version source: content hash, changes with the origin (which the core bakes in)
  // and with the CSS, and is what the loader appends to both runtime URLs.
  const a = assetVersionFor('http://127.0.0.1:39127');
  assert.match(a, /^[0-9A-Za-z+/_-]{12}$/, '标准 base64 版本号（可能含 + /），加载器会做 URL 编码');
  assert.equal(a, assetVersionFor('http://127.0.0.1:39127'), '同内容同版本（可用作缓存键）');
  assert.notEqual(a, assetVersionFor('http://127.0.0.1:1'), '端口变了 -> 核心脚本内容变了 -> 版本必须变');
});

test('re-patching strips the old block instead of stacking it', () => {
  const first = injectPatch(SYNTHETIC_HTML);
  const second = injectPatch(first);
  assert.equal(second.split(MARKER_START).length - 1, 1, '不得叠加');
  assert.equal(second, first, '同一补丁重复注入应逐字节幂等');
  assert.equal(stripPatch(second), SYNTHETIC_HTML, '二次注入后仍须能精确还原');
});

test('the injected block is static: no wallpaper URL, no settings', () => {
  const block = buildBlock();
  const videoTag = /<video[^>]*>/.exec(block);
  assert.ok(videoTag, '应当有 video 元素');
  assert.match(videoTag[0], /muted[^>]*loop[^>]*autoplay/);
  assert.doesNotMatch(videoTag[0], /src=/, 'video 不带 src —— 地址由脚本在运行时取');
  assert.doesNotMatch(block, /--we-wb-/, '不透明度与暗化由 CSS 文件提供');
});

test('CSP is widened only where a media element needs it', () => {
  const csp = /content="([\s\S]*?)"\s*\/>/.exec(SYNTHETIC_HTML)[1];
  const widened = widenCsp(csp);
  for (const directive of ['media-src', 'img-src', 'connect-src']) {
    const before = new RegExp(`${directive}\\s([^;]*);`).exec(csp)[1];
    const after = new RegExp(`${directive}\\s([^;]*);`).exec(widened)[1];
    assert.ok(after.includes('http://127.0.0.1:*'), `${directive} 必须放行回环源`);
    assert.ok(after.includes(before.trim()), `${directive} 原有来源不得丢失`);
  }
  // script-src / style-src / default-src must be untouched: our own files are
  // same-origin ./ references, so no script source needs relaxing.
  for (const directive of ['script-src', 'style-src', 'default-src']) {
    const before = new RegExp(`${directive}\\s([^;]*);`).exec(csp)[1];
    const after = new RegExp(`${directive}\\s([^;]*);`).exec(widened)[1];
    assert.equal(after, before, `${directive} 不应被修改`);
  }
  assert.equal(widenCsp(widened), widened, '重复放行是幂等的');
});

test('injectPatch rejects an html without a CSP meta', () => {
  assert.throws(() => injectPatch('<html><body></body></html>'), /Content-Security-Policy/);
});

test('setChecksumValue rewrites only the target key', () => {
  const product = JSON.stringify({ a: 1, checksums: { [CHECKSUM_KEY]: 'OLD', 'other/file.js': 'KEEP' } }, null, 2);
  const next = setChecksumValue(product, CHECKSUM_KEY, 'NEW');
  assert.ok(next.includes(`"${CHECKSUM_KEY}": "NEW"`));
  assert.ok(next.includes('"other/file.js": "KEEP"'), '其它校验和不受影响');
  assert.equal(JSON.parse(next).checksums[CHECKSUM_KEY], 'NEW');
  assert.throws(() => setChecksumValue(product, 'missing/key', 'X'), /找不到/);
});

test('checksumKeyFor derives the product.json key from the path', () => {
  assert.equal(checksumKeyFor(join('C:\\app', HTML_REL), 'C:\\app'), CHECKSUM_KEY);
  assert.equal(checksumKeyFor('C:\\elsewhere\\workbench.html', 'C:\\app'), null);
});

test('generated CSS/JS carry the load-bearing rules', () => {
  const css = buildCss();
  assert.match(css, /html:not\(\.we-wb-fallback\) body \{\s*\n\tbackground: transparent !important;/, 'body 保持透明（根元素才拿平色）');
  assert.match(css, /html:not\(\.we-wb-fallback\) \.monaco-workbench[\s\S]*background: transparent !important;/);
  assert.match(css, /--vscode-editor-background: transparent !important;/);
  assert.match(css, /#we-workbench-wallpaper \{[\s\S]*z-index: -1;/);
  assert.match(css, /object-fit: cover/);
  assert.match(css, /:root \{\s*\n\t--we-wb-opacity: 1;\s*\n\t--we-wb-scrim: 0\.35;/, '运行时可调的两个变量必须有默认值');
  // The cursor's line. It is NOT a CSS variable in this VS Code: the colour comes
  // from theme.getColor() and is injected as a dynamic rule on
  // `.view-overlays .current-line`, plus a 2px solid border (dark default #282828)
  // on the `-exact` variants. Overriding the variable painted nothing — that was the
  // surviving black band. The element rule must carry !important (the focused
  // dynamic selector ties on specificity and is injected later) and must kill the
  // border too.
  assert.match(css, /\.monaco-editor \.view-overlays \.current-line,[\s\S]{0,700}background-color: var\(--we-wb-line-tint, rgba\(255, 255, 255, 0\.07\)\) !important;\s*\n\tborder: none !important;/);
  assert.doesNotMatch(css, /--vscode-editor-lineHighlightBackground:\s/, '该死变量不该再被声明（注释里提到可以），留着会让人以为它有用');
  assert.match(css, /--vscode-editor-hoverHighlightBackground: var\(--we-wb-line-tint\) !important;/, '悬停高亮确实是 CSS 变量，仍要覆盖');
  assert.match(css, /--vscode-editorStickyScrollGutter-background: var\(--we-wb-sticky\) !important;/, '粘性滚动左侧行号条默认是 editor.background，不覆盖就是一条实色带');
  // Sticky scroll is an OVERLAY: it must occlude the lines scrolling under it. A
  // near-transparent wash is exactly what produced the duplicated-looking pinned
  // lines the user reported as "code line residue".
  assert.match(css, /--we-wb-sticky: rgba\(16, 16, 20, 0\.94\)/);
  assert.match(css, /--vscode-editorStickyScroll-background: var\(--we-wb-sticky\) !important;/);
  assert.match(css, /--vscode-editorStickyScroll-shadow: none !important;/, '阴影会被看成一条暗带');
  // ...and the tint block must be declared on .monaco-workbench too, not only on
  // <html>: the theme service's own declarations sit on .monaco-workbench, and a
  // closer ancestor beats an inherited value even when both are !important.
  const tintBlock = /html:not\(\.we-wb-fallback\),\s*\nhtml:not\(\.we-wb-fallback\) \.monaco-workbench \{\s*\n\t--we-wb-line-tint/;
  assert.match(css, tintBlock, 'tint 变量必须同时声明在 .monaco-workbench 上，否则被主题服务的声明压掉');
  assert.match(css, /--we-wb-line-tint: rgba\(255, 255, 255, 0\.07\)/);
  assert.match(css, /\.monaco-workbench\.vs,[\s\S]{0,120}--we-wb-line-tint: rgba\(0, 0, 0, 0\.055\)/);
  // Sticky scroll pins lines at the top: it must occlude them (see above), and it
  // must NOT be in the transparent-variable list — that list is applied on
  // .monaco-workbench and would win over the html-level value for every element
  // inside it, turning the pinned band transparent again.
  assert.doesNotMatch(css, /--vscode-editorStickyScroll-background: transparent/);
  assert.match(css, /--we-wb-editor-wash: rgba\(0, 0, 0, 0\.12\);[\s\S]{0,200}--we-wb-editor-wash-strong: rgba\(0, 0, 0, 0\.22\);/);
  // Compositing: the permanent promotion is GONE (upstream measured it as a
  // compositing-layer driver that did not prevent the artifacts); it exists only as
  // the two-frame nudge class. And the root element keeps a tone-matched colour so a
  // dropped layer degrades to the wallpaper instead of VS Code's dark plate.
  assert.doesNotMatch(css, /#we-workbench-wallpaper \{\s*\n\ttransform: translateZ/, '常驻提升必须删掉');
  assert.match(css, /#we-workbench-wallpaper\.we-wb-nudge \{\s*\n\twill-change: transform;\s*\n\ttransform: translateZ\(0\);/);
  assert.match(css, /html:not\(\.we-wb-fallback\) \{\s*\n\tbackground-color: var\(--we-wb-underlay, transparent\) !important;/);
  assert.match(css, /\.monaco-editor-background \{\s*\n\tbackground: var\(--we-wb-editor-wash\) !important;/);
  // Tab strip / title bar: structural rules, not variables only. Assert the
  // selectors individually — the rule's selector list keeps growing, so matching
  // one long span between two of them is brittle.
  for (const sel of [
    '.monaco-workbench .part.titlebar',
    '.monaco-workbench .part.titlebar > .titlebar-container',
    ' .titlebar-left',
    ' .titlebar-center',
    ' .titlebar-right',
    ' .command-center',
    ' .window-controls-container',
    '.monaco-workbench .menubar',
    '.editor-group-container > .title .tabs',
    '.editor-group-container > .title .tab',
  ]) {
    assert.ok(css.includes(sel), `标题栏/标签栏结构规则缺失：${sel}`);
  }
  // The three window buttons (minimize / maximize-restore / close).
  //
  // They are DOM nodes only with window.controlsStyle: "custom". With the default
  // native overlay VS Code forces the colour opaque before Electron paints it
  // (`isOpaque() ? c : c.makeOpaque(#252526)`), so `titleBar.activeBackground:
  // "#00000000"` lands there as #252526 and no stylesheet can reach that layer —
  // which is why the settings side has to switch the buttons over to DOM first.
  // Rest state transparent (the wallpaper shows through), hover feedback kept.
  assert.match(css, /\.monaco-workbench \.window-controls-container > \.window-icon \{\s*\n\tbackground-color: transparent !important;/);
  assert.match(css, /\.monaco-workbench\.vs \.window-controls-container > \.window-icon,[\s\S]{0,200}text-shadow: 0 0 4px/, '暗色主题下字符要有一层浅光晕，否则花纹壁纸上读不出');
  assert.match(css, /\.window-icon:hover \{\s*\n\tbackground-color: rgba\(255, 255, 255, 0\.1\) !important;/);
  assert.match(css, /\.window-icon\.window-close:hover \{\s*\n\tbackground-color: rgba\(232, 17, 35, 0\.9\) !important;\s*\n\tcolor: #fff !important;/);
  // The audit-driven additions for the bands that were still painting a fill.
  assert.match(css, /--vscode-commandCenter-background: transparent !important;/);
  assert.match(css, /--vscode-commandCenter-activeBackground: transparent !important;/);
  assert.match(css, /--vscode-tab-selectedBackground: transparent !important;/);
  assert.match(css, /--vscode-sideBarSectionHeader-background: transparent !important;/);
  // The proven chain that removes the editor's opaque block.
  assert.match(css, /\.part\.editor \.editor-container \.overflow-guard > \.monaco-scrollable-element \{\s*\n\tbackground: transparent !important;/);
  // The escape hatch: with .we-wb-fallback on <html>, nothing is overridden.
  assert.equal((css.match(/^html:not\(\.we-wb-fallback\)/gm) || []).length >= 5, true, '透明规则必须全部限定在 :not(.we-wb-fallback) 中');
  assert.match(css, /html\.we-wb-fallback #we-workbench-wallpaper \{\s*\n\tdisplay: none;/);

  // ── VS Code 1.141 "modern UI / floating panels" ──────────────────────────────
  // The regression this guards: the workbench writes an OPAQUE shell colour into
  // --modern-ui-shell-background at runtime (inline, so it beats a plain stylesheet
  // declaration) and paints it on `.monaco-workbench.floating-panels` AND on
  // `.monaco-workbench.floating-panels > .monaco-grid-view`. The root was already in
  // the transparent list; the grid view was not, so the wallpaper layer (z-index:-1)
  // sat behind an opaque sheet while every computed style still read transparent.
  assert.match(css, /--modern-ui-shell-background: transparent !important;/, '1.141 的 shell 变量必须被压成透明（它是行内设置，非 !important 压不住）');
  assert.match(css, /html:not\(\.we-wb-fallback\) \.monaco-workbench > \.monaco-grid-view,[\s\S]{0,240}background-color: transparent !important;/, '1.141 的布局容器必须显式透明');
  assert.match(css, /\.monaco-workbench\.floating-panels > \.monaco-grid-view/, 'floating-panels 变体也要覆盖');
  assert.match(css, /--vscode-surface-background: transparent !important;/, '1.141 浮动面板卡片用 surface.background 填充（!important），必须透明');
  // 1.141 moved the tab strip: the group header carries `tabs` itself and the strip
  // lives in .tabs-and-actions-container > .tabs-container (the old `.title .tabs`
  // descendant selector stopped matching — the probe reported it MISSING).
  assert.ok(css.includes('.editor-group-container > .title.tabs'), '1.141 的 .title.tabs 要覆盖');
  assert.ok(css.includes('.monaco-workbench .part.editor .tabs-and-actions-container'), '1.141 的标签条容器要覆盖');
  assert.ok(css.includes('.monaco-workbench .part.editor .tabs-container'), '1.141 的 .tabs-container 要覆盖');

  const js = buildJs('http://127.0.0.1:39127');
  assert.match(js, /we-workbench-video/);
  assert.match(js, /addEventListener\('error'/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /we-wb-fallback/, '脚本必须能在媒体始终加载不出来时关闭整个效果');
  assert.match(js, /setFallback\(false\)/, '播放成功后要撤销回退');
  assert.match(js, /fetch\(ORIGIN \+ '\/current'/, '运行时取壁纸地址');
  assert.match(js, /setInterval/, '定期跟随换壁纸');
  // The probe has to be able to tell the two modes apart: a MISSING .window-icon
  // means the buttons are still Electron's native overlay (window.controlsStyle is
  // not "custom"), which is the one case no stylesheet can make transparent.
  assert.match(js, /'\.monaco-workbench \.window-controls-container > \.window-icon'/, 'probe 必须能区分原生覆盖层与 DOM 按钮');
  // The probe must ride on a *successful* /current: the page loads before the
  // extension host binds its port, so a blind timer-based probe is always dropped
  // (and text/plain keeps it a "simple" request that needs no CORS preflight).
  assert.match(js, /if \(!probeSent\) \{/, '探针要在确认宿主可达后再发，否则永远拿不到回执');
  assert.match(js, /reportStyles\(\);/, '探针函数必须被调用');
  assert.match(js, /text\/plain;charset=UTF-8/, '探针 POST 必须避免触发 CORS 预检');
  assert.match(js, /inlineBg/, 'probe 要顺带回报 VS Code 写进行内样式的那个颜色');
  // The probe must also answer "is the wallpaper layer itself on screen?" — the 1.141
  // failure looked green everywhere else (patch written, glass applied, engine mounted,
  // contrast measuring bright pixels) while the layer was covered by an opaque sheet.
  assert.match(js, /'#we-workbench-wallpaper'/, 'probe 必须回报壁纸层自身');
  assert.match(js, /'#we-workbench-scene > canvas'/, 'probe 必须回报实时 Scene 画布');
  assert.match(js, /'\.monaco-workbench > \.monaco-grid-view'/, 'probe 必须回报 1.141 的布局容器');
  assert.match(js, /--modern-ui-shell-background/, 'probe 必须回报 1.141 的 shell 变量值');
  assert.match(js, /disp: cs\.display,[\s\S]{0,120}vis: cs\.visibility,[\s\S]{0,120}op: cs\.opacity,[\s\S]{0,80}z: cs\.zIndex/, 'probe 必须回报 display/visibility/opacity/z-index');
  assert.doesNotMatch(js, /<\/script/i, '内联内容不得提前闭合脚本标签');
});

test('installer enable → status → disable restores the installation exactly', async (t) => {
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));

  const logs = [];
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, { statePath });

  // Preconditions: the sandbox looks like a healthy, unpatched installation.
  const before = status(sandbox.appRoot);
  assert.equal(before.supported, true);
  assert.equal(before.patched, false);
  assert.equal(before.checksumMismatch, false, '沙箱初始校验和必须一致');

  const enabled = await installer.enable(settings());
  assert.equal(enabled.patched, true);
  assert.equal(enabled.checksumMismatch, false, '写回校验和后必须一致 —— 这是"不弹损坏提示"的证据');
  for (const f of [CSS_FILE, BOOT_FILE, CORE_FILE, ASSETS_FILE]) {
    assert.ok(existsSync(join(sandbox.appRoot, 'out/vs/code/electron-browser/workbench', f)), '补丁文件缺失：' + f);
  }
  assert.ok(existsSync(statePath), '状态文件必须写出来，供卸载钩子使用');
  assert.ok(existsSync(`${sandbox.htmlPath}.we-orig`), '必须留下备份');
  assert.ok(isPatched(readFileSync(sandbox.htmlPath, 'utf8')));

  const disabled = await installer.disable();
  assert.equal(disabled.patched, false);
  assert.equal(disabled.checksumMismatch, false);
  assert.equal(readFileSync(sandbox.htmlPath, 'utf8'), sandbox.originalHtml, '还原后 html 必须与原文逐字节相同');
  assert.equal(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'), sandbox.originalProduct, '还原后 product.json 必须与原文逐字节相同');
  assert.ok(!existsSync(`${sandbox.htmlPath}.we-orig`), '备份应被清理');
  assert.ok(!existsSync(statePath), '状态文件应被清理');
  for (const f of [CSS_FILE, BOOT_FILE, CORE_FILE, ASSETS_FILE]) {
    assert.ok(!existsSync(join(sandbox.appRoot, 'out/vs/code/electron-browser/workbench', f)), '禁用后仍残留：' + f);
  }
  assert.ok(logs.some((l) => l.includes('workbench.html')), '日志应记录写入工作台文件');
});

test('after a VS Code update the stale backup is never restored', async (t) => {
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const logs = [];
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, { statePath });

  await installer.enable(settings());
  assert.ok(existsSync(`${sandbox.htmlPath}.we-orig`), '备份应存在（属于当前版本）');

  // Simulate VS Code updating itself: both the file and the checksum table are
  // replaced by the new version, while our backups/state survive on disk.
  const NEW_VERSION_HTML = SYNTHETIC_HTML.replace('aria-label=""', 'aria-label="new-version"');
  writeFileSync(sandbox.htmlPath, NEW_VERSION_HTML, 'utf8');
  const product = JSON.parse(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'));
  product.checksums[CHECKSUM_KEY] = checksum(NEW_VERSION_HTML);
  writeFileSync(join(sandbox.appRoot, 'product.json'), JSON.stringify(product, null, '\t'), 'utf8');

  await installer.disable();

  assert.equal(readFileSync(sandbox.htmlPath, 'utf8'), NEW_VERSION_HTML, '新版本的文件必须原样保留，不能被旧备份覆盖');
  const after = JSON.parse(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'));
  assert.equal(after.checksums[CHECKSUM_KEY], checksum(NEW_VERSION_HTML), '新版本的校验和不得被改写');
  assert.ok(!existsSync(`${sandbox.htmlPath}.we-orig`), '残留备份应被清理');
  assert.ok(!existsSync(statePath), '状态文件应被清理');
  assert.ok(logs.some((l) => l.includes('更新')), '日志应说明是更新导致的');
});

test('a surviving patch whose checksum table changed is stripped in place', async (t) => {
  // The nastier variant: the table was replaced but our patched file survived.
  // Restoring the old backup is still wrong — strip in place instead.
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const logs = [];
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, { statePath });

  await installer.enable(settings());
  const product = JSON.parse(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'));
  product.checksums[CHECKSUM_KEY] = 'someOtherToolWroteThis';
  writeFileSync(join(sandbox.appRoot, 'product.json'), JSON.stringify(product, null, '\t'), 'utf8');

  await installer.disable();
  const html = readFileSync(sandbox.htmlPath, 'utf8');
  assert.equal(isPatched(html), false, '补丁应被剥离');
  assert.equal(html, sandbox.originalHtml, '就地剥离应得到原文');
  assert.ok(logs.some((l) => l.includes('就地剥离')), '日志应说明改为就地剥离');
});

test('state files are per installation, with legacy adoption', async (t) => {
  // Two installs must never share one state file: this box ran a C: user install and
  // an E: one side by side (the E: one was retired 2026-10-09), and a single shared
  // file meant whichever patched last owned it, leaving the other patched with no way
  // to restore it.
  const a = stateFilePath('C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\07f806f999\\resources\\app');
  const b = stateFilePath('E:\\Microsoft VS Code\\41dd792b5e\\resources\\app');
  assert.notEqual(a, b, '不同安装必须用不同的状态文件');
  assert.match(a, /workbench-patch-[0-9a-f]{8}\.json$/);
  assert.match(stateFilePath(), /workbench-patch\.json$/, '无参数时保留旧的共享名字');

  const sandbox = makeSandbox();
  const ownPath = join(sandbox.appRoot, 'own-state.json');
  const legacyPath = join(sandbox.appRoot, 'legacy-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));

  const mk = () =>
    new WorkbenchInstaller(sandbox.appRoot, { info: () => {}, warn: () => {} }, { statePath: ownPath, legacyStatePath: legacyPath });

  await mk().enable(settings());
  // Simulate the pre-change layout: only a legacy shared file exists, describing
  // THIS install — disable() must still restore from the backup.
  const own = JSON.parse(readFileSync(ownPath, 'utf8'));
  writeFileSync(legacyPath, JSON.stringify(own), 'utf8');
  rmSync(ownPath, { force: true });
  await mk().disable();
  assert.equal(readFileSync(sandbox.htmlPath, 'utf8'), sandbox.originalHtml, '收养旧状态文件后仍须能正确还原');
  assert.ok(!existsSync(legacyPath), '收养过的旧文件应被清理');

  // And a legacy file describing ANOTHER install must never be acted upon.
  await mk().enable(settings());
  writeFileSync(legacyPath, JSON.stringify({ ...own, appRoot: 'D:\\some\\other\\install' }), 'utf8');
  rmSync(ownPath, { force: true });
  await mk().disable();
  assert.equal(readFileSync(sandbox.htmlPath, 'utf8'), sandbox.originalHtml, '不属于本安装的旧状态不得被采纳（会走就地剥离）');
});

test('cache-busting moved out of the HTML and into we-workbench-assets.json', async (t) => {
  // vscode-file:// serves the css/core without Cache-Control, so a stale copy would
  // survive reloads — the loader therefore appends a content hash at runtime. The
  // point of this test is the *split*: the version travels in a side file and the
  // checksummed HTML does not move, ever. That is what keeps the integrity toast
  // ("安装似乎已损坏。请重新安装。") from coming back on every extension update.
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  const w = join(sandbox.appRoot, 'out/vs/code/electron-browser/workbench');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: () => {}, warn: () => {} }, { statePath });

  await installer.enable(settings());
  const first = readFileSync(sandbox.htmlPath, 'utf8');
  const assets1 = JSON.parse(readFileSync(join(w, ASSETS_FILE), 'utf8'));
  assert.match(assets1.version, /^[0-9A-Za-z+/_-]{12}$/, '版本号必须写进 side file（标准 base64，可能含 + /）');
  assert.equal(assets1.version, assetVersionFor(settings().origin), '安装器与运行时必须算出同一个版本');
  const initial = await installer.enable(settings());
  assert.equal(initial.assetsUpdated, false, '资源没变就不该让用户重载窗口');

  // Changed media origin: the core bakes the origin in, so the *assets* version must
  // change (or the browser keeps the old core), while the HTML stays byte-identical.
  // A window that is already open is now stale — and the caller has to say so, or an
  // update looks like it did nothing (the reload prompt hangs off this flag).
  const changed = await installer.enable(settings('http://127.0.0.1:1'));
  assert.equal(changed.assetsUpdated, true, '资源变了必须提示重载，否则窗口还在跑上一版');
  const second = readFileSync(sandbox.htmlPath, 'utf8');
  const assets2 = JSON.parse(readFileSync(join(w, ASSETS_FILE), 'utf8'));
  assert.notEqual(assets2.version, assets1.version, '内容变了版本号必须变（否则浏览器拿旧核心脚本）');
  assert.equal(second, first, '资源更新绝不能再改 HTML —— 那正是损坏提示的来源');
  assert.equal(isPatched(second), true);
  assert.equal(stripPatch(second), sandbox.originalHtml, '始终能逐字节还原');

  // And the checksum stayed in sync with whatever is on disk.
  const product = JSON.parse(readFileSync(join(sandbox.appRoot, 'product.json'), 'utf8'));
  assert.equal(product.checksums[CHECKSUM_KEY], checksum(second));
  for (const f of [CSS_FILE, BOOT_FILE, CORE_FILE, WEB_STUB_FILE, WEB_STUB_JS_FILE, ASSETS_FILE]) {
    assert.ok(existsSync(join(w, f)), `补丁文件缺失：${f}`);
  }
});

test('the Web-wallpaper stub only works because every step is legal under the workbench CSP', () => {
  // A Web wallpaper is an author HTML app that the engine mounts as a sandboxed blob:
  // iframe. The workbench CSP (frame-src 'self' vscode-webview:, script-src without the
  // loopback, no 'unsafe-inline') refuses several obvious ways of doing that, and
  // workbench.html is checksummed, so its CSP must not be widened. Measured facts this
  // encodes:
  //   · the stub is framed as a sibling file — 'self' allows it, blob: does not;
  //   · the frame does NOT escape the workbench policy, so the stub's script must be an
  //     external same-origin file (an inline one is silently blocked — that was the
  //     live failure: "frame loads, nothing happens");
  //   · the engine therefore arrives as text over connect-src and is imported from a
  //     blob URL, exactly like the Scene path.
  const html = buildWebStubHtml();
  const js = buildWebStubJs();
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/, 'stub 不该自带 CSP：它继承父页面的策略，自带一个只会更严');
  assert.doesNotMatch(html, /<script>[\s\S]*?<\/script>/, '内联脚本在 workbench 策略下会被丢弃 —— 必须外链同源文件');
  assert.match(html, /<script src="\.\/we-workbench-web\.js"><\/script>/, '外链脚本必须同源（script-src \'self\'）');
  assert.doesNotMatch(js, /http:\/\/127\.0\.0\.1/, 'stub 脚本必须是静态文件：媒体源由父页面通过 query 传入');
  assert.match(js, /q\.get\('o'\)/, '必须从 query 取媒体源');
  assert.match(js, /q\.get\('key'\)/, '必须从 query 取壁纸目录 token');
  assert.match(js, /fetch\(ORIGIN \+ '\/engine\/webwallgl\.mjs'/, '引擎只能经 connect-src 取文本');
  assert.match(js, /URL\.createObjectURL\(new Blob\(\[code\], \{ type: 'text\/javascript' \}\)\)/, '再经 blob: 导入（script-src 允许 blob:，不允许回环源）');
  assert.match(js, /d\.op !== 'we-frame'/, '作者页的帧心跳是"外面看得到它在动"的唯一证据');
  assert.match(js, /stage: 'web-'/, 'stub 的生命周期回报必须带 web- 前缀，和场景探针区分开');
  assert.match(js, /inline=/, '必须回报内联脚本是否被丢弃：这决定引擎该怎么加载，从外面完全看不见');

  // The framing side, in the injected core script and the stylesheet.
  const core = buildJs('http://127.0.0.1:39127');
  assert.match(core, /payload\.kind === 'web'/, '整窗层必须认得 kind=web');
  assert.doesNotMatch(
    core,
    /f\.setAttribute\('sandbox'/,
    'stub 这一层不能加 sandbox：实测带 sandbox 的 vscode-file 子框架根本不成文档（load 事件照发，既不渲染也不执行脚本）',
  );
  assert.match(js, /setAttribute\('sandbox', 'allow-scripts'\)/, '作者页必须由 stub 重新沙箱化：这一层不能加 sandbox，引擎的 blob iframe 否则与 workbench 同源');
  assert.match(js, /MutationObserver/, '沙箱化要尽早挂上（引擎插入 iframe 时立刻改，而不是等挂载完成）');
  assert.match(core, /\.\/we-workbench-web\.html\?o=/, 'iframed 的必须是同目录的 stub（frame-src \'self\'）');
  assert.match(core, /import\.meta\.url/, 'stub 的 URL 要带上加载器解析出的资源版本，否则更新后还能跑到旧 stub');
  assert.match(core, /web\.style\.display = mode === 'web' \? 'block' : 'none'/, 'setMode 必须显式 block（\'\' 会回落到样式表的 display:none）');
  assert.match(core, /if \(mode !== 'web'\) detachWeb\(\)/, '切走后必须拆掉 iframe，否则作者页在隐藏 iframe 里继续跑动画');
  const css = buildCss();
  assert.match(css, /#we-workbench-web \{[\s\S]*?display: none;/, '整窗层的 Web 层要有自己的盒子和隐藏默认值');
  assert.match(
    css,
    /#we-workbench-wallpaper > \.we-wb-scrim \{[\s\S]*?z-index: 1;/,
    '压暗层必须显式压在所有壁纸图层之上：live 图层是 append 进去的，DOM 顺序在压暗层之后',
  );
});

test('installer refuses to double-patch and repairs a stale backup', async (t) => {
  const sandbox = makeSandbox();
  const statePath = join(sandbox.appRoot, 'patch-state.json');
  t.after(() => rmSync(sandbox.appRoot, { recursive: true, force: true }));
  const installer = new WorkbenchInstaller(sandbox.appRoot, { info: () => {}, warn: () => {} }, { statePath });

  await installer.enable(settings('http://127.0.0.1:1'));
  const afterFirst = readFileSync(sandbox.htmlPath, 'utf8');
  await installer.enable(settings('http://127.0.0.1:1'));
  const html = readFileSync(sandbox.htmlPath, 'utf8');
  assert.equal(html.split(MARKER_START).length - 1, 1, 'enable 两次也只应有一个补丁块');
  assert.equal(html, afterFirst, 'enable 两次不得改变文件内容');

  // Startup: the assets are byte-identical after the first patch (the injected block is
  // version-free and the origin is stable), so the second enable() must not rewrite them.
  // Measured, the six writes cost 10-40 ms of every window's startup.
  const dir = dirname(sandbox.htmlPath);
  const stamps = () =>
    readdirSync(dir)
      .sort()
      .map((n) => `${n}@${statSync(join(dir, n)).mtimeMs}`)
      .join('|');
  const before = stamps();
  await installer.enable(settings('http://127.0.0.1:1'));
  assert.equal(stamps(), before, '内容没变就不得重写注入文件（每个窗口启动都要跑一次）');
  // …but a changed origin MUST be written: that is what the loader's version query reads.
  await installer.enable(settings('http://127.0.0.1:2'));
  assert.notEqual(stamps(), before, 'origin 变了必须重写（否则窗口会去连旧端口）');

  // A backup that itself contains the patch must not be trusted blindly.
  writeFileSync(`${sandbox.htmlPath}.we-orig`, html, 'utf8');
  await installer.disable();
  assert.equal(readFileSync(sandbox.htmlPath, 'utf8'), sandbox.originalHtml, '即便备份带补丁也要还原成原文');
});

test('resolveTargets reports unsupported app roots instead of throwing', () => {
  assert.equal(resolveTargets(join(tmpdir(), 'definitely-not-a-vscode-install')), null);
  const st = status(join(tmpdir(), 'definitely-not-a-vscode-install'));
  assert.equal(st.supported, false);
  assert.match(st.reason, /workbench\.html/);
});

test('buildBlock emits a playable, source-less video element', () => {
  const block = buildBlock('default-src \'none\';');
  assert.match(block, /<video[^>]+muted[^>]+loop[^>]+autoplay/);
  assert.match(block, /WE-CSP-ORIGINAL:/, 'CSP 原文随块一起保存，才能逐字节还原');
});

test('the startup path stays short: poster first, dense retry ramp, frozen loader', () => {
  const core = buildJs('http://127.0.0.1:1');
  const boot = buildBootJs();

  // The whole-window layer shows the project's preview as the <video>'s NATIVE poster, so
  // the window is not black while a big wallpaper decodes its first frame (measured ~0.7 s
  // for a 214 MB video). The browser owns the poster's lifetime, so there is no state
  // machine here to get wrong — which is how the panel's "poster stayed on top of the
  // live video" bug is impossible in this layer.
  assert.match(core, /video\.setAttribute\('poster', poster\)/, '视频必须先用预览当 poster');
  assert.match(core, /reportVideo\(poster \? 'poster' : 'buffering'/, 'poster 阶段要进 /probe 时间线');
  assert.match(core, /var videoFramed = false;/, '首帧只上报一次，靠这个闸门');
  assert.match(core, /reportVideo\('playing', video\.currentSrc \|\| '', 'first-frame'\)/, '首帧要单独上报一次');

  // Retry ramp: this page boots at ~0 and the port appears ~1.4 s later. A flat
  // `500 ms * failures` schedule read it 100-300 ms late (measured).
  assert.match(core, /var RETRY_STEPS = \[150, 150, 150/, '重试爬坡丢了');
  assert.match(core, /failures < RETRY_STEPS\.length \? RETRY_STEPS\[failures\]/, 'schedule() 必须用爬坡');
  assert.match(core, /: RETRY_TAIL_MS\);/, '爬坡之后要有长尾（新装的 VS Code 激活过慢时不能直接放弃）');
  assert.doesNotMatch(core, /Math\.min\(BASE_DELAY \* failures, 5000\)/, '旧的线性退避必须删掉');

  // The loader is frozen: workbench.html (checksummed, and rewriting it while VS Code
  // runs is what raises the "安装似乎已损坏" toast) references it by NAME, so any content
  // change needs a rename. Everything optimisable therefore lives in the CORE, which the
  // loader imports with a version query.
  assert.match(boot, /Math\.min\(400 \* tries, 5000\)/, 'loader 的重试逻辑不能改（改了要换文件名）');
});
