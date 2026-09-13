# Ad blocking sources and licenses

This directory is copied into packaged applications. `snapshot.json.gz` is gzip-compressed JSON containing the original subscription text, source URLs, script resources, generation time, version and SHA-256 checksum. List headers and their attribution are preserved. No Acceptable Ads subscription is included.

## Code

- Ghostery adblocker, adblocker-content and adblocker-extended-selectors 2.18.2: Copyright Ghostery GmbH and contributors; Mozilla Public License 2.0. Source: https://github.com/ghostery/adblocker . License: `MPL-2.0.txt`.
- adblockpluscore 0.11.1: Copyright eyeo GmbH and contributors; GNU GPL version 3 only. Source: https://gitlab.com/eyeo/adblockplus/abc/adblockpluscore . Exact source is also published in https://registry.npmjs.org/adblockpluscore/-/adblockpluscore-0.11.1.tgz . License: `GPL-3.0.txt`. The application imports the unmodified parser and matcher, not the browser extension.
- tldts-experimental: https://github.com/remusao/tldts ; MIT license. The npm dependency retains its original license.

The AdBlock integration architecture and its use of native POPUP matching were studied at https://gitlab.com/adblockinc/ext/adblock/adblock and https://github.com/adblockplus/adblockpluschrome/blob/master/lib/popupBlocker.js . No AdBlock branding, extension UI or telemetry is copied.

When distributing this combined application with the GPL-3.0-only filtering core, accompany the build with the corresponding application and dependency source, build instructions and GPL-3.0 terms. Package license files alone are not a substitute for corresponding source.

## Filter data and scriptlets

- EasyList, EasyPrivacy and EasyList China: https://easylist.to/ and https://easylist.to/pages/licence.html . Lists are distributed under the licenses stated in their original headers (GPLv3 or later / CC BY-SA 4.0).
- uBlock Origin uAssets lists and scriptlets, as packaged by Ghostery: https://github.com/uBlockOrigin/uAssets and https://github.com/gorhill/uBlock . Preserve the upstream GPLv3 notices and contributor attribution; https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE .
- Peter Lowe's list: https://pgl.yoyo.org/adservers/ . Source attribution and publisher terms: https://pgl.yoyo.org/adservers/policy.php . The original list is retained inside the snapshot.

The complete manifest of downloaded URLs is the `lists` and `resources` fields of the snapshot. `npm run adblock:update-snapshot` refreshes this artifact deliberately; normal builds use the checked-in snapshot and do not download rules.
