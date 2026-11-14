'use strict';
/* Modrinth-powered mod management (the TLauncher-style mod catalogue). */
const fs = require('fs');
const path = require('path');
const { getJson, downloadToFile } = require('./http.cjs');
const { loadJSON, saveJSON } = require('./store.cjs');

const API = 'https://api.modrinth.com/v2';

function searchMods({ query = '', loader = '', version = '', limit = 16, offset = 0 } = {}) {
  const facets = [['project_type:mod']];
  if (loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  if (version) facets.push([`versions:${version}`]);
  const url = `${API}/search?index=relevance&limit=${limit}&offset=${offset}` +
    `&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  return getJson(url);
}

function getProjectVersions(projectId, { loader = '', gameVersion = '' } = {}) {
  let url = `${API}/project/${encodeURIComponent(projectId)}/version`;
  const qs = [];
  if (loader && loader !== 'vanilla') qs.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
  if (gameVersion) qs.push(`game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`);
  if (qs.length) url += '?' + qs.join('&');
  return getJson(url);
}

function metaFile(modsDir) { return path.join(modsDir, '.fantasy-mods.json'); }

async function installMod(modsDir, project, { loader = '', gameVersion = '' } = {}) {
  const versions = await getProjectVersions(project.id, { loader, gameVersion });
  if (!versions.length) throw new Error(`No ${loader || ''} build of "${project.title}" for ${gameVersion || 'this version'}.`);
  const v = versions[0];
  const file = (v.files || []).find(f => f.primary) || (v.files || [])[0];
  if (!file) throw new Error('No downloadable file for this mod.');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, file.filename);
  await downloadToFile(file.url, dest);
  const meta = loadJSON(metaFile(modsDir), {});
  meta[file.filename] = {
    projectId: project.id, title: project.title, icon: project.icon || '',
    author: project.author || '', versionName: v.name || v.version_number
  };
  saveJSON(metaFile(modsDir), meta);
  return { file: file.filename, name: project.title, version: v.version_number };
}

/* ---- jar introspection: tell a bad mod BEFORE the game crashes on it ---- */

function loaderNames() { return { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' }; }

function tomlMcRange(toml) {
  if (!toml) return null;
  const m = toml.match(/\[\[dependencies[^\]]*\]\][^\[]*?modid\s*=\s*"minecraft"[\s\S]{0,400}?versionRange\s*=\s*"([^"]+)"/i);
  return m ? m[1] : null;
}

function inspectJar(file) {
  let zip;
  try { const AdmZip = require('adm-zip'); zip = new AdmZip(file); } catch { return null; }
  const names = new Set(zip.getEntries().map(e => e.entryName));
  const loaders = [];
  let mcRange = null;
  const read = n => { try { return zip.readAsText(n); } catch { return null; } };
  if (names.has('fabric.mod.json')) {
    loaders.push('fabric');
    try { const p = JSON.parse(read('fabric.mod.json')); if (p.depends && p.depends.minecraft) mcRange = String(p.depends.minecraft); } catch {}
  }
  if (names.has('quilt.mod.json')) loaders.push('quilt');
  if (names.has('META-INF/neoforge.mods.toml')) { loaders.push('neoforge'); mcRange = tomlMcRange(read('META-INF/neoforge.mods.toml')) || mcRange; }
  if (names.has('META-INF/mods.toml') && !loaders.includes('neoforge')) { loaders.push('forge'); mcRange = tomlMcRange(read('META-INF/mods.toml')) || mcRange; }
  if (!loaders.length) return null;
  return { loaders, mcRange };
}

/* version compare + "is mc inside a declared range like ~1.21.1, >=1.20, [1.21,1.22)" */
function splitNums(v) { return String(v).split('.').map(x => parseInt(x, 10) || 0); }
function cmpVer(a, b) {
  const A = splitNums(a), B = splitNums(b);
  for (let i = 0; i < Math.max(A.length, B.length, 3); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function numOf(t) { const m = String(t).match(/\d+\.\d+(?:\.\d+)?/); return m ? m[0] : null; }
function inMcRange(range, mc) {
  if (!range) return null;
  try {
    const r = String(range).trim();
    const iv = r.match(/^([\[\(])\s*([\d.]+)\s*,\s*([\d.]+)\s*([\]\)])$/);
    if (iv) {
      const lo = cmpVer(mc, iv[2]), hi = cmpVer(mc, iv[3]);
      return (iv[1] === '[' ? lo >= 0 : lo > 0) && (iv[4] === ']' ? hi <= 0 : hi < 0);
    }
    for (const rawTok of r.split(/[\s,]+/).filter(Boolean)) {
      let t = rawTok.replace(/^=+/, '');
      if (!t || t === '*') continue;
      if (t.startsWith('~')) {
        const v = numOf(t); if (!v) return null;
        const V = splitNums(v), M = splitNums(mc);
        if (!(M[0] === V[0] && M[1] === V[1] && cmpVer(mc, v) >= 0)) return false;
        continue;
      }
      const g = t.match(/^(>=|<=|>|<)(.+)$/);
      if (g) {
        const v = numOf(g[2]); if (!v) return null;
        const c = cmpVer(mc, v);
        if (g[1] === '>=' && c < 0) return false;
        if (g[1] === '>' && c <= 0) return false;
        if (g[1] === '<=' && c > 0) return false;
        if (g[1] === '<' && c >= 0) return false;
        continue;
      }
      const v = numOf(t);
      if (!v) { if (/\.x$|\.\*$/.test(t)) { const N = splitNums(t); const M = splitNums(mc); if (M[0] !== N[0] || M[1] !== N[1]) return false; continue; } return null; }
      const parts = splitNums(v).length;
      if (parts === 2) { const V = splitNums(v), M = splitNums(mc); if (M[0] !== V[0] || M[1] !== V[1]) return false; }
      else if (cmpVer(mc, v) !== 0) return false;
    }
    return true;
  } catch { return null; }
}

function compatOf(info, mcVersion, loader) {
  const L = loaderNames();
  if (loader === 'vanilla') return { level: 'bad', note: 'Vanilla cannot load mods — pick a loader on the Play page.' };
  if (!info) return { level: 'unknown', note: 'Could not read this jar — it may still work fine.' };
  if (loader && !info.loaders.includes(loader)) {
    return { level: 'bad', note: `Built for ${info.loaders.map(l => L[l] || l).join(' + ')} — crashes on ${L[loader] || loader}.` };
  }
  if (mcVersion && info.mcRange) {
    const ok = inMcRange(info.mcRange, mcVersion);
    if (ok === false) return { level: 'warn', note: `Made for Minecraft ${info.mcRange}, you're on ${mcVersion}.` };
  }
  return { level: 'ok', note: 'Matches your version and loader.' };
}

