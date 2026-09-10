# 开发者文档

[英文文档](DEVELOPMENT.md)

本文档说明同屏播放的技术结构、目录职责、开发流程和常见排查方式。

## 项目概览

同屏播放是一个 Electron 桌面应用。React/Vite 负责应用界面和二叉分屏布局；每个叶节点使用一个 Electron `<webview>` 承载网页。主进程负责窗口、Session、代理、导航、指纹、广告拦截和 IPC，访客预加载脚本负责网页内的视频识别与控制。

## 技术栈

| 组件 | 用途 |
| --- | --- |
| Electron 44 | 桌面运行时 |
| React 19 | 应用界面 |
| Vite 8 | 前端构建工具和开发服务器 |
| TypeScript 5.7 | 类型安全的应用代码 |
| Vitest 3 | 单元测试 |
| `@ghostery/adblocker-electron` | Electron 广告拦截 |
| `ws` | Chrome DevTools Protocol 连接 |

应用窗口启用 `contextIsolation`、`sandbox` 和关闭 Node 集成。网页分屏使用独立的访客预加载脚本；访客脚本需要单独打包，不能在 sandbox 预加载环境中直接依赖 Node 模块。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `electron/main.ts` | 主进程入口：创建窗口、注册 IPC、管理 webview、Session、代理、广告拦截、导航、受控本地视频选择和全屏。 |
| `electron/preload.ts` | 宿主窗口的安全 `contextBridge` API。 |
| `electron/guest-preload.ts` | webview 访客脚本：播放器识别、播放命令、状态上报、专注模式和 Cloudflare 挑战检测。 |
| `electron/fingerprint.ts` | Electron Session 的 Chrome 风格 User-Agent、Client Hints 和页面指纹注入。 |
| `electron/cloudflare.ts` | Cloudflare 挑战请求识别、导航循环状态和资源放行规则。 |
| `electron/cdp.ts` | 仅用于 Google 登录的 Chrome DevTools Protocol 管理器。 |
| `electron/fingerprint-preload.ts` | Chrome 登录窗口的指纹预加载。 |
| `electron/windows-helper.ts`、`electron/windows-window-helper.ps1` | Windows 辅助窗口样式和进程处理。 |
| `src/App.tsx` | React 应用、分屏布局表面、分屏控制栏、代理和字号界面。 |
| `src/index.css` | 应用标题栏、工具栏、分屏、控制栏和弹窗样式。 |
| `src/shared/types.ts` | 布局树、运行时状态、代理类型、配置校验和纯布局辅助函数。 |
| `src/shared/interaction.ts` | 网页操作/应用操作和全屏退出状态转换。 |
| `src/shared/*.test.ts`、`electron/*.test.ts` | 共享逻辑、指纹、Cloudflare、CDP 和代理单元测试。 |
| `scripts/bundle-preloads.js` | 使用 esbuild 将 sandbox 预加载脚本打包到 `dist-electron`。 |
| `chrome-extension/` | 专注模式所需的页面样式和辅助扩展资源。 |
| `docs/` | 项目文档。 |
| `dist/`、`dist-electron/`、`release/` | 构建产物，不应手动编辑。 |

## 关键运行流程

### 应用启动

- `app.whenReady()` 注册 IPC，读取 `proxy-settings.json`，损坏或缺失时回退到系统代理。
- 主进程先对 `persist:shared` 调用 `session.setProxy()`，再创建窗口并安装指纹、诊断和广告拦截。
- webview `dom-ready` 后通过 `pane:register` 注册 pane、Session 分区和当前代理策略，成功后才加载网址。
- 本地视频由主进程文件选择器返回编码后的 `file:` 地址；仅本次运行中由选择器授权且仍是受支持普通文件的地址可被加载到 webview。

### 代理优先级

全局代理有 `system`、`direct`、`custom` 三种模式；分屏有 `inherit`、`direct`、`custom` 三种模式。分屏只要不是 `inherit`，就覆盖全局配置。`inherit` 分屏在全局修改后会重新应用代理、关闭旧连接并刷新页面。

Electron 代理属于 Session 级别。共享 Session 无法同时承载不同的代理，因此共享分屏选择独立代理时，渲染层标记 `proxyAutoIsolated` 并切换到 `persist:<paneId>`；改回 `inherit` 时，仅自动切换过的分屏恢复到 `persist:shared`。用户手动选择的独立 Session 不会被自动恢复。

### 交互模式

- 网页操作模式让 webview 接收鼠标和键盘，网站的链接、输入框和原生播放器保持可用。
- 应用操作模式将 webview 的鼠标事件交给布局层，显示应用播放控制、拖拽交换和右键菜单。

### iframe 内嵌视频

