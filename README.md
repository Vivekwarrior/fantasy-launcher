# Fantasy Launcher

A lightweight, fantasy-styled **desktop Minecraft launcher** (Electron). Real Mojang downloads, Modrinth mods, four mod loaders, offline profiles, two themes.

## Features

- **Two themes** — Dark Fantasy and Divine, switchable from the titlebar or Runes page. Four sigil tints on top.
- **Loaders that actually work** — Vanilla, Fabric, Quilt, **Forge and NeoForge**. Fabric/Quilt profiles are merged directly; Forge/NeoForge install headless via their official installers, so hand-dropped `.jar` mods in the `mods/` folder just work.
- **Mod workshop** — search Modrinth, one-click install, enable/disable toggle, delete. Filters follow the version + loader picked on the Play page.
- **Offline profiles** — non-premium heroes using Minecraft's own offline-UUID scheme. Singleplayer and offline-mode servers work; premium-only servers need a Microsoft account (sign-in hook is stubbed in `main.cjs`).
- **The usual toolkit** — every release version, RAM slider (1–16 GB), resolution, custom Java path, launch log, progress tracking.
- **Lightweight** — plain JS renderer, one runtime dependency (`adm-zip`), everything disk-cached.

## Use it (no commands at all)

A ready-to-run Windows build ships next to this folder: **`Fantasy-Launcher-Windows-x64.zip`**

1. Extract the zip anywhere.
2. Open the folder, double-click **`Fantasy Launcher.exe`**.
3. Heroes tab → create an offline profile → pick version/loader → **Play**.

That's it. Portable folder, no installer, no npm, no terminal.

**Only requirement: Java 17+** (Java 21 for Minecraft 1.20.5+) — grab it from [adoptium.net](https://adoptium.net). First launch of a version downloads the game from Mojang (~300–500 MB, cached afterwards).

## Loader profiles

Choose Fabric / Quilt / Forge / NeoForge on the Play page and press Play once — the launcher installs the loader and the result becomes a **permanent entry in the version dropdown** (top group, "Loader profiles", e.g. `Fabric 1.20.1 · 0.16.9`). From then on you just select it and press Play. `.jar` mods dropped into the `mods/` folder manually also appear in the workshop and are toggleable.

## Offline play

The version list works offline: a cached manifest is served first, and if the launcher has never been online it lists the versions already downloaded on disk. Installed loader profiles launch fully offline.

## Performance & shaders

- **Performance mode** (Settings, on by default): tuned Java garbage-collector flags for steadier frame times and fewer RAM spikes.
- **One-click performance pack** (Mods tab): installs the FPS stack + shader support — Fabric/Quilt get Sodium, Lithium, FerriteCore, Entity Culling, ImmediatelyFast, Iris; Forge/NeoForge get Embeddium, FerriteCore, Entity Culling, ImmediatelyFast, Oculus. Shaders run on the optimized renderer, so visuals keep their quality and FPS stays high.

## Extras (0.2)

- **Automatic Java** — an existing compatible Java is always used first; otherwise the launcher downloads its own private JRE (Temurin 8/17/21 by MC version) into its data folder. System Java is never modified.
- **Microsoft sign-in** — full device-code flow (`core/msauth.cjs`, set `CLIENT_ID` to your free Azure app id). Tokens refresh automatically; premium profiles upload skins to the official profile (visible on every server).
- **Skins** — offline profiles get a local skin library with in-launcher face preview; in-game server visibility for offline profiles requires a skin mod (e.g. FabricTailor).
- **Keybind presets** — save the game's current `key_*` binds under a name; apply any preset with one click. Only keybind lines in `options.txt` change, and a `.bak` backup is written first.
- **Shots page** — in-game screenshots (F2) browsable in the launcher.
- **Open game / mods folder** buttons in Settings.
- **Update check** hook — point `UPDATE_FEED_URL` in `main.cjs` at a published release feed.
- Desktop shortcut with the logo: double-click `Create Desktop Shortcut.vbs` in the app folder.

Mod safety system (v1.0): every loader+version gets its **own mods folder** (`game/mods/<loader>-<version>`), so a Fabric jar can never leak into a Forge run. Every jar — including hand-dropped ones — is read for its loader (`fabric.mod.json` / `quilt.mod.json` / `META-INF/mods.toml` / `neoforge.mods.toml`) and its declared Minecraft range, then shown with a ✓/⚠/✕ pill on the Mods page. Pressing Play with a conflicting mod opens a **pre-launch check** modal: disable-and-launch, launch anyway, or cancel — no more crash screens for version mismatches.

## Setup for the author (dr.denji)

Two optional IDs unlock the remaining features — both free, a few minutes each:

1. **Discord Rich Presence** — wired and live (app id set in `core/discord.cjs`). On discord.com/developers → the app → Rich Presence: add an image asset named **`logo`** (use `branding/logo.png` — the square one). Players' Discord then shows "Fantasy Launcher · Playing Minecraft — 1.21.1 · Fabric" with our logo. `branding/logo-mark.png` is the transparent version used for icons/sidebar.
2. **Microsoft (premium) sign-in** — portal.azure.com → App registrations → allow personal accounts, public client → copy the Application (client) ID into `CLIENT_ID` in `core/msauth.cjs`, then re-enable the button in `public/index.html` (search for `coming soon`).

> **First run on Windows:** SmartScreen shows a blue *"Windows protected your PC"* dialog for any new, unsigned app. Click **More info → Run anyway** — it appears once. (A paid code-signing certificate removes it; reputation also builds automatically as more people download the release.)

## Branding

Fantasy Launcher is made by **dr.denji** (contact: Instagram **@loid_edits1**). The name is embedded in the exe properties, titlebar, About panel and `NOTICE.txt`. Note: no file can be made mathematically rebrand-proof — the NOTICE + embedded metadata make the origin clear and the official build should always come from your channel.

## Develop

```bash
cd fantasy-launcher
npm install
npm start        # desktop app
npm run preview  # design-review harness at :3000 (simulated launch)
npm run dist     # electron-builder packages
```

## Design-review preview (no JVM needed)

```bash
npm run preview   # serves the renderer at http://localhost:3000
```

Same UI with real version/mod data from Mojang and Modrinth; the launch sequence is simulated because a browser can't spawn Java. Not the product — a review harness (`server.cjs` + `public/demo.js`), excluded from packaged builds.

## Layout

```
fantasy-launcher/
├── main.cjs          Electron main process, IPC handlers
├── preload.cjs       contextBridge -> window.fantasy
├── server.cjs        preview harness (static + API proxies)
├── core/
│   ├── game.cjs      download pipeline + launch assembly
│   ├── loader.cjs    Fabric/Quilt merge; Forge/NeoForge headless installers
│   ├── mods.cjs      Modrinth API + mods/ folder management
│   ├── accounts.cjs  offline profiles (v3-style offline UUIDs)
│   ├── http.cjs      zero-dependency HTTPS helpers
│   └── store.cjs     tiny JSON persistence
└── public/           renderer (index.html + styles.css + app.js + demo.js + stars.js)
```

User data lives in `%APPDATA%/fantasy-launcher` (Windows) or `~/.config/fantasy-launcher` (Linux): `accounts.json`, `settings.json`, and `game/` (versions, libraries, assets, mods).
