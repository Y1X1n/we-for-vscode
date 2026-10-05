/**
 * Panel contract: the sliders, their DOM ids and their limits must agree.
 *
 * The bug this exists for: `chromeGlassAlpha` and `editorGlassAlpha` were added to
 * SLIDERS (and to index.html) but NOT to LIMITS. The input handler does
 * `clamp(raw, ...LIMITS[key])`, so `...undefined` threw a TypeError, the rest of the
 * handler never ran, and both sliders were dead from the day they were added — reported
 * as "代码区低衬这个拖拉没有用" and "只有侧边栏是生效的". Nothing in the suite compared the
 * three lists, which is why it shipped twice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { LIMITS } from '../media/glass.mjs';

const read = (p) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

/** `[key, inputId, outputId]` rows of main.mjs's SLIDERS table. */
function sliders() {
  const main = read('media/main.mjs');
  const table = main.slice(main.indexOf('const SLIDERS = ['), main.indexOf('];', main.indexOf('const SLIDERS = [')));
  return [...table.matchAll(/\['([A-Za-z]+)',\s*'([\w-]+)',\s*'([\w-]+)'\]/g)].map((m) => ({
    key: m[1],
    inputId: m[2],
    outputId: m[3],
  }));
}

test('the SLIDERS table is parsed (guards the test itself)', () => {
  const rows = sliders();
  assert.ok(rows.length >= 9, `SLIDERS 至少要解析出 9 行，实际 ${rows.length}`);
  assert.ok(rows.some((r) => r.key === 'editorGlassAlpha'), '必须包含代码区底衬');
});

test('every slider key has limits', () => {
  for (const { key } of sliders()) {
    const limits = LIMITS[key];
    assert.ok(
      Array.isArray(limits) && limits.length === 2,
      `${key} 缺少 LIMITS（会导致 clamp(raw, ...undefined) 抛错，滑块静默失效）`,
    );
    assert.ok(limits[0] < limits[1], `${key} 的上下限必须递增`);
  }
});

test('every slider key, input and output exists in the markup', () => {
  const html = read('media/index.html');
  for (const { key, inputId, outputId } of sliders()) {
    assert.ok(html.includes(`id="${inputId}"`), `${key} 的输入控件 ${inputId} 不在 index.html 里`);
    assert.ok(html.includes(`id="${outputId}"`), `${key} 的读数 ${outputId} 不在 index.html 里`);
    // The input must accept the limits, otherwise the browser clamps before we do.
    const tag = html.slice(html.indexOf(`id="${inputId}"`));
    const input = tag.slice(0, tag.indexOf('>'));
    const min = Number(/min="([\d.]+)"/.exec(input)?.[1]);
    const max = Number(/max="([\d.]+)"/.exec(input)?.[1]);
    assert.ok(
      min <= LIMITS[key][0] && max >= LIMITS[key][1],
      `${inputId} 的 min/max (${min}–${max}) 必须覆盖 LIMITS ${LIMITS[key].join('–')}`,
    );
  }
});

test('the slider handler cannot throw on an unknown key, and reports if it does', () => {
  const main = read('media/main.mjs');
  assert.ok(
    !/clamp\(raw, \.\.\.LIMITS\[key\]\)/.test(main),
    '不得直接展开 LIMITS[key]（缺失即抛错）',
  );
  assert.match(main, /const limits = LIMITS\[key\] \|\| \[Number\(input\.min\)/, '缺失时要退回控件自身的 min/max');
  assert.match(main, /catch \(err\) \{[\s\S]*?滑块 \$\{key\} 处理失败/, '处理失败要写进扩展日志，而不是静默');
  // A top-level throw used to leave the panel half-dead with a clean log.
  assert.match(main, /addEventListener\('error'/, '面板要上报 window error');
  assert.match(main, /addEventListener\('unhandledrejection'/, '面板要上报未处理的 Promise 异常');
});
