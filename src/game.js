// KANNA — 夜明けのランタン (v0.1 prototype)
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const dark = document.createElement('canvas');
  const dctx = dark.getContext('2d');

  // ---- 定数 ----
  const LIGHT_MAX = 100;
  const LIGHT_DECAY = 2.2;      // 毎秒の減少量
  const FIREFLY_GAIN = 12;
  const HIT_DAMAGE = 25;
  const BURST_COST = 15;
  const BURST_RADIUS = 170;
  const PLAYER_SPEED = 230;
  const INVINCIBLE_TIME = 1.0;
  const HISCORE_KEY = 'kanna.hiscore';

  let W = 0, H = 0, DPR = 1;
  let state = 'title'; // title | play | over
  let player = null, shadows = [], fireflies = null, particles = [], rings = [];
  let light = 0, score = 0, time = 0, kills = 0, spawnTimer = 0, fireflyTimer = 0, shake = 0;
  let hiscore = loadHiscore();
  let newRecord = false;

  // ---- 画面サイズ ----
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    for (const c of [canvas, dark]) {
      c.width = Math.floor(W * DPR);
      c.height = Math.floor(H * DPR);
    }
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    dctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (player) {
      player.x = clamp(player.x, 20, W - 20);
      player.y = clamp(player.y, 20, H - 20);
    }
  }
  window.addEventListener('resize', resize);

  // ---- ユーティリティ ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function loadHiscore() {
    try { return Number(localStorage.getItem(HISCORE_KEY)) || 0; } catch { return 0; }
  }
  function saveHiscore(v) {
    try { localStorage.setItem(HISCORE_KEY, String(v)); } catch { /* ignore */ }
  }
  const lightRadius = () => 60 + light * 2.2;

  // ---- サウンド (Web Audio で簡易合成) ----
  let audio = null;
  function initAudio() {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  }
  function tone(freq, dur, type = 'sine', vol = 0.15, slide = 0) {
    if (!audio) return;
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  }
  const sfx = {
    pick: () => { tone(880, 0.12, 'sine', 0.12, 440); },
    hit: () => { tone(160, 0.3, 'sawtooth', 0.15, -100); },
    burst: () => { tone(300, 0.5, 'triangle', 0.2, 900); tone(600, 0.4, 'sine', 0.1, 600); },
    over: () => { tone(400, 1.2, 'triangle', 0.2, -340); },
  };

  // ---- 入力 ----
  const keys = new Set();
  const pointer = { active: false, x: 0, y: 0 };
  let lastTap = 0;

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (state !== 'play' && (e.code === 'Enter' || e.code === 'Space')) startGame();
    else if (state === 'play' && e.code === 'Space' && !e.repeat) burst();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (state !== 'play') { startGame(); return; }
    const now = performance.now();
    if (now - lastTap < 300) burst();
    lastTap = now;
    pointer.active = true;
    pointer.x = e.clientX; pointer.y = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointer.active) return;
    pointer.x = e.clientX; pointer.y = e.clientY;
  });
  const release = () => { pointer.active = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // ---- ゲーム進行 ----
  function startGame() {
    initAudio();
    state = 'play';
    player = { x: W / 2, y: H / 2, r: 12, inv: 0, face: 1, bob: 0 };
    shadows = []; fireflies = []; particles = []; rings = [];
    light = LIGHT_MAX; score = 0; time = 0; kills = 0;
    spawnTimer = 2; fireflyTimer = 0.5; shake = 0;
    newRecord = false;
    for (let i = 0; i < 4; i++) spawnFirefly();
  }

  function gameOver() {
    state = 'over';
    sfx.over();
    const final = Math.floor(score);
    if (final > hiscore) { hiscore = final; saveHiscore(hiscore); newRecord = true; }
  }

  function spawnFirefly() {
    const m = 40;
    fireflies.push({
      x: rand(m, W - m), y: rand(m, H - m),
      phase: rand(0, Math.PI * 2), life: rand(9, 14),
      vx: rand(-15, 15), vy: rand(-15, 15),
    });
  }

  function spawnShadow() {
    const side = Math.floor(rand(0, 4));
    const m = 30;
    let x, y;
    if (side === 0) { x = rand(0, W); y = -m; }
    else if (side === 1) { x = W + m; y = rand(0, H); }
    else if (side === 2) { x = rand(0, W); y = H + m; }
    else { x = -m; y = rand(0, H); }
    const speed = 55 + Math.min(time * 1.6, 110) + rand(-10, 15);
    shadows.push({ x, y, r: rand(13, 19), speed, phase: rand(0, 6), wobble: rand(0.6, 1.4) });
  }

  function burst() {
    if (state !== 'play' || light <= BURST_COST) return;
    light -= BURST_COST;
    sfx.burst();
    rings.push({ x: player.x, y: player.y, r: 10, life: 0.45 });
    shake = 8;
    for (let i = shadows.length - 1; i >= 0; i--) {
      const s = shadows[i];
      if (dist(s, player) < BURST_RADIUS + s.r) {
        puff(s.x, s.y, '#5b4a9e', 14);
        shadows.splice(i, 1);
        kills++;
        score += 25;
      }
    }
  }

  function puff(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(40, 180);
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.7), max: 0.7, color });
    }
  }

  function update(dt) {
    if (state !== 'play') {
      // タイトル・リザルトでも蛍は漂わせる
      if (!fireflies) { fireflies = []; for (let i = 0; i < 12; i++) spawnFirefly(); }
      for (const f of fireflies) moveFirefly(f, dt);
      return;
    }

    time += dt;
    score += dt;
    light -= LIGHT_DECAY * (1 + time / 180) * dt;

    // 移動
    let dx = 0, dy = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
    if (pointer.active) {
      const px = pointer.x - player.x, py = pointer.y - player.y;
      const d = Math.hypot(px, py);
      if (d > 8) { dx = px / d * Math.min(1, d / 60); dy = py / d * Math.min(1, d / 60); }
    }
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    player.x = clamp(player.x + dx * PLAYER_SPEED * dt, 14, W - 14);
    player.y = clamp(player.y + dy * PLAYER_SPEED * dt, 14, H - 14);
    if (dx !== 0) player.face = Math.sign(dx);
    player.bob += dt * (len > 0.1 ? 12 : 3);
    player.inv = Math.max(0, player.inv - dt);

    // 蛍
    fireflyTimer -= dt;
    if (fireflyTimer <= 0 && fireflies.length < 8) { spawnFirefly(); fireflyTimer = rand(1.0, 2.2); }
    for (let i = fireflies.length - 1; i >= 0; i--) {
      const f = fireflies[i];
      moveFirefly(f, dt);
      f.life -= dt;
      if (dist(f, player) < player.r + 14) {
        light = Math.min(LIGHT_MAX, light + FIREFLY_GAIN);
        score += 10;
        sfx.pick();
        puff(f.x, f.y, '#fff3a0', 8);
        fireflies.splice(i, 1);
      } else if (f.life <= 0) {
        fireflies.splice(i, 1);
      }
    }

    // 影
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnShadow();
      spawnTimer = Math.max(0.35, 2.2 - time * 0.03) * rand(0.7, 1.3);
    }
    const lr = lightRadius();
    for (const s of shadows) {
      s.phase += dt * 3;
      const ax = player.x - s.x, ay = player.y - s.y;
      const d = Math.hypot(ax, ay) || 1;
      const slow = d < lr * 0.6 ? 0.6 : 1; // 光の中では鈍る
      const wob = Math.sin(s.phase * s.wobble) * 0.5;
      const nx = ax / d, ny = ay / d;
      s.x += (nx - ny * wob) * s.speed * slow * dt;
      s.y += (ny + nx * wob) * s.speed * slow * dt;
      if (player.inv <= 0 && d < s.r + player.r) {
        light -= HIT_DAMAGE;
        player.inv = INVINCIBLE_TIME;
        shake = 12;
        sfx.hit();
        puff(player.x, player.y, '#ff9a5a', 16);
        // ノックバック
        s.x -= nx * 60; s.y -= ny * 60;
      }
    }

    // エフェクト
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.92; p.vy *= 0.92;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= dt;
      r.r += (BURST_RADIUS - r.r) * 12 * dt;
      if (r.life <= 0) rings.splice(i, 1);
    }
    shake = Math.max(0, shake - dt * 40);

    if (light <= 0) { light = 0; gameOver(); }
  }

  function moveFirefly(f, dt) {
    f.phase += dt * 2;
    f.x += (f.vx + Math.cos(f.phase * 0.7) * 25) * dt;
    f.y += (f.vy + Math.sin(f.phase) * 25) * dt;
    if (f.x < 20 || f.x > W - 20) f.vx *= -1;
    if (f.y < 20 || f.y > H - 20) f.vy *= -1;
    f.x = clamp(f.x, 20, W - 20);
    f.y = clamp(f.y, 20, H - 20);
  }

  // ---- 描画 ----
  const trees = [];
  function ensureTrees() {
    if (trees.length && trees.w === W && trees.h === H) return;
    trees.length = 0;
    trees.w = W; trees.h = H;
    const n = Math.floor((W * H) / 22000);
    for (let i = 0; i < n; i++) trees.push({ x: rand(0, W), y: rand(0, H), s: rand(0.6, 1.4) });
    trees.sort((a, b) => a.y - b.y);
  }

  function drawWorld() {
    ensureTrees();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1b2440');
    g.addColorStop(1, '#14301f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 木
    for (const t of trees) {
      ctx.fillStyle = '#0f2a1a';
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - 34 * t.s);
      ctx.lineTo(t.x - 16 * t.s, t.y);
      ctx.lineTo(t.x + 16 * t.s, t.y);
      ctx.fill();
      ctx.fillStyle = '#2a1d14';
      ctx.fillRect(t.x - 2.5 * t.s, t.y, 5 * t.s, 8 * t.s);
    }
  }

  function drawFireflies(now) {
    for (const f of fireflies) {
      const tw = 0.6 + 0.4 * Math.sin(now * 0.006 + f.phase * 3);
      const fade = state === 'play' ? Math.min(1, f.life / 2) : 1;
      ctx.globalAlpha = tw * fade;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 16);
      g.addColorStop(0, 'rgba(255,250,180,1)');
      g.addColorStop(0.3, 'rgba(220,255,120,0.6)');
      g.addColorStop(1, 'rgba(180,255,80,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(f.x, f.y, 16, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawShadows() {
    for (const s of shadows) {
      const r = s.r * (1 + Math.sin(s.phase) * 0.08);
      ctx.fillStyle = 'rgba(20,10,40,0.92)';
      ctx.beginPath();
      ctx.arc(s.x, s.y - r * 0.2, r, Math.PI, 0);
      // ゆらめく裾
      for (let i = 0; i <= 4; i++) {
        const px = s.x + r - (i / 4) * r * 2;
        const py = s.y + r * 0.7 + Math.sin(s.phase * 2 + i) * 3;
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // 目
      const ex = (player.x - s.x) / (dist(player, s) || 1) * 2;
      ctx.fillStyle = '#ff4f6a';
      ctx.beginPath();
      ctx.arc(s.x - r * 0.35 + ex, s.y - r * 0.25, 2.4, 0, Math.PI * 2);
      ctx.arc(s.x + r * 0.35 + ex, s.y - r * 0.25, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPlayer() {
    const p = player;
    if (p.inv > 0 && Math.floor(p.inv * 15) % 2 === 0) return;
    const by = Math.sin(p.bob) * 1.5;
    const x = p.x, y = p.y + by;
    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 14, 10, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    // 着物（巫女風）
    ctx.fillStyle = '#c8303c';
    ctx.beginPath();
    ctx.moveTo(x - 9, y + 13); ctx.lineTo(x + 9, y + 13); ctx.lineTo(x + 6, y); ctx.lineTo(x - 6, y);
    ctx.fill();
    ctx.fillStyle = '#f4f0ea';
    ctx.fillRect(x - 6, y - 4, 12, 6);
    // 頭
    ctx.fillStyle = '#ffe1c8';
    ctx.beginPath(); ctx.arc(x, y - 10, 7, 0, Math.PI * 2); ctx.fill();
    // 髪
    ctx.fillStyle = '#1e1428';
    ctx.beginPath(); ctx.arc(x, y - 12, 7.5, Math.PI, 0); ctx.fill();
    ctx.fillRect(x - p.face * 7 - 2, y - 12, 4, 12);
    // 目
    ctx.fillStyle = '#1e1428';
    ctx.fillRect(x + p.face * 2 - 1, y - 10, 2, 2.5);
    // ランタン
    const lx = x + p.face * 11, ly = y + 2 + Math.sin(p.bob * 0.5) * 1.5;
    ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x + p.face * 6, y - 1); ctx.lineTo(lx, ly - 5); ctx.stroke();
    ctx.fillStyle = '#ffcf6a';
    ctx.fillRect(lx - 3.5, ly - 4, 7, 8);
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(lx - 4, ly - 5, 8, 2); ctx.fillRect(lx - 4, ly + 4, 8, 2);
  }

  function drawDarkness(now) {
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, W, H);
    dctx.fillStyle = 'rgba(4,3,14,0.96)';
    dctx.fillRect(0, 0, W, H);
    dctx.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => {
      const g = dctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.8})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      dctx.fillStyle = g;
      dctx.beginPath(); dctx.arc(x, y, r, 0, Math.PI * 2); dctx.fill();
    };
    if (state === 'play') {
      const flicker = 1 + Math.sin(now * 0.02) * 0.02 + Math.sin(now * 0.053) * 0.015;
      hole(player.x, player.y, lightRadius() * flicker);
      for (const r of rings) hole(r.x, r.y, r.r * 1.3, Math.min(1, r.life * 3));
    }
    for (const f of fireflies) hole(f.x, f.y, 34, 0.7);
    ctx.drawImage(dark, 0, 0, W, H);

    // 暖色のランタン光を加算
    if (state === 'play') {
      ctx.globalCompositeOperation = 'lighter';
      const r = lightRadius();
      const g = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, r);
      g.addColorStop(0, 'rgba(255,170,70,0.28)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(player.x, player.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawEffects() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      ctx.strokeStyle = `rgba(255,230,150,${Math.max(0, r.life * 2)})`;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawHUD() {
    const bw = Math.min(260, W - 40), bx = 20, by = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx - 2, by - 2, bw + 4, 14);
    const ratio = clamp(light / LIGHT_MAX, 0, 1);
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, '#ff7a30'); g.addColorStop(1, '#ffe08a');
    ctx.fillStyle = ratio < 0.25 && Math.floor(time * 6) % 2 ? '#ff3a3a' : g;
    ctx.fillRect(bx, by, bw * ratio, 10);
    // バーストに必要な光のライン
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(bx + bw * (BURST_COST / LIGHT_MAX), by - 2, 2, 14);

    ctx.fillStyle = '#f5ecd7';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`SCORE ${Math.floor(score)}`, W - 20, 34);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = 'rgba(245,236,215,0.7)';
    ctx.fillText(`${time.toFixed(1)}s  撃退 ${kills}`, W - 20, 54);
    ctx.textAlign = 'left';
  }

  function centerText(lines) {
    ctx.textAlign = 'center';
    let y = H / 2 - (lines.length * 34) / 2;
    for (const [text, size, color] of lines) {
      ctx.font = `bold ${size}px sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(text, W / 2, y);
      y += size + 16;
    }
    ctx.textAlign = 'left';
  }

  function drawOverlay(now) {
    const blink = Math.floor(now / 500) % 2 === 0;
    const touch = matchMedia('(pointer: coarse)').matches;
    if (state === 'title') {
      centerText([
        ['KANNA', 56, '#ffd98a'],
        ['夜明けのランタン', 22, '#f5ecd7'],
        ['', 8, '#000'],
        [touch ? 'ドラッグで移動 / ダブルタップでバースト' : 'WASD・矢印で移動 / スペースでバースト', 14, 'rgba(245,236,215,0.8)'],
        ['蛍を集めて光を保ち、影から逃げ延びろ', 14, 'rgba(245,236,215,0.8)'],
        [blink ? (touch ? 'タップでスタート' : 'Enter / クリックでスタート') : '', 18, '#ffffff'],
        [hiscore ? `HI-SCORE ${hiscore}` : '', 14, '#ffd98a'],
      ]);
    } else if (state === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
      centerText([
        ['光が消えた…', 34, '#ffb38a'],
        [`SCORE ${Math.floor(score)}`, 28, '#ffffff'],
        [`生存 ${time.toFixed(1)}s ・ 撃退 ${kills}`, 15, 'rgba(245,236,215,0.8)'],
        [newRecord ? '★ NEW RECORD ★' : `HI-SCORE ${hiscore}`, 16, '#ffd98a'],
        [blink ? 'タップ / Enter でリトライ' : '', 18, '#ffffff'],
      ]);
    }
  }

  function render(now) {
    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);
    drawWorld();
    drawFireflies(now);
    if (state !== 'title') {
      drawShadows();
      drawPlayer();
    }
    drawDarkness(now);
    drawFireflies(now); // 闇の上にも蛍の輝きを重ねる
    drawEffects();
    ctx.restore();
    if (state === 'play') drawHUD();
    drawOverlay(now);
  }

  // ---- メインループ ----
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render(now);
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  // テスト・デバッグ用
  window.__kanna = { get state() { return state; }, get light() { return light; }, get score() { return score; } };
})();
