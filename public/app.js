'use strict';
/* UI controller. Talks only to window.fantasy — injected by preload.cjs in the
   desktop app, or by demo.js in the browser preview harness. */
const FL = window.fantasy;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const PROF_PREFIX = 'prof:';
const PACK_NOTES = {
  vanilla: 'Pick Fabric, Quilt, Forge or NeoForge on the Play page first — Vanilla cannot load mods.',
  fabric: 'Sodium + Lithium + FerriteCore + Entity Culling + ImmediatelyFast + Iris (shaders) + Fabric API.',
  quilt: 'Sodium + Lithium + FerriteCore + Entity Culling + ImmediatelyFast + Iris (shaders).',
  forge: 'Embeddium + FerriteCore + Entity Culling + ImmediatelyFast + Oculus (shaders).',
  neoforge: 'Embeddium + FerriteCore + Entity Culling + ImmediatelyFast + Oculus (shaders).'
};

const state = {
  settings: { ramMB: 4096, width: 1280, height: 720, javaPath: '', loader: 'vanilla', version: '', accent: 'gold', theme: 'dark', performance: true },
  accounts: [],
  versions: [],
  profiles: [],
  modOffset: 0,
  modQuery: '',
  launching: false
};

function toast(msg, type = 'ok', title) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.innerHTML = `<div class="t-title">${title || (type === 'error' ? 'Something went wrong' : 'Fantasy Launcher')}</div><div>${msg}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 4600);
}

const fmtCount = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(1) + ' KB' : (b ? b + ' B' : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Navigation */
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
  $$('.page').forEach(p => p.classList.toggle('active', p.dataset.page === btn.dataset.nav));
  if (btn.dataset.nav === 'mods') refreshInstalled();
  if (btn.dataset.nav === 'shots') loadShots();
  if (btn.dataset.nav === 'settings') refreshKb();
}));

/* Window chrome + theme */
$('#win-min').onclick = () => FL.win.min();
$('#win-max').onclick = () => FL.win.max();
$('#win-close').onclick = () => FL.win.close();
if (!FL.isElectron) document.body.classList.add('web');

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  state.settings.theme = theme;
  $$('.seg-btn[data-theme-pick]').forEach(b => b.classList.toggle('on', b.dataset.themePick === theme));
}
$('#btn-theme').addEventListener('click', () => {
  const next = document.body.dataset.theme === 'divine' ? 'dark' : 'divine';
  applyTheme(next);
  FL.settings.set({ theme: next });
});
$$('.seg-btn[data-theme-pick]').forEach(btn => btn.addEventListener('click', () => {
  applyTheme(btn.dataset.themePick);
  FL.settings.set({ theme: btn.dataset.themePick });
}));

/* What Play will launch: vanilla + loader, or a saved loader profile. */
function currentTarget() {
  const raw = $('#sel-version').value || '';
  if (raw.startsWith(PROF_PREFIX)) {
    const id = raw.slice(PROF_PREFIX.length);
    const p = state.profiles.find(x => x.id === id);
    if (p) return { mergedId: id, version: p.mc, loader: p.loader, profile: p };
    return { mergedId: id };
  }
  return { version: raw, loader: $('#sel-loader').value };
}

/* Status bar + chips */
function refreshChrome() {
  const s = state.settings;
  const t = currentTarget();
  const active = state.accounts.find(a => a.active);
  const loaderName = LOADER_NAMES[t.loader] || s.loader;
  const versionLabel = t.profile ? t.profile.mc : (t.version || '—');
  $('#chip-account').textContent = active ? `Account: ${active.name}` : 'No account selected';
  $('#chip-ram').textContent = `${(s.ramMB / 1024).toFixed(s.ramMB % 1024 ? 1 : 0)} GB RAM`;
  $('#chip-loader').textContent = loaderName;
  $('#status-r').textContent = `${versionLabel}  ·  ${loaderName}  ·  ${active ? active.name : 'no account'}`;
  $('#mods-hint').textContent = t.loader === 'vanilla'
    ? `Showing every mod compatible with ${versionLabel}. Choose a loader on the Play page to filter by loader.`
    : `Showing ${loaderName} mods for ${versionLabel} (filters follow the Play page).`;
  $('#pack-note').textContent = PACK_NOTES[t.loader] || PACK_NOTES.vanilla;
  $('#btn-fps-pack').disabled = t.loader === 'vanilla';
  $('#installed-note').textContent = FL.isElectron
    ? `Installed for ${loaderName} ${versionLabel} — every version+loader combo keeps its own mods folder, so mods can never crash the wrong game. The ✓/⚠/✕ pill shows if a jar matches; drop-in .jar files are checked too.`
    : '';
}

/* Launch */
function setProgress(stage, percent, message) {
  $('#progress-wrap').hidden = false;
  $('#stage-msg').textContent = message || stage;
  if (percent >= 0) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    $('#stage-pct').textContent = `${p}%`;
    $('#pfill').style.width = `${p}%`;
  }
  if (stage === 'log') {
    const log = $('#launch-log');
    log.hidden = false;
    log.textContent += message + '\n';
    log.scrollTop = log.scrollHeight;
  }
  $('#status-l').textContent = message || stage;
}

FL.onProgress(d => setProgress(d.stage, d.percent, d.message));

/* Pre-launch mod compat check — resolves 'launch' | 'disable' | 'cancel'. */
function askModIssues(target, issues) {
  return new Promise(resolve => {
    const modal = $('#mod-modal');
    $('#mm-sub').innerHTML = `These mods don't match <b>${esc(target)}</b> and would likely crash at startup:`;
    $('#mm-list').innerHTML = issues.map(i =>
      `<div class="mm-item ${i.level}"><div class="n">${esc(i.title)}</div><div class="w">${esc(i.note)}</div></div>`).join('');
    modal.hidden = false;
    const done = v => { modal.hidden = true; cleanup(); resolve(v); };
    const onDis = () => done('disable');
    const onAny = () => done('launch');
    const onCancel = () => done('cancel');
    $('#mm-disable').addEventListener('click', onDis);
    $('#mm-anyway').addEventListener('click', onAny);
    $('#mm-cancel').addEventListener('click', onCancel);
    function cleanup() {
      $('#mm-disable').removeEventListener('click', onDis);
      $('#mm-anyway').removeEventListener('click', onAny);
      $('#mm-cancel').removeEventListener('click', onCancel);
    }
  });
}

