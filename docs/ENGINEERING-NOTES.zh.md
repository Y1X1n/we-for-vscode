# Wallpaper Engine for VS Code — PoC

把本机 **Wallpaper Engine** 壁纸搬进 VS Code 的壁纸视图，配 iOS 风格**液态玻璃**控制面板。

这是 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）移植到 VS Code 扩展的**第 1 步 PoC**，走的是评估报告里的**方案 A**：宿主逻辑（Steam/WE 库发现、`project.json` 解析、媒体服务）移植到扩展宿主，渲染放进扩展自己的 WebView。

> **边界先说清楚**：VS Code 扩展**没有**访问 workbench DOM 的 API，也没有设置窗口背景图/窗口透明的 API。所以这个扩展提供的是**它自己的壁纸视图**（编辑器标签页里的 WebView），**不是**铺在编辑器/侧栏/聊天界面之后的背景。想要"真背景"只能改安装目录（不受支持、随更新失效），详见评估报告方案 B。

---

## 这一步做了什么（step 1 范围）

| 能力 | 状态 |
|---|---|
| Steam / Wallpaper Engine 安装目录发现（注册表 → 配置 → 常见目录 → WSL `/mnt`） | ✅ 移植自上游探测链，行为对齐 |
| `libraryfolders.vdf` 解析（Valve KeyValues 行扫，只认含 appid `431960` 的库） | ✅ 与上游同算法（含其怪癖） |
| 壁纸枚举：`projects/defaultprojects`、`projects/myprojects`、`steamapps/workshop/content/431960` | ✅ 24 个一批的异步扫描 |
| `project.json` 解析：title / type / preview / **contentrating** / `schemecolor` | ✅ 类型白名单 + `scene` 兜底，与上游一致 |
| Scene 主容器解析：declared → `scene.pkg` → `scene.json` → 单个 `*.pkg` | ✅ |
| **Video 壁纸播放**（`<video autoplay loop muted playsinline>`） | ✅ 本步核心 |
| 带 **HTTP Range** 的本地媒体服务（4K/500MB+ 视频可 seek、渐进播放） | ✅ 随机端口 + 不可猜 token + 目录围栏 |
| 液态玻璃控制：模糊 / 玻璃底色不透明度 / 暗化 / 壁纸不透明度 / 边框 / 面板宽度 / 玻璃颜色 / 饱和度 | ✅ 实时生效，写回 VS Code 设置 |
| 可读性下限（浅色 0.45 / 深色 0.59） | ✅ 移植自上游实测值，压过滑块 |
| 遮挡暂停（面板隐藏 / 窗口失焦） | ✅ 映射到 `panel.visible` 与 `onDidChangeWindowState` |
| 自动轮播（秒级间隔，仅 Video） | ✅ 基础版 |
| 状态栏项、命令、快捷键、QuickPick 选择器 | ✅ |
| Application 类型壁纸 | ✅ 列出但**永不渲染**（上游 ADR-0001 D4） |

## 这一步**没有**做（后续步骤）

- ~~**Scene 实时渲染（WebWallGL）**~~：**已接通**——引擎是 MIT 的 npm 包 `webwallgl@1.4.2`，随扩展发布在 `media/webwallgl/`，webview 里同源 `mount()` 直接挂载（见下文「多类型壁纸」）。
- ~~**Web 壁纸实时渲染**~~：**已接通**——同一个库，构造只实现 `webEntry()` 的 `Source`；作者 HTML 仍由引擎放进它自己的沙箱 iframe，我们只提供载荷。
- **剩余的边界**：散装 `scene.json`（无 `scene.pkg`）与入口不是 HTML 的 Web 壁纸降级为预览图；Scene 在**整窗背景层**仍是静图（那层只有一个 `<video>`）；视频纹理场景可能需要给 webview CSP 补 `worker-src blob:`（已加）。
- **ffmpeg 帧率压缩 / faststart remux / 缩略图**：把 `DSH_WE_FFMPEG` 换成 `weWallpaper.ffmpegPath`，并沿用"PATH 探测 → 按需下载 → 自备"的降级顺序。
- **上传自定义壁纸**、**WE 播放列表导入**、**轮播列表分组**、**Now Playing / 音频频谱**、**字体集**：均为后续步骤（音频那部分建议降级或砍掉，理由见报告第 2 节第 18 项）。
- **`asWebviewUri` 资源投递路径**：当前统一走本地 HTTP 服务以获得 Range 控制；远程/Codespaces 场景需要切到 `asWebviewUri`（并接受 seek 行为差异）。

---

## 运行

**方式一（推荐，所有窗口都生效）**：打包成 VSIX 正式安装。

```powershell
npm install          # devDependencies：typescript + @types/*
npm run compile      # tsc -> out/
npm test             # 48 条测试
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension .\we-for-vscode-0.1.4.vsix --force
```

装好后会出现在**扩展视图**里（`local-poc.we-for-vscode`），并且**每个窗口都会激活**——这是方案 B 对所有窗口生效、命令/状态栏处处可用的前提。卸载：`code --uninstall-extension local-poc.we-for-vscode`。