function listMods(modsDir, { mcVersion = '', loader = '' } = {}) {
  const meta = loadJSON(metaFile(modsDir), {});
  let files = [];
  try { files = fs.readdirSync(modsDir); } catch { return []; }
  return files
    .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
    .map(f => {
      const key = f.endsWith('.disabled') ? f.slice(0, -9) : f;
      const m = meta[key] || {};
      let size = 0;
      try { size = fs.statSync(path.join(modsDir, f)).size; } catch {}
      const info = inspectJar(path.join(modsDir, f));
      return {
        file: f, baseName: key, enabled: !f.endsWith('.disabled'), size,
        title: m.title || key.replace(/\.jar$/, ''), icon: m.icon || '',
        author: m.author || '', versionName: m.versionName || '',
        loaders: info ? info.loaders : [], mcRange: info ? info.mcRange : null,
        compat: compatOf(info, mcVersion, loader)
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function toggleMod(modsDir, file, enable) {
  const cur = path.join(modsDir, file);
  const isDisabled = file.endsWith('.disabled');
  if (enable && isDisabled) fs.renameSync(cur, path.join(modsDir, file.slice(0, -9)));
  else if (!enable && !isDisabled) fs.renameSync(cur, path.join(modsDir, file + '.disabled'));
  return !file.endsWith('.disabled') ? !enable : enable ? true : false;
}

function removeMod(modsDir, file) {
  const key = file.endsWith('.disabled') ? file.slice(0, -9) : file;
  try { fs.unlinkSync(path.join(modsDir, file)); } catch {}
  const mf = metaFile(modsDir);
  const meta = loadJSON(mf, {});
  delete meta[key];
  saveJSON(mf, meta);
}

/* One-click performance packs — engine + memory + culling mods, plus shader
   support (Iris on Fabric/Quilt, Oculus on Forge/NeoForge). */
const PACKS = {
  fabric: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'iris'],
  quilt: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'iris'],
  forge: ['embeddium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'oculus'],
  neoforge: ['embeddium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'oculus']
};

async function installPack(modsDir, loader, { gameVersion } = {}) {
  const slugs = PACKS[loader];
  if (!slugs) throw new Error('The pack needs Fabric, Quilt, Forge or NeoForge — pick one on the Play page first (Vanilla cannot load mods).');
  const ok = [];
  const skipped = [];
  for (const slug of slugs) {
    try {
      const p = await getJson(`${API}/project/${encodeURIComponent(slug)}`);
      await installMod(modsDir, { id: p.id, title: p.title, icon: p.icon_url || '', author: '' }, { loader, gameVersion });
      ok.push(p.title);
    } catch {
      skipped.push(slug); // no build for this version/loader — fine, the rest still boost FPS
    }
  }
  return { ok, skipped };
}

module.exports = { searchMods, getProjectVersions, installMod, installPack, listMods, toggleMod, removeMod };
