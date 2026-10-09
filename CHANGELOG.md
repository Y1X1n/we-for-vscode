# Changelog

All notable changes to this extension. The project follows [Semantic Versioning](https://semver.org/).

## [0.1.16] — 2026-10-09

启动速度：窗口出现 → 壁纸首帧 **3.81 s → ~2.3 s**（本机实测，同一张视频壁纸，各连测 3 次；
逐次数据见文末）。

- **提前激活**：`activationEvents` 由 `onStartupFinished` 改为 `*`。补丁页面在本扩展绑定回环
  端口之前什么都做不了，而 `onStartupFinished` 要等扩展宿主起来后约 2.9 s 才触发 —— 单这一项
  就是启动时间的大头（实测激活点：宿主已运行 2950 ms → ~1450 ms）。
- **先用预览当 poster**：整窗层把项目预览设成 `<video>` 的原生 `poster`。214 MB 的壁纸解码首帧
  要 ~0.7 s，这期间窗口不再是全黑。poster 的生命周期归浏览器管，首帧一到自动消失 —— 面板那套
  "海报盖在实时视频上"的坑在这层不可能出现。
- **`/current` 重试爬坡**：原来固定 `500 ms × 失败次数`，端口就绪后还要多等 100–300 ms 才被读到；
  现在头 2 秒每 150 ms 探一次，之后退避到 2 s。长尾保留：新装 VS Code 首启实测要 7.2 s 才激活，
  早放弃会让窗口一直没有壁纸。
- **不再重写没变的注入资源**：补丁块本身不含版本号，注入文件在首次之后每次启动逐字节相同，于是
  6 个文件（~85 KB）+ 状态文件的写入变成只读比对 —— 每个窗口省 10–40 ms，也少一堆磁盘写入
  （origin 变了仍然会写，否则窗口会去连旧端口）。
- **启动时间线可测量**：宿主侧打 `[perf]` 日志（激活起点 / 媒体服务 / 壁纸库 / 注入资源 / 刷新
  完成，各带"扩展宿主已运行 N ms"）；渲染侧把 `boot → poster → metadata → playing` 每一阶段连同
  `performance.now()` 上报到 `/probe` 的 `video` 槽，并保留历史 `videoTimeline`（首帧会在一瞬间
  覆盖 poster，只留最后一条就读不出"poster 到底出现过没有"）。两边合起来直接回答"慢在哪"。
- 剩下的时间基本不在扩展手里：扩展宿主自身启动 ~1.45 s，视频首帧解码 ~0.15–0.7 s（取决于文件
  大小与系统缓存）。

实测（同一台机器、同一张壁纸，`/probe` 的 `video.ms` = 页面开始加载到首帧的毫秒数）：

| 版本 | 激活点（宿主已运行） | 窗口 → 首帧 |
|---|---|---|
| 0.1.15（改前） | 2944 / 2974 / 3004 ms | 3806 / 3817 ms（+1 次未采到） |
| 0.1.16（改后） | 1439 / 1477 / 1513 ms | 2266 / 2337 / 2388 ms |

时间线（`/probe.videoTimeline`，页面开始加载为 0）：`boot@108 → poster@2195 → metadata@2242 →
playing@2266` —— 也就是说窗口在 ~2.2 s 就有画面（预览），~2.27 s 换成实时视频。
安装后第一次启动会更慢（实测宿主 7.2 s 才激活，扩展目录刚落地被杀毒/文件系统扫描）：那一次
`poster@9293`，仍然出现了，没有被放弃。

## [0.1.15] — 2026-10-09

Category filters in the wallpaper picker.

- **筛选分类**: the library now has chip rows for 类型 (视频 / 场景 / 网页 / 应用), **标签**
  (WE's own categories — Anime / Girls / Landscape / Music …), 来源 (创意工坊 / 我的项目 /
  官方默认) and 分级 (全年龄 / 13+ / 成人) on top of the existing name search. Chips carry
  live counts and mark the active one; each row scrolls horizontally, so 30 tags cannot
  push the list out of the panel.
- Counts are **faceted**: a chip counts what the *other* filters would leave, and a value
  that can produce nothing is hidden — the UI cannot lead you into an empty list, and a
  selected chip always stays clickable (hiding the chip you are filtered by is how a
  faceted picker strands people).
- `tags` is now read from `project.json` (WE's `_`-prefixed internals dropped,
  de-duplicated) and travels through the inventory into the panel. The search box matches
  tags too, so a tag with a single wallpaper is reachable without a chip of its own.
- A rescan that drops the value a chip was filtering by resets that group instead of
  leaving a silently empty list.
- The filter state is deliberately not persisted: reopening the picker on a stale
  "Anime only" filter reads as "my workshop wallpapers are gone".

## [0.1.14] — 2026-10-09

Settings page UI pass (inside the 壁纸视图 panel).

- **Grouped by what each control affects** — 壁纸 / 玻璃 / VS Code 界面 / 面板. The three
  keys that only do anything with the whole-window patch on (侧边栏磨砂, 代码区底衬) are
  now under a caption that says so, instead of looking exactly as global as the rest.
- **Read-outs carry their unit**: `16 px`, `45%`, `1.30×`, `#101014` — every value used
  to be `toFixed(2)`, which printed "16.00" for a blur radius in px and "1.00" for an
  opacity. The 暗化层 read-out still says `（自动）` when the readability floor raised it.
- **Sliders show their value**: the track is filled up to the thumb with the theme accent
  colour (a gradient stop driven from JS), with hover/active thumb feedback.
- **Reset, per row and overall**: a ↺ on each row (only when the value differs from the
  default) and 「全部恢复默认」 for the lot. All of it goes through one write path, so a
  reset behaves exactly like dragging the slider.
- **Two columns on a wide panel** and a sticky 立即生效 bar — the settings page is 11
  controls tall, and on a laptop the apply button used to scroll out of reach.
- Accessibility: focus rings on sliders, buttons, the reset and the colour swatch;
  `role="status"`/`aria-live` on the apply feedback; `prefers-reduced-motion` respected.
- New guard: every slider must have a default, a unit and its own reset button (a row
  that silently loses one of the three now fails the suite).

## [0.1.13] — 2026-10-09

VS Code 1.141 support (the update that made the wallpaper disappear).

- **Fixed: no wallpaper on 1.141** — the new "modern UI / floating panels" shell is
  painted from `--modern-ui-shell-background`, which the workbench sets *inline* on the
  layout container with an opaque colour, and `workbench.desktop.main.css` then fills
  `.monaco-workbench.floating-panels` **and** `.monaco-workbench.floating-panels >
  .monaco-grid-view` with it. The root was already transparent; the grid view was not,
  so the whole window became an opaque sheet over the `z-index:-1` wallpaper layer —
  with the glass still applying, which is why every computed style looked healthy.
  The variable is now forced transparent (with `!important`, since it is set inline) and
  the layout container is explicitly transparent as well.
- **Fixed: floating panel cards were opaque** — 1.141 fills `.part.sidebar` /
  `.part.auxiliarybar` from the new `surface.background` theme key (with `!important`);
  it is now in the transparent-variable list, so the cards are frosted glass again.
- **Fixed: the editor tab strip selectors for 1.141** — the group header now carries
  `tabs` itself (`.title.tabs`) and the strip lives in
  `.tabs-and-actions-container > .tabs-container`; the old `.title .tabs` selector
  silently stopped matching.
- **Restart, not reload, after a patch is written**: VS Code reads the installation
  checksum table once, at startup, so writing `workbench.html` in a running app makes it
  report "installation has been modified on disk" (the "install appears to be corrupt"
  notification) on every later window load — a reload cannot clear it. The extension now
  says so explicitly and offers "退出 VS Code" (+ a `weWallpaper.restartCode` command and
  a status-bar item) instead of recommending Ctrl+R. This is what made the 1.141 update
  look like it had broken VS Code.
- The runtime style probe now reports the wallpaper layer itself
  (`#we-workbench-wallpaper`, the live scene canvas) with display / visibility / opacity /
  z-index, plus the 1.141 grid view and shell variable — the "layer is covered or hidden"
  failure is now visible from `/probe` instead of being inferred from screenshots.

## [0.1.12] — 2026-10-05

- Frosted glass for the menubar's own dropdowns (File / Edit / …), which are
  `.menubar .menubar-menu-items-holder` rather than context views.
- New on-demand style report: `POST /probe {"reReport":true}` makes every window
  re-report its computed styles (a boot-time snapshot cannot describe a popup).

## [0.1.9] — 2026-10-05

- Frosted dropdown menus, command palette and hover widgets (theme tone + the shared
  blur radius, on a `::before` so submenus cannot be trapped in a stacking context).

## [0.1.8] — 2026-10-05

- Fixed: the top menu bar's dropdowns were painted under the glass — `backdrop-filter`
  on the chrome parts created a stacking context that trapped them. The frosting moved
  to `::before` pseudo-elements.

## [0.1.7] — 2026-10-05

- Fixed: the 侧边栏磨砂 / 代码区底衬 (chrome glass / code backing) sliders never worked —
  their keys were missing from `LIMITS`, so the input handler threw before writing.
- The panel now reports script errors to the extension log.

## [0.1.6] — 2026-10-05

- Every slider now reaches the window (paired keys are mirrored), and none of them is
  silently overridden: `0` means no glass / no dimming.
- `autoContrast` defaults to `off`; the readability floor is opt-in.
- Added `saturate` and `glassColor` for the whole-window glass.

## [0.1.5] — 2026-10-05

- Fixed: 「立即生效」 reverted a slider that had just been moved (settings round-trip race).

## [0.1.4] — 2026-10-05

- Settings take effect immediately: server-sent events (`/events`) push every view
  change, and the panel gained a 「立即生效」 button.

## [0.1.3] — 2026-10-05

- The code area stays sharp: frosting is only on the chrome, never on the editor
  surface or the wallpaper layer.

## [0.1.2] — 2026-10-05

- Readable text over any wallpaper: the wallpaper layer measures its own pixels and the
  code surface's opacity is solved to WCAG 4.5:1 (measured 1.49:1 → 4.52:1).
- Frosted chrome (`backdrop-filter`), plus the two real bugs found while verifying it.

## [0.1.1] — 2026-10-05

- Performance: the whole-window layer renders at 1 canvas pixel per CSS pixel, 24 fps,
  medium particles; one live instance per wallpaper (`liveSurface`).

## [0.1.0] — 2026-10-05

- First release: Wallpaper Engine library discovery, panel playback (video / scene /
  web), whole-window background layer, liquid-glass panel.
