'use strict';
/*
 * Account management.
 * - Offline (non-premium) profiles: no password needed, works in singleplayer
 *   and on offline-mode ("cracked") servers. Uses the same offline-UUID scheme
 *   Minecraft itself uses (MD5 of "OfflinePlayer:<name>", v3-style).
 * - Microsoft (premium) login: hooks are stubbed in main.cjs — wire an Azure
 *   client id to enable (see README).
 */
const crypto = require('crypto');
const path = require('path');
const { loadJSON, saveJSON } = require('./store.cjs');

function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30; // version 3
  h[8] = (h[8] & 0x3f) | 0x80; // variant
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class Accounts {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'accounts.json');
    const data = loadJSON(this.file, { accounts: [], activeId: null });
    this.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    this.activeId = data.activeId || null;
  }

  save() {
    saveJSON(this.file, { accounts: this.accounts, activeId: this.activeId });
  }

  list() {
    return this.accounts.map(a => ({
      id: a.id, name: a.name, type: a.type, uuid: a.uuid,
      active: a.id === this.activeId
    }));
  }

  addOffline(name) {
    name = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      throw new Error('Name must be 3-16 chars: letters, numbers, underscore only.');
    }
    const existing = this.accounts.find(a => a.name.toLowerCase() === name.toLowerCase() && a.type === 'offline');
    if (existing) { this.activeId = existing.id; this.save(); return existing; }
    const acc = {
      id: 'off-' + crypto.randomBytes(6).toString('hex'),
      name,
      type: 'offline',
      uuid: offlineUuid(name),
      createdAt: Date.now()
    };
    this.accounts.push(acc);
    this.activeId = acc.id;
    this.save();
    return acc;
  }

  addMs(profile) {
    const existing = this.accounts.find(a => a.type === 'ms' && a.uuid === profile.uuid);
    const acc = existing
      ? Object.assign(existing, profile)
      : { id: 'ms-' + crypto.randomBytes(6).toString('hex'), createdAt: Date.now(), ...profile };
    if (!existing) this.accounts.push(acc);
    this.activeId = acc.id;
    this.save();
    return acc;
  }

  get(id) { return this.accounts.find(a => a.id === id) || null; }

  update(id, patch) {
    const a = this.get(id);
    if (a) { Object.assign(a, patch); this.save(); }
    return a;
  }

  remove(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.activeId === id) this.activeId = this.accounts[0] ? this.accounts[0].id : null;
    this.save();
  }

  select(id) {
    if (!this.accounts.some(a => a.id === id)) throw new Error('Account not found');
    this.activeId = id;
    this.save();
  }

  getActive() {
    return this.accounts.find(a => a.id === this.activeId) || null;
  }
}

module.exports = { Accounts, offlineUuid };
