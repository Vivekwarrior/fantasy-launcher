'use strict';
/*
 * Mod-loader resolution. Fabric/Quilt profiles merge directly over the vanilla
 * version json. Forge/NeoForge have no profile endpoint, so their official
 * installer is executed headless and its generated version json is merged.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getJson, downloadToFile } = require('./http.cjs');
const { loadJSON, saveJSON } = require('./store.cjs');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

async function listBuilds(loader, mcVersion) {
  if (loader === 'fabric') {
    const rows = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
    return rows.map(r => ({ id: r.loader.version, stable: !!r.loader.stable }));
  }
  if (loader === 'quilt') {
    const rows = await getJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
    return rows.map(r => ({ id: r.loader.version, stable: false }));
  }
  if (loader === 'forge') {
    const { promos } = await getJson(FORGE_PROMOS);
    const ver = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
    if (!ver) return [];
    return [{
      id: ver,
      stable: !!promos[`${mcVersion}-recommended`],
      installer: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${ver}/forge-${mcVersion}-${ver}-installer.jar`
    }];
  }
  if (loader === 'neoforge') {
    // NeoForge versions mirror MC minus the "1." prefix (1.21.1 -> 21.1.x), from 1.20.2 onward.
    const parts = mcVersion.split('.').map(Number);
    if (parts[0] !== 1 || parts[1] < 20 || (parts[1] === 20 && (parts[2] || 0) < 2)) return [];
    const prefix = parts.slice(1).join('.') + '.';
    const { versions } = await getJson(`${NEOFORGE_MAVEN.replace('/releases/net/neoforged/neoforge', '')}/api/maven/versions/releases/net/neoforged/neoforge`);
    return versions
      .filter(v => v.startsWith(prefix))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(v => ({ id: v, stable: true, installer: `${NEOFORGE_MAVEN}/${v}/neoforge-${v}-installer.jar` }));
  }
  return [];
}

/* Child (loader) wins over parent (vanilla); its args run last so they override duplicates. */
function mergeJson(parent, child, combinedId) {
  const pa = parent.arguments || {}, ca = child.arguments || {};
  return {
    ...parent,
    ...child,
    id: combinedId,
    inheritsFrom: undefined,
    mainClass: child.mainClass || parent.mainClass,
    assetIndex: parent.assetIndex,
    downloads: parent.downloads,
    type: parent.type,
    libraries: [...(parent.libraries || []), ...(child.libraries || [])],
    arguments: {
      game: [...(pa.game || []), ...(ca.game || [])],
      jvm: [...(pa.jvm || []), ...(ca.jvm || [])]
    },
    minecraftArguments: child.minecraftArguments || parent.minecraftArguments
  };
}

function runHeadless(javaBin, args, cwd, emit) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, args, { cwd });
    const tail = [];
    const onData = d => String(d).split(/\r?\n/).filter(Boolean).forEach(line => {
      tail.push(line); if (tail.length > 6) tail.shift();
      emit('loader', -1, line.slice(0, 220));
    });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => reject(err.code === 'ENOENT'
      ? new Error('Java not found — Forge/NeoForge install needs Java 17+ (set the path in Runes/Settings).')
      : err));
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`Installer exited ${code}: ${tail.join(' ').slice(-260)}`)));
  });
}

/* Forge/NeoForge installers write versions/<new-id>/<new-id>.json beside the vanilla one. */
function findProducedJson(gameDir, mcVersion, loader) {
  const versionsDir = path.join(gameDir, 'versions');
  const matches = fs.readdirSync(versionsDir)
    .filter(d => d !== mcVersion && /(forge|neoforge)/i.test(d))
    .map(d => {
      const f = path.join(versionsDir, d, `${d}.json`);
      try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .filter(x => (loadJSON(x.file, {}).inheritsFrom || '').startsWith(mcVersion) || loader !== 'vanilla')
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0] ? loadJSON(matches[0].file, null) : null;
}

/*
 * Returns a self-contained version json (vanilla + loader merged), cached on disk.
 * gameDir must already contain the vanilla version json + client jar.
 */
async function ensureLoaderJson(loader, mcVersion, baseJson, { dataDir, gameDir, javaPath, emit }) {
  const buildsList = await listBuilds(loader, mcVersion);
  if (!buildsList.length) {
    throw new Error(`${loader} has no build for ${mcVersion}. Try Vanilla/Fabric, or another version.`);
  }
  // lists are normalized newest-first; stable wins, otherwise take the newest
  const build = buildsList.find(b => b.stable) || buildsList[0];
  const id = loader === 'forge' || loader === 'neoforge'
    ? `${mcVersion}-${loader}-${build.id}`
    : `${mcVersion}-${loader}-${build.id}`;

  const cacheFile = path.join(gameDir, 'versions', id, `${id}.json`);
  const cached = loadJSON(cacheFile, null);
  if (cached && cached.id === id) return cached;

  if (loader === 'fabric' || loader === 'quilt') {
    const meta = loader === 'fabric' ? FABRIC_META : QUILT_META;
    emit('loader', 8, `${loader} ${build.id} selected`);
    const profile = await getJson(`${meta}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(build.id)}/profile/json`);
    const merged = mergeJson(baseJson, profile, id);
    merged._fantasy = { loader, mc: mcVersion, build: build.id };
    saveJSON(cacheFile, merged);
    return merged;
  }

  emit('loader', 8, `Downloading ${loader} ${build.id} installer…`);
  const installerJar = path.join(dataDir, 'installers', `${id}-installer.jar`);
  await downloadToFile(build.installer, installerJar);

  emit('loader', 10, `Running ${loader} installer (headless)…`);
  const javaBin = javaPath && javaPath.trim() ? javaPath.trim() : 'java';
  await runHeadless(javaBin, ['-jar', installerJar, '--installClient', gameDir], gameDir, emit);

  const produced = findProducedJson(gameDir, mcVersion, loader);
  if (!produced) throw new Error(`${loader} installer finished but its version json was not found.`);
  const merged = mergeJson(baseJson, produced, id);
  merged._fantasy = { loader, mc: mcVersion, build: build.id };
  saveJSON(cacheFile, merged);
  return merged;
}

module.exports = { listBuilds, ensureLoaderJson };