$('#btn-play').addEventListener('click', async () => {
  if (state.launching) return;
  const active = state.accounts.find(a => a.active);
  if (!active) {
    toast('Create an offline profile first — opening Accounts.', 'error', 'No account');
    $$('.nav-btn').find(b => b.dataset.nav === 'accounts').click();
    return;
  }
  const t = currentTarget();
  if (!t.mergedId && !t.version) { toast('Pick a version first.', 'error'); return; }

  state.launching = true;
  const btn = $('#btn-play');
  const offPlay = () => { state.launching = false; btn.disabled = false; btn.lastChild.textContent = ' Play'; };
  btn.disabled = true;
  btn.lastChild.textContent = ' Launching…';
  $('#launch-log').hidden = true;
  $('#launch-log').textContent = '';
  $('#pfill').style.width = '0%';
  $('#stage-pct').textContent = '';
  try {
    // the mods folder follows this exact combo — sync settings first
    await FL.settings.set({ version: t.version, loader: t.loader });
    Object.assign(state.settings, { version: t.version, loader: t.loader });

    /* no-crash guard: flag wrong-loader / wrong-version jars before starting */
    if (FL.isElectron) {
      const installed = (await FL.mods.list()).filter(m => m.enabled);
      const targetLabel = `${LOADER_NAMES[t.loader] || t.loader} ${t.version || ''}`.trim();
      let issues = [];
      if (t.loader === 'vanilla' && installed.length) {
        issues = installed.map(m => ({ file: m.file, title: m.title, level: 'bad', note: 'Vanilla cannot load mods — pick a loader, or disable them.' }));
      } else {
        issues = installed.filter(m => m.compat && (m.compat.level === 'bad' || m.compat.level === 'warn'))
          .map(m => ({ file: m.file, title: m.title, level: m.compat.level, note: m.compat.note }));
      }
      if (issues.length) {
        const decision = await askModIssues(targetLabel, issues.slice(0, 8));
        if (decision === 'cancel') { offPlay(); return; }
        if (decision === 'disable') {
          for (const i of issues) { try { await FL.mods.toggle(i.file, false); } catch {} }
          toast(`${issues.length} mod${issues.length > 1 ? 's' : ''} disabled for this combo.`, 'ok', 'Mods');
          refreshInstalled();
        }
      }
    }

    refreshChrome();
    const payload = t.mergedId ? { mergedId: t.mergedId } : { version: t.version, loader: t.loader };
    await FL.game.launch(payload);
    toast('Game closed cleanly. Until next time.');
  } catch (e) {
    setProgress('error', 0, e.message);
    toast(esc(e.message), 'error');
  } finally {
    offPlay();
    await loadVersions(); // a loader may have just installed — surface its profile
  }
});

