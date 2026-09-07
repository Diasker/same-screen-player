# 同屏播放 / Same Screen Player

同屏播放是一款基于 Electron 的多分屏网页视频工作台。它把多个网页放在同一个窗口中并排播放，适合同时查看 YouTube、bilibili 以及其他支持网页播放的视频站点。

Same Screen Player is an Electron-based multi-pane web video workspace. It places several web pages in one window so you can watch YouTube, bilibili, and other web video sites side by side.

播放内容使用 Electron 内嵌 `<webview>` 渲染。真实 Chrome 只用于 Google 登录和受 DRM、禁止内嵌或站点风控影响的通用兜底场景，不参与普通分屏播放。

Playback uses embedded Electron `<webview>` elements. The real Chrome browser is used only for Google sign-in and a general fallback for DRM, embedding restrictions, or site risk controls; it is not the normal playback backend.

## 功能 / Features

- 支持单屏、2 格、3 格、4 格（2×2）和 6 格（3×2）布局，分隔线可调整比例。
- Supports single, 2-pane, 3-pane, 4-pane (2×2), and 6-pane (3×2) layouts with adjustable dividers.
- 应用操作模式提供播放、暂停、进度、音量、静音、倍速、刷新、分屏、会话和广告拦截控制；网页操作模式保留网站原生控件。
- App mode provides play, pause, seek, volume, mute, speed, reload, split, session, and ad-block controls; Web mode keeps the site's native controls.
- 进度条支持按住鼠标实时拖动预览；倍速支持固定选项和 `0.25x`–`4x` 自定义值。
- The seek bar supports live scrubbing while holding the mouse button; playback speed includes presets and custom values from `0.25x` to `4x`.
- 应用操作模式下可拖动分屏交换网格位置，右键分屏可以关闭当前分屏，至少保留一个分屏。
- In App mode, drag a pane to exchange grid positions and right-click a pane to close it; at least one pane is always kept.
- 每个分屏有独立的后退/前进历史控制；网页操作模式下，`Alt + ←/→` 控制当前分屏历史。
- Each pane has Back/Forward history controls; in Web mode, `Alt + ←/→` navigates the active pane.
- 顶部字号支持 `80%`、`90%`、`100%`、`110%`、`125%`、`140%`，设置会持久化且不改变网页内部字体。
- The top font-size control supports `80%`, `90%`, `100%`, `110%`, `125%`, and `140%`; the choice persists without changing website fonts.
- 代理支持系统代理、直连和自定义 HTTP；可设置全局代理，也可为分屏覆盖代理。分屏覆盖优先于全局配置。
- Proxy modes include system proxy, direct connection, and custom HTTP. A global proxy can be overridden per pane, and pane settings take priority.
- 自定义代理支持地址、端口、例外地址和本地地址绕过；不支持 SOCKS、用户名或密码认证。
- Custom HTTP proxy settings support host, port, bypass rules, and local-address bypass; SOCKS and proxy authentication are not supported.
- 默认使用共享登录会话；分屏使用独立代理时会自动切换独立 Session，并提示 Cookie 隔离。
- Panes share a login session by default. Selecting a pane-specific proxy automatically switches that pane to an isolated Session and warns about Cookie isolation.
- Cloudflare 挑战资源在 Electron 分屏中保留并放行，指纹伪装帮助多数站点直接完成验证；挑战循环时可以手动重新加载验证页。
- Cloudflare challenge resources remain available inside Electron panes, while browser fingerprint emulation helps most sites complete verification; looping challenges can be manually reloaded.
- 可通过系统文件选择器播放单个本地 MP4、M4V、WebM、MOV 或 OGV 视频，并使用现有播放、进度、音量和倍速控制。
- Use the system file picker to play one local MP4, M4V, WebM, MOV, or OGV video with the existing play, seek, volume, and speed controls.

## 操作方式 / Usage

### 启动与打开页面 / Start and open pages

- 中文：在空白分屏输入 `http://` 或 `https://` 地址并点击“播放”，或点击“打开本地视频”选择一个本机文件。播放时可从应用控制栏选择“本地视频”替换内容；网页操作模式下，每格右上角也有同名快捷按钮。
- English: Enter an `http://` or `https://` address in an empty pane and click “播放 / Play”, or use “打开本地视频 / Open local video” to select a file. Replace a playing pane from App controls or the top-right shortcut in Web mode.

本地视频仅支持 MP4、M4V、WebM、MOV 和 OGV 容器；具体编码取决于 Electron 内置 Chromium。文件路径不会保存到布局，重启后不会自动重新打开本地视频。

