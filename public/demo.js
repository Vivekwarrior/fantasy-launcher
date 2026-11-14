'use strict';
/*
 * Preview-harness adapter. The renderer expects window.fantasy; in the real app
 * preload.cjs provides it over IPC. In a plain browser this module provides the
 * same interface backed by localStorage and the server.cjs API proxies, and
 * simulates the launch sequence so the interface can be reviewed without a JVM.
 */
(function () {
  if (window.fantasy) return;

  const LS = {
    get(key, fb) { try { return JSON.parse(localStorage.getItem(key)) ?? fb; } catch { return fb; } },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  };

  function pseudoUuid(name) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const s = 'OfflinePlayer:' + name;
    for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 2654435761); h2 = Math.imul(h2 + s.charCodeAt(i), 1597334677); }
    const hex = n => (n >>> 0).toString(16).padStart(8, '0');
    const raw = (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(~h2)).slice(0, 32);
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-3${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`;
  }

  const progressSubs = new Set();
  const emit = (stage, percent, message) => progressSubs.forEach(cb => { try { cb({ stage, percent, message }); } catch {} });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const PACK_TITLES = {
    fabric: ['Fabric API', 'Sodium', 'Lithium', 'FerriteCore', 'Entity Culling', 'ImmediatelyFast', 'Iris Shaders'],
    quilt: ['Sodium', 'Lithium', 'FerriteCore', 'Entity Culling', 'ImmediatelyFast', 'Iris Shaders'],
    forge: ['Embeddium', 'FerriteCore', 'Entity Culling', 'ImmediatelyFast', 'Oculus'],
    neoforge: ['Embeddium', 'FerriteCore', 'Entity Culling', 'ImmediatelyFast', 'Oculus']
  };

  const api = {
    isElectron: false,

    accounts: {
      _data() { return LS.get('fl_accounts', { accounts: [], activeId: null }); },
      _save(d) { LS.set('fl_accounts', d); },
      list() {
        const d = this._data();
        return Promise.resolve(d.accounts.map(a => ({ ...a, active: a.id === d.activeId })));
      },
      addOffline(name) {
        name = String(name || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return Promise.reject(new Error('Username must be 3–16 characters: letters, numbers, underscores.'));
        const d = this._data();
        let acc = d.accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
        if (!acc) {
          acc = { id: 'off-' + Math.random().toString(16).slice(2, 10), name, type: 'offline', uuid: pseudoUuid(name) };
          d.accounts.push(acc);
        }
        d.activeId = acc.id;
        this._save(d);
        return Promise.resolve(acc);
      },
      msLogin() { return Promise.reject(new Error('Microsoft sign-in runs in the desktop app (device-code flow).')); },
      async setSkin(id) { return this.list(); },
      remove(id) {
        const d = this._data();
        d.accounts = d.accounts.filter(a => a.id !== id);
        if (d.activeId === id) d.activeId = d.accounts[0]?.id || null;
        this._save(d); return this.list();
      },
      select(id) {
        const d = this._data();
        if (d.accounts.some(a => a.id === id)) d.activeId = id;
        this._save(d); return this.list();
      },
      _active() { const d = this._data(); return d.accounts.find(a => a.id === d.activeId) || null; }
    },

    versions: {
      async list() {
        try {
          const r = await fetch('/api/versions');
          if (!r.ok) throw new Error('bad');
          const data = await r.json();
          LS.set('fl_versions', data); // cache so offline sessions still show versions
          return { ...data, offline: false };
        } catch {
          const cached = LS.get('fl_versions', null);
          if (cached) return { ...cached, offline: true };
          throw new Error('Could not fetch the version list.');
        }
      }
    },

    profiles: {
      list() { return Promise.resolve(LS.get('fl_profiles', [])); }
    },

    settings: {
      get() { return Promise.resolve({ ramMB: 4096, width: 1280, height: 720, javaPath: '', loader: 'vanilla', version: '', accent: 'gold', theme: 'dark', performance: true, ...LS.get('fl_settings', {}) }); },
      set(patch) { LS.set('fl_settings', { ...LS.get('fl_settings', {}), ...patch }); return this.get(); }
    },

    mods: {
      async search({ query = '', loader = '', version = '', offset = 0 } = {}) {
        const r = await fetch(`/api/modrinth/search?query=${encodeURIComponent(query)}&loader=${encodeURIComponent(loader)}&version=${encodeURIComponent(version)}&offset=${offset}`);
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || 'Mod search service is unreachable.');
        return data;
      },
      async install(project) {
        const s = await api.settings.get();
        const r = await fetch(`/api/modrinth/versions/${project.id}?loader=${encodeURIComponent(s.loader)}&gameVersion=${encodeURIComponent(s.version)}`);
        const vers = await r.json();
        if (!r.ok || !Array.isArray(vers) || !vers.length) {
          throw new Error(`No ${s.loader} build of "${project.title}" for ${s.version}.`);
        }
        await wait(600); // stand-in for the real file download
        const mods = LS.get('fl_mods', []);
        const file = project.id + '.jar';
        if (!mods.some(m => m.baseName === file)) {
          mods.push({
            file, baseName: file, enabled: true, title: project.title,
            icon: project.icon || '', author: project.author || '',
            versionName: vers[0].version_number, size: 0
          });
          LS.set('fl_mods', mods);
        }
        return { file, name: project.title };
      },
      async installPack() {
        const s = await api.settings.get();
        const titles = PACK_TITLES[s.loader];
        if (!titles) throw new Error('The pack needs Fabric, Quilt, Forge or NeoForge — pick one on the Play page first (Vanilla cannot load mods).');
        await wait(1200);
        const mods = LS.get('fl_mods', []);
        for (const title of titles) {
          const file = 'pack-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '') + '.jar';
          if (!mods.some(m => m.file === file)) {
            mods.push({ file, baseName: file, enabled: true, title, icon: '', author: 'Performance pack', versionName: '', size: 0 });
          }
        }
        LS.set('fl_mods', mods);
        return { ok: titles, skipped: [] };
      },
      list() { return Promise.resolve(LS.get('fl_mods', [])); },
      toggle(file, enable) {
        LS.set('fl_mods', LS.get('fl_mods', []).map(m => m.file === file ? { ...m, enabled: enable } : m));
        return this.list();
      },
      remove(file) {
        LS.set('fl_mods', LS.get('fl_mods', []).filter(m => m.file !== file));
        return this.list();
      }
    },

    shots: {
      list() { return Promise.resolve([]); },
      open() { return Promise.resolve(); }
    },

    java: {
      status() {
        return Promise.resolve({ custom: null, system: { bin: 'java', ver: '17.0.8 (demo)', major: 17 }, bundled: [] });
      },
      ensure(mcVersion) { return Promise.resolve({ bin: 'java', ver: '17.0.8 (demo)', major: 17, source: 'system' }); }
    },

    keybinds: {
      _opt() {
        return LS.get('fl_options', [
          'key_key.attack=key.mouse.left', 'key_key.use=key.mouse.right',
          'key_key.forward=key.keyboard.w', 'key_key.back=key.keyboard.s',
          'key_key.jump=key.keyboard.space', 'key_key.sneak=key.keyboard.left.shift',
          'key_key.sprint=key.keyboard.left.control', 'key_key.inventory=key.keyboard.e'
        ]);
      },
      list() { return Promise.resolve(LS.get('fl_kb', []).map(p => ({ name: p.name, count: p.lines.length, createdAt: p.createdAt }))); },
      save(name) {
        name = String(name || '').trim();
        if (!/^[\w \-]{1,32}$/u.test(name)) return Promise.reject(new Error('Preset name: 1–32 letters/numbers/spaces.'));
        const lines = this._opt();
        const presets = LS.get('fl_kb', []);
        const i = presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        const preset = { name, lines, createdAt: Date.now() };
        if (i >= 0) presets[i] = preset; else presets.push(preset);
        LS.set('fl_kb', presets);
        return Promise.resolve(preset);
      },
      apply(name) {
        const p = LS.get('fl_kb', []).find(x => x.name === name);
        if (!p) return Promise.reject(new Error('Preset not found.'));
        LS.set('fl_options', p.lines);
        return Promise.resolve(p);
      },
      remove(name) { LS.set('fl_kb', LS.get('fl_kb', []).filter(p => p.name !== name)); return Promise.resolve(); },
      currentCount() { return Promise.resolve(this._opt().length); }
    },

    updates: {
      check() { return Promise.reject(new Error('Update feed is not published yet — new builds come from the official channel.')); }
    },

    onMsProgress() { return () => {}; },

    shell: { open() { return Promise.resolve(); } },

    game: {
      async dir() { return 'available in the desktop app'; },
      kill() { return false; },
      async launch({ version, loader, mergedId }) {
        const acc = api.accounts._active();
        if (!acc) throw new Error('No account selected.');
        const s = await api.settings.get();
        if (mergedId) {
          const p = LS.get('fl_profiles', []).find(x => x.id === mergedId);
          if (!p) throw new Error(`Profile "${mergedId}" not found.`);
          version = p.mc; loader = p.loader;
        }

        emit('manifest', 2, 'Reading version manifest…'); await wait(500);
        if (loader !== 'vanilla') { emit('loader', 8, `Preparing ${loader}…`); await wait(800); }
        for (let p = 20; p <= 45; p += 5) { emit('libraries', p, `Libraries ${Math.round((p - 20) / 25 * 52)}/52`); await wait(80); }
        for (let p = 47; p <= 80; p += 4) { emit('assets', p, `Assets ${Math.round((p - 47) / 33 * 1400)}/1400`); await wait(70); }
        emit('client', 84, 'Downloading game client…'); await wait(450);
        emit('finalize', 93, s.performance !== false ? 'Assembling launch (performance flags on)…' : 'Assembling launch…'); await wait(400);
        emit('launching', 97, `Starting ${version} (${loader}) as ${acc.name}…`); await wait(700);
        emit('log', 100, `[preview] java -Xmx${s.ramMB}M … --username ${acc.name} --version ${version}`);
        emit('log', 100, '[preview] browsers cannot spawn a JVM, so the launch is simulated here.');
        if (loader !== 'vanilla') {
          const profiles = LS.get('fl_profiles', []);
          const id = `${version}-${loader}-demo`;
          if (!profiles.some(p => p.id === id)) {
            profiles.push({ id, loader, mc: version, build: 'installed' });
            LS.set('fl_profiles', profiles);
          }
        }
        emit('closed', 100, 'Preview finished — the desktop build performs the real download and launch.');
        return 0;
      }
    },

    onProgress(cb) { progressSubs.add(cb); return () => progressSubs.delete(cb); },
    win: { min() {}, max() {}, close() {} }
  };

  window.fantasy = api;
})();
