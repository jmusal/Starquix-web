<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/logo-dark.svg">
    <img src=".github/readme/logo-light.svg" alt="Starquix" width="220">
  </picture>
</p>

<p align="center">Free visual editor for Astro websites. Mac app.</p>

<p align="center">
  <a href="https://github.com/Mayhopar/Starquix-releases/releases/latest"><img src=".github/readme/btn-download.svg" alt="Download for Mac" height="36"></a>
  <a href="https://github.com/Mayhopar/Starquix-releases/releases"><img src=".github/readme/btn-releases.svg" alt="Releases" height="36"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src=".github/readme/badge-license.svg" alt="MIT license" height="22"></a>
  <img src=".github/readme/badge-platform.svg" alt="macOS, Apple Silicon" height="22">
  <a href="https://astro.build"><img src=".github/readme/badge-stack.svg" alt="Astro" height="22"></a>
  <a href="https://discord.gg/Fpuwzbd48V"><img src=".github/readme/badge-discord.svg" alt="Discord" height="22"></a>
</p>

<p align="center">
  <img src=".github/readme/starquix-hero.jpg" alt="Starquix with a heading selected and the Design panel open" width="900">
</p>

Starquix opens your Astro project folder and shows the real site on a canvas. Select an element and change it in the Design panel; the change is written to your files. The project stays a plain Astro and Tailwind folder on your computer.

## Build with agents

Run Claude Code, Codex or another CLI agent in the built-in terminal, or chat in the app with your own API key (Anthropic, OpenAI, OpenRouter or a local Ollama). Agents edit the open project through the built-in MCP server, and their changes show on the canvas.

<img src=".github/readme/agents.gif" alt="Claude Code in the built-in terminal adds a section to the page" width="800">

## Edit by hand

Change text, images, colors and layout on the canvas or in the Design panel.

<img src=".github/readme/edit-by-hand.gif" alt="Editing a heading on the canvas; the code editor shows the changed line in red and green" width="800">

## Publish or export

Publish to Cloudflare or GitHub Pages, to Netlify or Vercel through your GitHub repo, or export the project folder.

<img src=".github/readme/deploy.gif" alt="Publishing the site to Cloudflare" width="800">

## Also included

<table>
  <tr>
    <td width="50%"><img src=".github/readme/cms.jpg" alt="Post editor"><br><b>CMS.</b> Write blog posts and publish them as pages.</td>
    <td width="50%"><img src=".github/readme/seo.jpg" alt="SEO panel"><br><b>SEO.</b> Titles, descriptions and a score for every page.</td>
  </tr>
  <tr>
    <td><img src=".github/readme/vars.jpg" alt="Variables table"><br><b>Variables.</b> Change a color once and it updates everywhere.</td>
    <td><img src=".github/readme/local.jpg" alt="The project folder in Finder"><br><b>Local files.</b> Your site is plain Astro files in a folder on your computer.</td>
  </tr>
</table>

## Run in the browser

Starquix also runs as a local web app: a Node server replaces the desktop app, and the editor opens in any browser. It needs Node.js 22+ and works on macOS and Linux.

```bash
npm ci
npm ci --prefix preview-template
npm run web:build
npm run web          # open the printed link (it ends with ?token=…)
```

How it works, options, security and limits: [docs/web.md](docs/web.md).

## Development

```bash
git clone https://github.com/Mayhopar/starquix.git
cd starquix
npm ci
npm ci --prefix preview-template
npm ci --prefix desktop
npm --prefix app run dev -- --host 127.0.0.1 --port 3061 --strictPort   # the editor the desktop app loads
```

Then, in a second terminal:

```bash
cd desktop && npm run deps && npm start      # desktop app
```

Requires Node.js 22+ and npm 10. The desktop app runs on macOS.

Tests: `cd app && npm run test:run`, `cd desktop && npm test` and `cd web && npm test`.

| Folder | Contents |
|---|---|
| `app/` | Editor (Vite + React) |
| `desktop/` | Electron app: runs each project's Astro dev server |
| `web/` | Web server: the desktop app's main process for a browser tab ([docs/web.md](docs/web.md)) |
| `preview-template/` | Vite plugin and canvas bridge copied into each project |
| `mcp/` | MCP server for coding agents |
| `scripts/` | Bridge and snapshot builds |
| `fixtures/` | Sample Astro project for tests |
| `docs/` | Architecture, data flows, how-tos |

The bridge source is `app/src/bridge/parts/`. After changing it or `preview-template/`, run `npm run build:snapshot`.

Bug fixes need a regression test. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

Projects and API keys are stored on your computer. The app goes online to:

- count anonymous page views with [Plausible](https://plausible.io) (no cookies; `app/src/main.tsx`);
- check GitHub for a newer release (`desktop/src/update-check.mjs`);
- load Google Fonts when you pick a font;
- reach the AI provider and publishing services you connect, with your own keys and accounts.

Third-party code and assets: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. Third-party components keep their own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). The Starquix name and logo were created by Oleg Maykhopar and are not covered by the license; using them requires his permission.