> **为什么 F5 开发宿主不够**：`--extensionDevelopmentPath` 加载的是"开发扩展"，它**不是已安装扩展**，所以 ① 不出现在扩展视图里，② **只存在于被启动的那一个窗口**。其它窗口没有它——我实测过其它窗口的 `exthost.log`，完全没有本扩展的激活记录。要在多窗口使用，只能走 VSIX 安装。

**方式二（改代码时用）**：本目录按 **F5**（"Run Extension (Wallpaper Engine PoC)"），仅在该开发宿主窗口内有效。

之后：`Ctrl+Alt+W` 打开壁纸视图，或点右下角状态栏项；点 **选择壁纸…** 挑一张 Video 壁纸，拖玻璃滑块实时调参，或搜设置 `weWallpaper.*`。

### 多窗口约定

- 每个窗口有**独立的扩展宿主**：壁纸视图、媒体服务、状态栏项都是每窗口一份；`weWallpaper.*` 设置是全局的。
- 方案 B 的补丁是**文件级**的，因此对所有窗口生效；但媒体 URL 只能指向一个端口（`weWallpaper.mediaPort`，默认 39127），所以**只有一个窗口能占用它**。占用的窗口关掉后，其它窗口会在 5 秒内**自动接管该端口**——端口和 token 都不变，已打开的窗口无需重载即可继续播放。
- token 密钥是**从机器信息确定性推导**的（不是随机存储）：否则两个窗口同时首次激活时会各自生成不同密钥，导致其中一个窗口烤进 HTML 的 URL 在另一个窗口里 404。

## 设置项

全部在 `weWallpaper.*` 下：`steamRoot`、`blur`、`saturate`、`wallpaperOpacity`、`scrim`、`border`、`glassAlpha`、`glassColor`、`panelWidth`、`autoRotateSeconds`、`pauseWhenHidden`、`logLevel`。
诊断日志在输出通道 **Wallpaper Engine**（`logLevel` 默认 `warn`，调成 `info` 可看完整的探测/扫描/注册过程）。

## 方案 B：铺满 VS Code 本体（实验，可一键还原）

命令面板里两条命令：

| 命令 | 作用 |
|---|---|
| `Wallpaper Engine: 启用壁纸背景（铺满 VS Code，实验/需改安装目录）` | 注入补丁 → 提示重载窗口 |
| `Wallpaper Engine: 禁用壁纸背景（还原安装目录）` | 还原安装目录 → 提示重载窗口 |

**它到底改了什么**（全部可逆）：

1. `<appRoot>/out/vs/code/electron-browser/workbench/workbench.html` —— 在 `</body>` 前插入一个**静态**标记块（壁纸层 `<video>` + 两个 `./` 相对引用），并把 CSP 的 `media-src`/`img-src`/`connect-src` 放行 `http://127.0.0.1:*`（**不动 `script-src`/`style-src`**：我们自己的文件是同源 `./` 引用）。这个文件只在启用/禁用时改动一次；
2. 同目录新增两个文件 `we-workbench-wallpaper.css` / `.js`（**新文件，不在校验表里**）；
3. `product.json` 里 `checksums["vs/code/electron-browser/workbench/workbench.html"]` 同步写成新哈希。

**校验和的编码（踩过的坑）**：`product.json.checksums` 里存的是 **`base64(sha256(文件字节))` 去掉 padding**（43 字符），**不是 base64url**。第一版实现误用了 base64url，导致写回去的值 VS Code 永远不认；而原厂 `workbench.html` 的哈希恰好既不含 `+` 也不含 `/`（两种编码在此重合），所以"算法核对"当时侥幸通过，之后又变成自己跟自己比，把 bug 藏住了。现在 `test/workbench-patch.test.mjs` 用两条断言钉死它：`checksum('hello') === 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ'`（含 `+` 与 `/`），以及**对着厂商原始校验表核对全部 10 项**。

**关于"安装似乎损坏"提示（重要，已修）**：VS Code 的完整性服务（bundle 里的 `vs/workbench/services/integrity/electron-browser/integrityService`）比的是 **`productService.checksums` —— 主进程启动时读进内存的那份表**，不是磁盘上现在的值（`out/main.js` 里 `createRequire("../product.json")` 只在进程启动时执行一次，Node 还会缓存 JSON 模块）。因此：

- 我们确实把新哈希写回了 `product.json`（磁盘上始终一致，已验证）；
- 但**在 VS Code 运行期间打补丁**，那个进程内存里还是原厂哈希 → 重载窗口不会刷新它 → **提示会出现，直到完全重启一次**。重启后主进程读到新表，提示消失。
- 更进一步：补丁块现在是**静态的**（`workbench.html` 里不含任何媒体地址，也不含用户设置）。壁纸地址由注入脚本在运行时向 `GET /current` 获取，不透明度/暗化写进 CSS 文件——两者都**不在校验表里**。因此**换壁纸、调滑块都不会再改动 `workbench.html`**，也就不会再触发这个提示。已打开的窗口每 15 秒轮询一次 `/current`，会自动跟上换壁纸，无需重载。