$('#sel-version').addEventListener('change', () => {
  const t = currentTarget();
  const sel = $('#sel-loader');
  if (t.profile) {
    sel.value = t.loader;
    sel.disabled = true;
    state.settings.version = t.version; state.settings.loader = t.loader;
    FL.settings.set({ version: t.version, loader: t.loader }); // mods view follows the profile's combo
  } else {
    sel.disabled = false;
    if (t.version) { state.settings.version = t.version; FL.settings.set({ version: t.version }); }
  }
  refreshChrome();
  refreshInstalled();
});
$('#sel-loader').addEventListener('change', e => { state.settings.loader = e.target.value; FL.settings.set({ loader: e.target.value }); refreshChrome(); refreshInstalled(); });

/* Versions + saved loader profiles */
async function loadVersions() {
  const sel = $('#sel-version');
  try {
    state.profiles = await FL.profiles.list();
  } catch { state.profiles = []; }
  try {
    const { versions, latest, offline } = await FL.versions.list();
    state.versions = versions;
    const groups = [];
    if (state.profiles.length) {
      groups.push(`<optgroup label="Loader profiles">` + state.profiles.map(p =>
        `<option value="${PROF_PREFIX}${esc(p.id)}">${LOADER_NAMES[p.loader]} ${esc(p.mc)} · ${esc(p.build)}</option>`).join('') + `</optgroup>`);
    }
    groups.push(`<optgroup label="Versions">` + versions.map(v =>
      `<option value="${esc(v.id)}">${esc(v.id)}${v.id === latest.release ? ' · latest' : ''}</option>`).join('') + `</optgroup>`);
    const prev = sel.value;
    sel.innerHTML = groups.join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    else if (state.settings.version && versions.some(v => v.id === state.settings.version)) sel.value = state.settings.version;
    else if (latest.release) { sel.value = latest.release; state.settings.version = latest.release; FL.settings.set({ version: latest.release }); }
    $('#sel-loader').value = state.settings.loader || 'vanilla';
    $('#sel-loader').disabled = Boolean(currentTarget().profile);
    if (offline) $('#status-l').textContent = 'Offline mode — showing versions already on this PC.';
  } catch (e) {
    sel.innerHTML = '<option value="">no versions cached — connect to internet once</option>';
    toast(esc(e.message), 'error', 'Version list');
  }
  refreshChrome();
}

/* Mods */
function modIconHtml(icon, title) {
  const letter = esc((title || '?')[0].toUpperCase());
  return icon
    ? `<img class="mod-icon" src="${esc(icon)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'mod-icon-fallback\\'>${letter}</div>'">`
    : `<div class="mod-icon-fallback">${letter}</div>`;
}