主进程通过 `WebFrameMain` 和现有 CDP 文档启动钩子向子 frame 注入仅用于媒体控制的桥接脚本，无需开启 Node 集成。HTML5 视频状态通过经过来源校验的 `postMessage` 事件上报，播放、暂停、进度、音量、静音和倍速命令则发送回当前活动 frame。嵌套 frame 会把同类桥接消息继续转发给顶层访客预加载脚本，过期的 frame 状态会自动失效。

### 本地视频

本地视频使用系统选择器选择单个 `MP4`、`M4V`、`WebM`、`MOV` 或 `OGV` 文件。应用控制和网页操作模式均可替换当前分屏；本地来源复用播放器控制，但隐藏代理、会话、广告拦截、登录和 Chrome 兜底等网络专用功能。文件被删除、没有访问权限或 Chromium 无法解码时，仅当前分屏显示错误。

应用操作模式下，本地分屏会保留文件名并显示网页地址输入框，因此无需新建分屏即可切回网页播放。

### Cloudflare 与 Chrome 边界

Cloudflare 挑战识别、Turnstile 资源放行、循环检测和 Electron 指纹注入分别位于 `cloudflare.ts`、`main.ts`、`guest-preload.ts` 和 `fingerprint.ts`。Chrome DevTools Protocol 代码只服务于 Google 登录；通用“用 Chrome 打开”只处理播放受限页面，不参与 Cloudflare Cookie 导入。

指纹 profile 基于当前运行时的系统版本、架构、位数、语言、时区和内置 Chromium 版本动态生成；Session 请求头和页面 JavaScript 使用同一 profile。页面层同步处理 `navigator`/Client Hints、插件、Canvas 导出、WebGL、普通与离线音频、字体测量和时区；屏幕与窗口尺寸保留真实设备数据，避免固定分辨率造成新的不一致。真实系统字体检测保持原样，以免影响网页字体加载。它用于降低 Electron 与 Chrome 的明显差异，不能保证绕过所有站点的风险控制。

## 数据与持久化

- `layout.json`：只保存布局树和版本号，不保存网页地址。
- 本地视频路径只保存在运行内存中，不会写入 `layout.json` 或其他持久化设置。
- `proxy-settings.json`：保存全局代理模式、地址、端口、例外地址和本地地址选项。
- `localStorage`：保存应用字号选择。
- `persist:shared`：默认共享登录 Cookie；`persist:<paneId>`：独立 Session 的 Cookie 和缓存。

这些文件位于 Electron 的 `app.getPath("userData")` 目录。Cloudflare 和焦点诊断日志也写入该目录。

## 开发流程

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

构建、测试和打包：

```bash
npm run build
npm test
npm run dist
```

`npm run build` 会依次运行 TypeScript 检查、预加载脚本打包和 Vite 构建。修改 `electron/` 下的主进程或预加载脚本后必须完整重启 Electron；HMR 只适合 React/CSS 调整。

## 测试说明

- `npm test` 运行 Vitest 单元测试，覆盖布局交换、代理转换与校验、交互状态、指纹、Cloudflare 和 CDP 辅助逻辑。
- `npm run test:frame-controls` 构建预加载脚本，并使用本地生成的视频在独立 Electron 网页视图中测试跨域框架、多层嵌套框架和直接视频页面的播放、暂停及切换命令，同时检查视频实际时间与应用收到的播放状态。
- 修改布局树时，优先在 `src/shared/layout.test.ts` 添加纯函数测试。
- 修改代理协议时，同时更新 `src/shared/proxy.test.ts`，不要在测试中依赖真实代理服务器。
- 修改访客脚本后运行 `npm run build`，确认 `dist-electron` 中生成新的 bundle。

## 故障排查

- 网页点击无反应：确认当前处于“网页操作”模式；应用操作模式会屏蔽 webview 的鼠标事件。
- 代理修改后页面仍使用旧连接：确认主进程已调用 `closeAllConnections()`，然后重新启动应用检查 Session 是否重建。
- Cloudflare 挑战循环：查看 `cloudflare-diagnostics.log`，确认挑战资源没有被广告拦截器阻断；应用会停止自动刷新，必要时可使用普通“刷新”重新加载分屏。
- 网页操作模式的分屏顶部诊断提示：开发模式自动显示；发布版默认隐藏。启动应用时附加精确参数 `--debug-overlays` 可临时显示。
- 指纹问题：使用应用诊断入口检查 `fingerprint` 日志；不要把真实 Chrome 的 Cookie 或 Profile 导入 Electron Session。
- 修改主进程后没有变化：重新执行 `npm run build`，完全退出旧 Electron 进程，再运行 `npm run dev`。

## 贡献约定

保持布局文件版本兼容，除非明确需要升级格式；新增 IPC 时同时更新 `electron/preload.ts` 和 `src/vite-env.d.ts`；涉及主进程、Session 或安全边界的改动应补充测试和文档。不要提交 `node_modules/`、构建产物、安装包或本地诊断日志。