**失败自愈**：注入脚本会重试并从 `/current` 取地址；如果始终拿不到（扩展没在跑、壁纸被删），它给 `<html>` 加上 `.we-wb-fallback`，**全部透明规则立刻失效**，界面回到正常外观——不会留下"黑底 + 透明 UI"的坏状态。

**透明度覆盖范围与三处边界（实测踩过）**：

- 覆盖：编辑器、侧栏、活动栏、状态栏、面板、标签栏、面包屑、菜单/下拉/输入框等 36 个 `--vscode-*` 背景变量，外加 `.monaco-workbench` / `.part` / `.editor-group-container` / 编辑器遮挡块（`… .overflow-guard > .monaco-scrollable-element`，选择器链取自 vscode-background 验证过的写法）等结构性规则。
- **实色高亮要改成半透明着色，不能设成 transparent**：2026-dark 等主题里 `editor.lineHighlightBackground` / `hoverHighlight` / `rangeHighlight` 都是**实色 `#242526`**，直接盖在壁纸上就是光标所在行的一条黑带。现在改成 `var(--we-wb-line-tint)`（深色主题 `rgba(255,255,255,0.07)`，浅色主题 `rgba(0,0,0,0.055)`），视觉提示保留、壁纸透得出来。
- **顶部标题栏：原生模式改不了**。`window.titleBarStyle` 未设置时默认 `native` —— 那一条由 **Windows 自己绘制**，CSS 无从触及。设成 `custom` 后标题栏与菜单栏变成 DOM 元素（`.part.titlebar` / `.menubar`），上面的规则才能生效：

  ```json
  "window.titleBarStyle": "custom"
  ```

  不喜欢随时改回 `native`。
- **右上角三个按钮：`titleBar.activeBackground` 改不动它**（前一版在这里写错了）。它们是 Electron 的原生覆盖层，底色被 VS Code 用 `makeOpaque(#252526)` 强制成不透明后才交给 Electron，所以把主题色设成全透明只会得到一块不透明 `#252526` 的黑矩形 —— 样式表碰不到那层，行内字符串也读不出透明来。唯一出路是 `window.controlsStyle: "custom"`：VS Code 会**放弃原生覆盖层**，改用 DOM 画这三个按钮，CSS 才说得了话。细节、源码依据与"必须重开窗口"的原因见下一节。

## 这一轮修掉的三件事（都是实测踩出来的）

**① "Code 安装似乎损坏。请重新安装。" 不会再出现了。** 根因不是校验和写错（磁盘上一直是对的），而是 **在 VS Code 运行期间改写了受校验的 `workbench.html`**：完整性服务拿的是主进程启动时读进内存的那张表，任何一次会话内改写都会弹一次，直到完全重启。上一版把"内容哈希"放在 HTML 的 `?v=` 里，于是**每次扩展更新都会重写这个文件**。

现在 HTML 里的注入块是**冻结的**，只引用一个不带版本号的加载器 `we-workbench-boot.js`；真正的逻辑/样式是 `we-workbench-core.js` / `we-workbench-wallpaper.css`，由加载器在运行时按 `we-workbench-assets.json` 里的内容哈希加载。**HTML 从此一个字节都不动**，这条提示的成因被消除。加载器本身若要改，必须换文件名（测试里钉了它的摘要，改了会红）。Trusted Types 也要绕：样式用 `fetch` + `<style>.textContent` 注入，逻辑用动态 `import()`，两者都不是 TT 的 sink。

顺带修掉两个诊断 bug：探针原来用 `POST application/json`（触发 CORS 预检，而服务端对 `OPTIONS` 只回裸 200 → 浏览器静默丢弃，`/probe` 永远是 `null`），且在页面启动 1.5 秒后盲发一次（那时扩展宿主还没绑端口，失败不重试）。现在：`text/plain`（简单请求）、服务端正确应答预检、**只在 `/current` 成功之后**上报，并在 9 秒后补报一次（那时编辑器才挂载，才问得到"光标行"）。

**② "代码行残留" = sticky scroll 没有遮住下面的行。** 它是**覆盖层**，本来就要把滚过去的行挡住；之前给它的是近乎透明的浅色，于是被钉住的那行文字和下面的正文**叠在一起**，看起来就是重影/残留。现在 `--we-wb-sticky` 用 `rgba(16,16,20,0.94)`（浅色主题 `rgba(250,250,250,0.96)`），并去掉那圈阴影（会被看成一条暗带）。

**③ "光标所在行黑色遮挡"：原来那两行 CSS 是死代码。** 在这个 VS Code 里，`editor.lineHighlightBackground` / `editor.lineHighlightBorder` **根本不是 CSS 变量**（`workbench.desktop.main.css` 里出现 0 次）。真身是 JS 动态注入的规则：

