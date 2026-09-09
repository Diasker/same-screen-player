# Same Screen Player

[Chinese documentation](README.zh-CN.md)

Same Screen Player is an Electron-based multi-pane web video workspace. It places several web pages in one window so you can watch YouTube, bilibili, and other web video sites side by side.

Playback uses embedded Electron `<webview>` elements. The real Chrome browser is used only for Google sign-in and a general fallback for DRM, embedding restrictions, or site risk controls; it is not the normal playback backend.

## Features

- Supports single, 2-pane, 3-pane, 4-pane (2×2), and 6-pane (3×2) layouts with adjustable dividers.
- App mode provides play, pause, seek, volume, mute, speed, reload, split, session, and ad-block controls; Web mode keeps the site's native controls.
- The seek bar supports live scrubbing while holding the mouse button; playback speed includes presets and custom values from `0.25x` to `4x`.
- In App mode, drag a pane to exchange grid positions and right-click a pane to close it; at least one pane is always kept.
- Each pane has Back/Forward history controls; in Web mode, `Alt + ←/→` navigates the active pane.
- The top font-size control supports `80%`, `90%`, `100%`, `110%`, `125%`, and `140%`; the choice persists without changing website fonts.
- Proxy modes include system proxy, direct connection, and custom HTTP. A global proxy can be overridden per pane, and pane settings take priority.
- Custom HTTP proxy settings support host, port, bypass rules, and local-address bypass; SOCKS and proxy authentication are not supported.
- Panes share a login session by default. Selecting a pane-specific proxy automatically switches that pane to an isolated Session and warns about Cookie isolation.
- Cloudflare challenge resources remain available inside Electron panes, while browser fingerprint emulation helps most sites complete verification; automatic refresh stops when a loop is detected.
- Use the system file picker to play one local MP4, M4V, WebM, MOV, or OGV video with the existing play, seek, volume, and speed controls.

## Usage

### Start and open pages

Enter an `http://` or `https://` address in an empty pane and click **Play**, or use **Open local video** to select a file. To replace a playing pane, switch to App mode and choose **Local video** from its controls.

Local video selection accepts MP4, M4V, WebM, MOV, and OGV containers; actual codec support depends on Electron's embedded Chromium. File paths are never saved in the layout, so local videos do not reopen after restart.

### Interaction modes

- **Web mode** sends mouse and keyboard input to the page for links, text fields, and native players.
- **App mode** lets the application control the active pane. Move the pointer to the bottom to show controls; press `F8` or use the top button to switch.
- `F11` toggles application fullscreen; `Esc` exits webpage fullscreen, App mode, and application fullscreen in that order.

### Pane management

- In App mode, hold the left mouse button on a pane's empty or page area to exchange it with another pane. Buttons, inputs, and menus do not start a drag.
- In App mode, right-click a pane and choose **Close current pane**. The action is disabled when only one pane remains.
- The session button in each pane switches between shared and isolated Sessions. A pane proxy override automatically uses an isolated Session.

### Proxy settings

- Open **Proxy** at the top for global settings: **System proxy** follows Windows proxy/PAC, **Direct** bypasses proxies, and **Custom HTTP** uses the configured host and port.
- Separate bypass addresses with English semicolons; enabling local-address bypass adds the `<local>` rule.
- **Follow global** tracks global changes in real time; **Pane direct** and **Pane custom HTTP** override the global setting.
- Global proxy settings are stored in the application data directory. Pane overrides last for the current run and reset to Follow global after restart.

### Sign-in and restricted pages

- YouTube and bilibili sign-in entries open an application login window using the current pane session; Google sign-in uses a separate Chrome window.
- For DRM, embedding restrictions, or pages returning 401/403/412/451, choose **Open in Chrome** from the App controls.
- Cloudflare challenges are handled in the current Electron pane; Chrome verification and Cookie import controls are not provided.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Production build, test, and package commands:

```bash
npm run build
npm test
npm run dist
```

`npm run dev` starts Vite and Electron. After changing the main process or guest preload, run `npm run build` and fully restart the development process; a page refresh or HMR alone does not reload those scripts.

Development mode shows pane debug notices in Web mode. Production builds hide them by default; add `--debug-overlays` when launching the app to inspect them.

For architecture, the directory map, and troubleshooting notes, see the [Developer Guide](docs/DEVELOPMENT.md). See the [Chinese Developer Guide](docs/DEVELOPMENT.zh-CN.md) for Chinese documentation.
