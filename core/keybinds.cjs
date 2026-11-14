'use strict';
/*
 * Keybind presets. Minecraft stores them as `key_*` lines in options.txt at the
 * game directory root. A preset is just a named snapshot of those lines; applying
 * replaces the keybind lines but leaves every other option (video settings etc.)
 * untouched. A backup is written before each apply.
 */
const fs = require('fs');
const path = require('path');
const { loadJSON, saveJSON } = require('./store.cjs');

const isKeybindLine = line => line.startsWith('key_');

function currentKeybinds(optionsFile) {
  let text = '';
  try { text = fs.readFileSync(optionsFile, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map(l => l.trim()).filter(isKeybindLine);
}

class Keybinds {
  constructor(dataDir) {
    this.storeFile = path.join(dataDir, 'keybind-presets.json');
    this.data = loadJSON(this.storeFile, { presets: [] });
  }

  list() { return this.data.presets.map(p => ({ name: p.name, count: p.lines.length, createdAt: p.createdAt })); }

  saveFromGame(optionsFile, name) {
    name = String(name || '').trim();
    if (!/^[\w \-]{1,32}$/u.test(name)) throw new Error('Preset name: 1–32 letters/numbers/spaces.');
    const lines = currentKeybinds(optionsFile);
    if (!lines.length) throw new Error('No keybinds found in the game yet — set them in-game first, then save.');
    const i = this.data.presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    const preset = { name, lines, createdAt: Date.now() };
    if (i >= 0) this.data.presets[i] = preset; else this.data.presets.push(preset);
    saveJSON(this.storeFile, this.data);
    return preset;
  }

  remove(name) {
    this.data.presets = this.data.presets.filter(p => p.name !== name);
    saveJSON(this.storeFile, this.data);
  }

  apply(optionsFile, name) {
    const preset = this.data.presets.find(p => p.name === name);
    if (!preset) throw new Error('Preset not found.');
    let lines = [];
    try { lines = fs.readFileSync(optionsFile, 'utf8').split(/\r?\n/); } catch {}
    try { fs.copyFileSync(optionsFile, optionsFile + '.bak'); } catch {} // safety net
    const kept = lines.filter(l => !isKeybindLine(l.trim()) && l.trim() !== '');
    fs.writeFileSync(optionsFile, kept.concat(preset.lines).join('\n') + '\n');
    return preset;
  }
}

module.exports = { Keybinds, currentKeybinds };
