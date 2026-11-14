'use strict';
/*
 * Launch pipeline: vanilla json -> optional loader merge -> libraries/natives ->
 * assets -> client jar -> java. Files are verified by size and skipped when
 * present, making relaunches near-instant.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getJson, downloadToFile } = require('./http.cjs');
const { loadJSON, saveJSON } = require('./store.cjs');
const loaderApi = require('./loader.cjs');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest.json';

const osName = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux');
const archKey = () => (process.arch === 'x64' || process.arch === 'arm64' ? '64' : '86');

async function listVersions(dataDir) {
  const cacheFile = path.join(dataDir, 'version_manifest.json');
  const cached = loadJSON(cacheFile, null);
  if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached.manifest;
  try {
    const manifest = await getJson(MANIFEST_URL);
    saveJSON(cacheFile, { fetchedAt: Date.now(), manifest });
    return manifest;
  } catch (e) {
    if (cached) return cached.manifest; // offline: serve stale cache
    throw e;
  }
}

/* Vanilla versions already downloaded — last-resort list when fully offline. */
function listDownloadedVersions(gameDir) {
  const out = [];
  const dir = path.join(gameDir, 'versions');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const j = loadJSON(path.join(dir, e.name, `${e.name}.json`), null);
    if (j && j.id && !j._fantasy && !j.inheritsFrom) out.push({ id: j.id, type: j.type || 'release' });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

async function fetchVersionJson(dataDir, versionId) {
  const file = path.join(dataDir, 'game', 'versions', versionId, `${versionId}.json`);
  const cached = loadJSON(file, null);
  if (cached && cached.id && !cached.inheritsFrom) return cached;
  const manifest = await listVersions(dataDir);
  const entry = manifest.versions.find(v => v.id === versionId);
  if (!entry) throw new Error(`Unknown version: ${versionId}`);
  const json = await getJson(entry.url);
  saveJSON(file, json);
  return json;
}

function ruleAllows(rules, features = {}) {
  if (!rules) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) match = false;
      if (rule.os.arch && rule.os.arch !== process.arch) match = false;
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== Boolean(v)) { match = false; break; }
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

const validFile = (p, size) => {
  try { const s = fs.statSync(p); return s.isFile() && (size == null || s.size === size); }
  catch { return false; }
};

async function mapLimit(items, limit, fn, onEach) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      await fn(items[i++]);
      if (onEach) onEach();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
}

