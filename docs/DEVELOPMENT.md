# 开发者文档 / Developer Guide

本文档说明同屏播放的技术结构、目录职责、开发流程和常见排查方式。

This guide describes the technical architecture, directory responsibilities, development workflow, and troubleshooting steps for Same Screen Player.

## 项目概览 / Overview

同屏播放是一个 Electron 桌面应用。React/Vite 负责应用界面和二叉分屏布局；每个叶节点使用一个 Electron `<webview>` 承载网页。主进程负责窗口、Session、代理、导航、指纹、广告拦截和 IPC，访客预加载脚本负责网页内的视频识别与控制。

Same Screen Player is an Electron desktop application. React and Vite render the application UI and binary pane layout, while every leaf node hosts a page in an Electron `<webview>`. The main process owns windows, Sessions, proxy settings, navigation, fingerprinting, ad blocking, and IPC. The guest preload handles in-page video detection and controls.

## 技术栈 / Technology stack

| 中文 | English |
| --- | --- |
| Electron 44 | Electron 44 |
| React 19 | React 19 |
| Vite 8 | Vite 8 |
| TypeScript 5.7 | TypeScript 5.7 |
| Vitest 3 | Vitest 3 |
| `@ghostery/adblocker-electron` | `@ghostery/adblocker-electron` |
| `ws`（Google Chrome DevTools Protocol 连接） | `ws` for Chrome DevTools Protocol connections |

应用窗口启用 `contextIsolation`、`sandbox` 和关闭 Node 集成。网页分屏使用独立的访客预加载脚本；访客脚本需要单独打包，不能在 sandbox 预加载环境中直接依赖 Node 模块。

The application window enables `contextIsolation`, `sandbox`, and disabled Node integration. Web panes use a separate guest preload. Guest preload files must be bundled because sandboxed preload code cannot directly depend on Node modules.

## 目录结构 / Directory map

| 路径 / Path | 作用 / Responsibility |
| --- | --- |
| `electron/main.ts` | 主进程入口：创建窗口、注册 IPC、管理 webview、Session、代理、广告拦截、导航和全屏。 / Main-process entry: windows, IPC, webviews, Sessions, proxies, ad blocking, navigation, and fullscreen. |
| `electron/preload.ts` | 宿主窗口的安全 `contextBridge` API。 / Secure `contextBridge` API for the host window. |
| `electron/guest-preload.ts` | webview 访客脚本：播放器识别、播放命令、状态上报、专注模式和 Cloudflare 挑战检测。 / Guest script for player detection, commands, state reporting, focus mode, and Cloudflare challenge detection. |
| `electron/fingerprint.ts` | Electron Session 的 Chrome 风格 User-Agent、Client Hints 和页面指纹注入。 / Chrome-style User-Agent, Client Hints, and page fingerprint injection for Electron Sessions. |
| `electron/cloudflare.ts` | Cloudflare 挑战请求识别、导航循环状态和资源放行规则。 / Cloudflare request detection, navigation-loop state, and resource allow rules. |
| `electron/cdp.ts` | 仅用于 Google 登录的 Chrome DevTools Protocol 管理器。 / Chrome DevTools Protocol manager used only for Google sign-in. |
| `electron/fingerprint-preload.ts` | Chrome 登录窗口的指纹预加载。 / Fingerprint preload for the Chrome login window. |
| `electron/windows-helper.ts`、`electron/windows-window-helper.ps1` | Windows 辅助窗口样式和进程处理。 / Windows helper process and window styling. |
| `src/App.tsx` | React 应用、分屏布局表面、分屏控制栏、代理和字号界面。 / React app, layout surface, pane controls, proxy settings, and font-size UI. |
| `src/index.css` | 应用标题栏、工具栏、分屏、控制栏和弹窗样式。 / Styles for the title bar, toolbar, panes, controls, and popovers. |
| `src/shared/types.ts` | 布局树、运行时状态、代理类型、配置校验和纯布局辅助函数。 / Layout tree, runtime state, proxy types, validation, and pure layout helpers. |
| `src/shared/interaction.ts` | 网页操作/应用操作和全屏退出状态转换。 / Web/App interaction and fullscreen escape transitions. |
| `src/shared/*.test.ts`、`electron/*.test.ts` | 共享逻辑、指纹、Cloudflare、CDP 和代理单元测试。 / Unit tests for shared logic, fingerprinting, Cloudflare, CDP, and proxies. |
| `scripts/bundle-preloads.js` | 使用 esbuild 将 sandbox 预加载脚本打包到 `dist-electron`。 / Bundles sandbox preload files into `dist-electron` with esbuild. |
| `chrome-extension/` | 专注模式所需的页面样式和辅助扩展资源。 / Page styles and helper extension assets used by focus mode. |
| `docs/` | 项目文档。 / Project documentation. |
| `dist/`、`dist-electron/`、`release/` | 构建产物，不应手动编辑。 / Generated artifacts; do not edit manually. |

