# Developer Guide

[Chinese documentation](DEVELOPMENT.zh-CN.md)

This guide describes the technical architecture, directory responsibilities, development workflow, and troubleshooting steps for Same Screen Player.

## Overview

Same Screen Player is an Electron desktop application. React and Vite render the application UI and binary pane layout, while every leaf node hosts a page in an Electron `<webview>`. The main process owns windows, Sessions, proxy settings, navigation, fingerprinting, ad blocking, and IPC. The guest preload handles in-page video detection and controls.

## Technology stack

| Component | Purpose |
| --- | --- |
| Electron 44 | Desktop runtime |
| React 19 | Application UI |
| Vite 8 | Front-end build tool and development server |
| TypeScript 5.7 | Type-safe application code |
| Vitest 3 | Unit testing |
| `@ghostery/adblocker-electron` | Electron ad blocking |
| `ws` | Chrome DevTools Protocol connections |

The application window enables `contextIsolation`, `sandbox`, and disabled Node integration. Web panes use a separate guest preload. Guest preload files must be bundled because sandboxed preload code cannot directly depend on Node modules.

## Directory map

| Path | Responsibility |
| --- | --- |
| `electron/main.ts` | Main-process entry: windows, IPC, webviews, Sessions, proxies, ad blocking, navigation, controlled local-video selection, and fullscreen. |
| `electron/preload.ts` | Secure `contextBridge` API for the host window. |
| `electron/guest-preload.ts` | Guest script for player detection, commands, state reporting, focus mode, and Cloudflare challenge detection. |
| `electron/fingerprint.ts` | Chrome-style User-Agent, Client Hints, and page fingerprint injection for Electron Sessions. |
| `electron/cloudflare.ts` | Cloudflare request detection, navigation-loop state, and resource allow rules. |
| `electron/cdp.ts` | Chrome DevTools Protocol manager used only for Google sign-in. |
| `electron/fingerprint-preload.ts` | Fingerprint preload for the Chrome login window. |
| `electron/windows-helper.ts`, `electron/windows-window-helper.ps1` | Windows helper process and window styling. |
| `src/App.tsx` | React app, layout surface, pane controls, proxy settings, and font-size UI. |
| `src/index.css` | Styles for the title bar, toolbar, panes, controls, and popovers. |
| `src/shared/types.ts` | Layout tree, runtime state, proxy types, validation, and pure layout helpers. |
| `src/shared/interaction.ts` | Web/App interaction and fullscreen escape transitions. |
| `src/shared/*.test.ts`, `electron/*.test.ts` | Unit tests for shared logic, fingerprinting, Cloudflare, CDP, and proxies. |
| `scripts/bundle-preloads.js` | Bundles sandbox preload files into `dist-electron` with esbuild. |
| `chrome-extension/` | Page styles and helper extension assets used by focus mode. |
| `docs/` | Project documentation. |
| `dist/`, `dist-electron/`, `release/` | Generated artifacts; do not edit manually. |

## Runtime flows

### Application startup

- `app.whenReady()` registers IPC, loads `proxy-settings.json`, and falls back to the system proxy when the file is missing or invalid.
- The main process applies the proxy to `persist:shared` before creating the window, then installs fingerprinting, diagnostics, and ad blocking.
- After webview `dom-ready`, `pane:register` registers the pane, Session partition, and effective proxy policy before loading its URL.
- The main-process picker returns encoded `file:` URLs; only supported regular files authorized during the current run may load in a webview.

### Proxy precedence

Global proxy settings use `system`, `direct`, or `custom` modes. Pane settings use `inherit`, `direct`, or `custom`. Any pane mode other than `inherit` overrides the global setting. Inherited panes reapply the proxy, close old connections, and reload when the global setting changes.

Electron proxies are Session-scoped. A shared Session cannot carry different proxies at once, so selecting a pane override marks `proxyAutoIsolated` and switches the pane to `persist:<paneId>`. Returning to `inherit` restores `persist:shared` only for panes that were switched automatically; a manually selected isolated Session stays isolated.

### Interaction modes

- Web mode sends mouse and keyboard input to the webview so links, inputs, and native players remain usable.
- App mode routes pointer handling to the layout layer for app controls, pane dragging, and the context menu.

### Embedded iframe video