/* Forge jsons sometimes omit artifact URLs; reconstruct from the maven coordinate. */
function mavenPath(name) {
  const [group, artifact, rest] = name.split(':');
  const [version, classifier] = (rest || '').split('@')[0].split(':');
  const base = `${group.replace(/\./g, '/')}/${artifact}/${version}`;
  return `${base}/${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
}

async function installLibraries(json, gameDir, emit) {
  const libRoot = path.join(gameDir, 'libraries');
  const nativesDir = path.join(gameDir, 'versions', json.id, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });
  const classpath = [];
  const jobs = [];

  for (const lib of json.libraries || []) {
    if (!ruleAllows(lib.rules, {})) continue;
    const nativesKey = lib.natives && lib.natives[osName()];
    if (nativesKey && lib.downloads && lib.downloads.classifiers) {
      const art = lib.downloads.classifiers[String(nativesKey).replace('${arch}', archKey())];
      if (art) jobs.push({ art, dest: path.join(libRoot, art.path), natives: true });
      continue;
    }
    let art = lib.downloads && lib.downloads.artifact;
    if (art && art.url) {
      const dest = path.join(libRoot, art.path || mavenPath(lib.name));
      classpath.push(dest);
      jobs.push({ art, dest, natives: false });
    } else if (lib.name) {
      const rel = mavenPath(lib.name);
      const dest = path.join(libRoot, rel);
      classpath.push(dest);
      if (!validFile(dest)) {
        if (lib.url) jobs.push({ art: { url: lib.url.replace(/\/$/, '') + '/' + rel, size: null }, dest, natives: false });
        else emit('log', 100, `[warn] no URL for library ${lib.name}`);
      }
    }
  }

  let done = 0, bytesDone = 0;
  const totalBytes = jobs.reduce((s, j) => s + (j.art.size || 0), 0);
  await mapLimit(jobs, 8, async job => {
    if (!validFile(job.dest, job.art.size)) await downloadToFile(job.art.url, job.dest);
    if (job.natives) extractNatives(job.dest, nativesDir);
    bytesDone += job.art.size || 0;
  }, () => {
    done++;
    if (done % 6 === 0 || done === jobs.length) {
      const pct = totalBytes ? 20 + Math.round((bytesDone / totalBytes) * 25) : 20 + Math.round((done / jobs.length) * 25);
      emit('libraries', pct, `Libraries ${done}/${jobs.length}`);
    }
  });
  return { classpath, nativesDir };
}

function extractNatives(zipFile, destDir) {
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch { return; }
  try {
    for (const entry of new AdmZip(zipFile).getEntries()) {
      if (entry.isDirectory || entry.entryName.startsWith('META-INF')) continue;
      const target = path.join(destDir, entry.entryName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  } catch {}
}

async function installAssets(json, gameDir, emit) {
  const idx = json.assetIndex;
  if (!idx) return 'legacy';
  const assetsRoot = path.join(gameDir, 'assets');
  const indexFile = path.join(assetsRoot, 'indexes', `${idx.id}.json`);
  if (!validFile(indexFile, idx.size)) {
    emit('assets', 47, 'Fetching asset index…');
    await downloadToFile(idx.url, indexFile);
  }
  const index = loadJSON(indexFile, { objects: {} });
  const entries = Object.values(index.objects || {});
  const totalBytes = entries.reduce((s, o) => s + o.size, 0) || 1;
  let bytesDone = 0, done = 0;
  await mapLimit(entries, 10, async obj => {
    const dest = path.join(assetsRoot, 'objects', obj.hash.slice(0, 2), obj.hash);
    if (!validFile(dest, obj.size)) {
      await downloadToFile(`https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`, dest);
    }
    bytesDone += obj.size; done++;
  }, () => {
    if (done % 40 === 0) emit('assets', 47 + Math.round((bytesDone / totalBytes) * 33), `Assets ${done}/${entries.length}`);
  });
  return idx.id;
}

async function installClient(json, gameDir, emit) {
  const client = json.downloads && json.downloads.client;
  if (!client) throw new Error('No client download in version json');
  const dest = path.join(gameDir, 'versions', json.id, `${json.id}.jar`);
  if (!validFile(dest, client.size)) {
    emit('client', 84, 'Downloading game client…');
    await downloadToFile(client.url, dest);
  }
  return dest;
}

function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

function pushArg(entry, features, vars, out) {
  if (typeof entry === 'string') return out.push(substitute(entry, vars));
  if (entry && typeof entry === 'object' && ruleAllows(entry.rules, features)) {
    const v = entry.value != null ? entry.value : entry.values;
    (Array.isArray(v) ? v : [v]).forEach(x => out.push(substitute(x, vars)));
  }
}

/* Tuned garbage-collector flags (client-safe subset) for steadier FPS and lower RAM spikes. */
const PERF_FLAGS = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=100',
  '-XX:G1NewSizePercent=28',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=16M',
  '-XX:G1ReservePercent=20',
  '-XX:InitiatingHeapOccupancyPercent=12',
  '-XX:+DisableExplicitGC'
];

function buildCommand(json, opts) {
  const { gameDir, classpath, nativesDir, clientJar, account, ramMB, width, height, assetsIndexId, performance } = opts;
  const sep = process.platform === 'win32' ? ';' : ':';
  const features = { is_demo_user: false, has_custom_resolution: Boolean(width && height) };
  const vars = {
    auth_player_name: account.name,
    auth_uuid: account.uuid.replace(/-/g, ''),
    auth_access_token: account.accessToken || '0',
    clientid: '0', auth_xuid: '0',
    user_type: account.type === 'offline' ? 'legacy' : 'msa',
    version_name: json.id,
    version_type: json.type || 'release',
    game_directory: gameDir,
    assets_root: path.join(gameDir, 'assets'),
    assets_index_name: assetsIndexId,
    natives_directory: nativesDir,
    launcher_name: 'fantasy-launcher',
    launcher_version: '0.1.0',
    library_directory: path.join(gameDir, 'libraries'),
    classpath_separator: sep,
    classpath: [...classpath, clientJar].join(sep),
    resolution_width: width || 854,
    resolution_height: height || 480
  };

  const jvm = [];
  (json.arguments && json.arguments.jvm ? json.arguments.jvm
    : ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'])
    .forEach(a => pushArg(a, features, vars, jvm));
  if (!jvm.some(a => a.startsWith('-Xmx'))) jvm.unshift(`-Xmx${ramMB || 4096}M`);
  if (!jvm.some(a => a.startsWith('-Xms'))) jvm.unshift('-Xms512M');
  if (performance) jvm.unshift(...PERF_FLAGS);

  const game = [];
  (json.arguments && json.arguments.game ? json.arguments.game
    : String(json.minecraftArguments || '').split(' '))
    .forEach(a => pushArg(a, features, vars, game));

  return [...jvm, json.mainClass, ...game];
}

let activeChild = null;

async function launch(opts, emit) {
  const { dataDir, versionId, loader = 'vanilla', account, ramMB = 4096, width, height, javaPath } = opts;
  const gameDir = path.join(dataDir, 'game');
  fs.mkdirSync(gameDir, { recursive: true });

  emit('manifest', 2, 'Reading version manifest…');
  let baseJson;
  let json;
  if (opts.mergedId) {
    // Previously installed loader profile (TLauncher-style permanent entry).
    json = loadJSON(path.join(gameDir, 'versions', opts.mergedId, `${opts.mergedId}.json`), null);
    if (!json || !json.id) throw new Error(`Loader profile "${opts.mergedId}" not found. Reinstall it once via loader + version.`);
    baseJson = await fetchVersionJson(dataDir, (json._fantasy && json._fantasy.mc) || versionId);
  } else {
    baseJson = await fetchVersionJson(dataDir, versionId);
    json = baseJson;
    if (loader !== 'vanilla') {
      emit('client', 4, 'Ensuring vanilla client…');
      await installClient(baseJson, gameDir, () => {});
      emit('loader', 6, `Preparing ${loader}…`);
      json = await loaderApi.ensureLoaderJson(loader, versionId, baseJson, { dataDir, gameDir, javaPath, emit });
    }
  }

  emit('libraries', 20, 'Resolving libraries…');
  const { classpath, nativesDir } = await installLibraries(json, gameDir, emit);
  const assetsIndexId = await installAssets(json, gameDir, emit);
  const clientJar = await installClient(baseJson, gameDir, emit);

  emit('finalize', 93, 'Assembling launch…');
  const cmd = buildCommand(json, {
    gameDir, classpath, nativesDir, clientJar,
    account: { name: account.name, uuid: account.uuid, accessToken: account.accessToken || '0', type: account.type },
    ramMB, width, height, assetsIndexId, performance: opts.performance !== false
  });

  const javaBin = javaPath && javaPath.trim() ? javaPath.trim() : 'java';
  emit('launching', 97, `Starting ${json.id} as ${account.name}`);

  return new Promise((resolve, reject) => {
    // detached: the game keeps living even if the launcher itself is closed
    const child = spawn(javaBin, cmd, { cwd: gameDir, detached: true, windowsHide: true });
    child.unref();
    activeChild = child;
    child.stdout.on('data', d => String(d).split(/\r?\n/).filter(Boolean)
      .forEach(line => emit('log', 100, line.slice(0, 300))));
    child.stderr.on('data', d => emit('log', 100, String(d).slice(0, 300)));
    child.on('error', err => {
      const msg = err.code === 'ENOENT'
        ? 'Java not found. Install Java 17+ (21 recommended) or set its path in Settings.'
        : err.message;
      emit('error', 0, msg);
      reject(new Error(msg));
    });
    child.on('close', code => {
      activeChild = null;
      emit('closed', 100, code === 0 ? 'Game closed cleanly.' : `Game exited with code ${code}.`);
      resolve(code);
    });
  });
}

function kill() {
  if (activeChild) { try { activeChild.kill(); } catch {} activeChild = null; return true; }
  return false;
}

/* Loader profiles installed so far (fabric/quilt/forge/neoforge merged jsons). */
function listInstalledProfiles(gameDir) {
  const out = [];
  const dir = path.join(gameDir, 'versions');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const json = loadJSON(path.join(dir, e.name, `${e.name}.json`), null);
    if (json && json._fantasy) {
      out.push({ id: e.name, loader: json._fantasy.loader, mc: json._fantasy.mc, build: json._fantasy.build });
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

module.exports = { listVersions, listDownloadedVersions, fetchVersionJson, launch, kill, listInstalledProfiles };
