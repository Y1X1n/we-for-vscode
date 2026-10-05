# Wallpaper Engine for VS Code

把**本机 Wallpaper Engine 的壁纸**渲染进 VS Code：既有一个液态玻璃风格的壁纸视图（面板），也能把壁纸**铺满整个窗口**——VS Code 的界面浮在壁纸之上。

> English: [README.en.md](README.en.md)

![壁纸铺满整个 VS Code](docs/screenshot-workbench.jpg)

![面板内的壁纸库：搜索 + 缩略图，选择过程不离开面板](docs/screenshot-library.jpg)

---

## 目录

- [能做什么](#能做什么)
- [安装](#安装)
- [使用](#使用)
- [设置](#设置)
- [工作原理](#工作原理)
- [已知限制](#已知限制)
- [排错](#排错)
- [开发](#开发)
- [许可与致谢](#许可与致谢)

## 能做什么

- **壁纸库自动发现**
  - Wallpaper Engine 安装目录：注册表 `HKCU\Software\Valve\Steam` → 常见目录 → WSL `/mnt/*`；
  - 创意工坊内容（appid `431960`）与 `projects/defaultprojects`、`projects/myprojects`。

- **四种渲染方式**，按壁纸工程 `project.json` 的 `type` 与主文件自动分流：

  | 类型 | 渲染 | 说明 |
  |---|---|---|
  | Video | `<video>` 播放 | mp4 / webm 等媒体文件 |
  | Scene | **实时渲染**（WebGL） | `scene.pkg` 打包形态，或散装 `scene.json` 源码形态 |
  | Web | **实时渲染**（网页） | 入口是 HTML 的网页壁纸 |
  | 其它（含 Application、入口非 HTML 的 Web、主文件不是 pkg/json 的 Scene） | 预览图降级 | Application 类型永不执行 |

- **两个渲染面，同一份选择**
  1. **壁纸视图（面板）**：一个 webview，壁纸铺满它，上面是液态玻璃控制面板；
  2. **整窗背景层（实验）**：壁纸铺满整个 VS Code 窗口，编辑器/侧栏/状态栏浮在上面。

- **面板内选壁纸**：`选择壁纸…` 就在面板里展开壁纸库——搜索框 + 缩略图列表，点一行即换，列表不关闭，可以直接一张张试。不需要命令面板，也不占用窗口顶部。

- **液态玻璃参数**：玻璃模糊、饱和度、玻璃底色与不透明度、面板宽度、边框、暗化层、壁纸不透明度。

- **透明标题栏**：一条开关把 `window.titleBarStyle` / `window.controlsStyle` / 标题栏颜色一起切到可透明的配方（关闭时精确还原你的原值）。

- 多窗口、窗口失焦/遮挡暂停、幻灯片轮播（`autoRotateSeconds`，只轮播 Video）。

## 安装

**要求**：Windows；本机已安装 Wallpaper Engine；VS Code ≥ 1.90。

### 用 Release 里的 vsix

```powershell
# 先完全关闭 VS Code（整窗背景层是文件级补丁，运行中安装会留给 webview 一个
# "Could not register service worker" 报错）
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
  --install-extension .\we-for-vscode-0.1.1.vsix --force
```

装好后启动 VS Code：扩展会自动激活，壁纸视图用 `Ctrl+Alt+W` 打开。

### 从源码构建

```powershell
git clone https://github.com/Y1X1n/we-for-vscode.git
cd we-for-vscode
npm install
npm run verify                        # tsc + node --test
npx vsce package --no-dependencies    # 产出 we-for-vscode-0.1.1.vsix
```

### 打开“铺满整个窗口”

默认是关的（它要改 VS Code 安装目录里的 `workbench.html`，见[工作原理](#工作原理)）：

1. 打开壁纸视图（`Ctrl+Alt+W`），选一张壁纸；
2. 命令面板运行 **Wallpaper Engine: 启用壁纸背景（铺满 VS Code，实验/需改安装目录）**，或在设置里打开 `weWallpaper.workbenchBackground`；
3. 按提示**重载窗口**（其它已打开的窗口各按一次 `Ctrl+R`；新开的窗口自动生效）。

想还原：运行 **禁用壁纸背景（还原安装目录）**——安装目录会被还原成原样。

## 使用

| 命令 | 说明 |
|---|---|
| `Wallpaper Engine: 打开壁纸视图`（`Ctrl+Alt+W`） | 打开面板 |
| `Wallpaper Engine: 选择壁纸…` | 打开面板并展开壁纸库（选择全程在面板内完成） |
| `Wallpaper Engine: 下一张壁纸` | 顺延到下一张可播放壁纸 |
| `Wallpaper Engine: 重新扫描壁纸库` | 强制重扫（含 Steam 目录缓存） |
| `Wallpaper Engine: 启用/禁用壁纸背景` | 整窗背景层的开关（改/还原安装目录） |
| `Wallpaper Engine: 诊断：壁纸背景状态` | 补丁状态、校验和一致性、媒体端口归属、已加载补丁的窗口数 |

面板里的三个按钮：`暂停 / 播放`、`选择壁纸…`（展开/收起壁纸库）、`下一张`。状态栏右侧常驻当前壁纸名；资源更新后会变成 **壁纸资源待重载**，点它即可重载窗口。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `weWallpaper.wallpaperId` | `""` | 当前壁纸 id；留空 = 自动选第一张可播放的。面板里选壁纸会写回这里 |
| `weWallpaper.steamRoot` | `""` | 手动指定 Steam 根目录，多个用 `;` 分隔 |
| `weWallpaper.mediaPort` | `39127` | 本地媒体服务端口（仅 `127.0.0.1`）。端口与 token 必须稳定 |
| `weWallpaper.blur` | `16` | 玻璃面板模糊半径 px（0–60） |
| `weWallpaper.saturate` | `1.3` | 玻璃背景饱和度 |
| `weWallpaper.glassAlpha` | `0.45` | 玻璃底色不透明度（会被可读性下限抬升） |
| `weWallpaper.glassColor` | `#101014` | 玻璃底色 |
| `weWallpaper.panelWidth` | `420` | 面板宽度 px |
| `weWallpaper.border` | `1` | 玻璃边框宽度 px |
| `weWallpaper.scrim` | `0.35` | 壁纸之上的暗化层强度 |
| `weWallpaper.wallpaperOpacity` | `1` | 壁纸图层不透明度 |
| `weWallpaper.pauseWhenHidden` | `true` | 面板不可见或窗口失焦时暂停 |
| `weWallpaper.autoRotateSeconds` | `0` | 幻灯片间隔秒数（0 = 关闭，只轮播 Video） |
| `weWallpaper.workbenchBackground` | `false` | **实验**：壁纸铺满整个 VS Code（改安装目录，可还原） |
| `weWallpaper.workbenchOpacity` | `1` | 整窗层壁纸不透明度 |
| `weWallpaper.workbenchScrim` | `0.35` | 整窗层暗化强度 |
| `weWallpaper.workbenchLiveScene` | `false` | **实验**：让 **Scene / Web 壁纸在整窗层也实时渲染**（关 = 只显示预览图）。整窗层按"背景层"定位降配：`renderDpr` 1（每 CSS 像素一个画布像素，像素约 0.44×）、24 fps、粒子 `medium`；面板始终全质量 |
| `weWallpaper.liveSurface` | `workbench` | **同一张 Scene/Web 壁纸由哪一面实时渲染**：`workbench`（默认：整窗层实时，面板**透明透出**它，不再自己渲染）/ `panel`（反过来）/ `both`（旧行为，同一张壁纸渲染两遍） |
| `weWallpaper.transparentTitleBar` | `false` | 透明标题栏与右上角三个按钮 |
| `weWallpaper.logLevel` | `warn` | 输出通道 "Wallpaper Engine" 的日志级别（排错时开 `info`） |

## 工作原理

### 面板（官方 API 能做的部分）

面板是一个普通 webview，扩展对它拥有完全控制权：壁纸铺满整个 webview，玻璃面板浮在上面。

- 引擎（`webwallgl`，见下）**同源 import**，面板直接持有 `SceneInstance`，可以 `pause/resume`、`canvas.toDataURL()` 抓帧；
- Scene 与 Web **走同一条链路**：`httpSource(项目目录 token)`，由引擎读 `project.json` 按 `type` 分流；
- 媒体服务只监听 `127.0.0.1`，用**不可猜的 token** 指路：
  - `/m/<token>` 单个文件（视频、预览图）；
  - `/wallpaper-engine/scene-files/<token>/<相对路径>` 整个项目目录（Scene 的相对贴图/材质、Web 的 css/js 都按相对路径取）。

### 整窗背景层（方案 B）

VS Code 没有“把窗口背景交给扩展”的 API，所以这一层是**文件级补丁**：往安装目录的 `workbench.html` 注入一小段静态块，再放几个同目录的 side 文件。

关键取舍：**`workbench.html` 是受校验和保护的**（`product.json` 里有它的 SHA-256，改坏了会弹“安装似乎已损坏。请重新安装。”）。因此：

- 注入块**永不变化**，只引用不带版本号的 `we-workbench-boot.js`（加载器）；
- 加载器启动时读 `we-workbench-assets.json` 里的内容哈希，再按 `<file>?v=<hash>` 拉当前版本的 css / 核心脚本 —— **扩展更新不再改写 HTML**；
- 补丁时同步 `product.json` 的校验和条目（用磁盘上实际的字节算），所以不会弹完整性提示；
- 注入与还原都是**逐字节可逆**的（`stripPatch(injectPatch(x)) === x`，有测试钉死；`禁用壁纸背景` 会还原安装目录）。

整窗层的 Scene / Web 实时渲染有各自的坑，实测结论都写在代码注释里：

- **Scene**：引擎经 **blob URL** 导入（workbench CSP 允许 `script-src blob:`，但不允许回环源作为脚本源）；容器在挂载前用 `visibility:hidden` 参与布局——否则引擎量到 CSS 尺寸 0×0，画布永远不可见。
- **Web**：网页壁纸的作者页面必须待在 sandbox iframe 里，而 workbench CSP 的 `frame-src` 既没有 `blob:` 也没有回环源。解法是**同源中转页** `we-workbench-web.html` + `.js`（`frame-src 'self'` 允许同目录文件）：它把引擎当文本取过来、从 blob URL 导入，再由引擎去装作者页面；作者 iframe 会被重新沙箱化（opaque origin），作者代码碰不到 VS Code 的 DOM。两条路都不需要放宽 `workbench.html` 的 CSP。

### 引擎

实时渲染由 **`webwallgl@2.1.0`（MIT）** 完成，随扩展发布在 [`media/webwallgl/`](media/webwallgl/)（附 `LICENSE` 与 `UPSTREAM.json`），由 webview 同源 import、由整窗层经 blob URL 导入。

更细的踩坑记录（CSP 逐指令匹配、`makeOpaque()` 与原生窗口按钮、Trusted Types、多窗口端口接管……）在 [`docs/ENGINEERING-NOTES.zh.md`](docs/ENGINEERING-NOTES.zh.md)。

### 性能

实时渲染跑在**窗口渲染进程的主线程**上——和编辑器 UI 同一条线程——所以这里的花费不只是电，也直接关系到打字是否跟手。实测方法：按 Electron 进程角色（`renderer` / `gpu-process` / `extensionHost`）归因 CPU，并交替 A/B/A/B 采样（本机噪声带 ±5~8% 单核，只做 A→B 会得到错误结论）。

| 配置（面板关闭，150% 缩放，轻量 Scene） | CPU（单核 = 100%） |
|---|---|
| 整窗层显示静图（预览 GIF） | 27.5 / 27.9 |
| 整窗层实时渲染同一张 | 31.4 / 32.2 → **单个实时实例 ≈ +4%** |
| 重场景（32 层 4K）× 第二个实例 | 40.0 → 44.4 → 再一次 **+4.4%** |
| 两面都实时 · 窗口最小化 | **3.0**（可见时 42.4）→ 不后台空烧 |

结论落到两个默认行为上：

- **整窗层按"背景"降配**：`renderDpr` 1 —— 画布从设备像素比（本机 1839×1239）降到每 CSS 像素一个（1226×826），像素约 0.44×，150% 缩放下剩下的 1.5× 放大隔着 UI 看不出；再叠加 24 fps、粒子 `medium`。面板保持全质量。
  （先试过 `0.5`：画布 613×413、像素少 9×，截图明显发糊，对带文字/UI 的 Web 壁纸风险太大，故取 1。）
- **同一张壁纸默认只渲染一遍**（`weWallpaper.liveSurface = workbench`）：两个引擎实例省掉一个，也就省掉一半主线程压力。而面板本身是透明的，会**透出整窗层的实时壁纸**——观感没变差，只是少了一份渲染。切到 `panel` 或 `both` 随时可以，只是要自己承担那份开销。

## 已知限制

- **PoC 定位**：接口、设置名、内部结构都可能变。
- **Application 类型壁纸永不渲染**（上游口径）。
- 入口不是 HTML 的 Web 壁纸、主文件既不是 `scene.pkg` 也不是 `scene.json` 的 Scene，**降级为预览图**而不是硬撑。
- 装好补丁后**每个已打开的窗口要各自重载一次**才会加载补丁；新开的窗口自动生效。
- 多窗口时**只有绑定媒体端口的那个窗口**在应答 `/current`；其它窗口会在它退出后接管端口。
- `window.controlsStyle` 只在创建窗口时读取，改透明标题栏需要**完全重开 VS Code**（`Ctrl+R` 不够）。
- 整窗层是“全屏动画表面”，可能诱发合成问题（代码行残留一类）；遇到就关掉 `workbenchLiveScene`，或关掉 sticky scroll。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 状态栏提示 **壁纸资源待重载** | 刚更新过扩展：点它重载窗口（其它窗口各 `Ctrl+R`） |
| 一次性提示 **“安装似乎已损坏。请重新安装。”** | `workbench.html` 在本次会话里被改写过（例如 VS Code 更新后自动重新注入）。**完全退出 VS Code 再打开**即可消除；`禁用壁纸背景` 也能把安装目录还原成原样 |
| 更新扩展后 webview 报 **Could not register service worker** | 运行中安装导致的 webview 报错，完全关闭并重新打开 VS Code |
| 选中 Scene / Web 壁纸但整窗层只有一张模糊图 | `weWallpaper.workbenchLiveScene` 是关的（默认关），打开它 |
| 面板里看不到画面、日志也没动静 | 把 `weWallpaper.logLevel` 调成 `info`，输出通道 "Wallpaper Engine" 里能看到挂载过程与引擎诊断 |
| 顶部标题栏/右上角三个按钮仍然不透明 | 顶栏由 Windows 绘制时 CSS 碰不到；开 `weWallpaper.transparentTitleBar`（会把 `titleBarStyle`/`controlsStyle` 切成 `custom`，需要完全重开 VS Code） |

## 开发

```powershell
npm install
npm run verify     # tsc -p . + node --test（当前 105 条）
```

测试重点覆盖那些“只有真跑起来才会发现”的契约：`workbench.html` 的注入/剥离逐字节可逆、校验和编码与真实 `product.json` 表一致、扩展更新不再改 HTML、CSP 只放开必要指令、webview 里每个 `id` 都存在、面板与主机的消息契约、整窗层 Scene/Web 的挂载前置条件。

`tools/` 里有两个**同款 CSP 复刻环境**（真实 workbench CSP + `require-trusted-types-for 'script'`），用无头 Edge/Chrome 把整窗层的挂载路径真跑一遍并回报生命周期：

```powershell
npm run compile
node tools/check-workbench-scene.mjs 1   # 场景：blob 导入 + 挂载 + 抓帧
node tools/check-workbench-web.mjs 0     # 网页：同源中转页 + 引擎 + 作者页出帧
```

两者都需要本机有 Wallpaper Engine 壁纸库。打包：

```powershell
npx vsce package --no-dependencies
```

## 许可与致谢

本项目 **MIT**（见 [LICENSE](LICENSE)）。

- **`elysia395/dsh-wallpaper-engine`（MIT）**：本扩展是它到 VS Code 的移植，库发现、玻璃参数口径与不少实测结论都源自上游。
- **`oneincase/webwallgl@2.1.0`（MIT）**：Scene / Web 实时渲染引擎，随扩展发布（`media/webwallgl/`）。
- **`vscode-background`、`GlassIt-VSC`、`vscode-custom-ui-style`**：整窗背景层与“把界面变透明”的 CSS 手法参考了它们。

Wallpaper Engine 与各壁纸的版权归其作者所有；本扩展只读取你本机的壁纸文件，不上传任何内容。