```js
var LineHL = te("editor.lineHighlightBackground", null, …);
addRule(`.monaco-editor.focused .view-overlays .current-line { background-color: ${focusedColor}; }`);
addRule(`.monaco-editor.focused .margin-view-overlays .current-line-margin { background-color: ${focusedColor}; border: none; }`);
addRule(`.monaco-editor .view-overlays .current-line-exact { border: 2px solid ${theme.getColor(LineBorder)}; }`);  // 深色默认 #282828
```

`theme.getColor()` 会走 `colorCustomizations`，所以现在**两条路一起上**：

- `workbench.colorCustomizations` 写入 `editor.lineHighlightBackground: #80808014`、`editor.inactiveLineHighlightBackground: #8080800a`、`editor.lineHighlightBorder: #00000000`（机制正确的那条，主题服务一改就重注入，**不用重载**）；
- 注入样式表再加一条 `!important` 的元素规则（`.current-line` / `.current-line-margin` / `-exact` 变体，`border: none !important`），压掉动态规则。

同理补上了 `editorStickyScrollGutter.background`（默认取 `editor.background`，不覆盖就是钉住行左侧一条实色带）。

**为什么你之前"改了却看不出变化"**：升级扩展后，**正在运行的那个窗口早就加载完上一版的 CSS/JS 了**。所以 `enable()` 现在会比对资源版本，一旦变了就弹「**壁纸资源已更新，需要重载窗口才会生效**」，点一下即可（重载会重新读取磁盘上的 HTML → 新加载器 → 新资源）。"装完没效果"这类问题从此有明确提示。

## 多类型壁纸：Scene / Web 实时渲染（引擎是 MIT 的 npm 包 `webwallgl`）

**引擎来源**：`media/webwallgl/`（`webwallgl@1.4.2`，**MIT**，随包附 LICENSE，来源与版本记在 `UPSTREAM.json`）。上游仓库 `oneincase/webwallgl` 本身没附 LICENSE，但**npm 发布的包带 MIT 许可证**，所以改成正规依赖——不再需要用户自备构建页，也不再依赖本仓库里的 `_repo2` 克隆。线索来自 `oneincase/WallpaperEM`（同作者的 Tauri 壁纸引擎）：它的渲染器只是宿主适配层，真正的引擎就是这个 npm 包。

**挂载方式**（`media/renderer.mjs`，薄适配层）：

```js
import { mount, httpSource } from './webwallgl/webwallgl.min.mjs';
const inst = await mount(el, { source: httpSource(sceneBase), fit: 'cover', fps: 30, autoplay: true, volume: 0 });
inst.pause() / inst.resume() / inst.setFit() / inst.setFps() / inst.setQuality() / inst.getQuality()
inst.canvas.toDataURL('image/jpeg')      // 抓帧：同源直取，不需要任何桥
```

- **Scene（pkg 形态）**：`httpSource(<目录 token>)` —— 引擎 2.1.0 先试 `project.json` 声明的 pkg 路径，再回退固定名 `scene.pkg` / `scenes/scene.pkg` / `gifscene.pkg`（媒体服务把目录里唯一的 `*.pkg` 别名到固定名上）；
- **Scene（松散源码工程形态）**：`project.json` 的 `file` 以 `.json` 结尾（`scene.json` 等，无打包 pkg）→ 引擎的 `sceneDir` 按**相对路径按名取** `scene.json` / `materials/` / `models/` / `shaders/` —— 目录 token 本来就按路径服务全部文件，所以散装工程 2.1.0 起直接可渲染（此前降级为预览图）；
- **Web**：**与 Scene 同一条路**，也是 `httpSource(<目录 token>)`。`mount()` 先取 `project.json` 按 `type` 分流：`web` → 沙箱 iframe，入口 = `{基址}/{project.file 或 index.html}`。不要为 Web 手写 Source——`scenePkg` reject + `project: null` 的自制品会让引擎无法识别类型，报 "web wallpaper has no scene.pkg"。作者的 css/js/audio 靠相对路径，所以注册的是**整个项目目录**的 token；服务端 HTML **原样返回**，WE web-API shim（`wallpaperPropertyListener` 等）由引擎在改写 blob 文档时自行注入（幂等），我们不再注入第二套。面板 CSP 必须为这条路径放开 `script-src 'unsafe-inline' + 回环源`、`frame-src blob:`、`style-src/font-src 回环源`——blob 文档**继承**创建者（面板）的策略，少一项就是"挂上了但什么都不跑"；
- **可见性**：`mountWallpaper` 透传引擎的 `onDiagnostic/onError`（2.1.0 给四条静默失败路径接了一次性诊断，WebGL 上下文丢失也是可见事件）到输出通道，并保留 `mountTimeoutMs` 默认的 60s 首帧看门狗——渲染循环无声死亡现在会 reject 成 `实时渲染失败` 并降级预览图，而不是永远停在预览图上；
- **Video**：仍然用 `<video>` + Range 流式（已验证），不经过引擎。

**这样删掉了什么**（都是为"跨源 iframe"存在的）：`weWallpaper.webwallglDir` 设置与探测、「选择 WebWallGL 渲染页目录」命令、`/wallpaper-engine/scene-live/*` 路由、转发时注入的就绪探针、`/scene-frame` 回传、以及 `we-scene-command/we-scene-frame` postMessage 桥。控制面变成**直接调用实例**，抓帧变成**本地 `canvas.toDataURL()`**。