Local video selection accepts MP4, M4V, WebM, MOV, and OGV containers; actual codec support depends on Electron's embedded Chromium. File paths are never saved in the layout, so local videos do not reopen after restart.

### 两种操作模式 / Interaction modes

- “网页操作”把鼠标和键盘交给网页，适合点击链接、输入文字和使用网站原生播放器。
- “网页操作 / Web mode” sends mouse and keyboard input to the page for links, text fields, and native players.
- “应用操作”由应用接管活动分屏，鼠标移到分屏底部显示应用控制栏；按 `F8` 或顶部按钮切换。
- “应用操作 / App mode” lets the application control the active pane. Move the pointer to the bottom to show controls; press `F8` or use the top button to switch.
- `F11` 切换应用全屏；`Esc` 按网页全屏、应用操作层、应用全屏的顺序退出。
- `F11` toggles application fullscreen; `Esc` exits webpage fullscreen, App mode, and application fullscreen in that order.

### 分屏管理 / Pane management

- 在应用操作模式下，从分屏空白区域或网页区域按住左键拖动，可以交换两个分屏的位置。控制按钮、输入框和菜单不会触发拖动。
- In App mode, hold the left mouse button on a pane's empty or page area to exchange it with another pane. Buttons, inputs, and menus do not start a drag.
- 在应用操作模式下右键分屏，选择“关闭当前分屏”；单屏时关闭按钮会禁用。
- In App mode, right-click a pane and choose “关闭当前分屏 / Close current pane”. The action is disabled when only one pane remains.
- 每格控制栏的会话按钮可在共享 Session 和独立 Session 之间切换。代理覆盖会自动使用独立 Session。
- The session button in each pane switches between shared and isolated Sessions. A pane proxy override automatically uses an isolated Session.

### 代理设置 / Proxy settings

- 顶部“代理”打开全局设置：`系统代理` 使用 Windows 系统代理/PAC，`直连` 完全不使用代理，`自定义 HTTP` 使用地址和端口。
- Open “代理 / Proxy” at the top for global settings: `System proxy` follows Windows proxy/PAC, `Direct` bypasses proxies, and `Custom HTTP` uses the configured host and port.
- 自定义代理的例外地址使用英文分号分隔；勾选本地地址选项后会追加 `<local>` 规则。
- Separate bypass addresses with English semicolons; enabling local-address bypass adds the `<local>` rule.
- 分屏选择“跟随全局代理”时实时继承全局设置；选择“分屏直连”或“分屏自定义 HTTP”时覆盖全局设置。
- “跟随全局代理 / Follow global” tracks global changes in real time; “Pane direct” and “Pane custom HTTP” override the global setting.
- 全局代理配置保存到应用数据目录；分屏覆盖只在当前运行期间有效，重启后恢复为跟随全局。
- Global proxy settings are stored in the application data directory. Pane overrides last for the current run and reset to Follow global after restart.

### 登录与受限页面 / Sign-in and restricted pages

- YouTube 和 bilibili 的登录入口会在应用登录窗口打开并复用当前分屏会话；Google 登录使用独立 Chrome 窗口。
- YouTube and bilibili sign-in entries open an application login window using the current pane session; Google sign-in uses a separate Chrome window.
- 对 DRM、禁止内嵌或返回 401/403/412/451 的页面，可在应用控制栏选择“用 Chrome 打开”。
- For DRM, embedding restrictions, or pages returning 401/403/412/451, choose “用 Chrome 打开 / Open in Chrome” from the App controls.
- Cloudflare 挑战优先在当前 Electron 分屏内完成；应用不再提供 Chrome 验证或 Cookie 导入入口。
- Cloudflare challenges are handled in the current Electron pane; Chrome verification and Cookie import controls are not provided.

## 开发 / Development

环境要求：Node.js 20 或更高版本、npm。

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

生产构建、测试和安装包命令：

Production build, test, and package commands:

```bash
npm run build
npm test
npm run dist
```

`npm run dev` 会启动 Vite 和 Electron。改动主进程或访客预加载脚本后，请重新运行 `npm run build` 并彻底重启开发进程；仅刷新页面或依赖 HMR 不会重新加载这些脚本。

`npm run dev` starts Vite and Electron. After changing the main process or guest preload, run `npm run build` and fully restart the development process; a page refresh or HMR alone does not reload those scripts.

更多技术结构、目录说明和故障排查请参阅 [开发者文档 / Developer Guide](docs/DEVELOPMENT.md)。

See [开发者文档 / Developer Guide](docs/DEVELOPMENT.md) for the architecture, directory map, and troubleshooting notes.
