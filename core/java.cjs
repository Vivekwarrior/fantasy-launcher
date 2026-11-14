'use strict';
/*
 * Java runtime manager. Never touches a system Java — an existing compatible
 * `java` on PATH (or the user-set path) always wins. Only when nothing suitable
 * exists does it download a private copy into <dataDir>/java — launchers and
 * other Java apps on the machine are unaffected.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { downloadToFile } = require('./http.cjs');

/* Minecraft -> required Java major: <=1.16.5 needs 8, 1.17–1.20.4 needs 17, 1.20.5+ needs 21. */
function requiredMajor(mcVersion) {
  const m = String(mcVersion).match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21; // unknown/new naming -> newest
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

function probe(javaBin) {
  try {
    const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8', timeout: 8000 });
    const out = (r.stderr || '') + (r.stdout || '');
    const m = out.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
    if (!m) return null;
    const major = +m[1] === 1 ? +(m[2] || 0) : +m[1];
    return { bin: javaBin, ver: m[0].slice(9, -1), major };
  } catch { return null; }
}

const isWin = process.platform === 'win32';
const bundledBin = (dataDir, major) =>
  path.join(dataDir, 'java', `jre-${major}`, 'bin', isWin ? 'java.exe' : 'java');

function bundledInfo(dataDir, major) {
  const bin = bundledBin(dataDir, major);
  return fs.existsSync(bin) ? probe(bin) : null;
}

/* Resolve a Java to launch with, downloading a private runtime if needed. */
async function resolveJava({ dataDir, mcVersion, javaPath, emit = () => {} }) {
  const need = requiredMajor(mcVersion);

  const custom = javaPath && javaPath.trim() ? probe(javaPath.trim()) : null;
  if (custom) {
    if (custom.major >= need) return { ...custom, source: 'custom' };
    emit('java', -1, `Custom Java ${custom.major} is too old for ${mcVersion} (needs ${need}+) — checking others…`);
  }
  const bundled = bundledInfo(dataDir, need);
  if (bundled) return { ...bundled, source: 'bundled' };

  const system = probe('java');
  if (system && system.major >= need) return { ...system, source: 'system' };
  if (system) emit('java', -1, `System Java is ${system.major}, but ${mcVersion} needs ${need}+. Downloading a private copy…`);
  else emit('java', -1, `No Java found. Downloading a private Java ${need} runtime (one time)…`);

  return installJava({ dataDir, major: need, emit });
}

async function installJava({ dataDir, major, emit = () => {} }) {
  const os = isWin ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/x64/jre/hotspot/normal/eclipse`;
  const zipFile = path.join(dataDir, 'java', `jre-${major}.zip`);
  emit('java', 0, `Downloading Java ${major} (Temurin JRE)…`);
  await downloadToFile(url, zipFile, (done, total) => {
    const mb = n => (n / 1048576).toFixed(0);
    if (total > 0) {
      const pct = Math.floor((done * 100) / total);
      emit('java', pct, `Downloading Java ${major} — ${pct}% (${mb(done)} / ${mb(total)} MB)`);
    } else {
      emit('java', 0, `Downloading Java ${major} (Temurin JRE)… ${mb(done)} MB`);
    }
  });

  emit('java', 100, 'Unpacking Java…');
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch { throw new Error('adm-zip missing'); }
  const tmp = path.join(dataDir, 'java', `extract-${major}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  new AdmZip(zipFile).extractAllTo(tmp, true);
  const inner = fs.readdirSync(tmp)[0];
  const dest = path.join(dataDir, 'java', `jre-${major}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(path.join(tmp, inner), dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zipFile, { force: true });

  const info = bundledInfo(dataDir, major);
  if (!info) throw new Error('Java downloaded but the binary was not found.');
  emit('java', -1, `Java ${info.ver} ready (stored privately in the launcher folder).`);
  return { ...info, source: 'bundled' };
}

module.exports = { requiredMajor, probe, resolveJava, installJava, bundledInfo };