**本机实测**（`node _scratch/check-shipped-renderer.mjs`，跑的就是随扩展发布的那两个文件，页面带面板同款 CSP）：

```
Scene: 【4K 动态】DF首鸡纪念壁纸！     ok=true  canvas=625x313（软件渲染下 autoQuality 自动降档）
quality={"antiAliasing":"off","particles":"high","postProcessing":"off"}
✅ 抓到真实帧 51337B → _scratch/.shots/shipped-scene-0.jpg
Web 可渲染项: 3 张（CORSAIR Collection / Corsair-O-Tron / Customizable Module Visualizer）
```

**整窗背景层的实时 Scene（可选，默认关）**：设置 `weWallpaper.workbenchLiveScene`。开启后注入脚本会把随扩展发布的引擎经 **blob URL** 导入并挂到整窗背景上——`workbench.html` 的 CSP 本来就允许 `script-src blob:`，所以**不需要改写受校验的 HTML**（① 的前提不破）。默认关是因为"整个 VS Code 背后一块全屏 WebGL 画布"正是"代码行残留/重影"那类合成问题的温床；失败会自动退回预览静图。机制已实测（`_scratch/check-blob-engine.mjs`）：引擎 949,603B 取回 → blob 导入 → 真实场景挂载 → canvas 1250×625 → 抓帧成功。
**仍有边界**：散装 `scene.json`（无 `scene.pkg`）与入口不是 HTML 的 Web 壁纸按上游口径降级为预览图 + 说明；Scene 在**整窗背景层**仍是静图（那层只有一个 `<video>`，`/current` 用 `kind` 区分 video/image），要让它动需要给受校验的 `workbench.html` 的 CSP 加 `frame-src`（一次改写 = 一次"安装似乎损坏"提示），属独立一步。
## 怎么确认"三个按钮真的透明了"（本机实测口径）

不要靠肉眼猜，页面的探针会直接回答"原生覆盖层还在不在"。在任意一个已加载补丁的窗口里跑：

```powershell
(Invoke-WebRequest http://127.0.0.1:39127/probe -UseBasicParsing).Content | ConvertFrom-Json |
  Select-Object wcoVisible, iconCount, fallback
```

本机实测（VS Code 1.115.0，`window.titleBarStyle=custom` + `window.controlsStyle=custom`）：

| 字段 | 值 | 含义 |
|---|---|---|
| `wcoVisible` | `False` | Chromium 的 Window Controls Overlay **已关闭** —— 那块黑矩形就是它画的 |
| `iconCount` | `3` | 最小化/最大化/关闭已是 **DOM 节点**（`.window-controls-container > .window-icon`，各 46×34） |
| `fallback` | `False` | 补丁已生效（壁纸在放） |

再取那几个元素的计算样式，`styles['.monaco-workbench .window-controls-container > .window-icon'].bg` 应为 `rgba(0, 0, 0, 0)`，而 `styles['.monaco-workbench .part.titlebar'].inlineBg` 会显示 `rgb(37, 37, 38)` —— 那就是 VS Code 用 `makeOpaque()` 算出来、写进行内样式、并准备交给 Electron 的 `#252526`。样式表用 `!important` 把**绘制**改成透明，行内字符串动不了，所以只能靠 `controlsStyle` 换掉整条链路。

> 探针自己有两条坑，本步一并修了：① 它是 `POST application/json`，会触发 CORS 预检，而服务端对 `OPTIONS` 只回了个裸 200，浏览器于是静默丢弃 —— `/probe` 从来都是 `null`；② 它在页面启动后 1.5 秒盲发一次，而那一刻扩展宿主还没绑端口，失败不重试。现在改成 `text/plain`（简单请求、无需预检）、服务端正确应答 `OPTIONS`，并且**只在 `/current` 成功之后**上报一次。

## 全部开关都在扩展设置页（搜 `weWallpaper`）


| 设置 | 作用 |
|---|---|
| `weWallpaper.workbenchBackground` | **把壁纸铺满整个 VS Code**（改安装目录，已备份可还原）。改完提示重载 |
| `weWallpaper.transparentTitleBar` | **顶部标题栏 + 右上角最小化/最大化/关闭按钮一起透明**（写 `window.titleBarStyle: custom`、`window.controlsStyle: custom` 与 `workbench.colorCustomizations` 的 `titleBar.*Background`，关闭时精确还原你的原值）。**改完要完全关闭并重新打开 VS Code**：`controlsStyle` 只在建窗时读取，Ctrl+R 不够 |
| `weWallpaper.workbenchOpacity` / `workbenchScrim` | 壁纸不透明度 / 暗化层强度 |
| `weWallpaper.wallpaperId` | 当前壁纸 id（可直接填；用「选择壁纸…」挑会自动写回） |
| `weWallpaper.mediaPort` | 媒体服务端口（默认 39127，被占用自动回退随机端口） |
| `weWallpaper.blur` / `saturate` / `glassAlpha` / `glassColor` / `panelWidth` / `border` / `wallpaperOpacity` / `scrim` | 壁纸视图的液态玻璃参数 |
| `weWallpaper.autoRotateSeconds` / `pauseWhenHidden` / `steamRoot` / `logLevel` | 轮播、遮挡暂停、Steam 根目录、日志级别 |

