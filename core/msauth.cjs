'use strict';
/*
 * Microsoft (premium) sign-in via the OAuth device-code flow, then
 * Xbox Live -> XSTS -> Minecraft Services. Needs a free Azure app
 * registration: portal.azure.com > App registrations > Mobile & desktop
 * (https://login.live.com/oauth20_desktop.srf redirect), "accounts in any
 * org + personal", public client. Paste its Application (client) ID below.
 */
const { httpJson, urlencoded, getJson } = require('./http.cjs');

const CLIENT_ID = ''; // <- Azure Application (client) ID; launcher refuses MS login while empty
const SCOPE = 'XboxLive.signin offline_access';

async function beginDeviceFlow() {
  if (!CLIENT_ID) {
    const e = new Error('Microsoft sign-in needs an Azure client id. Set CLIENT_ID in core/msauth.cjs (free at portal.azure.com).');
    e.code = 'NO_CLIENT_ID';
    throw e;
  }
  const { json } = await httpJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlencoded({ client_id: CLIENT_ID, scope: SCOPE })
  });
  if (!json || !json.user_code) throw new Error('Microsoft did not return a device code.');
  return { userCode: json.user_code, verifyUrl: json.verification_uri || 'https://www.microsoft.com/link', deviceCode: json.device_code, interval: (json.interval || 5) * 1000 };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollMsToken({ deviceCode, interval }, emit) {
  for (;;) {
    await sleep(interval);
    emit('msauth', -1, 'Waiting for approval on microsoft.com/link…');
    const { json } = await httpJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlencoded({ client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode })
    });
    if (json && json.access_token) return json;
    if (json && ['authorization_pending', 'slow_down'].includes(json.error)) continue;
    throw new Error((json && json.error_description) || 'Microsoft sign-in was cancelled.');
  }
}

async function msTokenToMcAccount(json) {
  return mcChain(json.access_token, json.refresh_token);
}

async function refreshMcAccount(refreshToken) {
  const { json } = await httpJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlencoded({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE })
  });
  if (!json || !json.access_token) throw new Error('Microsoft session expired — sign in again.');
  return mcChain(json.access_token, json.refresh_token);
}

async function mcChain(msAccessToken, refreshToken) {
  const xbl = await httpJson('https://user.auth.xboxlive.com/user/authenticate', {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    })
  });
  if (!xbl.json || !xbl.json.Token) throw new Error('Xbox Live authentication failed.');
  const uhs = xbl.json.DisplayClaims.xui[0].uhs;

  const xsts = await httpJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    })
  });
  if (!xsts.json || !xsts.json.Token) throw new Error('XSTS failed (this Microsoft account may not own an Xbox profile).');

  const mc = await httpJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}` })
  });
  if (!mc.json || !mc.json.access_token) throw new Error('Minecraft login failed.');
  const mcToken = mc.json.access_token;

  const own = await httpJson('https://api.minecraftservices.com/entitlements/mcstore', {
    method: 'GET', headers: { Authorization: `Bearer ${mcToken}` }
  });
  if (!own.json || !own.json.items || !own.json.items.length) throw new Error('This Microsoft account does not own Minecraft.');

  const prof = await httpJson('https://api.minecraftservices.com/minecraft/profile', {
    method: 'GET', headers: { Authorization: `Bearer ${mcToken}` }
  });
  if (!prof.json || !prof.json.id) throw new Error('Could not read the Minecraft profile.');

  return {
    type: 'ms',
    name: prof.json.name,
    uuid: prof.json.id,
    accessToken: mcToken,
    refreshToken,
    xuid: uhs,
    expiresAt: Date.now() + (mc.json.expires_in || 86400) * 1000
  };
}

async function ensureValidMs(acc) {
  if (acc.expiresAt && acc.expiresAt > Date.now() + 60_000) return acc;
  return refreshMcAccount(acc.refreshToken);
}

/* Upload a PNG skin to the official profile — visible everywhere, incl. premium servers. */
async function uploadSkin(accessToken, pngBuffer, variant) {
  const boundary = '----fantasy' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${variant}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, pngBuffer, tail]);
  const { status, json } = await httpJson('https://api.minecraftservices.com/minecraft/profile/skins', {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${accessToken}` },
    body
  });
  if (status < 200 || status >= 300) throw new Error((json && json.errorMessage) || `Skin upload failed (HTTP ${status}).`);
  return true;
}

module.exports = { beginDeviceFlow, pollMsToken, msTokenToMcAccount, ensureValidMs, uploadSkin, CLIENT_ID };
