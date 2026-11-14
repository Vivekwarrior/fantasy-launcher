'use strict';
/*
 * Discord Rich Presence via the local IPC socket (Discord desktop app must run).
 * A free Discord developer application provides the shown name + logo:
 * discord.com/developers > New Application "Fantasy Launcher" > Rich Presence
 * > upload asset named "logo" > paste the Application ID below.
 */
const CLIENT_ID = '1570819461324210337'; // <- Discord Application ID
const APP_NAME = 'Fantasy Launcher';

let RPC = null;
try { RPC = require('discord-rpc'); } catch {}
if (RPC && CLIENT_ID) { try { RPC.register(CLIENT_ID); } catch {} }

let client = null;
let retryTimer = null;
let wanted = false;
let lastActivity = null;

function setActivity(activity) {
  if (!client || !client.ready) { lastActivity = activity; return; }
  lastActivity = activity;
  client.setActivity({
    instance: false,
    largeImageKey: 'logo',
    largeImageText: APP_NAME,
    ...activity
  }).catch(() => {});
}

function destroy() {
  wanted = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (client) { try { client.destroy(); } catch {} client = null; }
}

function scheduleRetry() {
  if (!wanted || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 30000);
  if (retryTimer.unref) retryTimer.unref();
}

function connect() {
  if (!RPC || !CLIENT_ID || client) return;
  wanted = true;
  client = new RPC.Client({ transport: 'ipc' });
  client.on('ready', () => {
    client.ready = true;
    if (lastActivity) setActivity(lastActivity); else idle();
  });
  client.login({ clientId: CLIENT_ID }).catch(() => {
    try { client.destroy(); } catch {}
    client = null;
    scheduleRetry(); // Discord closed or not installed — check again later
  });
}

let idleSince = Date.now();

function idle() {
  setActivity({
    details: 'In the launcher',
    state: 'Picking an adventure',
    startTimestamp: idleSince
  });
}

function playing(version, loader) {
  idleSince = Date.now();
  setActivity({
    details: 'Playing Minecraft',
    state: [version, loader && loader !== 'vanilla' ? loader : null].filter(Boolean).join(' · '),
    startTimestamp: Date.now()
  });
}

module.exports = { connect, destroy, idle, playing, get enabled() { return Boolean(CLIENT_ID); } };
