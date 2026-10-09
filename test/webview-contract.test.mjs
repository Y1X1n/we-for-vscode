/**
 * Webview contract guards.
 *
 * The webview is the one layer `node --test` cannot render, so instead of
 * pretending to test it, this file asserts the *contracts between* the layers
 * that would otherwise only break at F5:
 *
 *   1. every %PLACEHOLDER% in index.html is replaced by panel.ts, and nothing
 *      unreplaced ships to the browser;
 *   2. every element id main.mjs reaches for exists in index.html (the classic
 *      silent-typo bug: getElementById returns null and the control just dies);
 *   3. the CSS custom properties glass.mjs emits and style.css consumes are the
 *      same set (a renamed variable is invisible until a slider does nothing);
 *   4. the CSP keeps its strict shape and only opens the loopback origin;
 *   5. main.mjs imports nothing but its sibling module, so `script-src
 *      ${cspSource}` is sufficient and no remote code can load.
 *
 * This mirrors upstream's guard philosophy (docs/GUARD-MAP.md: machine checks
 * that are cheap and catch drift), scoped down to what a PoC needs.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGlassVars } from '../media/glass.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const html = read('media/index.html');
const mainSrc = read('media/main.mjs');
const styleSrc = read('media/style.css');
const panelSrc = read('src/panel/panel.ts');

test('index.html placeholders are exactly the ones panel.ts replaces', () => {
  const present = [...html.matchAll(/%([A-Z_]+)%/g)].map((m) => m[1]).sort();
  assert.deepEqual(present, ['CSP', 'MEDIA_ORIGIN', 'SCRIPT_URI', 'STYLE_URI'], `模板占位符：${present.join(', ')}`);
  for (const name of present) {
    assert.match(panelSrc, new RegExp(`replace\\('%${name}%'`), `panel.ts 必须替换 %${name}%`);
  }
  // The loopback origin has to reach main.mjs, which is an EXTERNAL module — the host
  // substitutes tokens in index.html only, so a token inside main.mjs would ship
  // literally. It travels as a body attribute instead.
  assert.match(html, /<body data-media-origin="%MEDIA_ORIGIN%">/);
  assert.match(mainSrc, /document\.body\.dataset\.mediaOrigin/);
  assert.doesNotMatch(mainSrc, /%[A-Z_]+%/, 'main.mjs 里不许出现占位符：它不会被替换');
});

test('the live layer mounts the vendored engine directly, not through a frame', () => {
  // The engine is the MIT npm package webwallgl, vendored under media/ and imported as
  // a same-origin module. That is what removed the licence blocker, the "user must
  // supply a build" requirement, and the cross-origin iframe + postMessage bridge.
  assert.match(mainSrc, /from '\.\/renderer\.mjs'/, 'main.mjs 必须通过挂载层使用引擎');
  assert.match(html, /<div id="wp-live" hidden><\/div>/, '实时层是一个 div（引擎把 canvas 挂进去）');
  assert.doesNotMatch(html, /<iframe id="wp-scene"/, '不该再有 iframe');
  assert.match(mainSrc, /mountWallpaper\(el\.live, item/);
  assert.match(mainSrc, /liveInstance\.canvas/);
  assert.match(mainSrc, /toDataURL\('image\/jpeg'/, '抓帧用 canvas.toDataURL（同源直取）');
  // The engine ships with the extension: nothing may depend on a user-supplied path.
  assert.doesNotMatch(mainSrc, /wallpaper-engine\/scene-live/, '不再从回环源加载渲染页');
  assert.doesNotMatch(mainSrc, /we-scene-command|we-scene-frame/, '不再需要 postMessage 桥');
  assert.match(panelSrc, /worker-src blob:/, '引擎内部用 blob worker 解纹理，CSP 要放开它');
  // Root cause of "web wallpaper has no scene.pkg": a hand-written Source for web
  // items. It must stay dead, and web items must ride the same httpSource as scenes.
  const rendererSrc = read('media/renderer.mjs');
  assert.doesNotMatch(rendererSrc, /webSource/, '不许再为 Web 手写 Source');
  assert.match(rendererSrc, /renderMode === 'scene' \|\| item\.renderMode === 'web'/, 'Web 与 Scene 同走项目目录 Source');
  assert.match(rendererSrc, /webSandbox/, 'Web 沙箱档位必须显式（strict：作者代码不得触及面板 origin）');
  // Silent failures must be VISIBLE: the engine's one-shot diagnostics and errors
  // have to reach the panel's log, or a dead render loop reads as "nothing on screen".
  assert.match(rendererSrc, /onDiagnostic: options\.onDiagnostic/, '适配层必须透传引擎诊断回调');
  assert.match(mainSrc, /onDiagnostic: /, '面板必须把引擎诊断写进输出通道');
});

test('the vendored engine is present and attributed', () => {
  const upstream = JSON.parse(read('media/webwallgl/UPSTREAM.json'));
  assert.equal(upstream.license, 'MIT');
  assert.match(upstream.version, /^\d+\.\d+\.\d+$/);
  assert.ok(existsSync(join(root, 'media/webwallgl/LICENSE')), 'MIT 要求随附许可证');
  const lib = read('media/webwallgl/webwallgl.min.mjs');
  assert.ok(lib.length > 500_000, `引擎本体应当在（实际 ${lib.length}B）`);
  assert.match(lib, /export\s*\{/, '必须是 ESM，才能被 webview 直接 import');
  // The adapter must only import from the vendored copy, and only relatively.
  const renderer = read('media/renderer.mjs');
  assert.match(renderer, /from '\.\/webwallgl\/webwallgl\.min\.mjs'/);
  for (const spec of [...renderer.matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
    assert.ok(spec.startsWith('./'), `挂载层只允许相对导入，实际：${spec}`);
  }
});

test('every id main.mjs touches exists in index.html', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(htmlIds.size >= 10, `index.html 应定义足够多的 id，实际 ${htmlIds.size}`);

  const wanted = new Set([...mainSrc.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
  // Slider tables reference ids through variables, so collect those literals too.
  for (const m of mainSrc.matchAll(/^\s*\['(\w+)',\s*'([\w-]+)',\s*'([\w-]+)'\],?$/gm)) {
    wanted.add(m[2]);
    wanted.add(m[3]);
  }
  assert.ok(wanted.size >= 10, `main.mjs 应引用了足够多的 id，实际 ${wanted.size}`);

  const missing = [...wanted].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `main.mjs 引用了 index.html 中不存在的 id：${missing.join(', ')}`);
});

test('every slider has a default, a unit and its own reset button', () => {
  const sliderKeys = [...mainSrc.matchAll(/^\s*\['(\w+)',\s*'[\w-]+',\s*'[\w-]+'\],?$/gm)].map((m) => m[1]);
  assert.ok(sliderKeys.length >= 9, `SLIDERS 应解析出 9 个以上滑块，实际 ${sliderKeys.length}`);

  const literalKeys = (name) => {
    const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(mainSrc);
    assert.ok(block, `main.mjs 里找不到 ${name} 字面量`);
    return new Set([...block[1].matchAll(/^\s*([\w-]+):/gm)].map((m) => m[1]));
  };
  const defaults = literalKeys('DEFAULTS');
  const units = literalKeys('UNITS');

  const noDefault = sliderKeys.filter((k) => !defaults.has(k));
  assert.deepEqual(noDefault, [], `这些滑块没进 DEFAULTS，「恢复默认」会写成 undefined：${noDefault.join(', ')}`);
  const noUnit = sliderKeys.filter((k) => !units.has(k));
  assert.deepEqual(noUnit, [], `这些滑块没进 UNITS，读数会退回原始小数：${noUnit.join(', ')}`);

  // The per-row reset is markup, tied to the setting by data-reset — a row without it
  // simply has no reset, and nothing else would notice.
  const noReset = sliderKeys.filter((k) => !html.includes(`data-reset="${k}"`));
  assert.deepEqual(noReset, [], `这些滑块缺少行内「恢复默认」按钮：${noReset.join(', ')}`);
  const unknownReset = [...html.matchAll(/data-reset="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((k) => !defaults.has(k));
  assert.deepEqual(unknownReset, [], `data-reset 指向 DEFAULTS 里没有的键：${unknownReset.join(', ')}`);

  // The grouping is the point of the settings page — three of the keys only do anything
  // with the whole-window patch on, and they used to look exactly as global as the rest.
  const groups = (html.match(/class="we-group"/g) || []).length;
  assert.ok(groups >= 4, `设置页应分成 4 组以上，实际 ${groups}`);
});

test('glass.mjs emits exactly the CSS variables style.css consumes', () => {
  const vars = buildGlassVars({}, 'dark');
  const produced = new Set(Object.keys(vars));
  const consumed = new Set([...styleSrc.matchAll(/var\((--we-[\w-]+)\)/g)].map((m) => m[1]));
  // --we-* is also referenced in :root defaults; those must be produced too.
  const declared = new Set([...styleSrc.matchAll(/^\s*(--we-[\w-]+):/gm)].map((m) => m[1]));

  const usedButNotProduced = [...consumed].filter((v) => !produced.has(v));
  assert.deepEqual(usedButNotProduced, [], `style.css 使用了未产生的变量：${usedButNotProduced.join(', ')}`);
  const declaredButNotProduced = [...declared].filter((v) => !produced.has(v));
  assert.deepEqual(declaredButNotProduced, [], `style.css 声明了未产生的变量：${declaredButNotProduced.join(', ')}`);
});

test('panel.ts keeps a strict CSP that only opens the loopback origin', () => {
  assert.match(panelSrc, /default-src 'none'/);
  for (const directive of ['img-src', 'media-src', 'connect-src']) {
    assert.match(panelSrc, new RegExp(`${directive}[^\`]*\\$\\{origin\\}`), `${directive} 必须精确放开回环源，而不是 *`);
  }
  // A Web wallpaper runs in a blob: iframe whose document INHERITS this policy (blob
  // documents carry the creator's CSP), so the engine's INLINE shim script and the
  // author's loopback-served css/js can only run if these are open — with just
  // cspSource here every Web wallpaper mounts and then silently runs no code.
  // 'unsafe-eval' is for the engine's scene-script sandbox: WE text widgets and
  // object property expressions compile as JS strings, and without eval every
  // scripted scene fails with "Evaluating a string as JavaScript …" (the real
  // reason scenes rendered broken in the panel while the workbench layer worked —
  // its CSP already carried 'unsafe-eval').
  assert.match(panelSrc, /script-src \$\{webview\.cspSource\} 'unsafe-inline' 'unsafe-eval' \$\{origin\}/);
  assert.match(panelSrc, /style-src \$\{webview\.cspSource\} 'unsafe-inline' \$\{origin\}/);
  assert.match(panelSrc, /frame-src blob: \$\{origin\}/);
  // …but never a remote origin.
  assert.doesNotMatch(panelSrc, /script-src[^`]*https?:/, 'script-src 不得放开远端源');
  // The webview may only read files it ships.
  assert.match(panelSrc, /localResourceRoots: \[vscode\.Uri\.joinPath\(extensionUri, 'media'\)\]/);
});

test('main.mjs has no remote imports (script-src stays cspSource-only)', () => {
  const specifiers = [...mainSrc.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'main.mjs 应当有 import');
  for (const s of specifiers) {
    assert.ok(s.startsWith('./'), `只允许相对同级模块，实际：${s}`);
  }
});

test('the preview can never paint on top of the live video again', () => {
  // Three independent guards, because this bug was invisible until a wallpaper
  // with an animated-GIF preview was selected.
  // 1. no <video poster> attribute (Chromium keeps showing it on its own terms)
  assert.doesNotMatch(mainSrc, /setAttribute\(\s*'poster'/, 'main.mjs 不得给 <video> 设 poster 属性');
  // 2. visibility comes from the tested state machine, not ad-hoc assignments
  assert.match(mainSrc, /from '\.\/render-state\.mjs'/, 'main.mjs 必须用 render-state.mjs 决定图层可见性');
  assert.match(mainSrc, /computeLayerState\(state\)/);
  // 3. CSS stacking: poster below video
  const zOf = (sel) => {
    const block = new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(styleSrc);
    assert.ok(block, `style.css 缺少 ${sel} 规则`);
    const z = /z-index:\s*(-?\d+)/.exec(block[1]);
    assert.ok(z, `${sel} 必须显式声明 z-index（层序是契约，不是装饰）`);
    return Number(z[1]);
  };
  assert.ok(zOf('#wp-poster') < zOf('#wp-video'), '预览图必须排在视频之下');
  assert.ok(zOf('#wp-video') < zOf('\\.we-scrim'), '暗化层必须在视频之上');
});

test('panel replays state on `ready` (first-push race)', () => {
  // postMessage to a webview whose script has not run yet is dropped, and the
  // document is rebuilt every time a hidden tab comes back (retainContextWhenHidden
  // is false), so the host must replay inventory + item on every `ready`.
  assert.match(panelSrc, /case 'ready':/, 'panel.ts 必须处理 ready');
  assert.match(panelSrc, /if \(this\.lastSnapshot\) this\.post\(\{ type: 'inventory'/, 'ready 时必须重放 inventory');
  assert.match(panelSrc, /if \(this\.lastItem !== undefined\) this\.post\(\{ type: 'item'/, 'ready 时必须重放 item');
  // …and when there is nothing to replay, it must ASK for a scan. A panel restored by
  // VS Code never went through the open command, so without this it sits on
  // "正在扫描本地壁纸库…" forever — which reads as "the library cannot be scanned".
  assert.match(panelSrc, /if \(!this\.lastSnapshot\) this\.hooks\.onNeedsInventory\(\)/);
  assert.match(panelSrc, /onNeedsInventory\(\): void;/, 'hooks 必须声明这个回调');
  assert.match(read('src/extension.ts'), /onNeedsInventory: \(\): void => \{/);
});

test('wallpaper selection happens inside the panel, not in a QuickPick', () => {
  // The library used to be `vscode.window.showQuickPick`: a dropdown over the top of
  // the window, with no thumbnails and no way to see the wallpaper you are choosing.
  // It lives in the panel now, so the assertion is deliberately blunt — no QuickPick
  // anywhere in the host, and the panel owns both the list and the selection message.
  const extensionSrc = read('src/extension.ts');
  assert.doesNotMatch(extensionSrc, /showQuickPick/, '壁纸选择不得再走顶部栏 QuickPick');
  assert.match(extensionSrc, /onSelectRequest: \(id: string\)/, 'host 必须处理面板发来的选择');
  assert.match(extensionSrc, /WallpaperPanel\.instance\?\.openLibrary\(\)/, '命令应打开面板内的壁纸库');

  // The webview builds the list from the inventory it already receives, and selects
  // by posting the id back.
  assert.match(mainSrc, /type: 'select', id: item\.id/, 'webview 通过 select 消息选择壁纸');
  assert.match(mainSrc, /function renderLibrary\(\)/, 'webview 必须自己渲染壁纸库');
  assert.match(panelSrc, /case 'select':/, 'panel.ts 必须转发 select');
  assert.match(panelSrc, /openLibrary\(\): void \{[\s\S]*?type: 'library', open: true/, 'panel.ts 必须支持命令打开壁纸库');
  assert.match(mainSrc, /case 'library':/, 'webview 必须处理 library 消息');

  // Rows are built as DOM, never as HTML strings: titles and notes come from
  // third-party project.json files.
  assert.doesNotMatch(mainSrc, /\.innerHTML\s*=/, '壁纸库里不许用 innerHTML 拼标题');
  assert.doesNotMatch(mainSrc, /insertAdjacentHTML/, '壁纸库里不许用 insertAdjacentHTML');
  assert.match(mainSrc, /createElement\('button'\)/, '列表行必须是可聚焦的按钮（键盘可用）');
  assert.match(html, /<input[\s\S]*?id="lib-search"/, '壁纸库要有搜索框');
  assert.match(styleSrc, /\.we-controls\[hidden\]\s*\{\s*display: none;/, '打开壁纸库时滑块必须真的隐藏（UA 的 [hidden] 敌不过 display:flex）');
});

test('the picker can filter by category (type / tags / source / rating)', () => {
  assert.match(html, /id="lib-filters"/, '壁纸库要有筛选条');
  assert.match(mainSrc, /const FILTER_ROWS = \[/, 'main.mjs 必须定义筛选分组');
  for (const group of ['type', 'tag', 'source', 'rating']) {
    assert.ok(mainSrc.includes(`'${group}'`), `筛选分组缺少 ${group}`);
  }
  // One predicate for every group: search and filters have to compose, not fight.
  assert.match(mainSrc, /function filterMatch\(item, group, value\)/, '筛选必须走同一个判定函数');
  assert.match(mainSrc, /function libraryMatches\(item, query = ''\)[\s\S]{0,300}Object\.entries\(libFilter\)/, '搜索与筛选必须同时生效');
  assert.match(mainSrc, /\(item\.tags \|\| \[\]\)\.join\(' '\)/, '搜索要包含标签（只有一张壁纸的标签没有 chip，也要能搜到）');
  assert.match(mainSrc, /chip\.dataset\.group = group;[\s\S]{0,140}chip\.dataset\.value = value;/, 'chip 必须带 group/value');
  assert.match(mainSrc, /chip\.setAttribute\('aria-pressed'/, 'chip 要报出选中状态（键盘/读屏可用）');
  assert.match(mainSrc, /function renderFilters\(\)/, '必须有渲染 chip 的函数');
  // Counts with the OTHER groups applied: otherwise a chip promises wallpapers the
  // current combination cannot show.
  assert.match(mainSrc, /function filterPool\(items, group\)[\s\S]{0,220}others\.every/, 'chip 计数要考虑其它分组的当前值');
  assert.match(mainSrc, /if \(!available\.has\(libFilter\[group\]\)\) libFilter\[group\] = 'all';/, '重扫后失效的筛选要自动复位，否则列表静默变空');
  assert.match(mainSrc, /没有符合当前筛选的壁纸/, '筛到空集要有专门的空状态文案');
  assert.match(styleSrc, /\.we-chip--on \{/, '选中的 chip 要有可见状态');
  assert.match(styleSrc, /\.we-filter-row \{[\s\S]{0,240}overflow-x: auto;/, '标签行要能横向滚动（30 个标签不能把列表挤出去）');
});

test('only one surface renders a Scene/Web wallpaper live (the panel obeys the host)', () => {
  // Two engine instances for the same wallpaper cost a second full render on the
  // renderer main thread — measured ~4% of one core per instance, sharing the thread
  // the editor UI runs on. The host owns the policy; the panel only obeys it.
  assert.match(mainSrc, /const panelLive = state\.panelLive !== false/, 'webview 必须按主机策略决定是否挂载引擎');
  assert.match(mainSrc, /isLive\(state\.item\) && panelLive/, '关掉面板实时后不得再挂载');
  // A mount already in flight when the policy flips must be parked: the engine exposes
  // no destroy(), so without this the panel keeps rendering a detached 0x0 canvas —
  // invisible, and worse than the duplicate it replaced (reproduced live). The guard is
  // a generation, not the key: re-attaching the SAME wallpaper while its first mount is
  // still in flight would otherwise let the stale mount adopt itself as the live one.
  assert.match(mainSrc, /let liveGen = 0;/, '取消要用世代号判定');
  assert.match(mainSrc, /if \(gen !== liveGen\) \{[\s\S]*?parkLiveInstance\(instance\)/, '迟到的挂载必须释放');
  assert.match(mainSrc, /function detachLive\(\) \{\s*\/\/[^\n]*\n\s*liveGen \+= 1;/, 'detach 必须让在飞行的挂载失效');
  assert.match(mainSrc, /let mountChain = Promise\.resolve\(\);/, '挂载必须串行，否则释放会把新画布一起删掉');
  assert.match(mainSrc, /实时挂载已被取消/, '取消要留一条日志，否则下次只能靠猜');
  assert.match(mainSrc, /case 'live':/, 'webview 必须处理 live 消息');
  assert.match(mainSrc, /整窗层实时渲染/, '面板不是实时面时必须如实标注徽章（不能继续写"实时渲染"）');
  assert.match(panelSrc, /setLiveSurface\(panelLive: boolean\)/, 'panel.ts 必须能下发实时面策略');
  assert.match(panelSrc, /type: 'live', panelLive/, 'panel.ts 必须发送 live 消息');
  assert.match(panelSrc, /this\.post\(\{ type: 'live', panelLive: this\.panelLive \}\)/, 'ready 时必须重放策略（首推会输给文档加载）');
  const extensionSrc = read('src/extension.ts');
  assert.match(extensionSrc, /const liveSurface = \(\)/, 'extension.ts 必须读 liveSurface 设置');
  assert.match(extensionSrc, /service\.workbenchTargetFor\(item, liveSceneEnabled\(\), liveSurface\(\)\)/, '两个调用点都要传实时面');
  assert.match(extensionSrc, /workbenchRendersLive/, '面板策略要按"整窗层是否真的在实时渲染"算，而不是只看设置');
  // The whole-window layer is tuned for its job (behind a translucent UI at 24fps).
  assert.match(read('src/workbench/patch.ts'), /renderDpr: 1[\s\S]*?fps: 24[\s\S]*?particles: 'medium'/, '整窗层要降配渲染');
});

test('every browser module parses (a syntax error here kills the whole panel)', () => {
  // This is not hypothetical: a botched edit left `log('info', 暂停/恢复失败：);` in
  // main.mjs, the module failed to parse, the webview never sent `ready`, and the panel
  // sat on "正在扫描本地壁纸库…" forever — which reads exactly like "the wallpaper
  // library cannot be scanned". node --test never loads these files, so nothing caught it.
  for (const rel of ['media/main.mjs', 'media/renderer.mjs', 'media/glass.mjs', 'media/render-state.mjs']) {
    const src = read(rel);
    // Strip module syntax so the rest can be compiled as a function body (syntax only).
    const body = src
      .replace(/^\s*import\s[^;]*;$/gm, '')
      .replace(/^\s*export\s+/gm, '')
      .replace(/^\s*export\s*\{[^}]*\};?$/gm, '');
    assert.doesNotThrow(() => new Function(body), `${rel} 必须能解析`);
  }
});

test('extension manifest keeps its activation and capability declarations in sync', () => {
  const pkg = JSON.parse(read('package.json'));
  // Activation must cover the status bar item created on activate().
  //
  // It is `*`, not `onStartupFinished`, and that is a measured decision: the patched
  // page can do nothing until this extension binds the loopback port, and
  // `onStartupFinished` fires ~2.9 s after the extension host starts (the workbench has
  // to finish coming up first). The measured effect is in CHANGELOG 0.1.16; the price is
  // a few config reads and one status() during startup, which the [perf] lines report.
  assert.ok(
    pkg.activationEvents.includes('*'),
    '必须在扩展宿主启动时就激活：壁纸要等 onStartupFinished 的话要晚 ~2.9 秒才出现',
  );
  // Remote/virtual workspaces are declared unsupported: local disk + loopback server.
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
  // Every command contributed must be registered by the compiled extension.
  const extensionJs = read('out/extension.js');
  for (const { command } of pkg.contributes.commands) {
    assert.ok(extensionJs.includes(`registerCommand('${command}'`), `extension.ts 未注册 ${command}`);
  }
  // Every setting the webview writes must exist, or update() throws at runtime.
  const known = new Set(Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace('weWallpaper.', '')));
  const sliders = [...read('media/main.mjs').matchAll(/postMessage\(\{ type: 'setting', key: ([^,]+),/g)].map((m) =>
    m[1] === 'key' ? null : m[1].replace(/['"]/g, ''),
  );
  for (const key of sliders.filter(Boolean)) {
    assert.ok(known.has(key), `webview 会写设置 ${key}，但 package.json 里没有`);
  }
  // The switches the extension must act on (they do real work, not just store a value).
  for (const key of ['workbenchBackground', 'transparentTitleBar', 'wallpaperId']) {
    assert.ok(known.has(key), `package.json 缺少 ${key}`);
    assert.ok(extensionJs.includes(key), `extension.ts 未处理 ${key}`);
  }
});