async function searchMods(reset = true) {
  const q = $('#mod-query').value.trim();
  if (reset) { state.modOffset = 0; state.modQuery = q; $('#mod-results').innerHTML = ''; }
  $('#mod-status').textContent = 'Searching…';
  try {
    const t = currentTarget();
    const data = await FL.mods.search({
      query: state.modQuery, loader: t.loader || state.settings.loader,
      version: t.version || state.settings.version, offset: state.modOffset
    });
    const hits = data.hits || [];
    $('#mod-status').textContent = hits.length
      ? `${data.total_hits ?? hits.length} mods found.`
      : 'Nothing found — try a different search or version.';
    $('#mod-loadmore-wrap').hidden = hits.length < 16;
    for (const h of hits) {
      const card = document.createElement('div');
      card.className = 'frame mod-card';
      card.innerHTML = `
        ${modIconHtml(h.icon_url, h.title)}
        <div class="mod-info">
          <span class="mod-name">${esc(h.title)}</span>
          <span class="mod-author">by ${esc(h.author || 'unknown')}</span>
          <p class="mod-desc">${esc(h.description || '')}</p>
          <div class="mod-foot">
            <span class="mod-dls">${fmtCount(h.downloads || 0)} downloads</span>
            <button class="btn-mini" data-id="${esc(h.project_id)}" data-title="${esc(h.title)}" data-icon="${esc(h.icon_url || '')}" data-author="${esc(h.author || '')}">Install</button>
          </div>
        </div>`;
      $('#mod-results').appendChild(card);
    }
  } catch (e) {
    $('#mod-status').textContent = e.message;
  }
}

$('#btn-mod-search').addEventListener('click', () => searchMods(true));
$('#mod-query').addEventListener('keydown', e => { if (e.key === 'Enter') searchMods(true); });
$('#btn-mod-more').addEventListener('click', () => { state.modOffset += 16; searchMods(false); });

$('#mod-results').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'Installing…';
  try {
    await FL.mods.install({ id: btn.dataset.id, title: btn.dataset.title, icon: btn.dataset.icon, author: btn.dataset.author });
    btn.textContent = 'Installed'; btn.classList.add('done');
    toast(`<b>${esc(btn.dataset.title)}</b> installed.`);
    refreshInstalled();
  } catch (err) {
    btn.textContent = 'Failed';
    toast(esc(err.message), 'error');
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Install'; }, 2600);
  }
});

$('#btn-fps-pack').addEventListener('click', async () => {
  const t = currentTarget();
  if (t.loader === 'vanilla') { toast(PACK_NOTES.vanilla, 'error', 'Loader needed'); return; }
  const btn = $('#btn-fps-pack');
  btn.disabled = true; btn.textContent = 'Installing…';
  try {
    const r = await FL.mods.installPack();
    const skippedNote = r.skipped.length ? ` (${r.skipped.length} skipped — no build for this version)` : '';
    toast(`Installed: <b>${esc(r.ok.join(', '))}</b>${esc(skippedNote)}`, 'ok', '⚡ Performance pack');
    refreshInstalled();
  } catch (e) {
    toast(esc(e.message), 'error');
  } finally {
    btn.disabled = t.loader === 'vanilla';
    btn.textContent = 'Install pack';
  }
});

async function refreshInstalled() {
  const list = await FL.mods.list();
  const wrap = $('#mod-installed');
  $('#installed-count').textContent = list.length ? `· ${list.length}` : '';
  if (!list.length) {
    wrap.innerHTML = `<p class="muted">Nothing installed yet. If you drop .jar files into the mods folder by hand, they will show up here.</p>`;
    return;
  }
  wrap.innerHTML = '';
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'installed-item' + (m.enabled ? '' : ' off');
    const pill = m.compat
      ? `<span class="pill pill-${m.compat.level}" title="${esc(m.compat.note)}">${({ ok: 'matches', warn: 'version?', bad: 'conflict', unknown: 'unknown' })[m.compat.level]}</span>`
      : '';
    row.innerHTML = `
      ${modIconHtml(m.icon, m.title)}
      <div class="installed-meta">
        <div class="t">${esc(m.title)}${pill}</div>
        <div class="s">${esc([m.versionName, m.author && 'by ' + m.author, fmtSize(m.size)].filter(Boolean).join('  ·  '))}</div>
      </div>
      <label class="switch" title="${m.enabled ? 'Disable' : 'Enable'}">
        <input type="checkbox" ${m.enabled ? 'checked' : ''} data-file="${esc(m.file)}">
        <span class="track"><span class="knob"></span></span>
      </label>
      <button class="icon-btn" title="Remove" data-del="${esc(m.file)}">✕</button>`;
    wrap.appendChild(row);
  }
}

