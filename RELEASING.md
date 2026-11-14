# Publishing releases (no terminal needed)

The launcher's **Settings > Check for updates** button reads this repo's
latest GitHub release: `vivekwarrior/fantasy-launcher`.

## First-time repo upload (web only)

1. Open https://github.com/new — name: `fantasy-launcher`, Public (or Private if you'd rather).
2. Create repo, then on the repo page: **"uploading an existing file"** → drag-drop the whole `fantasy-launcher` folder → Commit.
3. Done — code is on GitHub.

## Each new release

1. Repo page → **Releases** → **Draft a new release**.
2. Tag: `v1.0.0` (then `v1.1.0`, …) — tag = the version inside the zip.
3. Title: `Fantasy Launcher v1.0.0`, notes: what changed.
4. Attach **`Fantasy-Launcher-Windows-x64.zip`** as an asset → Publish release.

The launcher compares the tag with its own version and opens this release
page when a newer one exists.

## Updating code later (web only)

Repo page → any file → pencil icon → paste the new content → Commit.
(A GitHub Actions build can be added later to produce the zip automatically.)
