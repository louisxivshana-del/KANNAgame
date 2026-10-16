// KANNA — 顔合体パズル v0.1
// 写真なしピース（四角・丸・三角・しずく）で遊べる合体パズルの土台。
(() => {
  'use strict';

  const { Engine, Bodies, Body, Composite, Events } = Matter;

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
  const RADIUS = [0, 17, 23, 30, 38, 48, 59, 72, 86];               // [1..8]
  const COLOR = [null, '#ff8fab', '#ffb347', '#ffe066', '#9be15d',
    '#4cc9f0', '#7b8cff', '#c77dff', '#ff5d8f'];
  const MERGE_SCORE = [0, 1, 3, 6, 10, 15, 21, 28];                 // LvN+LvN → N+1
  const VANISH_SCORE = 50;                                          // Lv8+Lv8
  const SHAPES = ['square', 'circle', 'triangle', 'drop'];
  const BEST_KEY = 'kanna.best';

  // ---- 状態 ----
  let engine, state, score, best = loadBest();
  let levelShape, templates;   // レベルごとの形（ゲーム開始時にランダム決定）
  let current, next, dropX, dropAngle, cooldown;
  let mergeQueue, particles, popups, overTimer, overAnim, newBest, now = 0;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let scale = 1, DPR = 1;

  // ---- ユーティリティ ----
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function loadBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; } }
  function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* ignore */ } }

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

  function makeBody(level, x, y, angle = 0) {
    const r = RADIUS[level];
    const opts = { restitution: 0.08, friction: 0.35, frictionStatic: 0.6, frictionAir: 0.012, density: 0.0012 };
    let body;
    switch (levelShape[level]) {
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
  function newGame() {
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
    for (let lv = 1; lv <= MAX_LEVEL; lv++) levelShape.push(SHAPES[randInt(0, SHAPES.length - 1)]);
    buildTemplates();

    state = 'play';
    score = 0;
    mergeQueue = []; particles = []; popups = [];
    overTimer = 0; overAnim = 0; newBest = false;
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
        Composite.add(engine.world, nb);
        addScore(MERGE_SCORE[lv], x, y);
        burst(x, y, COLOR[lv + 1], 10 + lv * 2);
        sound(330 * Math.pow(1.12, lv), 0.14, 'sine', 0.12);
      } else {
        addScore(VANISH_SCORE, x, y);
        burst(x, y, COLOR[MAX_LEVEL], 40);
        burst(x, y, '#ffffff', 20);
        sound(660, 0.4, 'triangle', 0.15, 1320);
      }
    }
    mergeQueue.length = 0;
  }

  function addScore(pts, x, y) {
    score += pts;
    popups.push({ x, y, text: `+${pts}`, life: 0.9 });
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
      if (score > best) { best = score; saveBest(best); newBest = true; }
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
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  }
  function sound(freq, dur, type, vol, to = 0) {
    if (!audio) return;
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
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
    if (state === 'over') { if (overAnim > 0.8) newGame(); return; }
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
  window.addEventListener('keydown', (e) => {
    initAudio();
    keys.add(e.code);
    if (['Space', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (state === 'over' && (e.code === 'Enter' || e.code === 'Space') && overAnim > 0.8) newGame();
    else if (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'Enter') dropPiece();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // ---- 更新 ----
  const STEP = 1000 / 60;
  let acc = 0;
  function update(dtMs) {
    const dt = dtMs / 1000;
    now += dt;
    if (state === 'play') {
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
    } else {
      overAnim += dt;
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

  // テンプレートを (x, y, angle, scale) に描く
  function drawPiece(level, x, y, angle, s = 1, alpha = 1) {
    const t = templates[level];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
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
    // レベル数字（回転させない）
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
      if (b.level) drawPiece(b.level, b.position.x, b.position.y, b.angle);
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
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px sans-serif';
    for (const p of popups) {
      ctx.globalAlpha = clamp(p.life * 2, 0, 1);
      ctx.fillStyle = '#5a3b1f';
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

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
    ctx.fillStyle = 'rgba(60,35,15,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('GAME OVER', W / 2, H / 2 - 70);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`SCORE ${score}`, W / 2, H / 2 - 20);
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#ffe066';
    ctx.fillText(newBest ? '★ ベスト更新！' : `BEST ${best}`, W / 2, H / 2 + 14);
    if (overAnim > 0.8 && Math.floor(now * 2) % 2 === 0) {
      ctx.fillStyle = '#fff';
      ctx.fillText('タップ / Enter でもう一度', W / 2, H / 2 + 60);
    }
  }

  // ---- メインループ ----
  let last = performance.now();
  function frame(t) {
    const dtMs = Math.min(100, t - last);
    last = t;
    update(dtMs);
    render();
    requestAnimationFrame(frame);
  }

  resize();
  newGame();
  requestAnimationFrame(frame);

  // テスト・デバッグ用
  window.__kanna = {
    get state() { return state; },
    get score() { return score; },
    get pieces() { return Composite.allBodies(engine.world).filter(b => b.level).length; },
    get maxLevel() { return Math.max(0, ...Composite.allBodies(engine.world).map(b => b.level || 0)); },
    get shapes() { return levelShape.slice(1); },
    drop(x) { dropX = x; dropPiece(); },
    spawn(level, x, y) { Composite.add(engine.world, makeBody(level, x, y)); },
  };
})();
