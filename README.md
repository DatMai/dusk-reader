<p align="center">
  <img src="icons/icon128.png" width="96" alt="Dusk Reader">
</p>

<h1 align="center">Dusk Reader</h1>

<p align="center">Dark mode for every website.</p>

Dusk Reader is a Chrome extension (Manifest V3) that turns any website dark. Instead of simply
inverting the page, it reads every CSS rule and recomputes each color, so images stay untouched
and text stays easy to read.

## Install

1. Download this repository (`git clone` or **Code → Download ZIP** and unzip it)
2. Open `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and select the repository folder
4. Pin the crescent moon icon to the toolbar

Tabs that are already open are picked up automatically, no reload needed.

## Features

- **Dynamic mode**: recolors each color by its role (background, text, border). Handles CSS
  variables, gradients, inline styles, SVG, Shadow DOM, CSS-in-JS (`insertRule`),
  `adoptedStyleSheets`, `@media`, `@layer`, `@keyframes`, nested CSS, and cross-origin stylesheets.
- **Filter mode**: inverts the whole page with a CSS filter and reverts images and videos.
  A fast fallback for pages where Dynamic mode looks off.
- Dark logos and icons on transparent backgrounds are inverted so they don't disappear.
- Skips websites that already have a dark theme.
- Brightness, contrast, sepia and grayscale sliders, plus custom background and text colors.
- Per-site on/off.
- Shortcuts: `Alt+Shift+D` toggles the extension, `Alt+Shift+A` toggles the current site.
  Change them at `chrome://extensions/shortcuts`.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 |
| `content.js` | The recoloring engine, runs at `document_start` in every frame |
| `background.js` | Default settings, shortcuts, cross-origin CSS and image fetching, injecting into open tabs |
| `popup.*` | Settings UI |

## Known limitations

- CSS background images (`background-image: url(...)`) are not analyzed, only `<img>` elements.
- No per-website fix list yet.
- Nested `@import` inside cross-origin stylesheets is skipped.
- No schedule (time of day or sunset) yet.
- Chrome does not allow extensions on `chrome://` pages or the Chrome Web Store.

---

© 2026 [AnhEmSoftware](https://anhemsoftware.com)
