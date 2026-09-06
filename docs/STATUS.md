# 项目现状记录

> 更新日期：2026-09-06

本文件用于记录「同屏播放」当前的架构、功能状态与已知问题，作为后续开发的基线。README 面向使用者；本文件面向开发与维护。

## 1. 项目定位

一个基于 Electron 的沉浸式多视频网页播放器。核心是把多个网页视频放进 `<webview>` 分屏里同屏播放，重点适配 YouTube、bilibili 及其他普通网页视频站（如 jable.tv / missav.ws 等）。

**当前只有一个播放后端：Electron 内嵌 `<webview>`。** 早期规划的「Chrome 播放模式」（每个分屏开一个真实 Chrome `--app` 窗口来播放）已经移除，不再维护。

## 2. 架构概览

- **框架**：Electron 44 + React 19 + Vite 8 + TypeScript 5.7。
- **渲染**：每个分屏是一个 `<webview>`，`contextIsolation=yes, sandbox=yes, nativeWindowOpen=no`。
- **预加载脚本**：
  - 宿主窗口 `electron/preload.ts`（contextBridge 暴露 `window.desktop.*`）。
  - 每个 webview 的访客脚本 `electron/guest-preload.ts`，负责：识别播放器、专注模式样式、播放状态上报、接收并执行播放命令（播放/暂停/seek/音量/倍速）、Cloudflare 挑战检测。
  - 访客预加载脚本必须被打包（esbuild，见 `scripts/bundle-preloads.js`），因为 `sandbox=true` 的预加载脚本不能 `require` 本地模块。
- **主进程 `electron/main.ts`**：窗口/布局生命周期、webview 绑定（键盘快捷键、导航监听、Cloudflare 检测）、广告拦截、指纹伪装、Chrome 兜底（Cloudflare 求解 + Cookie 导入）、诊断日志。
- **指纹伪装 `electron/fingerprint.ts`**：伪装 UA / `sec-ch-ua` Client Hints / 插件 / MIME / `window.chrome` 等，并对所有请求强制使用干净的 Chrome UA。
- **广告拦截**：`@ghostery/adblocker-electron`；对视频资源、同站/子域资源、Cloudflare 验证资源放行。
- **Chrome 兜底 `electron/cdp.ts` + `electron/windows-helper.ts`**：仅用于「Chrome 验证」（开一个专用 Chrome 窗口完成 Cloudflare 验证）与「导入验证」（把通行 Cookie 回填到 Electron 会话），**不再用于分屏播放**。

### 交互模式（两个概念，容易混淆）

- **网页操作 / 应用操作**（顶部按钮或 `F8` 切换）：
  - 网页操作：鼠标/键盘完整交给网站，站点原生控制条可用，App 控制条隐藏。
  - 应用操作：webview 设置为 `pointer-events:none`（不接收鼠标），显示 App 自己的播放/进度/音量/倍速控制条。
- **专注模式 / 网页原始模式**（分屏控制条里的按钮）：
  - 专注模式：把识别到的播放器容器钉满分屏，隐藏播放器链路之外的内容，保留站点原生控制条。
  - 网页原始模式：完全不干预页面，站点原生布局。
  - **默认是「网页原始模式」**（`focusModeEnabled: false`）。

## 3. 当前功能清单

- 布局：单屏、2 格、3 格、4 格（2×2）、6 格（3×2），分隔线可拖动，最多 6 格。
- 每个分屏：输入网址打开、后退/前进、刷新、关闭、左右/上下分屏、共享会话/独立会话切换。
- 应用控制条：播放/暂停、进度条（拖动时实时 seek）、音量、静音、倍速（0.5x/0.75x/1x/1.25x/1.5x/2x，支持自定义 0.25x–4x）。
- 广告拦截：每格可「拦截/放行」切换。
- 登录：YouTube/bilibili 登录弹窗在应用自己的登录窗口打开，复用当前分屏会话。
- 全屏：`F11` 或顶部「全屏」；网页原生全屏由站点接管；`Esc` 优先级为 网页全屏 → 应用层 → 应用全屏。应用全屏时顶部边缘悬停显示「按 Esc 退出全屏」+ 退出按钮。
- Cloudflare：内嵌模式能伪装指纹并直接在分屏内完成验证；验证资源精确放行；检测到循环时停止自动处理，可手动重载。仍可兜底「Chrome 验证」「导入验证」。
- 数据：只保存布局，不保存网址；登录 Cookie 存于应用数据目录；顶部「清除登录」清空会话存储。

## 4. 已知问题

### 4.1 bilibili 主页点击无法跳转（已修复）

- **现象**：在「网页操作」模式下打开 bilibili 主页，**鼠标悬停视频卡片能出现预览界面**（说明鼠标事件确实到达了页面），但**点击任何内容（视频卡片、顶部导航栏、标签）都完全无反应**，无法跳转/播放。
- **对照**：直接输入一个固定的 B 站视频网址，可以正常加载和播放。
- **此前尝试过的修复（当时均未解决）**：
  1. 同源 `new-window`（`target="_blank"`）改为分屏内导航。
  2. 专注模式的尺寸阈值 + bilibili 无播放器容器时 `return null`。
  3. 移除每 2.5s 一次的诊断轮询 `pollFocusDiagnostics`。
  4. 注入指纹后立刻 `debugger.detach()`（不再常驻调试器）。
  5. 检测循环性能优化（YouTube/bilibili 改轻量 `querySelectorAll`、`innerText`→`textContent`、`hasVisibleDialog` 每轮只算一次、检测加 450ms 节流）。
- **修复**：访客脚本默认关闭专注模式，避免把首页悬停预览误当成主播放器；站内新窗口链接按注册域名判断，允许 `bilibili.com` 子域之间正常回到当前分屏导航。

### 4.2 其他已解决的问题（供追溯）

- YouTube 拖动进度条卡死 → 已修复（移除诊断轮询 + 调试器脱挂 + 进度条改为拖动时实时提交）。
- YouTube 专注模式无效 → 已修复（`hasVisibleDialog` 不再把空弹窗容器 `ytd-popup-container` 当对话框）。
- 倍速控制缺失 → 已新增固定倍速和自定义倍速输入。
- 分屏网页历史 → 已新增每格独立的后退/前进按钮，并支持活动分屏 `Alt + ←/→` 快捷键。

## 5. 诊断手段

诊断日志（按需写文件，不会周期轮询）：

- `%APPDATA%\same-screen-player\focus-diagnostics.log`：专注模式识别/应用情况（`found` / `site` / `rootTag` / `dialog` / `fullscreen` / `applied` 等），由访客脚本在每次检测时上报。
- `%APPDATA%\same-screen-player\cloudflare-diagnostics.log`：Cloudflare 挑战导航、资源完成状态、指纹诊断。
- `%APPDATA%\same-screen-player\chrome-profile\`：Chrome 兜底专用 profile（Chrome 验证 / 导入验证用）。

## 6. 开发与验证

```bash
npm run build   # tsc + 打包预加载脚本 + vite 构建
npm run dev     # vite + electron（加载已构建的 dist-electron）
npm test        # vitest 单元测试（当前 16 个用例全过）
```

注意：改动主进程或访客预加载脚本后必须重新 `npm run build`，并且要**彻底重启 `npm run dev`**（Ctrl+C 后重跑），页面刷新 / HMR 不会生效。
