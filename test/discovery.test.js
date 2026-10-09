/**
 * Discovery + inventory tests.
 *
 * Two kinds of coverage:
 *  - machine-independent: fixtures and pure functions (vdf scan, type inference,
 *    extension extraction, schemecolor conversion) — these always run;
 *  - machine-dependent: the real Steam library, when one is present. Those
 *    assertions adapt instead of failing on a machine without Wallpaper Engine,
 *    so the suite stays honest on CI as well as on the dev box.
 */

'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const locate = require('../out/we/locate.js');
const inventory = require('../out/we/inventory.js');

test('librariesFromVdf: only libraries whose block mentions appid 431960', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'we-vdf-'));
  try {
    const vdf = join(dir, 'libraryfolders.vdf');
    await writeFile(
      vdf,
      [
        '"libraryfolders"',
        '{',
        '\t"0"',
        '\t{',
        '\t\t"path"\t\t"D:\\\\Steam"',
        '\t\t"apps"',
        '\t\t{',
        '\t\t\t"431960"\t\t"826275581"',
        '\t\t}',
        '\t}',
        '\t"1"',
        '\t{',
        '\t\t"path"\t\t"E:\\\\SteamLibrary"',
        '\t\t"apps"',
        '\t\t{',
        '\t\t\t"1172470"\t\t"87645448568"',
        '\t\t}',
        '\t}',
        '\t"2"',
        '\t{',
        '\t\t"path"\t\t"F:\\\\Games"',
        '\t\t"apps"',
        '\t\t{',
        '\t\t\t"431960"\t\t"1"',
        '\t\t}',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.deepEqual(await locate.librariesFromVdf(vdf), ['D:\\Steam', 'F:\\Games']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('librariesFromVdf: missing file yields [] rather than throwing', async () => {
  assert.deepEqual(await locate.librariesFromVdf(join(tmpdir(), 'definitely-missing', 'libraryfolders.vdf')), []);
});

test('inferType / extOf follow upstream rules', () => {
  assert.equal(inventory.inferType('a.mp4'), 'video');
  assert.equal(inventory.inferType('A.WEBM'), 'video');
  assert.equal(inventory.inferType('index.html'), 'web');
  assert.equal(inventory.inferType('app.js'), 'web');
  assert.equal(inventory.inferType('scene.pkg'), 'scene');
  assert.equal(inventory.extOf('C:\\x\\y\\clip.MP4'), 'mp4');
  assert.equal(inventory.extOf('C:\\x\\y\\no-extension'), '');
  assert.equal(inventory.extOf(null), '');
});

test('schemeToCss converts WE 0–1 floats to rgb() and rejects junk', () => {
  assert.equal(inventory.schemeToCss('1 0.5 0'), 'rgb(255, 128, 0)');
  assert.equal(inventory.schemeToCss('0.1 0.2 0.3'), 'rgb(26, 51, 77)');
  assert.equal(inventory.schemeToCss('1 2'), null);
  assert.equal(inventory.schemeToCss('a b c'), null);
  assert.equal(inventory.schemeToCss(undefined), null);
});

test('readProject: KINDS whitelist falls back to scene, unknown types included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'we-proj-'));
  try {
    const cases = [
      ['ok-video', { file: 'v.mp4', title: 'V', contentrating: 'Mature', general: { properties: { schemecolor: { value: '1 0 0' } } } }, 'video'],
      ['upper-web', { file: 'index.html', type: 'Web' }, 'web'],
      ['bogus-type', { file: 'x.tex', type: 'nonsense' }, 'scene'],
      ['no-type-mp4', { file: 'y.mp4' }, 'video'],
    ];
    for (const [name, body, expectedType] of cases) {
      const p = join(dir, name);
      await mkdir(p, { recursive: true });
      await writeFile(join(p, 'project.json'), JSON.stringify(body), 'utf8');
      const proj = await inventory.readProject(p);
      assert.ok(proj, `${name} should parse`);
      assert.equal(proj.type, expectedType, `${name} type`);
      assert.equal(proj.id, name);
      // Tags default to [] (not undefined): the picker's filter chips read this straight.
      assert.deepEqual(proj.tags, [], `${name} tags 缺失时必须是 []`);
    }

    // Missing project.json and missing `file` are both skipped, like upstream.
    const bare = join(dir, 'bare');
    await mkdir(bare, { recursive: true });
    assert.equal(await inventory.readProject(bare), null);
    const noFile = join(dir, 'no-file');
    await mkdir(noFile, { recursive: true });
    await writeFile(join(noFile, 'project.json'), JSON.stringify({ title: 'x' }), 'utf8');
    assert.equal(await inventory.readProject(noFile), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readProject: tags are the picker categories (WE internals and junk dropped)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'we-tags-'));
  try {
    const p = join(dir, 'tagged');
    await mkdir(p, { recursive: true });
    await writeFile(
      join(p, 'project.json'),
      JSON.stringify({
        file: 'scene.pkg',
        title: 'Tagged',
        // WE stores its own bookkeeping in the same array — those are not categories.
        tags: ['Anime', '_approved', 'Girls', 'Anime', '', 42],
      }),
      'utf8');
    const proj = await inventory.readProject(p);
    assert.deepEqual(proj.tags, ['Anime', 'Girls'], '只保留真实标签，去重且剔除 _ 前缀/非字符串');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSceneMainFile: declared → scene.pkg → scene.json → single *.pkg', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'we-scene-'));
  try {
    // Declared file absent, scene.pkg present → scene.pkg wins.
    await writeFile(join(dir, 'scene.pkg'), 'pkg', 'utf8');
    assert.equal(await inventory.resolveSceneMainFile(dir, 'scene.json'), 'scene.pkg');

    // Declared file present → declared wins.
    await writeFile(join(dir, 'scene.json'), '{}', 'utf8');
    assert.equal(await inventory.resolveSceneMainFile(dir, 'scene.json'), 'scene.json');

    // Nothing declared and exactly one pkg → that pkg.
    const only = await mkdtemp(join(tmpdir(), 'we-scene2-'));
    await writeFile(join(only, 'weird-name.pkg'), 'pkg', 'utf8');
    assert.equal(await inventory.resolveSceneMainFile(only, null), 'weird-name.pkg');
    await rm(only, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real machine: locates Wallpaper Engine and enumerates its library', async (t) => {
  locate.resetProbeCache();
  const roots = await locate.steamProbeDirs([]);
  t.diagnostic(`探针目录：${roots.join(' | ')}`);

  const installDir = await locate.locateWallpaperEngine([]);
  if (!installDir) {
    t.diagnostic('本机未找到 Wallpaper Engine —— 跳过依赖真实库的断言');
    return;
  }
  assert.ok(existsSync(join(installDir, 'wallpaper32.exe')), '安装目录应含 wallpaper32.exe');

  const libs = await locate.owningLibraries([]);
  t.diagnostic(`拥有 431960 的库：${libs.join(' | ')}`);
  assert.ok(libs.length >= 1, '至少应解析出一个拥有 431960 的 Steam 库');

  const items = await inventory.enumerateWallpapers(installDir, libs);
  t.diagnostic(`枚举到 ${items.length} 张壁纸`);
  assert.ok(items.length > 0, '应从 projects/ 或 workshop 枚举到壁纸');

  const kinds = new Set(inventory.KINDS);
  const nonContainerSceneMains = [];
  for (const it of items) {
    assert.ok(kinds.has(it.type), `类型必须在白名单内：${it.id}=${it.type}`);
    assert.ok(it.title.length > 0, `${it.id} 应有标题`);
    assert.ok(it.fileAbs.includes(it.id) || it.source === 'workshop', `${it.id} 主文件应落在项目目录内`);
    assert.ok(existsSync(it.fileAbs), `${it.id} 主文件应存在：${it.fileAbs}`);
    if (it.type === 'scene' && !/\.(pkg|json)$/i.test(it.fileAbs)) {
      // Upstream's inferType() falls back to 'scene' for anything that is not
      // video/web, so a project declaring e.g. `sheep.exe` is classified as a
      // scene. Recorded rather than asserted away: it is a real behaviour of the
      // ported rules, and the render step has to decide what to do with it.
      nonContainerSceneMains.push(`${it.id} → ${it.fileAbs}`);
    }
  }
  if (nonContainerSceneMains.length) {
    t.diagnostic(`上游类型推断怪癖（非 pkg/json 的 scene 主文件）：${nonContainerSceneMains.join(' | ')}`);
  }

  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] ?? 0) + 1;
  t.diagnostic(`类型分布：${JSON.stringify(byType)}`);
});
