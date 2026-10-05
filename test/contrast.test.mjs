/**
 * Contrast / readability tests.
 *
 * The claim being defended: the wallpaper behind the UI cannot make the UI
 * unreadable, because the surface rendering it measures its own pixels and raises the
 * dimming to what the text needs. Two copies of that math exist — `media/contrast.mjs`
 * (panel + node) and a block embedded in the patched workbench script, which cannot
 * import the module because the workbench CSP only allows scripts from 'self'. The
 * equivalence test below is what keeps them from drifting: it extracts the block out
 * of the generated script and compares answers on the same inputs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  contrastFloor,
  contrastRatio,
  dimmedLuma,
  editorAlphaFor,
  fillChannels,
  luma,
  luminanceStats,
  textBackdropBound,
  themeKindFromClassList,
} from '../media/contrast.mjs';
import { buildJs } from '../out/workbench/patch.js';

const read = (p) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

/** A synthetic RGBA image: rows of the given luma values (0..1), repeated. */
function image(rows) {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.round(rows[y][x] * 255);
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const WHITE = image(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1)));
const DARK = image(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0.12)));
/** Left half black, right half white: maximum clutter, the "high contrast" case. */
const SPLIT = image(
  Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, x) => (x < 4 ? 0 : 1))),
);

test('luminance stats see brightness, darkness and clutter', () => {
  const white = luminanceStats(WHITE);
  assert.equal(white.p95, 1);
  assert.equal(white.bright, 1);
  assert.equal(white.busy, 0, 'a flat image has no edges');

  const dark = luminanceStats(DARK);
  // 0.12 → byte 31 → 31/255 = 0.1216, so compare with tolerance rather than guessing.
  assert.ok(Math.abs(dark.p95 - 0.122) < 0.002, `dark wallpaper reads dark (got ${dark.p95})`);
  assert.equal(dark.dark, 1);

  const split = luminanceStats(SPLIT);
  // A hard black/white edge is HIGH CONTRAST but not CLUTTER: only the pixels either
  // side of it cross the threshold, which is why `busy` stays low while `p95` is 1.
  // Readability is protected by the p95 term here, not by blur.
  assert.ok(split.busy < 0.2, `a single hard edge is not clutter (got ${split.busy})`);
  assert.equal(split.p95, 1);
  assert.equal(split.p05, 0, 'the dark half is still represented');

  const checker = luminanceStats(
    image(Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? 0.2 : 0.9)))),
  );
  assert.ok(checker.busy > 0.8, `detail everywhere IS clutter (got ${checker.busy})`);

  // A fully transparent image carries no information: the panel must not read it as
  // "black wallpaper, nothing to do".
  const empty = luminanceStats({ data: new Uint8ClampedArray(16), width: 2, height: 2 });
  assert.equal(empty.samples, 0);
});

test('the floor follows the theme direction, and only ever dims', () => {
  // Dark theme: white text, so the bright areas set the requirement.
  const bright = contrastFloor({ samples: 100, p05: 0.4, p50: 0.7, p95: 0.9, busy: 0.1 }, 'dark', 'balanced');
  assert.ok(bright.scrim > 0.5 && bright.scrim <= 0.75, `bright wallpaper needs dimming (got ${bright.scrim})`);
  assert.equal(bright.fill, '#000');
  assert.equal(bright.blur, 0, 'a smooth wallpaper does not need blur');

  const strong = contrastFloor({ samples: 100, p05: 0.4, p50: 0.7, p95: 0.9, busy: 0.1 }, 'dark', 'strong');
  assert.ok(strong.scrim > bright.scrim, 'strong dims more');

  // Already dark: nothing to do, the user's slider decides.
  assert.equal(contrastFloor({ samples: 100, p95: 0.18, busy: 0 }, 'dark', 'balanced').scrim, 0);

  // Light theme: dark text, so the DARK areas set the requirement — and the answer is
  // a white wash, not a black scrim.
  const wash = contrastFloor({ samples: 100, p05: 0.05, p50: 0.3, p95: 0.6, busy: 0 }, 'light', 'balanced');
  assert.ok(wash.scrim > 0.3, `dark wallpaper needs a wash in a light theme (got ${wash.scrim})`);
  assert.equal(wash.fill, '#fff');
  assert.equal(contrastFloor({ samples: 100, p05: 0.9, busy: 0 }, 'light', 'balanced').scrim, 0);

  // Clutter buys blur, and 'off' buys nothing at all.
  const busy = contrastFloor({ samples: 100, p05: 0.2, p95: 0.8, busy: 0.5 }, 'dark', 'balanced');
  assert.ok(busy.blur > 0, 'a busy wallpaper gets blur');
  assert.deepEqual(contrastFloor({ samples: 100, p95: 1, busy: 1 }, 'dark', 'off'), { scrim: 0, fill: '#000', blur: 0 });
  // A wallpaper the panel could not measure must not change anything.
  assert.deepEqual(contrastFloor({ samples: 0 }, 'dark', 'balanced'), { scrim: 0, fill: '#000', blur: 0 });
});

