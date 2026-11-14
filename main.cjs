'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Accounts } = require('./core/accounts.cjs');
const game = require('./core/game.cjs');
const mods = require('./core/mods.cjs');
const javaApi = require('./core/java.cjs');
const msauth = require('./core/msauth.cjs');
const { Keybinds } = require('./core/keybinds.cjs');
const discord = require('./core/discord.cjs');
const { loadJSON, saveJSON } = require('./core/store.cjs');

/* One launcher at a time; a second shortcut click focuses the existing one. */
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();

let win = null;
let dataDir, accounts, keybinds, settingsFile;
let launching = false;

const UPDATE_FEED_URL = 'https://api.github.com/repos/vivekwarrior/fantasy-launcher/releases/latest';

const DEFAULT_SETTINGS = {
  ramMB: 4096, width: 1280, height: 720, javaPath: '',
  loader: 'vanilla', version: '', accent: 'gold', theme: 'dark',
  performance: true, skinModel: 'classic', discordRpc: true, hideOnPlay: true
};

const gameDir = () => path.join(dataDir, 'game');
/* Each loader+version combo gets its own mods folder, so a Fabric-1.21 jar can
   never leak into a Forge-1.20 run and crash it. */
const modsDir = () => {
  const s = getSettings();
  const combo = `${s.loader || 'vanilla'}-${s.version || 'unknown'}`.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(gameDir(), 'mods', combo);
};
const skinsDir = () => path.join(dataDir, 'skins');
const optionsFile = () => path.join(gameDir(), 'options.txt');

function getSettings() { return { ...DEFAULT_SETTINGS, ...loadJSON(settingsFile, {}) }; }
function setSettings(patch) { saveJSON(settingsFile, { ...getSettings(), ...patch }); return getSettings(); }
function sendProgress(data) { if (win && !win.isDestroyed()) win.webContents.send('game:progress', data); }
const sendMs = data => { if (win && !win.isDestroyed()) win.webContents.send('ms:progress', data); };

/* avatar: locally stored skin beats the online lookup for offline profiles */
function listAccounts() {
  return accounts.list().map(a => {
    const skinFile = path.join(skinsDir(), `${a.uuid}.png`);
    return { ...a, localSkin: fs.existsSync(skinFile) ? skinFile : null };
  });
}

async function resolveJavaForLaunch(payload, emit) {
  const s = getSettings();
  let mc = payload.version;
  if (payload.mergedId) {
    const p = game.listInstalledProfiles(gameDir()).find(x => x.id === payload.mergedId);
    mc = p ? p.mc : payload.mergedId;
  }
  const j = await javaApi.resolveJava({ dataDir, mcVersion: mc, javaPath: s.javaPath, emit });
  sendProgress({ stage: 'java', percent: -1, message: `Java: ${j.ver} (${j.source})` });
  return j.bin;
}