两个开关**必须写成设置**，原因在代码里：

- **原生标题栏**：`window.titleBarStyle` 为 `native` 时整条顶栏（含菜单栏）由 Windows 绘制，任何样式表都碰不到；必须切成 `custom` 让 VSCode 用 DOM 渲染。
- **右上角三个按钮**：它们是 **Electron 的原生窗口控件覆盖层**（`setTitleBarOverlay`），而且 **VS Code 会把它的底色强制成不透明**。这是本仓库踩过的第二个坑，前一版 README 在这里写错了结论 —— 以为把 `titleBar.activeBackground` 写成 `#00000000` 就能让按钮透明。**实际不行**，原因是 VS Code 1.115.0 的 `titlebarPart.updateStyles()`（从 `out/vs/workbench/workbench.desktop.main.js` 里读出来的原码）：

  ```js
  let e = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_BACKGROUND : TITLE_BAR_ACTIVE_BACKGROUND,
                        (c, theme) => c.isOpaque() ? c : c.makeOpaque(DF(theme))) || "";
  this.element.style.backgroundColor = e;                      // ← 行内样式
  ...
  nativeHostService.updateWindowControls({ backgroundColor: this.element.style.backgroundColor, ... })
  ```

  而 `DF(theme)` 是按主题类型写死的常量（深色 `#252526` / 浅色 `#F3F3F3`），`makeOpaque(ref)` 在 alpha=0 时返回的就是这个参考色并把 alpha 钉成 1（`r = ref.r - a*(ref.r - r)`，`a=0` ⇒ 就是 `ref`）。所以：

  - `#00000000` 交给 Electron 时是 **不透明的 `#252526`** —— 壁纸上那块黑色矩形就是它；
  - 它读的是**行内属性字符串**，样式表的 `!important` 只能改"画出来的"背景，改不了 JS 读到的东西；而覆盖层根本不在 DOM 里，CSS 也无从命中。

  **正确做法**：让 VS Code 别再用原生覆盖层，改由 DOM 画这三个按钮 —— 设置项 `window.controlsStyle: "custom"`：

  ```json
  { "window.titleBarStyle": "custom", "window.controlsStyle": "custom" }
  ```

  依据同样来自该版本的源码：主进程 `windowControlsOverlayEnabled()`（`out/main.js`）在 `controlsStyle` 为 `custom`/`hidden` 时返回 false，于是 `BrowserWindow` 根本不带 `titleBarOverlay`；渲染进程随之创建

  ```html
  <div class="window-controls-container">
    <div class="window-icon window-minimize codicon-chrome-minimize"></div>
    <div class="window-icon window-max-restore codicon-chrome-maximize"></div>
    <div class="window-icon window-close codicon-chrome-close"></div>
  </div>
  ```

  这三个是**普通 DOM 元素**（点击经 `nativeHostService.minimizeWindow/maximizeWindow/closeWindow` 执行），所以 CSS 说了算。VS Code 自带规则里它们本来就没有底色（只有 `:hover` 的 `#ffffff1a` / 关闭键 `#e81123e6`），扩展另外显式写死"常态全透明 + 悬停反馈"（见 `src/workbench/patch.ts`）。

  > **注意**：`window.controlsStyle` 只在**创建窗口时**被主进程读取，所以改完必须**完全关闭并重新打开 VS Code**；只按 Ctrl+R 重载页面的话，旧的原生覆盖层还在，会和新的 DOM 按钮叠在一起。

  `workbench.colorCustomizations` 的两个 `titleBar.*Background` 键仍然写（合并写入，只碰这两个键；你原来的值会先存起来，关闭开关时精确还原）：它们生成 `--vscode-titleBar-*Background` 变量，DOM 顶栏与 DOM 按钮消费的就是这些变量 —— 但它**单独存在时永远无法让按钮透明**。

**风险（务必知情）**：

- **VS Code 更新会覆盖回去**：`workbench.html` 与 `product.json` 都会被更新替换，补丁自动消失（这比留下一个坏补丁好），需要重新启用。扩展也**不会**在此期间帮倒忙：
  - `status()` 报告"未注入"；
  - `disable()` 发现文件已不含补丁时**只清理残留、不改动安装**；
  - 若校验表被换掉（更新过）而补丁文件仍在，**改为就地剥离，绝不还原旧版本备份**——否则会拿旧版 `workbench.html` 覆盖新版文件，把好好的安装弄坏。状态文件里记录了 `patchedChecksum` 就是用来识别这件事的；卸载钩子走同一套判断。
  - 新版若改了 `workbench.html` 结构（CSP meta 或 `</body>`），`injectPatch` 会**明确报错拒绝**，而不是打半个补丁。
