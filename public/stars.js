'use strict';
/* Ambient canvas: night stars + embers (dark theme), or drifting sunlit motes (divine theme). */
(function () {
  const cv = document.getElementById('fx');
  const ctx = cv.getContext('2d');
  let W, H, stars = [], motes = [];

  function resize() {
    W = cv.width = innerWidth;
    H = cv.height = innerHeight;
    stars = Array.from({ length: Math.round(W * H / 15000) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.25 + .3,
      p: Math.random() * Math.PI * 2,
      s: .008 + Math.random() * .02,
      v: Math.random() > .85
    }));
    motes = Array.from({ length: Math.round(W / 55) }, () => spawnMote(true));
  }

  function spawnMote(anywhere) {
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : -12,
      r: .8 + Math.random() * 2.4,
      vy: .12 + Math.random() * .35,
      sway: Math.random() * Math.PI * 2,
      swaySpd: .004 + Math.random() * .01,
      spark: Math.random() > .82
    };
  }

  const theme = () => document.body.dataset.theme || 'dark';
  const gold = () => getComputedStyle(document.body).getPropertyValue('--gold-strong').trim() || '#e9c76d';

  function drawDark() {
    for (const s of stars) {
      s.p += s.s;
      const a = .22 + .55 * (0.5 + Math.sin(s.p) / 2);
      ctx.globalAlpha = a;
      ctx.fillStyle = s.v ? '#b7a4f5' : '#e8dcae';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = gold();
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      m.y -= m.vy * 1.6;
      m.sway += m.swaySpd;
      m.x += Math.sin(m.sway) * .35;
      if (m.y < -14) motes[i] = { ...spawnMote(false), y: H + 12 };
      const life = Math.min(1, (H - m.y) / H + .35);
      ctx.globalAlpha = .5 * life;
      ctx.fillStyle = m.spark ? '#8b6cf0' : g;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawDivine() {
    const g = gold();
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      m.y += m.vy; // motes settle downward like dust in a cathedral beam
      m.sway += m.swaySpd;
      m.x += Math.sin(m.sway) * .3 + .08;
      if (m.y > H + 14 || m.x > W + 14) motes[i] = spawnMote(false);
      const glowA = m.spark ? .5 : .28;
      ctx.globalAlpha = glowA * Math.min(1, m.y / 120 + .25);
      ctx.fillStyle = m.spark ? '#ffffff' : g;
      ctx.shadowColor = g;
      ctx.shadowBlur = m.spark ? 12 : 6;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r * (m.spark ? 1.2 : 1), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    for (const s of stars.slice(0, 40)) {
      s.p += s.s;
      ctx.globalAlpha = .12 + .18 * (0.5 + Math.sin(s.p) / 2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x, s.y * .6, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    if (theme() === 'divine') drawDivine(); else drawDark();
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  addEventListener('resize', resize);
  resize();
  tick();
})();