test('the editor opacity is solved against a WCAG target, not guessed', () => {
  const dark = { surfaceLuma: 0.118, fgLuma: 0.743, target: 4.5 };
  // The solve runs AFTER the dimming floor — that order is what makes the target
  // reachable at all, because the scrim is what removes most of the wallpaper's light.
  const wp = dimmedLuma({ p95: 0.7 }, 0.63, 'dark');
  const needed = editorAlphaFor({ ...dark, wallpaperLuma: wp });
  assert.ok(needed > 0.85 && needed <= 0.95, `a dimmed-but-bright wallpaper still needs a solid surface (got ${needed})`);
  const blended = needed * dark.surfaceLuma + (1 - needed) * wp;
  // 4.45 rather than 4.5: the alpha is rounded to two decimals before it is applied.
  assert.ok(
    contrastRatio(dark.fgLuma, blended) >= 4.45,
    `the solved alpha must reach AA (got ${contrastRatio(dark.fgLuma, blended)})`,
  );
  // With the dimming already doing the job, no extra opacity is asked for.
  assert.equal(editorAlphaFor({ ...dark, wallpaperLuma: dimmedLuma({ p95: 0.45 }, 0.75, 'dark') }), 0, 'dimming enough removes the need for opacity');
  assert.equal(editorAlphaFor({ ...dark, wallpaperLuma: 0.12 }), 0, 'a dark wallpaper needs nothing');
  // A light theme is the mirror image: dark text, bright surface, wash from below. Note
  // the ceiling here is the THEME's own: #333 text on any background tops out around
  // 4.2:1, so the honest claim is "the solve reaches what an opaque surface would".
  const light = { wallpaperLuma: 0.1, surfaceLuma: 0.93, fgLuma: 0.2, target: 4.5 };
  const lightAlpha = editorAlphaFor(light);
  assert.ok(lightAlpha > 0.7, `a dark wallpaper in a light theme needs the surface too (got ${lightAlpha})`);
  const lightBlended = lightAlpha * light.surfaceLuma + (1 - lightAlpha) * light.wallpaperLuma;
  const rawRatio = contrastRatio(light.fgLuma, light.wallpaperLuma);
  const ceiling = contrastRatio(light.fgLuma, light.surfaceLuma);
  assert.ok(
    contrastRatio(light.fgLuma, lightBlended) >= rawRatio + 0.7 * (ceiling - rawRatio),
    `the solve must capture most of the available contrast (got ${contrastRatio(light.fgLuma, lightBlended)}, ceiling ${ceiling})`,
  );
  assert.ok(lightBlended > light.wallpaperLuma, 'and it moves the backdrop toward the light surface');
  // A wallpaper that is bright AND undimmed cannot be saved by opacity alone: the cap is
  // what stops the editor from becoming a black rectangle, and the scrim is what keeps
  // this case from arising (the two are always applied together).
  const capped = editorAlphaFor({ ...dark, wallpaperLuma: 0.7 });
  assert.equal(capped, 0.95, 'the solve is capped so the wallpaper never disappears entirely');
  assert.ok(contrastRatio(dark.fgLuma, capped * dark.surfaceLuma + (1 - capped) * 0.7) < 4.5);
  assert.equal(textBackdropBound(0.743, 4.5), (0.743 + 0.05) / 4.5 - 0.05);
  // The wash/scrim arithmetic the solve depends on.
  assert.equal(dimmedLuma({ p95: 0.8 }, 0.5, 'dark'), 0.4);
  assert.equal(dimmedLuma({ p05: 0.2 }, 0.5, 'light'), 0.6);
});