- **每个窗口都需要扩展在跑**：媒体 URL 由扩展的回环服务提供。没有扩展的窗口会走 `.we-wb-fallback` 回退成正常界面。
- **墙纸从 D 盘、VS Code 在 E 盘**：`vscode-file://vscode-app` 只能访问安装目录，所以不能用"同源文件"方案，必须走回环 HTTP + CSP 放行。
- **4K 视频铺满整个窗口的 GPU/电量开销**远超面板模式；窗口不可见时会暂停解码。
- **未验证**：macOS / Linux / Remote / 便携版（只读安装目录）未测试；macOS 的 `workbench.html` 路径与校验项不同。
- **卸载安全**：植入 `vscode:uninstall` 钩子（`out/uninstall.js`），卸载扩展时会自动还原。

**手工还原（不依赖扩展，两条命令即可）**：

```powershell
$d = 'E:\Microsoft VS Code\41dd792b5e\resources\app'   # = vscode.env.appRoot
$w = "$d\out\vs\code\electron-browser\workbench"
Copy-Item "$w\workbench.html.we-orig" "$w\workbench.html" -Force
Copy-Item "$d\product.json.we-orig"   "$d\product.json"   -Force
```

## 验证结果（本机实测）

`npm run compile` 无错误；`npm test` **52/52 通过**（Node 24.11.1）。其中端到端那条不是 mock：它跑的是编译后的生产代码路径（discovery → inventory → token → HTTP Range），打的是**本机真实 Wallpaper Engine 库**：

```
安装目录：d:\steam\steamapps\common\wallpaper_engine
壁纸：35 张，可播放 4 张
类型分布：{"scene":28,"video":4,"web":3}
流式验证通过：霸王之卵（自用）（558.4 MB, mp4）      ← 含中段 seek（206 + 1024 字节）
流式验证通过：鬼刀（16.0 MB, mp4）
流式验证通过：烟（by wlop)（40.3 MB, mp4）
流式验证通过：Aeolian by WLOP（214.6 MB, mp4）
```

每条流媒体断言都校验：`HEAD` 200 + 非零长度 + `Accept-Ranges: bytes`；`Range: bytes=0-8191` → 206 且 `Content-Range` 精确；首段字节的**容器魔数**（MP4 `ftyp` / Matroska EBML）；大文件再做一次中段跳转。

扩展在真实 **Extension Development Host** 中激活成功（扩展宿主日志）：

```
16:50:29.870 [info] ExtensionService#_doActivateExtension local-poc.we-for-vscode, startup: false, activationEvent: 'onStartupFinished'
```

并已生成输出通道文件 `logs/.../exthost/local-poc.we-for-vscode/Wallpaper Engine.log`。

**还没被自动化验证的只剩一件事**：WebView 的实际渲染（`node --test` 无法渲染 WebView）。为此用 7 条 **契约守卫** 覆盖了各层接口（`test/webview-contract.test.mjs`）：占位符是否都被替换、`main.mjs` 引用的每个 id 是否都存在于 HTML、`glass.mjs` 产出的 CSS 变量与 `style.css` 消费的是否是同一集合、CSP 是否仍只放开回环源、`main.mjs` 是否只 import 同级模块、`ready` 是否重放状态、清单命令/设置是否与代码一致。方案 B 另有 13 条守卫（`test/workbench-patch.test.mjs`），全部跑在**真实安装目录的副本**上：补丁 ↔ 剥离**逐字节往返**、`enable → disable` 后 `workbench.html` 与 `product.json` 逐字节还原、写入校验和后 `checksumMismatch === false`、CSP 只放行回环源、**重复 enable 不改动 `workbench.html`**（防止提示复发）、补丁块里不含媒体地址；`test/media-server.test.js` 另有多窗口**端口接管**与 `/current`+`/status`+`/beacon` 路由测试。

> 测试对"本机此刻已打补丁"这一状态免疫：fixture 会先 `stripPatch` 归一化成未打补丁的基线，因此 CI 与开发机都能跑。

顺带修掉三个只会在 F5 时暴露的真问题：

1. **首帧残留（用户目视发现）**：预览图 `<img>` 在 DOM 里排在 `<video>` **之后**，因此画在视频**上面**；而且本机 4 张 Video 壁纸里有 **2 张的 preview 是动图 GIF**（`1289832516`、`3722158524`），叠在播放中的视频上就是"第一帧卡住了"。修法：
   - 图层顺序改为契约：`#wp-poster` z-index 0 < `#wp-video` 1 < `.we-scrim` 2；
   - **不再给 `<video>` 设 `poster` 属性**（Chromium 在不受控的时机继续显示它）；
   - 预览图降级为"首帧之前的占位层"，由纯状态机 `media/render-state.mjs` 决定可见性，**首帧一出现（`loadeddata`/`playing`）立刻隐藏**——对应上游"首帧之前不留黑屏"的原意，且残留不可能复现；
   - 回归防线：7 条状态机单测 + 3 条契约守卫（禁止 `poster` 属性、必须走状态机、CSS 层序）。