## 关键运行流程 / Runtime flows

### 应用启动 / Application startup

- `app.whenReady()` 注册 IPC，读取 `proxy-settings.json`，损坏或缺失时回退到系统代理。
- `app.whenReady()` registers IPC, loads `proxy-settings.json`, and falls back to the system proxy when the file is missing or invalid.
- 主进程先对 `persist:shared` 调用 `session.setProxy()`，再创建窗口并安装指纹、诊断和广告拦截。
- The main process applies the proxy to `persist:shared` before creating the window, then installs fingerprinting, diagnostics, and ad blocking.
- webview `dom-ready` 后通过 `pane:register` 注册 pane、Session 分区和当前代理策略，成功后才加载网址。
- After webview `dom-ready`, `pane:register` registers the pane, Session partition, and effective proxy policy before loading its URL.

### 代理优先级 / Proxy precedence

全局代理有 `system`、`direct`、`custom` 三种模式；分屏有 `inherit`、`direct`、`custom` 三种模式。分屏只要不是 `inherit`，就覆盖全局配置。`inherit` 分屏在全局修改后会重新应用代理、关闭旧连接并刷新页面。

Global proxy settings use `system`, `direct`, or `custom` modes. Pane settings use `inherit`, `direct`, or `custom`. Any pane mode other than `inherit` overrides the global setting. Inherited panes reapply the proxy, close old connections, and reload when the global setting changes.

Electron 代理属于 Session 级别。共享 Session 无法同时承载不同的代理，因此共享分屏选择独立代理时，渲染层标记 `proxyAutoIsolated` 并切换到 `persist:<paneId>`；改回 `inherit` 时，仅自动切换过的分屏恢复到 `persist:shared`。用户手动选择的独立 Session 不会被自动恢复。

Electron proxies are Session-scoped. A shared Session cannot carry different proxies at once, so selecting a pane override marks `proxyAutoIsolated` and switches the pane to `persist:<paneId>`. Returning to `inherit` restores `persist:shared` only for panes that were switched automatically; a manually selected isolated Session stays isolated.

### 交互模式 / Interaction modes

- 网页操作模式让 webview 接收鼠标和键盘，网站的链接、输入框和原生播放器保持可用。
- Web mode sends mouse and keyboard input to the webview so links, inputs, and native players remain usable.
- 应用操作模式将 webview 的鼠标事件交给布局层，显示应用播放控制、拖拽交换和右键菜单。
- App mode routes pointer handling to the layout layer for app controls, pane dragging, and the context menu.

### Cloudflare 与 Chrome 边界 / Cloudflare and Chrome boundary

Cloudflare 挑战识别、Turnstile 资源放行、循环检测和 Electron 指纹注入分别位于 `cloudflare.ts`、`main.ts`、`guest-preload.ts` 和 `fingerprint.ts`。Chrome DevTools Protocol 代码只服务于 Google 登录；通用“用 Chrome 打开”只处理播放受限页面，不参与 Cloudflare Cookie 导入。

Cloudflare detection, Turnstile resource allow rules, loop detection, and Electron fingerprint injection live in `cloudflare.ts`, `main.ts`, `guest-preload.ts`, and `fingerprint.ts`. Chrome DevTools Protocol code serves Google sign-in only. The general “Open in Chrome” fallback handles restricted playback pages and does not import Cloudflare Cookies.

## 数据与持久化 / Data and persistence

