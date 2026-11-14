'use strict';
/* Tiny dependency-free HTTPS helpers with redirect support. */
const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'fantasy-launcher/0.1 (+https://fantasy.launcher)';

function getJson(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getJson(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('Bad JSON from ' + url)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* Download with redirects, stall timeout and optional (doneBytes,totalBytes) progress. */
function downloadToFile(url, dest, onProgress = null, redirects = 5) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const req = https.get(url, { headers: { 'User-Agent': UA }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadToFile(res.headers.location, dest, onProgress, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = +res.headers['content-length'] || 0;
      let done = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', chunk => {
        done += chunk.length;
        if (onProgress) {
          const pct = total ? Math.floor((done * 100) / total) : -1;
          if (pct !== lastPct) { lastPct = pct; try { onProgress(done, total); } catch {} }
        }
      });
      const fail = err => { try { fs.unlinkSync(dest); } catch {} reject(err); };
      res.on('error', fail);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('Download stalled — check the internet connection and press Play again.')));
    req.on('error', reject);
  });
}

/* POST with a JSON or urlencoded body; resolves {status, json}. */
function httpJson(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'User-Agent': UA, 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const urlencoded = obj => Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

module.exports = { getJson, downloadToFile, httpJson, urlencoded };
