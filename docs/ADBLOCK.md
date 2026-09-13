# 广告拦截维护与验收

广告拦截由 `adblock-service.ts` 统一连接 Electron 的网络、导航和 frame 生命周期。Ghostery 2.18.2 负责网络、CSP、页面隐藏和脚本过滤，AdBlock 所使用的 adblockpluscore 0.11.1 负责原生 `$popup` 与例外规则。依赖固定版本，升级时须一起更新快照版本并重跑集成测试。后者附带的归档工具通过 npm override 固定为已修复的 tar 7.5.22；应用运行时不调用归档工具。

## 用户行为

- 点击正常链接时允许导航；`target=_blank` 的普通页面在当前分屏打开，保留浏览历史、来源和表单 POST 数据。已知登录提供者的用户操作走受控登录流程。
- 点击播放附带的广告或用途不确定的窗口／跳转被阻止，提示域名与原因。按钮“本次放行”只能消费一次，仅授权对应分屏和目标文档，不放行后续广告重定向或资源。
- 不因为跨站直接判定广告。真实点击上下文只短时有效；无关联的普通站内导航、SPA 路由及表单继续正常工作。空白弹窗暂存于隐藏窗口，延迟目标接受相同检查，不显示广告窗口；最多两个、30 秒清理。
- “拦截／放行”按分屏和站点生效。切换后刷新当前分屏，清除已安装的 CSS 和脚本行为。同一个 Session 中其他分屏不受影响。
- 登录和 Cloudflare 不是广告屏蔽绕过器。Cloudflare 放行只适用于现有明确验证资源判定，不能保证站点风控通过。

## 注入与隔离

专用 Session frame preload 在 sandbox 中运行，初始过滤只读取本地内存，不等待网络。使用 `nodeIntegrationInSubFrames` 使 preload 进入子 frame，同时维持 `sandbox: true`、`contextIsolation: true` 和 `nodeIntegration: false`。页面主世界没有 `require` 或 `process`；这在跨域、嵌套 frame 集成测试中实际断言。普通访客播放器脚本通过 `process.isMainFrame` 仅在顶层聚合状态。

每个 frame 独立请求域名规则、插入用户级 CSS、执行 scriptlet 和扩展选择器。DOMMonitor 合并类名／ID／链接变化，扩展选择器更新节流到 100 毫秒；复用节点不再满足规则时移除隐藏标记。销毁页面时停止观察。主进程依据真实 IPC 发送者 frame 查询 URL 和所属分屏，不信任网页提供的分屏 ID 或放行标记。

## 规则、更新及诊断

规则先按 Electron 的真实能力处理条件分支，再交给网络及弹窗两个匹配器。使用 Ghostery 的条件表达式求值器，声明 Chromium、非 Firefox、非 MV3、不支持响应正文过滤；每份列表独立处理，未闭合的分支会使更新失败并保留旧规则。避免在互斥分支或不同订阅里重复出现的规则被错误排除。

Ghostery 2.18.2 的资源模板会调用 `decodeURIComponent`，但默认参数替换直接插入原始文本。本项目的适配层先编码参数再交给模板解码，保留字面 `%`、`%2F`、正则、反引号及模板字符串。每条脚本使用独立函数作用域，防止后续注入重新声明共享辅助函数、破坏已经安装的请求代理。资源及规则整体编译时验证 Bilibili／YouTube 所需脚本存在并通过语法检查；运行异常记录为域名、脚本内容哈希及异常类型，不记录脚本参数、响应内容或完整页面 URL。

播放兼容例外独立于订阅：仅当顶层站点和请求来源均为 HTTPS Bilibili，目标为 `https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi` 的精确路径，且类型为 XHR／fetch 时放行。图片、脚本、其他路径、外站嵌入 Bilibili 均不能借用该例外；`cm.bilibili.com/cm/api/`、`/x/ad/` 仍按规则过滤。允许该验证接口意味着允许播放所需的风控数据交换，不是整站追踪白名单。Bilibili 有时会在最初返回 412 的文档内完成验证并加载视频；宿主仅在同一页面已出现解码并开始播放的视频后清除该 412 提示。

播放器的静音意图保存在 preload，实际状态用于更新控制栏；React 状态上报不再触发静音命令。跨 frame 静音命令带播放器身份和递增序号，等待确认并忽略过期反馈；每个新播放器初始化一次。快速切换按待确认意图计算，播放失败仅在 `NotAllowedError` 时尝试一次静音重试。

内置 `electron/adblock-assets/snapshot.json.gz` 包含 17 个广告／追踪订阅（含 EasyList China）和 uBlock scriptlet/redirect 资源，不订阅 Acceptable Ads。启动先读取经过校验的内置快照；同版本、同来源且更新的缓存可替代它。旧的 `adblock-engine.bin` 不再读取。