- `layout.json`：只保存布局树和版本号，不保存网页地址。
- `layout.json`: stores only the versioned layout tree, not page URLs.
- `proxy-settings.json`：保存全局代理模式、地址、端口、例外地址和本地地址选项。
- `proxy-settings.json`: stores the global proxy mode, host, port, bypass rules, and local-address option.
- `localStorage`：保存应用字号选择。
- `localStorage`: stores the application font-size selection.
- `persist:shared`：默认共享登录 Cookie；`persist:<paneId>`：独立 Session 的 Cookie 和缓存。
- `persist:shared`: shared login Cookies by default; `persist:<paneId>`: Cookies and cache for isolated Sessions.

这些文件位于 Electron 的 `app.getPath("userData")` 目录。Cloudflare 和焦点诊断日志也写入该目录。

These files live under Electron's `app.getPath("userData")` directory. Cloudflare and focus diagnostic logs are written there as well.

## 开发流程 / Development workflow

安装依赖：

Install dependencies:

```bash
npm install
```

启动开发环境：

Start the development environment:

```bash
npm run dev
```

构建、测试和打包：

Build, test, and package:

```bash
npm run build
npm test
npm run dist
```

`npm run build` 会依次运行 TypeScript 检查、预加载脚本打包和 Vite 构建。修改 `electron/` 下的主进程或预加载脚本后必须完整重启 Electron；HMR 只适合 React/CSS 调整。

`npm run build` runs TypeScript checking, preload bundling, and the Vite build. Fully restart Electron after changing main-process or preload code; HMR is intended for React and CSS changes.

## 测试说明 / Testing notes

- `npm test` 运行 Vitest 单元测试，覆盖布局交换、代理转换与校验、交互状态、指纹、Cloudflare 和 CDP 辅助逻辑。
- `npm test` runs Vitest unit tests for layout swapping, proxy conversion and validation, interaction state, fingerprinting, Cloudflare, and CDP helpers.
- 修改布局树时，优先在 `src/shared/layout.test.ts` 添加纯函数测试。
- When changing the layout tree, add pure-function tests to `src/shared/layout.test.ts` first.
- 修改代理协议时，同时更新 `src/shared/proxy.test.ts`，不要在测试中依赖真实代理服务器。
- When changing proxy behavior, update `src/shared/proxy.test.ts` and avoid depending on a live proxy server in tests.
- 修改访客脚本后运行 `npm run build`，确认 `dist-electron` 中生成新的 bundle。
- After changing a guest preload, run `npm run build` and verify that a new bundle is generated in `dist-electron`.

## 故障排查 / Troubleshooting

- 网页点击无反应：确认当前处于“网页操作”模式；应用操作模式会屏蔽 webview 的鼠标事件。
- Page clicks do nothing: switch to Web mode; App mode intentionally blocks webview pointer events.
- 代理修改后页面仍使用旧连接：确认主进程已调用 `closeAllConnections()`，然后重新启动应用检查 Session 是否重建。
- A page still uses an old proxy connection: ensure `closeAllConnections()` runs in the main process, then restart the app to verify the Session is recreated.
- Cloudflare 挑战循环：查看 `cloudflare-diagnostics.log`，确认挑战资源没有被广告拦截器阻断，并使用分屏里的“重新加载验证页”。
- Cloudflare loops: inspect `cloudflare-diagnostics.log`, verify challenge resources are not blocked, and use “重新加载验证页 / Reload challenge” in the pane.
- 指纹问题：使用应用诊断入口检查 `fingerprint` 日志；不要把真实 Chrome 的 Cookie 或 Profile 导入 Electron Session。
- Fingerprint issues: inspect the fingerprint diagnostics; do not import real Chrome Cookies or profiles into an Electron Session.
- 修改主进程后没有变化：重新执行 `npm run build`，完全退出旧 Electron 进程，再运行 `npm run dev`。
- Main-process changes are not visible: run `npm run build`, fully exit old Electron processes, and start `npm run dev` again.

## 贡献约定 / Contribution guidelines

保持布局文件版本兼容，除非明确需要升级格式；新增 IPC 时同时更新 `electron/preload.ts` 和 `src/vite-env.d.ts`；涉及主进程、Session 或安全边界的改动应补充测试和文档。不要提交 `node_modules/`、构建产物、安装包或本地诊断日志。

Keep layout-file compatibility unless a format upgrade is intentional. Update `electron/preload.ts` and `src/vite-env.d.ts` together when adding IPC. Changes involving the main process, Sessions, or security boundaries should include tests and documentation. Do not commit `node_modules/`, build artifacts, installers, or local diagnostic logs.