$('#mod-installed').addEventListener('change', async e => {
  const input = e.target.closest('input[data-file]');
  if (!input) return;
  await FL.mods.toggle(input.dataset.file, input.checked);
  refreshInstalled();
});
$('#mod-installed').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  await FL.mods.remove(btn.dataset.del);
  toast('Mod removed.');
  refreshInstalled();
});

/* Screenshots */
async function loadShots() {
  const grid = $('#shots-grid');
  const empty = $('#shots-empty');
  let shots = [];
  if (FL.isElectron) {
    try { shots = await FL.shots.list(); } catch {}
  }
  grid.innerHTML = '';
  if (!FL.isElectron) {
    empty.hidden = false;
    empty.textContent = 'Screenshots are available in the desktop app.';
    return;
  }
  empty.hidden = shots.length > 0;
  empty.textContent = 'Screenshots appear after you play through this launcher (game folder → screenshots).';
  for (const s of shots) {
    const src = 'file:///' + s.file.replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
    const card = document.createElement('div');
    card.className = 'shot-card';
    card.innerHTML = `<img loading="lazy" src="${src}" alt="${esc(s.name)}"><div class="shot-name">${esc(s.name)}</div>`;
    card.querySelector('img').onclick = () => FL.shots.open(s.name);
    grid.appendChild(card);
  }
}
$('#btn-shots-refresh').addEventListener('click', loadShots);

/* Accounts */
function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
}

/* avatar: locally saved skin face > online lookup; skins are 64x64, face sits at (8,8)-(16,16) */
function avatarHtml(a) {
  if (a.localSkin && FL.isElectron) {
    return `<div class="acc-avatar skin-face" style="background-image:url('${fileUrl(a.localSkin)}')" title="Local skin"></div>`;
  }
  return `<img class="acc-avatar" src="https://minotar.net/helm/${encodeURIComponent(a.name)}/42.png" alt="" onerror="this.outerHTML='<div class=\\'acc-avatar-fallback\\'>${esc(a.name[0].toUpperCase())}</div>'">`;
}

async function refreshAccounts() {
  state.accounts = await FL.accounts.list();
  const wrap = $('#account-list');
  if (!state.accounts.length) {
    wrap.innerHTML = `<p class="muted">No profiles yet. Create one on the left.</p>`;
  } else {
    wrap.innerHTML = '';
    for (const a of state.accounts) {
      const card = document.createElement('div');
      card.className = 'account-card' + (a.active ? ' active' : '');
      card.innerHTML = `
        ${avatarHtml(a)}
        <div class="acc-info">
          <div class="acc-name">${esc(a.name)}</div>
          <span class="acc-tag ${a.type}">${a.type === 'offline' ? 'Offline profile' : 'Premium'}</span>
          ${a.active ? '<span class="acc-tag active"> · Selected</span>' : ''}
        </div>
        <button class="btn-mini" data-skin="${esc(a.id)}" title="Change skin (PNG)">Skin</button>
        ${a.active ? '' : `<button class="btn-mini" data-select="${esc(a.id)}">Select</button>`}
        <button class="icon-btn" title="Delete" data-banish="${esc(a.id)}">✕</button>`;
      wrap.appendChild(card);
    }
  }
  refreshChrome();
}

$('#btn-acc-add').addEventListener('click', async () => {
  try {
    const acc = await FL.accounts.addOffline($('#acc-name').value);
    $('#acc-name').value = '';
    toast(`Profile <b>${esc(acc.name)}</b> created and selected.`);
    refreshAccounts();
  } catch (e) { toast(esc(e.message), 'error'); }
});
$('#acc-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-acc-add').click(); });

