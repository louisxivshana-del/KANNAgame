// おちgame — 顔合体パズル
// 顔写真を登録したレベルは切り抜きの形、未登録のレベルは四角・丸・三角・しずくのピース。
(() => {
  'use strict';

  const { Engine, Bodies, Body, Composite, Events, Common, Vertices } = Matter;
  if (window.decomp) Common.setDecomp(window.decomp); // 凹みのある顔の形を分割して計算する

  // ---- 画面（論理座標） ----
  const W = 400, H = 760;
  const WALL_L = 10, WALL_R = 390, FLOOR = 715;
  const DROP_Y = 125;       // 落とす前のピースの高さ
  const LINE_Y = 178;       // ゲームオーバーライン
  const OVER_LIMIT = 3;     // ラインを超え続けて良い秒数
  const BORN_GRACE = 0.8;   // 出現直後はライン判定しない秒数
  const DROP_COOLDOWN = 0.6;

  // ---- レベル定義 ----
  const MAX_LEVEL = 8;
  // ピースの大きさ（半径）。Lv1 から Lv8 まで同じ割合（約1.34倍ずつ）でなだらかに大きくする
  const RADIUS_MIN = 17;    // Lv1
  const RADIUS_MAX = 129;   // Lv8（難易度アップのため大きめ）
  const RADIUS = [0];       // [1..8]
  for (let lv = 1; lv <= 8; lv++) RADIUS.push(RADIUS_MIN * Math.pow(RADIUS_MAX / RADIUS_MIN, (lv - 1) / 7));
  const COLOR = [null, '#ff8fab', '#ffb347', '#ffe066', '#9be15d',
    '#4cc9f0', '#7b8cff', '#c77dff', '#ff5d8f'];
  const MERGE_SCORE = [0, 1, 3, 6, 10, 15, 21, 28];                 // LvN+LvN → N+1
  const VANISH_SCORE = 50;                                          // Lv8+Lv8
  const SHAPES = ['square', 'circle', 'triangle', 'drop'];
  const PHOTO_POINTS = 14;  // 顔ピースの当たり判定の点の数（軽さ優先で間引く）

  // ---- 状態 ----
  let engine, state, score, best = Ranking.best();
  let levelShape, templates;   // レベルごとの形（ゲーム開始時にランダム決定）
  let photoGeo;                // 顔ピースの形（ゲーム開始時に計算）
  let current, next, dropX, dropAngle, cooldown;
  let mergeQueue, particles, popups, overTimer, overAnim, now = 0;
  let maxReached, playTime, resultShown;
  let rings = [], shake = 0, flash = 0;
  let muted = (() => { try { return localStorage.getItem('kanna.muted') === '1'; } catch { return false; } })();

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let scale = 1, DPR = 1;

  // ---- ユーティリティ ----
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- 形の生成 ----
  // しずく型：x = sin t · sin(t/2), y = -cos t（先端が上）。凸形なので分割不要。
  function dropVertices(r, n = 16) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push({ x: Math.sin(t) * Math.sin(t / 2), y: -Math.cos(t) });
    }
    // 面積を同じ半径の円に揃える
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      area += a.x * b.y - b.x * a.y;
    }
    const k = Math.sqrt((Math.PI * r * r) / Math.abs(area / 2));
    return pts.map(p => ({ x: p.x * k, y: p.y * k }));
  }

  // 上向きの正三角形（R = 外接円の半径）
  function triangleVertices(R) {
    return [-90, 30, 150].map(d => ({ x: R * Math.cos(d * Math.PI / 180), y: R * Math.sin(d * Math.PI / 180) }));
  }

  // 顔の切り抜きから、当たり判定の頂点と描画用の情報を作る。
  // 面積が同じレベルの円と同じになるよう拡大縮小する。
  function buildPhotoGeo(level, face) {
    let pts = Faces.resample(face.poly, PHOTO_POINTS);
    if (Faces.area(pts) < 0) pts = pts.reverse();
    if (Faces.selfIntersects(pts)) pts = Vertices.hull(pts.map(p => ({ x: p.x, y: p.y })));
    const r = RADIUS[level];
    const k = Math.sqrt((Math.PI * r * r) / Math.abs(Faces.area(pts)));
    const c = Faces.centroid(pts);
    const tr = (p) => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k });
    // 切り抜いた形にぴったり沿ったレベル色のふちを付けた画像を作る（ステッカー風）
    const pad = Math.ceil(2.5 / k);
    const out = document.createElement('canvas');
    out.width = face.w + pad * 2;
    out.height = face.h + pad * 2;
    const o = out.getContext('2d');
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * Math.PI * 2;
      o.drawImage(face.img, pad + Math.cos(t) * pad, pad + Math.sin(t) * pad);
    }
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = COLOR[level];
    o.fillRect(0, 0, out.width, out.height);
    o.globalCompositeOperation = 'source-over';
    o.drawImage(face.img, pad, pad);
    return {
      img: out,
      verts: pts.map(tr),
      ox: (-c.x - pad) * k, oy: (-c.y - pad) * k, dw: out.width * k, dh: out.height * k,
    };
  }

  function makeBody(level, x, y, angle = 0) {
    const r = RADIUS[level];
    const opts = { restitution: 0.08, friction: 0.35, frictionStatic: 0.6, frictionAir: 0.012, density: 0.0012 };
    let body;
    switch (levelShape[level]) {
      case 'photo': body = Bodies.fromVertices(x, y, [photoGeo[level].verts.map(v => ({ ...v }))], opts); break;
      case 'circle': body = Bodies.circle(x, y, r, opts, 14); break;
      case 'square': body = Bodies.rectangle(x, y, r * 1.75, r * 1.75, opts); break;
      case 'triangle': body = Bodies.fromVertices(x, y, [triangleVertices(r * 1.5)], opts); break;
      default: body = Bodies.fromVertices(x, y, [dropVertices(r)], opts); break;
    }
    Body.setAngle(body, angle);
    body.level = level;
    body.born = now;
    body.overT = 0;
    return body;
  }

  // 描画用テンプレート（重心基準・角度0の頂点）
  function buildTemplates() {
    templates = [null];
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      if (levelShape[lv] === 'photo') {
        templates.push({ photo: true, r: RADIUS[lv], ...photoGeo[lv] });
        continue;
      }
      const b = makeBody(lv, 0, 0, 0);
      templates.push({
        circle: levelShape[lv] === 'circle',
        r: RADIUS[lv],
        verts: b.vertices.map(v => ({ x: v.x - b.position.x, y: v.y - b.position.y })),
      });
    }
  }

  function halfWidth(level, angle) {
    const t = templates[level];
    if (t.circle) return t.r;
    const c = Math.cos(angle), s = Math.sin(angle);
    let m = 0;
    for (const v of t.verts) m = Math.max(m, Math.abs(v.x * c - v.y * s));
    return m;
  }

  // ---- ゲーム進行 ----
  // play=false のときは盤面だけ用意してタイトル表示
  function newGame(play = true) {
    if (engine) { Composite.clear(engine.world, false); Engine.clear(engine); }
    engine = Engine.create({ positionIterations: 6, velocityIterations: 4 });
    engine.gravity.y = 1.3;

    const wallOpts = { isStatic: true, friction: 0.4, restitution: 0 };
    Composite.add(engine.world, [
      Bodies.rectangle(W / 2, FLOOR + 50, W * 2, 100, wallOpts),
      Bodies.rectangle(WALL_L - 50, H / 2, 100, H * 2, wallOpts),
      Bodies.rectangle(WALL_R + 50, H / 2, 100, H * 2, wallOpts),
    ]);
    Events.on(engine, 'collisionStart', onCollide);
    Events.on(engine, 'collisionActive', onCollide);

    levelShape = [null];
    photoGeo = [null];
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const face = Faces.get(lv);
      photoGeo.push(face ? buildPhotoGeo(lv, face) : null);
      levelShape.push(face ? 'photo' : SHAPES[randInt(0, SHAPES.length - 1)]);
    }
    buildTemplates();

    state = play ? 'play' : 'title';
    score = 0;
    mergeQueue = []; particles = []; popups = [];
    rings = []; shake = 0; flash = 0;
    overTimer = 0; overAnim = 0;
    maxReached = 0; playTime = 0; resultShown = false;
    best = Ranking.best();
    current = randInt(1, 3);
    next = randInt(1, 3);
    dropAngle = rand(-0.4, 0.4);
    dropX = W / 2;
    cooldown = 0;
  }

  function dropPiece() {
    if (state !== 'play' || cooldown > 0) return;
    const hw = halfWidth(current, dropAngle);
    const x = clamp(dropX, WALL_L + hw, WALL_R - hw);
    Composite.add(engine.world, makeBody(current, x, DROP_Y, dropAngle));
    maxReached = Math.max(maxReached, current);
    sound(220 + current * 40, 0.06, 'triangle', 0.08);
    current = next;
    next = randInt(1, 3);
    dropAngle = rand(-0.4, 0.4);
    cooldown = DROP_COOLDOWN;
  }

  function onCollide(e) {
    for (const pair of e.pairs) {
      const a = pair.bodyA.parent, b = pair.bodyB.parent;
      if (!a.level || a.level !== b.level || a.merging || b.merging) continue;
      a.merging = b.merging = true;
      mergeQueue.push([a, b]);
    }
  }

  function processMerges() {
    for (const [a, b] of mergeQueue) {
      Composite.remove(engine.world, [a, b]);
      const x = (a.position.x + b.position.x) / 2;
      const y = (a.position.y + b.position.y) / 2;
      const lv = a.level;
      if (lv < MAX_LEVEL) {
        const nb = makeBody(lv + 1, x, y, (a.angle + b.angle) / 2);
        Body.setVelocity(nb, {
          x: (a.velocity.x + b.velocity.x) / 2,
          y: Math.min(0, (a.velocity.y + b.velocity.y) / 2),
        });
        // 壁にめり込まないよう補正
        const hw = halfWidth(lv + 1, nb.angle);
        Body.setPosition(nb, { x: clamp(x, WALL_L + hw, WALL_R - hw), y: Math.min(y, FLOOR - RADIUS[lv + 1]) });
        nb.pop = now; // ぽんっと膨らむ演出
        Composite.add(engine.world, nb);
        maxReached = Math.max(maxReached, lv + 1);
        addScore(MERGE_SCORE[lv], x, y);
        burst(x, y, COLOR[lv + 1], 10 + lv * 3);
        rings.push({ x, y, r: RADIUS[lv + 1] * 0.6, to: RADIUS[lv + 1] * 1.7, life: 0.35, max: 0.35, color: COLOR[lv + 1] });
        if (lv >= 4) shake = Math.max(shake, lv * 1.2);
        if (lv >= 6) vibrate(15);
        mergeSound(lv + 1);
      } else {
        // Lv8 同士：消滅（大きな演出）
        addScore(VANISH_SCORE, x, y, '消滅！');
        burst(x, y, COLOR[MAX_LEVEL], 50);
        burst(x, y, '#ffffff', 30);
        burst(x, y, '#ffe066', 30);
        rings.push({ x, y, r: 20, to: 260, life: 0.6, max: 0.6, color: '#ffffff' });
        rings.push({ x, y, r: 10, to: 180, life: 0.5, max: 0.5, color: COLOR[MAX_LEVEL] });
        shake = 16;
        flash = 0.5;
        vibrate([40, 30, 80]);
        vanishSound();
      }
    }
    mergeQueue.length = 0;
  }

  function addScore(pts, x, y, label = '') {
    score += pts;
    popups.push({ x, y, text: `${label}+${pts}`, life: label ? 1.4 : 0.9, big: !!label });
  }

  function checkOver(dt) {
    let worst = 0;
    for (const b of Composite.allBodies(engine.world)) {
      if (!b.level) continue;
      if (now - b.born > BORN_GRACE && b.bounds.min.y < LINE_Y) b.overT += dt;
      else b.overT = 0;
      worst = Math.max(worst, b.overT);
    }
    overTimer = worst;
    if (worst >= OVER_LIMIT) {
      state = 'over';
      overAnim = 0;
      sound(300, 0.8, 'sawtooth', 0.1, 120);
    }
  }

  // ---- エフェクト・音 ----
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(60, 220);
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.6), color });
    }
  }

  let audio = null;
  function initAudio() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
    }
    // スマホでは操作のたびに再開しないと音が止まっていることがある
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  }
  function sound(freq, dur, type, vol, to = 0, delay = 0) {
    if (!audio || muted) return;
    const t = audio.currentTime + delay, o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  }

  // 合体音：レベルが上がるほど高く、和音が厚くなる
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19]; // ペンタトニック
  function mergeSound(level) {
    const base = 392 * Math.pow(2, SCALE[level - 1] / 12);
    sound(base, 0.18, 'sine', 0.12);
    sound(base * 1.5, 0.16, 'triangle', 0.05, 0, 0.04);
    if (level >= 5) sound(base * 2, 0.22, 'sine', 0.06, 0, 0.08);
  }
  function vanishSound() {
    [523, 659, 784, 1047].forEach((f, i) => sound(f, 0.35, 'triangle', 0.12, 0, i * 0.08));
    sound(1568, 0.6, 'sine', 0.06, 0, 0.32);
  }
  function vibrate(pattern) {
    if (!muted && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* ignore */ } }
  }

  // ---- 入力 ----
  const keys = new Set();
  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  }
  let pointerDown = false;
  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (state !== 'play') return;
    pointerDown = true;
    dropX = toLogical(e).x;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state === 'play' && (pointerDown || e.pointerType === 'mouse')) dropX = toLogical(e).x;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    dropX = toLogical(e).x;
    dropPiece();
  });
  canvas.addEventListener('pointercancel', () => { pointerDown = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しメニューを出さない
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return; // 名前入力中はゲーム操作しない
    initAudio();
    keys.add(e.code);
    if (['Space', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (state === 'play' && (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'Enter')) dropPiece();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // ---- 更新 ----
  const STEP = 1000 / 60;
  let acc = 0;
  function update(dtMs) {
    const dt = dtMs / 1000;
    now += dt;
    if (state === 'play') {
      playTime += dt;
      if (keys.has('ArrowLeft') || keys.has('KeyA')) dropX -= 320 * dt;
      if (keys.has('ArrowRight') || keys.has('KeyD')) dropX += 320 * dt;
      const hw = halfWidth(current, dropAngle);
      dropX = clamp(dropX, WALL_L + hw, WALL_R - hw);
      cooldown = Math.max(0, cooldown - dt);

      acc += dtMs;
      let steps = 0;
      while (acc >= STEP && steps < 3) {
        Engine.update(engine, STEP);
        processMerges();
        acc -= STEP;
        steps++;
      }
      if (steps === 3) acc = 0;
      checkOver(dt);
    } else if (state === 'pause') {
      return; // 一時停止中は演出も止める
    } else if (state === 'over') {
      overAnim += dt;
      if (!resultShown && overAnim > 0.9) { resultShown = true; UI.showResult(); }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 400 * dt;
      if ((p.life -= dt) <= 0) particles.splice(i, 1);
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].y -= 40 * dt;
      if ((popups[i].life -= dt) <= 0) popups.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      if ((rings[i].life -= dt) <= 0) rings.splice(i, 1);
    }
    shake = Math.max(0, shake - dt * 40);
    flash = Math.max(0, flash - dt);
  }

  // ---- 描画 ----
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    canvas.width = Math.round(W * scale * DPR);
    canvas.height = Math.round(H * scale * DPR);
  }
  window.addEventListener('resize', resize);

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (s) => clamp(Math.round(((n >> s) & 255) * f), 0, 255);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  // 合体直後のピースを 0.6 → 1.08 → 1 と膨らませる（見た目だけ。当たり判定は最初から実寸）
  function popScale(b) {
    if (!b.pop) return 1;
    const t = (now - b.pop) / 0.2;
    if (t >= 1) { b.pop = 0; return 1; }
    const c = 2.2;
    return 0.6 + 0.4 * (1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2));
  }

  // テンプレートを (x, y, angle, scale) に描く
  function drawPiece(level, x, y, angle, s = 1, alpha = 1) {
    const t = templates[level];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
    if (t.photo) {
      // 顔ピース：レベル色のふち付きの切り抜き画像（数字は書かない）
      ctx.drawImage(t.img, t.ox, t.oy, t.dw, t.dh);
      ctx.restore();
      return;
    }
    ctx.beginPath();
    if (t.circle) ctx.arc(0, 0, t.r, 0, Math.PI * 2);
    else {
      ctx.moveTo(t.verts[0].x, t.verts[0].y);
      for (let i = 1; i < t.verts.length; i++) ctx.lineTo(t.verts[i].x, t.verts[i].y);
      ctx.closePath();
    }
    ctx.fillStyle = COLOR[level];
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = shade(COLOR[level], 0.7);
    ctx.stroke();
    // ハイライト
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(-t.r * 0.3, -t.r * 0.35, t.r * 0.22, t.r * 0.13, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // レベル数字（回転させない）。顔写真を登録したレベルには表示しない
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = shade(COLOR[level], 0.45);
    ctx.font = `bold ${Math.max(10, t.r * 0.8 * s)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(level, x, y + 1);
    ctx.restore();
  }

  function render() {
    ctx.setTransform(scale * DPR, 0, 0, scale * DPR, 0, 0);
    ctx.fillStyle = '#f6e7cf';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);

    // 箱
    ctx.fillStyle = '#fff8ec';
    ctx.fillRect(WALL_L, LINE_Y - 30, WALL_R - WALL_L, FLOOR - LINE_Y + 30);
    ctx.strokeStyle = '#c8a27a';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(WALL_L - 3, LINE_Y - 30); ctx.lineTo(WALL_L - 3, FLOOR + 3);
    ctx.lineTo(WALL_R + 3, FLOOR + 3); ctx.lineTo(WALL_R + 3, LINE_Y - 30);
    ctx.stroke();

    // ゲームオーバーライン
    const danger = overTimer > 0.3;
    ctx.strokeStyle = danger && Math.floor(now * 8) % 2 ? '#ff3b5c' : 'rgba(255,90,110,0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(WALL_L, LINE_Y); ctx.lineTo(WALL_R, LINE_Y); ctx.stroke();
    ctx.setLineDash([]);

    // ピース
    for (const b of Composite.allBodies(engine.world)) {
      if (b.level) drawPiece(b.level, b.position.x, b.position.y, b.angle, popScale(b));
    }

    // 落とす前のピース
    if (state === 'play') {
      const hw = halfWidth(current, dropAngle);
      const x = clamp(dropX, WALL_L + hw, WALL_R - hw);
      ctx.strokeStyle = 'rgba(160,120,80,0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, DROP_Y); ctx.lineTo(x, FLOOR); ctx.stroke();
      drawPiece(current, x, DROP_Y, dropAngle, 1, cooldown > 0 ? 0.35 : 1);
    }

    // エフェクト
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life * 2, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      const t = 1 - r.life / r.max;
      ctx.globalAlpha = r.life / r.max;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 6 * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r + (r.to - r.r) * (1 - (1 - t) * (1 - t)), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const p of popups) {
      ctx.globalAlpha = clamp(p.life * 2, 0, 1);
      ctx.font = `bold ${p.big ? 30 : 18}px sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#fff8ec';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.big ? '#ff3b78' : '#5a3b1f';
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 1.2})`;
      ctx.fillRect(0, 0, W, H);
    }

    drawHUD();
    if (state === 'over') drawOver();
  }

  function drawHUD() {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5a3b1f';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('SCORE', 16, 26);
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(score, 16, 56);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#8a6a4a';
    ctx.fillText(`BEST ${best}`, 16, 74);

    // NEXT
    ctx.textAlign = 'center';
    ctx.fillStyle = '#5a3b1f';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('NEXT', W - 46, 26);
    ctx.fillStyle = '#fff8ec';
    ctx.beginPath(); ctx.arc(W - 46, 56, 26, 0, Math.PI * 2); ctx.fill();
    drawPiece(next, W - 46, 56, 0, 20 / Math.max(20, RADIUS[next]));

    // 3秒カウントダウン
    if (state === 'play' && overTimer > 0.3) {
      ctx.fillStyle = '#ff3b5c';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(Math.ceil(OVER_LIMIT - overTimer), W / 2, LINE_Y - 8);
    }

    // 進化表
    const slot = (WALL_R - WALL_L) / MAX_LEVEL;
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const cx = WALL_L + slot * (lv - 0.5);
      drawPiece(lv, cx, 740, 0, 13 / RADIUS[lv]);
      if (lv < MAX_LEVEL) {
        ctx.fillStyle = '#b89470';
        ctx.font = '10px sans-serif';
        ctx.fillText('›', cx + slot / 2, 744);
      }
    }
  }

  function drawOver() {
    if (resultShown) return; // リザルト画面（HTML）が出たらそちらに任せる
    ctx.fillStyle = `rgba(60,35,15,${Math.min(0.45, overAnim)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('GAME OVER', W / 2, H / 2);
  }

  // ---- 画面（タイトル・リザルト・ランキング） ----
  const UI = (() => {
    const $ = (id) => document.getElementById(id);
    let lastEntry = null; // 直前に登録した記録（ランキングで強調）

    const show = Screens.show;

    function start() {
      initAudio();
      show(null);
      newGame(true);
    }

    function showTitle() {
      newGame(false);
      show('scr-title');
    }

    function showResult() {
      $('res-score').textContent = score;
      $('res-detail').textContent = `最高 Lv${maxReached} ・ ${Math.floor(playTime / 60)}分${Math.floor(playTime % 60)}秒`;
      const rank = Ranking.rankOf(score);
      $('rankin').hidden = rank < 0;
      $('res-buttons').hidden = rank >= 0;
      if (rank >= 0) {
        $('rankin-title').textContent = `ランクイン！ ${rank + 1}位`;
        $('name-input').value = Ranking.lastName();
      } else {
        $('res-best').textContent = `ベスト ${best}`;
      }
      show('scr-result');
      if (rank >= 0) setTimeout(() => $('name-input').focus(), 50);
    }

    function submitName(e) {
      e.preventDefault();
      const name = $('name-input').value.trim().slice(0, 10) || 'ななし';
      lastEntry = { name, score, maxLevel: maxReached, date: Date.now() };
      Ranking.add(lastEntry);
      best = Ranking.best();
      $('name-input').blur();
      showRanking();
    }

    function showRanking() {
      const list = Ranking.load();
      const ol = $('rank-list');
      ol.textContent = '';
      list.forEach((e, i) => {
        const li = document.createElement('li');
        if (lastEntry && e.date === lastEntry.date && e.score === lastEntry.score) li.className = 'me';
        const d = new Date(e.date);
        const cells = [
          ['pos', `${i + 1}`],
          ['name', e.name],
          ['score', `${e.score}`],
          ['meta', `最高 Lv${e.maxLevel || '-'} ・ ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`],
        ];
        for (const [cls, text] of cells) {
          const span = document.createElement('span');
          span.className = cls;
          span.textContent = text; // 名前はテキストとして表示（HTMLとして解釈しない）
          li.appendChild(span);
        }
        ol.appendChild(li);
      });
      $('rank-empty').hidden = list.length > 0;
      show('scr-ranking');
    }

    $('btn-start').addEventListener('click', start);
    $('btn-rank').addEventListener('click', () => { lastEntry = null; showRanking(); });
    $('btn-faces').addEventListener('click', () => Faces.openManager(showTitle));
    $('rankin').addEventListener('submit', submitName);
    $('btn-retry').addEventListener('click', start);
    $('btn-res-rank').addEventListener('click', () => { lastEntry = null; showRanking(); });
    $('btn-res-title').addEventListener('click', showTitle);
    $('btn-rank-play').addEventListener('click', start);
    $('btn-rank-title').addEventListener('click', showTitle);

    // ---- 一時停止 ----
    function pause() {
      if (state !== 'play') return;
      state = 'pause';
      pointerDown = false;
      keys.clear();
      show('scr-pause');
    }
    function resume() {
      if (state !== 'pause') return;
      initAudio();
      state = 'play';
      acc = 0;
      show(null);
    }
    $('btn-pause').addEventListener('click', pause);
    $('btn-resume').addEventListener('click', resume);
    $('btn-restart').addEventListener('click', start);
    $('btn-pause-title').addEventListener('click', showTitle);
    // アプリを切り替えたり画面を消したりしたら自動で一時停止
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Escape' || e.code === 'KeyP') { if (state === 'play') pause(); else resume(); }
    });

    // ---- 音のオン・オフ ----
    const soundBtn = $('btn-sound');
    function refreshSound() {
      soundBtn.classList.toggle('off', muted);
      soundBtn.setAttribute('aria-pressed', String(!muted));
    }
    soundBtn.addEventListener('click', () => {
      muted = !muted;
      try { localStorage.setItem('kanna.muted', muted ? '1' : '0'); } catch { /* ignore */ }
      refreshSound();
      initAudio();
    });
    refreshSound();

    // プレイ中だけ上部ボタンを表示
    const hud = $('hud');
    function syncHud() {
      const v = state !== 'play';
      if (hud.hidden !== v) hud.hidden = v;
    }

    return { showTitle, showResult, syncHud };
  })();

  // ---- メインループ ----
  let last = performance.now();
  function frame(t) {
    const dtMs = Math.min(100, t - last);
    last = t;
    update(dtMs);
    render();
    UI.syncHud();
    requestAnimationFrame(frame);
  }

  resize();
  Faces.init().finally(() => {
    UI.showTitle();
    requestAnimationFrame(frame);
  });

  // オフライン対応（Webサーバー経由で開いたときのみ）
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => { document.getElementById('offline-note').hidden = false; })
      .catch((e) => console.info('オフライン対応を有効にできませんでした', e));
  }

  // テスト・デバッグ用
  window.__kanna = {
    get state() { return state; },
    get score() { return score; },
    get pieces() { return Composite.allBodies(engine.world).filter(b => b.level).length; },
    get maxLevel() { return Math.max(0, ...Composite.allBodies(engine.world).map(b => b.level || 0)); },
    get shapes() { return levelShape.slice(1); },
    forceOver() { overTimer = OVER_LIMIT; state = 'over'; overAnim = 0; },
    drop(x) { dropX = x; dropPiece(); },
    spawn(level, x, y) { Composite.add(engine.world, makeBody(level, x, y)); },
  };
})();