test('the workbench copy of the math answers exactly like the module', () => {
  const js = buildJs('http://127.0.0.1:39127');
  const block = js.match(/\/\* WB-CONTRAST:START[\s\S]*?WB-CONTRAST:END \*\//);
  assert.ok(block, 'the contrast block must stay marked, the test extracts it by marker');
  // eslint-disable-next-line no-new-func -- the point IS to run the generated script's math
  const wb = new Function(`${block[0]}\nreturn { wbStats, wbContrast, wbEditorAlpha, wbDimmedLuma };`)();

  const cases = [
    { rows: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1)) },
    { rows: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0.12)) },
    { rows: Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, x) => (x < 4 ? 0 : 1))) },
    { rows: Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ((x + y) % 2 ? 0.2 : 0.9))) },
  ];
  for (const mode of ['balanced', 'strong', 'off']) {
    for (const theme of ['dark', 'light']) {
      for (const c of cases) {
        const img = image(c.rows);
        const mine = luminanceStats(img);
        const theirs = wb.wbStats(img.data, img.width, img.height);
        assert.deepEqual(theirs, mine, `stats must match for ${mode}/${theme}`);
        const a = contrastFloor(mine, theme, mode);
        const b = wb.wbContrast(theirs, theme, mode);
        assert.equal(b.scrim, a.scrim, `scrim must match for ${mode}/${theme}`);
        assert.equal(b.blur, a.blur, `blur must match for ${mode}/${theme}`);
        assert.equal(b.fill, fillChannels(a.fill), `fill must match for ${mode}/${theme}`);
        // The editor solve and the dimming arithmetic must agree too.
        for (const scrim of [0, 0.3, a.scrim]) {
          assert.equal(
            wb.wbDimmedLuma(theirs, scrim, theme),
            dimmedLuma(mine, scrim, theme),
            `dimmed luma must match for ${mode}/${theme}/${scrim}`,
          );
        }
        for (const [wp, fg, target] of [
          [dimmedLuma(mine, a.scrim, theme), 0.743, 4.5],
          [0.8, 0.2, 4.5],
          [0.05, 0.9, 7],
        ]) {
          assert.equal(
            wb.wbEditorAlpha(wp, theme === 'light' ? 0.93 : 0.118, fg, target),
            editorAlphaFor({ wallpaperLuma: wp, surfaceLuma: theme === 'light' ? 0.93 : 0.118, fgLuma: fg, target }),
            `editor alpha must match for ${mode}/${theme}/${wp}`,
          );
        }
      }
    }
  }
});

test('every surface that renders the wallpaper applies the floor', () => {
  const manifest = JSON.parse(read('package.json'));
  const setting = manifest.contributes.configuration.properties['weWallpaper.autoContrast'];
  assert.deepEqual(setting.enum, ['off', 'balanced', 'strong'], 'autoContrast 必须是三档');
  assert.equal(setting.default, 'balanced', '默认开启（可读性不能被滑块归零）');

  const js = buildJs('http://127.0.0.1:39127');
  assert.match(js, /var effective = Math\.max\(userScrim === null \? 0 : userScrim, floor\.scrim\)/, '整窗层取滑块与实测值的较大者');
  assert.match(js, /scheduleContrast\('scene'\)/, 'Scene 挂载后要采样');
  assert.match(js, /scheduleContrast\('video'\)/, 'Video 出画后要采样');
  assert.match(js, /reportContrast\(contrastKey/, '采样结果要进 /probe 的独立槽位，否则被每轮 already-mounted 覆盖');
  assert.match(read('src/media/server.ts'), /contrast: this\.lastContrast/, '/probe 要暴露对比度槽位');
  assert.match(js, /代码文字对比度=/, '/probe 要给出算出来的文字对比度（锁屏时截不了图）');
  assert.match(js, /function wbTextContrast/, '对比度要用主题色与实测亮度算，而不是猜');
  assert.match(js, /--vscode-editor-foreground/, '前景色必须取自主题变量');
  const css = read('src/workbench/patch.ts');
  assert.match(css, /--we-wb-blur/, '整窗层要有可读性模糊变量');
  assert.match(css, /--we-wb-scrim-rgb/, '暗化层颜色要按主题方向可换（浅色主题要提亮）');

  const main = read('media/main.mjs');
  assert.match(main, /import \{ contrastFloor as contrastFloorMath, fillChannels, luminanceStats \} from '\.\/contrast\.mjs'/, '面板必须用同一份数学');
  assert.match(main, /scrim: Math\.max\(Number\(state\.settings\?\.scrim\) \|\| 0, contrastFloor\.scrim\)/, '面板同样取较大者');
  assert.match(main, /panelOwnsWallpaper/, '面板只在它是渲染面时才抬升（否则会和整窗层叠成两倍暗化）');
  assert.match(read('media/style.css'), /rgb\(var\(--we-scrim-fill, 0, 0, 0\)\)/, '面板暗化层颜色也要可换');
  assert.match(read('src/media/server.ts'), /contrast: this\.viewContrast/, '/current 要下发模式');
  assert.match(read('src/extension.ts'), /contrast: autoContrastMode\(\)/, '主机要把模式推给整窗层');
  assert.equal(fillChannels('#fff'), '255,255,255');
  assert.equal(fillChannels('#000'), '0,0,0');
  // Rec.709 weights sum to 1 only up to floating point.
  assert.ok(Math.abs(luma(255, 255, 255) - 1) < 1e-9);
  assert.equal(luma(0, 0, 0), 0);
  assert.equal(themeKindFromClassList(['vscode-light']), 'light');
  assert.equal(themeKindFromClassList(['vscode-dark']), 'dark');
});