$('#account-list').addEventListener('click', async e => {
  const sel = e.target.closest('button[data-select]');
  const ban = e.target.closest('button[data-banish]');
  const skinBtn = e.target.closest('button[data-skin]');
  if (sel) { await FL.accounts.select(sel.dataset.select); refreshAccounts(); }
  if (ban) { await FL.accounts.remove(ban.dataset.banish); toast('Profile deleted.'); refreshAccounts(); }
  if (skinBtn) {
    try {
      await FL.accounts.setSkin(skinBtn.dataset.skin, 'classic');
      toast('Skin saved to your library. To show it on offline servers, use a skin mod in-game (e.g. FabricTailor).', 'ok', 'Skin');
      refreshAccounts();
    } catch (err) { toast(esc(err.message), 'error', 'Skin'); }
  }
});

/* Microsoft sign-in arrives in a later release (button is disabled for now). */

/* Settings */
function drawRam() {
  const r = $('#set-ram');
  $('#set-ram-out').textContent = (r.value / 1024).toFixed(r.value % 1024 ? 1 : 0) + ' GB';
  r.style.setProperty('--fill', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
}

async function initSettings() {
  const s = await FL.settings.get();
  Object.assign(state.settings, s);
  document.body.dataset.accent = s.accent || 'gold';
  applyTheme(s.theme || 'dark');
  $('#set-ram').value = s.ramMB; drawRam();
  $('#set-perf').checked = s.performance !== false;
  $('#set-w').value = s.width; $('#set-h').value = s.height;
  $('#set-java').value = s.javaPath || '';
  $('#sel-loader').value = s.loader || 'vanilla';
  $('#set-discord').checked = s.discordRpc !== false;
  const hp = $('#set-hideplay'); if (hp) hp.checked = s.hideOnPlay !== false;
  try { $('#set-dir').value = await FL.game.dir(); } catch { $('#set-dir').value = '—'; }
}

$('#set-discord').addEventListener('change', e => { FL.settings.set({ discordRpc: e.target.checked }); toast(e.target.checked ? 'Discord status on — friends will see what you play.' : 'Discord status off.'); });
{ const hp = $('#set-hideplay'); if (hp) hp.addEventListener('change', e => { FL.settings.set({ hideOnPlay: e.target.checked }); toast(e.target.checked ? 'Launcher will step aside while you play.' : 'Launcher stays open while you play.'); }); }

$('#set-ram').addEventListener('input', drawRam);
$('#set-ram').addEventListener('change', e => { const v = +e.target.value; state.settings.ramMB = v; FL.settings.set({ ramMB: v }); refreshChrome(); });
$('#set-perf').addEventListener('change', e => { state.settings.performance = e.target.checked; FL.settings.set({ performance: e.target.checked }); toast(e.target.checked ? 'Performance mode on — tuned Java flags active.' : 'Performance mode off.'); });
$('#set-w').addEventListener('change', e => { const v = Math.max(320, +e.target.value || 854); state.settings.width = v; FL.settings.set({ width: v }); });
$('#set-h').addEventListener('change', e => { const v = Math.max(240, +e.target.value || 480); state.settings.height = v; FL.settings.set({ height: v }); });
$('#set-java').addEventListener('change', e => { state.settings.javaPath = e.target.value.trim(); FL.settings.set({ javaPath: state.settings.javaPath }); });

async function openFolder(which) {
  if (!FL.isElectron) { toast('Folder access is available in the desktop app.'); return; }
  await FL.shell.open(which);
}
$('#btn-open-game').addEventListener('click', () => openFolder('game'));
$('#btn-open-mods').addEventListener('click', () => openFolder('mods'));

$$('.accent-dot').forEach(dot => dot.addEventListener('click', () => {
  document.body.dataset.accent = dot.dataset.accentPick;
  state.settings.accent = dot.dataset.accentPick;
  FL.settings.set({ accent: dot.dataset.accentPick });
}));

/* Java manager */
$('#btn-java-check').addEventListener('click', async () => {
  const st = $('#java-status');
  st.textContent = 'Checking Java…';
  if (!FL.isElectron) {
    st.textContent = 'In the desktop app: existing Java is used if compatible; otherwise a private copy is downloaded into the launcher folder. Your system Java is never modified.';
    return;
  }
  try {
    const s = await FL.java.status();
    const lines = [];
    if (s.custom) lines.push(`Custom: ${s.custom.ver} (${s.custom.bin})`);
    if (s.system) lines.push(`System: ${s.system.ver} (${s.system.bin})`);
    s.bundled.forEach(b => lines.push(`Launcher's copy: Java ${b.ver}`));
    const t = currentTarget();
    const mc = t.version || state.settings.version || '1.21.1';
    st.textContent = lines.length ? lines.join('\n') + `\nChecking what ${mc} needs…` : `No Java found — installing a private copy for ${mc}…`;
    const j = await FL.java.ensure(mc);
    st.textContent = (lines.length ? lines.join('\n') + '\n' : '') + `Ready for ${mc}: Java ${j.ver} (${j.source === 'bundled' ? "launcher's private copy" : j.source}). System Java unchanged.`;
  } catch (e) {
    st.textContent = e.message;
    toast(esc(e.message), 'error', 'Java');
  }
});

/* Keybind presets */
async function refreshKb() {
  try {
    const [list, cur] = await Promise.all([FL.keybinds.list(), FL.keybinds.currentCount()]);
    $('#kb-current').textContent = `Keybinds currently set in the game: ${cur}.`;
    const wrap = $('#kb-list');
    wrap.innerHTML = list.length ? '' : '<p class="muted">No presets saved yet — play once, set controls in-game, come back.</p>';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'installed-item';
      row.innerHTML = `
        <div class="installed-meta">
          <div class="t">${esc(p.name)}</div>
          <div class="s">${p.count} keybinds · saved ${new Date(p.createdAt).toLocaleDateString()}</div>
        </div>
        <button class="btn-mini" data-kb-apply="${esc(p.name)}">Apply</button>
        <button class="icon-btn" title="Delete" data-kb-del="${esc(p.name)}">✕</button>`;
      wrap.appendChild(row);
    }
  } catch {}
}