新缓存为 userData 下的 `adblock-rules-v1.json.gz`。启动时检查是否超过 24 小时，此后每 24 小时检查一次。下载走共享 Session 的应用全局代理，每项请求 15 秒超时；所有下载、校验、编译和临时文件写入成功后才整体替换缓存和引擎。更新失败保留旧引擎并显示状态。已经打开的页面在下一次刷新时完整使用新的页面规则。

控制栏显示规则来源、更新时间和失败状态。`adblock-diagnostics.log` 只记录域名、分屏、请求／导航类型和静态命中规则，限制每分钟 200 条、文件约 1 MiB，不记录完整访问 URL、Cookie、请求头和表单数据。

维护内置快照：`npm run adblock:update-snapshot`。在需要 Windows 系统代理的开发环境使用 `npm run adblock:update-snapshot -- --windows-proxy`。更新命令验证 HTTP 状态，保留原始清单标头。许可和源码来源随应用发布在 `adblock-assets/NOTICE.md`。

## 自动验收

- `npm test`：网络类型、弹窗来源与例外、导航意图、首次离线启动、损坏缓存、完整更新和更新失败。
- `npm run test:adblock`：真实 Electron webview、本地 HTTP fixture、实际服务器请求记录。覆盖首段脚本前的 scriptlet、普通及扩展 CSS、动态和嵌套 frame 广告、媒体广告、播放时弹窗／同页跳转／延迟空白弹窗、原生 `$popup`、一次性放行、正常跨站及新标签链接、搜索表单、重定向、CSP、共享 Session 独立开关及页面 Node 隔离。
- `npm run test:frame-controls`：现有直接及跨 frame 播放、暂停、切换和媒体时钟回归。
- `npm run build` 与 `npx tsc -p tsconfig.json --noEmit`：主进程、preload、前端构建与类型检查。
- `npm run test:video-sites -- youtube full --extended`：可选的真实网络验收，使用临时会话和应用全局代理，检查正文视频、暂停／继续、进度、静音及站内下一视频；失败返回非零状态。`bilibili full --warm --extended` 从首页选择实际存在的视频，`off`／`network`／`no-scripts` 用于分层对照。测试不读取用户 Cookie，不将完整请求 URL 写入报告。
- `npm run test:playback-ui`：启动实际 React 宿主与 Electron 主进程，使用临时配置和本地 HTTPS 协议 fixture，验证 Bilibili 412 文档在验证后开始播放时清除错误提示，以及应用控制栏操作、原播放器状态同步不形成命令回环。

新增自动回归覆盖条件分支、脚本参数编码与隔离、不兼容脚本资源更新回退、精确验证例外的实际 HTTPS 请求及顶层归属，以及直接／跨域／嵌套播放器的静音稳定性、过期反馈、快速连续切换、播放器替换及非权限播放错误。

## 真实网站验收记录

2026-09-13：Electron 44.2.0，Ghostery 2.18.2／ABP 0.11.1，规则快照 `2026-09-13T03:18:58.858Z`，应用系统代理、临时未登录会话，完整广告过滤开启。

- YouTube：`Me at the zoo` 正文视频持续播放，暂停／继续、跳转进度、静音／取消静音均通过；真实点击下一视频链接后 URL 改变而文档 timeOrigin 不变，新视频继续播放，播放器 API 返回 200。广告请求仍被过滤，未记录脚本注入异常。个别备选 CDN 请求出现 403，播放器重试后仍通过播放检查。
- Bilibili：从首页选择公开教学视频，验证接口返回 200，正文视频持续播放，暂停／继续、跳转进度、静音／取消静音均通过；广告接口继续阻止。首次文档可出现 412，然后由站点验证流程恢复。另一个全新会话直接访问固定视频链接时，开／关拦截均被站点风控拒绝；精确兼容规则不承诺消除服务器对新会话的所有验证。

这些结果是测试视频的实际播放记录，不代表登录、付费、所有地区或所有视频均已覆盖。

`missav.ws` 是用户指定的对照站点。当前未标记实测通过：调研访问停在 Cloudflare 安全验证页，尚未取得实际播放页面，也未取得用户 Chrome 中 AdBlock 的版本和订阅设置。自动测试通过不代表该网站已验收。

后续对照需记录日期、应用／Electron 版本、Chrome／AdBlock 版本及实际订阅，分别检查进入视频、首次播放、暂停后继续、切换视频；记录可见广告、额外窗口、当前页跳转和播放结果。当前规则快照能够为该域名提供页面规则和脚本，但不能据此推断所有广告链已覆盖。
