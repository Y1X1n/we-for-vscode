# Changelog

All notable changes to this extension. The project follows [Semantic Versioning](https://semver.org/).

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