$('#kb-save').addEventListener('click', async () => {
  try {
    const p = await FL.keybinds.save($('#kb-name').value);
    $('#kb-name').value = '';
    toast(`Preset <b>${esc(p.name)}</b> saved (${p.lines.length} keybinds).`);
    refreshKb();
  } catch (e) { toast(esc(e.message), 'error', 'Keybinds'); }
});
$('#kb-list').addEventListener('click', async e => {
  const ap = e.target.closest('[data-kb-apply]');
  const del = e.target.closest('[data-kb-del]');
  if (ap) {
    try {
      await FL.keybinds.apply(ap.dataset.kbApply);
      toast(`Preset <b>${esc(ap.dataset.kbApply)}</b> applied — restart the game if it's open. (Backup: options.txt.bak)`);
    } catch (err) { toast(esc(err.message), 'error', 'Keybinds'); }
    refreshKb();
  }
  if (del) { await FL.keybinds.remove(del.dataset.kbDel); refreshKb(); }
});

/* Updates */
$('#btn-update-check').addEventListener('click', async () => {
  try {
    const r = await FL.updates.check();
    if (r.updateAvailable) {
      toast(`New version <b>${esc(r.latest)}</b> is out — opening the download page…`, 'ok', 'Update available');
      if (r.url) window.open(r.url, '_blank');
    } else {
      toast(`You're on the latest build (${esc(r.latest || 'v1.0.0')}).`, 'ok', 'Up to date');
    }
  } catch (e) { toast(esc(e.message), 'ok', 'Updates'); }
});

/* Boot */
(async function boot() {
  await initSettings();
  await refreshAccounts();
  await loadVersions();
  refreshInstalled();
  searchMods(true);
  const active = state.accounts.find(a => a.active);
  $('#status-l').textContent = active
    ? `Signed in as ${active.name}`
    : 'Ready. Create a profile in Accounts to start playing.';
})();