function registerIpc() {
  ipcMain.handle('accounts:list', () => listAccounts());
  ipcMain.handle('accounts:addOffline', (_e, name) => { accounts.addOffline(name); return listAccounts(); });
  ipcMain.handle('accounts:remove', (_e, id) => { accounts.remove(id); return listAccounts(); });
  ipcMain.handle('accounts:select', (_e, id) => { accounts.select(id); return listAccounts(); });

  /* Microsoft sign-in: full device-code flow, resolves when the account is added. */
  ipcMain.handle('accounts:msLogin', async () => {
    const flow = await msauth.beginDeviceFlow();
    sendMs({ stage: 'code', userCode: flow.userCode, verifyUrl: flow.verifyUrl });
    const msJson = await msauth.pollMsToken(flow, (stage, percent, message) => sendMs({ stage, message }));
    sendMs({ stage: 'xbox', message: 'Linking Xbox Live & Minecraft profile…' });
    const profile = await msauth.msTokenToMcAccount(msJson);
    const acc = accounts.addMs(profile);
    sendMs({ stage: 'done' });
    return acc;
  });

  /* Skin: premium -> official upload (visible everywhere); offline -> library copy. */
  ipcMain.handle('accounts:setSkin', async (_e, { id, variant }) => {
    const acc = accounts.get(id);
    if (!acc) throw new Error('Account not found.');
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a skin PNG',
      filters: [{ name: 'Minecraft skin', extensions: ['png'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return listAccounts();
    const file = picked.filePaths[0];

    if (acc.type === 'ms') {
      const fresh = await msauth.ensureValidMs(acc);
      accounts.update(acc.id, fresh);
      await msauth.uploadSkin(fresh.accessToken, fs.readFileSync(file), variant === 'slim' ? 'slim' : 'classic');
    } else {
      fs.mkdirSync(skinsDir(), { recursive: true });
      fs.copyFileSync(file, path.join(skinsDir(), `${acc.uuid}.png`));
    }
    return listAccounts();
  });

  ipcMain.handle('versions:list', async () => {
    try {
      const m = await game.listVersions(dataDir);
      return { latest: m.latest, versions: m.versions.filter(v => v.type === 'release').slice(0, 120), offline: false };
    } catch {
      const local = game.listDownloadedVersions(gameDir());
      return { latest: { release: local[0] ? local[0].id : '' }, versions: local, offline: true };
    }
  });

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const out = setSettings(patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'discordRpc')) {
      if (out.discordRpc) discord.connect(); else discord.destroy();
    }
    return out;
  });
  ipcMain.handle('gameDir', () => gameDir());

  ipcMain.handle('mods:search', (_e, q) => mods.searchMods(q || {}));
  ipcMain.handle('mods:install', (_e, project) => {
    const s = getSettings();
    return mods.installMod(modsDir(), project, { loader: s.loader, gameVersion: s.version });
  });
  ipcMain.handle('mods:installPack', () => {
    const s = getSettings();
    return mods.installPack(modsDir(), s.loader, { gameVersion: s.version });
  });
  ipcMain.handle('mods:list', () => { const s = getSettings(); return mods.listMods(modsDir(), { mcVersion: s.version, loader: s.loader }); });
  ipcMain.handle('mods:toggle', (_e, { file, enable }) => { const s = getSettings(); mods.toggleMod(modsDir(), file, enable); return mods.listMods(modsDir(), { mcVersion: s.version, loader: s.loader }); });
  ipcMain.handle('mods:remove', (_e, file) => { const s = getSettings(); mods.removeMod(modsDir(), file); return mods.listMods(modsDir(), { mcVersion: s.version, loader: s.loader }); });

  ipcMain.handle('profiles:list', () => game.listInstalledProfiles(gameDir()));

  ipcMain.handle('game:launch', async (_e, payload) => {
    if (launching) throw new Error('Already launching — wait for the current run.');
    const account = accounts.getActive();
    if (!account) throw new Error('No account selected — create a profile first.');
    if (account.type === 'ms') {
      try { accounts.update(account.id, await msauth.ensureValidMs(account)); }
      catch (e) { throw new Error('Microsoft session expired — sign in again from Accounts. (' + e.message + ')'); }
    }
    const s = getSettings();
    let rpcLabel = { version: payload.version || '', loader: payload.loader || 'vanilla' };
    if (payload.mergedId) {
      const p = game.listInstalledProfiles(gameDir()).find(x => x.id === payload.mergedId);
      if (p) {
        rpcLabel = { version: p.mc, loader: p.loader };
        setSettings({ version: p.mc, loader: p.loader }); // mods folder follows the profile
      }
    }
    launching = true;
    try {
      const emit = (stage, percent, message) => {
        sendProgress({ stage, percent, message });
        if (stage === 'launching') {
          discord.playing(rpcLabel.version, rpcLabel.loader);
          if (s.hideOnPlay !== false && win) {
            setTimeout(() => { try { win.hide(); } catch {} }, 1400);
          }
        }
        if (stage === 'closed' || stage === 'error') {
          discord.idle();
          if (win) { try { win.show(); win.focus(); } catch {} }
        }
      };
      const javaBin = await resolveJavaForLaunch(payload, emit);
      const code = await game.launch({
        dataDir, versionId: payload.version, loader: payload.loader, mergedId: payload.mergedId,
        account: accounts.getActive(),
        ramMB: s.ramMB, width: s.width, height: s.height,
        javaPath: javaBin, performance: s.performance !== false
      }, emit);
      return code;
    } finally {
      launching = false;
    }
  });
  ipcMain.handle('game:kill', () => game.kill());

  /* Java management */
  ipcMain.handle('java:status', () => {
    const s = getSettings();
    const custom = s.javaPath && s.javaPath.trim() ? javaApi.probe(s.javaPath.trim()) : null;
    const system = javaApi.probe('java');
    const bundled = [21, 17, 8].map(m => javaApi.bundledInfo(dataDir, m)).filter(Boolean);
    return { custom, system, bundled };
  });
  ipcMain.handle('java:ensure', async (_e, mcVersion) => {
    const s = getSettings();
    return javaApi.resolveJava({ dataDir, mcVersion, javaPath: s.javaPath, emit: (stage, percent, message) => sendProgress({ stage, percent, message }) });
  });

  /* Keybind presets */
  ipcMain.handle('keybinds:list', () => keybinds.list());
  ipcMain.handle('keybinds:save', (_e, name) => keybinds.saveFromGame(optionsFile(), name));
  ipcMain.handle('keybinds:apply', (_e, name) => keybinds.apply(optionsFile(), name));
  ipcMain.handle('keybinds:remove', (_e, name) => keybinds.remove(name));
  ipcMain.handle('keybinds:currentCount', () => {
    const { currentKeybinds } = require('./core/keybinds.cjs');
    return currentKeybinds(optionsFile()).length;
  });

  ipcMain.handle('shell:openPath', (_e, which) => {
    const dir = which === 'mods' ? modsDir() : gameDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('shots:list', () => {
    const dir = path.join(gameDir(), 'screenshots');
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files
      .filter(f => /\.(png|jpe?g)$/i.test(f))
      .map(f => {
        const full = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return { name: f, file: full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 60);
  });
  ipcMain.handle('shots:open', (_e, name) =>
    shell.openPath(path.join(gameDir(), 'screenshots', path.basename(String(name)))));

  ipcMain.handle('update:check', async () => {
    if (!UPDATE_FEED_URL) throw new Error('Update feed is not published yet — new builds come from the official channel.');
    const { getJson } = require('./core/http.cjs');
    const rel = await getJson(UPDATE_FEED_URL);
    const latest = rel.tag_name || rel.name || '';
    const current = app.getVersion();
    const fresh = latest.replace(/^v/i, '');
    return {
      latest, url: rel.html_url || '',
      updateAvailable: fresh !== current
    };
  });

  ipcMain.on('win:min', () => win && win.minimize());
  ipcMain.on('win:max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win && win.close());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 780,
    minWidth: 1060, minHeight: 660,
    frame: false,
    show: false,
    backgroundColor: '#0a0812',
    title: 'Fantasy Launcher',
    icon: path.join(__dirname, 'public', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  dataDir = path.join(app.getPath('appData'), 'fantasy-launcher');
  fs.mkdirSync(dataDir, { recursive: true });
  settingsFile = path.join(dataDir, 'settings.json');
  accounts = new Accounts(dataDir);
  keybinds = new Keybinds(dataDir);
  registerIpc();
  if (getSettings().discordRpc && discord.enabled) discord.connect();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => discord.destroy());