2. **首次推送竞态**：WebView 脚本还没跑起来时 `postMessage` 会丢，导致打开视图是黑屏。现在宿主在 `ready` 时重放 inventory + item（隐藏标签页重建文档后同样受益）。
3. **玻璃底色用 `color-mix()` 有静默失效风险**：改成兼容性更久的 `rgb(var(--we-glass-rgb) / var(--we-glass-alpha))`，并把 hex 拆成通道由 `glass.mjs` 计算。

> 附带说明：`preview.gif` 仍然用于选择器缩略图，只是不再参与舞台叠加。若重测时出现**短暂黑屏**而非残留，说明 Chromium 在首帧前把 `<video>` 画成了黑块——那就把占位层翻到视频之上并加一个首帧看门狗（改动约 3 行），告诉我即可。

## 架构

```
src/we/locate.ts       Steam/WE 定位（移植：注册表探测、vdf 行扫、WSL 路径翻译、60s 探测缓存）
src/we/inventory.ts    项目枚举与 project.json 解析（移植：类型白名单、scene 主文件解析、24/批扫描）
src/media/server.ts    token 化回环媒体服务（Range / 206 / 416 / HEAD / 目录围栏 / CORS）
src/service.ts         库扫描 → 可播放清单（带 renderMode 与"为什么不渲染"的说明）
src/panel/panel.ts     WebviewPanel + CSP + postMessage 协议
src/workbench/patch.ts 方案B 的纯函数：注入/剥离补丁、CSP 放行、CSS/JS 生成、哈希
src/workbench/installer.ts 方案B 的磁盘操作：备份、写文件、同步校验和、状态文件
src/uninstall.ts       卸载钩子：卸载扩展时自动还原安装目录
src/extension.ts       命令 / 状态栏 / 设置变更 / 轮播 / 焦点暂停
media/index.html       模板（%CSP% / %STYLE_URI% / %SCRIPT_URI% 由宿主注入）
media/glass.mjs        纯函数：settings + 主题 → CSS 变量（Node 可直接测）
media/render-state.mjs 纯状态机：item + 遮挡/暂停 + 首帧是否已画 → 图层可见性
media/main.mjs         WebView 逻辑：渲染、滑块、播放状态、消息
media/style.css        玻璃配方 + 图层顺序（z-index 是契约）
test/                  node:test：发现链 / 媒体服务 / 玻璃数学
_repo2/                上游源码克隆（只作参照，不参与构建）
_ref/                  VSCode 侧参考实现克隆（vscode-background / custom-ui-style / GlassIt-VSC）
```

## 设计取舍（为什么这样做）

- **媒体走本地 HTTP 而不是 `asWebviewUri`**：4K 视频需要 Range 才能 seek 与快速起播；`asWebviewUri` 无法控制 Range。代价是必须自己管端口生命周期与 CORS，收益是播放体验与上游一致。
- **token 化 URL、不暴露路径**：请求根本无法表达路径，也就没有目录穿越面；再叠一层"只允许注册在壁纸根目录内"的围栏（对应上游的 `mediaMap` + 目录围栏）。
- **CSP 只放开回环源**：`media-src`/`img-src`/`connect-src` 精确到 `http://127.0.0.1:<端口>`，`default-src 'none'`。`127.0.0.1` 属规范定义的 potentially trustworthy origin，因此**不被混合内容拦截**。面板侧为引擎/壁纸额外放开的几处同样只指回环源：`script-src 'unsafe-inline' 'unsafe-eval' + 回环源`（**`unsafe-eval` 是场景脚本的硬需求**——WE 的文本挂件、对象属性表达式都是引擎编译执行的 JS 字符串，缺了它所有带脚本的场景在面板里残缺/不可见，而整窗层因 workbench CSP 本就有 unsafe-eval 而正常——这是"Scene 在面板不显示"的最后一块根因）、`style-src/font-src 回环源`、`frame-src blob:`（引擎改写后的作者文档经 blob URL 进 iframe，而 blob 文档继承面板的策略——见"挂载方式"一节）。
- **可读性下限压过滑块**：上游测过 0.45/0.59 是文字对比度的硬底线，用户把玻璃调到全透明会让标题读不出来——这里沿用上游决定。
- **Application 壁纸永不执行**：上游的明确排除项，照搬。

## 归属与许可

- 上游：[elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)（MIT）。本 PoC 的发现链、inventory 规则、玻璃配方与可读性下限均移植自该仓库。
- 渲染引擎：[oneincase/webwallgl](https://github.com/oneincase/webwallgl) **1.4.2**，经 npm 包引入（MIT，许可证与来源记在 `media/webwallgl/LICENSE` / `UPSTREAM.json`）。同一作者的 [WallpaperEM](https://github.com/oneincase/WallpaperEM)（MIT）提供了"引擎其实是这个 npm 包"的线索。
- 本仓库代码同样以 MIT 发布（见 `LICENSE`）。
- **未决许可证**：Scene 实时渲染所依赖的 WebWallGL（`oneincase/webwallgl`）上游**未随仓库附带 LICENSE**，接入前必须先核实（见评估报告风险节）。