The main process injects a media-only bridge into child frames through `WebFrameMain` and the existing CDP document-start hook without enabling Node integration. HTML5 video state is forwarded through validated `postMessage` events, while play, pause, seek, volume, mute, and speed commands are routed back to the active frame. Nested frames forward the same bridge messages to the top-level guest preload, and stale frame state expires automatically.

### Local video

Local video uses the system picker for one `MP4`, `M4V`, `WebM`, `MOV`, or `OGV` file. Both App and Web modes can replace the current pane. Local sources reuse player controls while hiding network-only features such as proxy, session, ad blocking, sign-in, and Chrome fallback. Deleted, inaccessible, or unsupported media reports an error only in its own pane.

In App mode, the local pane keeps its filename label and exposes a network URL field, so switching back to a webpage does not require creating another pane.

### Cloudflare and Chrome boundary

Cloudflare detection, Turnstile resource allow rules, loop detection, and Electron fingerprint injection live in `cloudflare.ts`, `main.ts`, `guest-preload.ts`, and `fingerprint.ts`. Chrome DevTools Protocol code serves Google sign-in only. The general **Open in Chrome** fallback handles restricted playback pages and does not import Cloudflare Cookies.

The fingerprint profile is generated from the current runtime's platform version, architecture, bitness, language, time zone, and embedded Chromium version; Session headers and page JavaScript share it. The page layer aligns navigator/Client Hints, plugins, Canvas export, WebGL, live and offline audio, font metrics, and time zone; native display and window dimensions stay intact to avoid a new inconsistency from fixed resolutions. Native system-font checks remain intact so page font loading continues to work. It reduces obvious Electron-versus-Chrome differences but does not guarantee bypassing site risk controls.

## Data and persistence

- `layout.json`: stores only the versioned layout tree, not page URLs.
- Local video paths exist only in runtime memory and are never written to `layout.json` or other persistent settings.
- `proxy-settings.json`: stores the global proxy mode, host, port, bypass rules, and local-address option.
- `localStorage`: stores the application font-size selection.
- `persist:shared`: shared login Cookies by default; `persist:<paneId>`: Cookies and cache for isolated Sessions.

These files live under Electron's `app.getPath("userData")` directory. Cloudflare and focus diagnostic logs are written there as well.

## Development workflow

Install dependencies:

```bash
npm install
```

Start the development environment:

```bash
npm run dev
```

Build, test, and package:

```bash
npm run build
npm test
npm run dist
```

`npm run build` runs TypeScript checking, preload bundling, and the Vite build. Fully restart Electron after changing main-process or preload code; HMR is intended for React and CSS changes.

## Testing notes

- `npm test` runs Vitest unit tests for layout swapping, proxy conversion and validation, interaction state, fingerprinting, Cloudflare, and CDP helpers.
- `npm run test:frame-controls` builds the preloads and runs an isolated Electron webview test with locally generated video. It checks play, pause, and toggle commands in cross-origin frames, nested frames, and direct video pages, including the actual media clock and host playback state.
- When changing the layout tree, add pure-function tests to `src/shared/layout.test.ts` first.
- When changing proxy behavior, update `src/shared/proxy.test.ts` and avoid depending on a live proxy server in tests.
- After changing a guest preload, run `npm run build` and verify that a new bundle is generated in `dist-electron`.

## Troubleshooting

- Page clicks do nothing: switch to Web mode; App mode intentionally blocks webview pointer events.
- A page still uses an old proxy connection: ensure `closeAllConnections()` runs in the main process, then restart the app to verify the Session is recreated.
- Cloudflare loops: inspect `cloudflare-diagnostics.log`, verify challenge resources are not blocked; automatic refresh stops, and the normal Reload control can reload the pane if needed.
- Pane-top diagnostic notices in Web mode: shown automatically in development and hidden by default in production. Launch with the exact `--debug-overlays` argument to show them temporarily.
- Fingerprint issues: inspect the fingerprint diagnostics; do not import real Chrome Cookies or profiles into an Electron Session.
- Main-process changes are not visible: run `npm run build`, fully exit old Electron processes, and start `npm run dev` again.

## Contribution guidelines

Keep layout-file compatibility unless a format upgrade is intentional. Update `electron/preload.ts` and `src/vite-env.d.ts` together when adding IPC. Changes involving the main process, Sessions, or security boundaries should include tests and documentation. Do not commit `node_modules/`, build artifacts, installers, or local diagnostic logs.
