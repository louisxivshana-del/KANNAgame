// 顔ピース：写真の登録・顔の自動切り抜き・手動調整・端末内保存（IndexedDB）
// 写真はすべて端末の中だけで処理し、外部には送信しない。
const Faces = (() => {
  'use strict';

  const LEVELS = 8;
  const HANDLES = 28;        // 調整用の点の数（髪の輪郭も表せるよう多めに）
  const WORK_MAX = 1280;     // 編集用に縮小する元写真の最大辺
  const CROP_MAX = 320;      // 保存する切り抜き画像の最大辺
  const cache = new Map();   // level -> { img, poly, w, h }（ゲームが使う）
  const $ = (id) => document.getElementById(id);

  // ---- 幾何 ----
  function area(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function centroid(pts) {
    const a = area(pts);
    if (Math.abs(a) < 1e-6) {
      return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const f = p.x * q.y - q.x * p.y;
      cx += (p.x + q.x) * f;
      cy += (p.y + q.y) * f;
    }
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  // 輪郭を周長に沿って n 点に等間隔で取り直す
  function resample(pts, n) {
    const len = [];
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      len.push(d);
      total += d;
    }
    const out = [];
    let seg = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const target = (k / n) * total;
      while (seg < pts.length - 1 && acc + len[seg] < target) { acc += len[seg]; seg++; }
      const p = pts[seg], q = pts[(seg + 1) % pts.length];
      const t = len[seg] ? (target - acc) / len[seg] : 0;
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
    return out;
  }

  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function inside(pts, x, y) {
    let r = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
    }
    return r;
  }

  // 辺同士が交差しているか（交差した形は物理計算できないため判定に使う）
  function selfIntersects(pts) {
    const n = pts.length;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
      }
    }
    return false;
  }

  // なめらかな閉曲線（各辺の中点を通る2次曲線）でパスを描く
  function tracePath(c, pts) {
    const n = pts.length;
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const m0 = mid(pts[n - 1], pts[0]);
    c.moveTo(m0.x, m0.y);
    for (let i = 0; i < n; i++) {
      const p = pts[i], m = mid(p, pts[(i + 1) % n]);
      c.quadraticCurveTo(p.x, p.y, m.x, m.y);
    }
    c.closePath();
  }

  // ---- 端末内保存（IndexedDB） ----
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('kanna', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('faces', { keyPath: 'level' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('faces', mode);
      const req = fn(t.objectStore('faces'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  }
  const dbGetAll = () => tx('readonly', (s) => s.getAll());
  const dbGet = (lv) => tx('readonly', (s) => s.get(lv));
  const dbPut = (rec) => tx('readwrite', (s) => s.put(rec));
  const dbDelete = (lv) => tx('readwrite', (s) => s.delete(lv));

  function blobToImage(blob, keepUrl = true) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { if (!keepUrl) URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }
  const canvasToBlob = (c, type, q) => new Promise((resolve) => c.toBlob(resolve, type, q));

  function setCache(level, img, rec) {
    const old = cache.get(level);
    if (old) URL.revokeObjectURL(old.img.src);
    cache.set(level, { img, poly: rec.cropPoly, w: rec.cw, h: rec.ch });
  }

  async function init() {
    try {
      for (const rec of await dbGetAll()) setCache(rec.level, await blobToImage(rec.crop), rec);
    } catch (e) {
      console.info('顔ピースを読み込めませんでした', e);
    }
  }

  // ---- 顔と髪の自動検出（MediaPipe・端末内で実行） ----
  const url = (p) => new URL(p, document.baseURI).href;
  let visionPromise = null, detectorPromise = null, hairPromise = null;

  function visionTasks() {
    if (!visionPromise) {
      visionPromise = (async () => {
        const vision = await import(url('vendor/mediapipe/vision_bundle.mjs'));
        const fileset = await vision.FilesetResolver.forVisionTasks(url('vendor/mediapipe/wasm'));
        return { vision, fileset };
      })();
      visionPromise.catch(() => { visionPromise = null; });
    }
    return visionPromise;
  }

  function detector() {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        const { vision, fileset } = await visionTasks();
        const landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: url('vendor/mediapipe/face_landmarker.task') },
          runningMode: 'IMAGE',
          numFaces: 5,
        });
        return { landmarker, oval: ovalOrder(vision.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL) };
      })();
      detectorPromise.catch(() => { detectorPromise = null; });
    }
    return detectorPromise;
  }

  // 髪の毛の領域を塗り分けるモデル
  function hairSegmenter() {
    if (!hairPromise) {
      hairPromise = (async () => {
        const { vision, fileset } = await visionTasks();
        return vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: url('vendor/mediapipe/hair_segmenter.tflite') },
          runningMode: 'IMAGE',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
      })();
      hairPromise.catch(() => { hairPromise = null; });
    }
    return hairPromise;
  }

  // フェイスライン（線のつながり）を一周の点の順番に並べる
  function ovalOrder(conns) {
    const next = new Map(conns.map((c) => [c.start, c.end]));
    const first = conns[0].start;
    const order = [first];
    for (let cur = next.get(first); cur !== undefined && cur !== first && order.length <= conns.length; cur = next.get(cur)) {
      order.push(cur);
    }
    return order;
  }

  // 一番大きく写っている顔を切り抜く。withHair なら髪の毛も含める。
  // 戻り値 { pts, hair }（hair: 髪を含められたか）。顔が見つからなければ null
  async function detectFace(canvas, withHair = true) {
    const { landmarker, oval } = await detector();
    const result = landmarker.detect(canvas);
    let best = null, bestArea = 0;
    for (const face of result.faceLandmarks) {
      const pts = oval.map((i) => ({ x: face[i].x * canvas.width, y: face[i].y * canvas.height }));
      const a = Math.abs(area(pts));
      if (a > bestArea) { bestArea = a; best = pts; }
    }
    if (!best) return null;
    if (withHair) {
      try {
        const pts = await faceWithHair(canvas, best);
        if (pts) return { pts, hair: true };
      } catch (e) {
        console.info('髪の検出を使えません', e);
      }
    }
    const c = centroid(best);
    // フェイスラインのわずかに外側で切り抜く
    return { pts: resample(best.map((p) => ({ x: c.x + (p.x - c.x) * 1.05, y: c.y + (p.y - c.y) * 1.05 })), HANDLES), hair: false };
  }

  // 顔のまわりを髪のモデルで調べ、「顔＋つながった髪」の外側の輪郭を作る
  async function faceWithHair(canvas, ovalPts) {
    const segmenter = await hairSegmenter();
    const b = bbox(ovalPts);
    const fc = centroid(ovalPts);
    // 顔のまわりを広めに切り出して調べる（髪は上と横に広がる）
    const rx0 = Math.max(0, b.x - b.w * 1.3), rx1 = Math.min(canvas.width, b.x + b.w * 2.3);
    const ry0 = Math.max(0, b.y - b.h * 1.1), ry1 = Math.min(canvas.height, b.y + b.h * 2.0);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    const k = Math.min(1, 512 / Math.max(rw, rh));
    const mw = Math.max(1, Math.round(rw * k)), mh = Math.max(1, Math.round(rh * k));
    const region = document.createElement('canvas');
    region.width = mw; region.height = mh;
    region.getContext('2d').drawImage(canvas, rx0, ry0, rw, rh, 0, 0, mw, mh);

    const res = segmenter.segment(region);
    const masks = res.confidenceMasks || [];
    const hairMask = masks[masks.length - 1];
    if (!hairMask) { masks.forEach((m) => m.close()); return null; }
    const conf = hairMask.getAsFloat32Array();
    const cw = hairMask.width, ch = hairMask.height;

    // 顔（フェイスライン内側）＋髪 のマスク
    const toMask = (p) => ({ x: (p.x - rx0) * k * (cw / mw), y: (p.y - ry0) * k * (ch / mh) });
    const faceCanvas = document.createElement('canvas');
    faceCanvas.width = cw; faceCanvas.height = ch;
    const fctx = faceCanvas.getContext('2d');
    // フェイスラインは額の上部や耳を含まないので、少し広げて髪とのすき間を埋める
    const grown = ovalPts.map((p) => ({ x: fc.x + (p.x - fc.x) * 1.12, y: fc.y + (p.y - fc.y) * 1.12 }));
    fctx.beginPath();
    tracePath(fctx, grown.map(toMask));
    fctx.fill();
    const faceAlpha = fctx.getImageData(0, 0, cw, ch).data;
    const mask = new Uint8Array(cw * ch);
    let hairCount = 0;
    for (let i = 0; i < cw * ch; i++) {
      const hair = conf[i] > 0.5;
      if (hair) hairCount++;
      mask[i] = hair || faceAlpha[i * 4 + 3] > 127 ? 1 : 0;
    }
    masks.forEach((m) => m.close());

    const mb = bbox(ovalPts.map(toMask));
    const faceR = Math.max(mb.w, mb.h) / 2;
    if (hairCount < faceR * faceR * 0.15) return null; // 髪がほとんど見つからない（坊主・帽子など）

    // 顔の中心から放射状に線を伸ばし、マスクが途切れるところまでを輪郭とする
    const c = toMask(fc);
    const N = 96, gapTol = Math.max(3, faceR * 0.3), maxD = faceR * 2.4;
    const radii = [];
    for (let a = 0; a < N; a++) {
      const t = (a / N) * Math.PI * 2;
      const dx = Math.cos(t), dy = Math.sin(t);
      let last = 0, gap = 0;
      for (let d = 0; d < maxD; d += 1) {
        const x = Math.round(c.x + dx * d), y = Math.round(c.y + dy * d);
        if (x < 0 || y < 0 || x >= cw || y >= ch) break;
        if (mask[y * cw + x]) { last = d; gap = 0; } else if (++gap > gapTol) break;
      }
      radii.push(last);
    }
    // とげとげを抑える（中央値 → 平均でならす）
    const at = (arr, i) => arr[(i + arr.length) % arr.length];
    const med = radii.map((_, i) => [-2, -1, 0, 1, 2].map((o) => at(radii, i + o)).sort((p, q) => p - q)[2]);
    const smooth = med.map((_, i) => (at(med, i - 1) + at(med, i) + at(med, i + 1)) / 3);

    const back = (x, y) => ({ x: x / (k * (cw / mw)) + rx0, y: y / (k * (ch / mh)) + ry0 });
    const pts = smooth.map((r, i) => {
      const t = (i / N) * Math.PI * 2;
      const rr = r * 1.03 + 1;
      return back(c.x + Math.cos(t) * rr, c.y + Math.sin(t) * rr);
    });
    return resample(pts, HANDLES);
  }

  function defaultHandles(w, h) {
    const rx = Math.min(w, h) * 0.22, ry = rx * 1.3;
    const pts = [];
    for (let i = 0; i < HANDLES; i++) {
      const t = (i / HANDLES) * Math.PI * 2;
      pts.push({ x: w / 2 + Math.cos(t) * rx, y: h / 2 + Math.sin(t) * ry });
    }
    return pts;
  }

  // ---- 顔ピース一覧画面 ----
  let onClose = null;
  let pendingLevel = 0;

  function openManager(closeCallback) {
    onClose = closeCallback;
    renderManager();
    Screens.show('scr-faces');
  }

  function renderManager() {
    const grid = $('face-grid');
    grid.textContent = '';
    for (let lv = 1; lv <= LEVELS; lv++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const face = cache.get(lv);
      if (face) {
        const img = document.createElement('img');
        img.src = face.img.src;
        img.alt = `Lv${lv} の顔`;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '未登録';
        thumb.classList.add('empty');
      }
      const label = document.createElement('div');
      label.className = 'lv';
      label.textContent = `Lv${lv}`;
      const acts = document.createElement('div');
      acts.className = 'acts';
      const btn = (text, fn) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.addEventListener('click', fn);
        acts.appendChild(b);
      };
      btn(face ? '写真変更' : '写真', () => pickPhoto(lv));
      if (face) {
        btn('調整', () => reEdit(lv));
        btn('削除', () => remove(lv));
      }
      slot.append(thumb, label, acts);
      grid.appendChild(slot);
    }
  }

  function pickPhoto(lv) {
    pendingLevel = lv;
    const input = $('face-file');
    input.value = '';
    input.click();
  }

  async function reEdit(lv) {
    try {
      const rec = await dbGet(lv);
      if (rec) openEditor(lv, rec.original, rec.handles);
    } catch {
      alert('保存した写真を読み込めませんでした');
    }
  }

  async function remove(lv) {
    if (!confirm(`Lv${lv} の顔ピースを削除しますか？`)) return;
    try { await dbDelete(lv); } catch { /* 保存が使えない環境 */ }
    const old = cache.get(lv);
    if (old) URL.revokeObjectURL(old.img.src);
    cache.delete(lv);
    renderManager();
  }

  // ---- 切り抜き調整画面 ----
  const ed = { level: 0, work: null, handles: [], view: { s: 1, ox: 0, oy: 0 }, drag: null, busy: false };
  let edCanvas, edCtx, cssSize = 300, dpr = 1;

  async function openEditor(level, blob, handles = null) {
    ed.level = level;
    $('editor-title').textContent = `Lv${level} の切り抜き`;
    Screens.show('scr-editor');
    sizeEditor();
    status('写真を読み込み中…');
    try {
      const img = await blobToImage(blob, false);
      const k = Math.min(1, WORK_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ed.work = c;
    } catch {
      status('写真を読み込めませんでした');
      ed.work = null;
      return;
    }
    if (handles) {
      ed.handles = handles.map((p) => ({ ...p }));
      fitView();
      status('点をドラッグして形を調整できます');
    } else {
      await autoDetect();
    }
  }

  async function autoDetect(withHair = true) {
    if (!ed.work || ed.busy) return;
    ed.busy = true;
    status(withHair ? '顔と髪を探しています…' : '顔を探しています…');
    drawEditor();
    let found = null, failed = false;
    try { found = await detectFace(ed.work, withHair); } catch (e) { failed = true; console.info('顔検出を使えません', e); }
    ed.busy = false;
    ed.handles = found ? found.pts : defaultHandles(ed.work.width, ed.work.height);
    fitView();
    if (found && found.hair) status('顔と髪を切り抜きました。点をドラッグして調整できます');
    else if (found && withHair) status('顔を切り抜きました（髪は見つかりませんでした）。点をドラッグして調整できます');
    else if (found) status('顔だけを切り抜きました。点をドラッグして調整できます');
    else if (failed) status('自動切り抜きを使えません。枠を動かして顔に合わせてください');
    else status('顔が見つかりませんでした。枠を動かして顔に合わせてください');
  }

  function status(text) { $('editor-status').textContent = text; }

  function sizeEditor() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssSize = Math.max(200, Math.round(edCanvas.parentElement.clientWidth));
    edCanvas.style.width = edCanvas.style.height = `${cssSize}px`;
    edCanvas.width = edCanvas.height = Math.round(cssSize * dpr);
    drawEditor();
  }

  // 切り抜き枠が画面の6割ほどに収まるよう表示位置を合わせる
  function fitView() {
    const b = bbox(ed.handles);
    const size = Math.max(b.w, b.h, 1) * 1.7;
    ed.view.s = cssSize / size;
    ed.view.ox = cssSize / 2 - (b.x + b.w / 2) * ed.view.s;
    ed.view.oy = cssSize / 2 - (b.y + b.h / 2) * ed.view.s;
    drawEditor();
  }

  const toScreen = (p) => ({ x: p.x * ed.view.s + ed.view.ox, y: p.y * ed.view.s + ed.view.oy });
  const toImage = (p) => ({ x: (p.x - ed.view.ox) / ed.view.s, y: (p.y - ed.view.oy) / ed.view.s });

  function drawEditor() {
    if (!edCtx) return;
    const c = edCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#3a2a1c';
    c.fillRect(0, 0, cssSize, cssSize);
    if (!ed.work) return;
    c.save();
    c.translate(ed.view.ox, ed.view.oy);
    c.scale(ed.view.s, ed.view.s);
    c.drawImage(ed.work, 0, 0);
    c.restore();
    if (!ed.handles.length) return;
    const sp = ed.handles.map(toScreen);
    // 切り抜き枠の外側を暗くする
    c.beginPath();
    c.rect(0, 0, cssSize, cssSize);
    tracePath(c, sp);
    c.fillStyle = 'rgba(20,10,0,0.6)';
    c.fill('evenodd');
    c.beginPath();
    tracePath(c, sp);
    c.strokeStyle = '#ff8fab';
    c.lineWidth = 2.5;
    c.stroke();
    for (const p of sp) {
      c.beginPath();
      c.arc(p.x, p.y, 6, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = '#e0607f';
      c.stroke();
    }
  }

  function edPointer(e) {
    const r = edCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cssSize / r.width), y: (e.clientY - r.top) * (cssSize / r.height) };
  }

  function bindEditor() {
    edCanvas = $('editor-canvas');
    edCtx = edCanvas.getContext('2d');
    edCanvas.addEventListener('pointerdown', (e) => {
      if (!ed.work || ed.busy) return;
      const p = edPointer(e);
      edCanvas.setPointerCapture(e.pointerId);
      let best = -1, bestD = 22;
      ed.handles.forEach((h, i) => {
        const s = toScreen(h);
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) ed.drag = { type: 'handle', i: best };
      else {
        const ip = toImage(p);
        ed.drag = { type: inside(ed.handles, ip.x, ip.y) ? 'move' : 'pan', last: p };
      }
    });
    edCanvas.addEventListener('pointermove', (e) => {
      if (!ed.drag) return;
      const p = edPointer(e);
      if (ed.drag.type === 'handle') {
        ed.handles[ed.drag.i] = toImage(p);
      } else {
        const dx = p.x - ed.drag.last.x, dy = p.y - ed.drag.last.y;
        ed.drag.last = p;
        if (ed.drag.type === 'move') {
          for (const h of ed.handles) { h.x += dx / ed.view.s; h.y += dy / ed.view.s; }
        } else {
          ed.view.ox += dx; ed.view.oy += dy;
        }
      }
      drawEditor();
    });
    const end = () => { ed.drag = null; };
    edCanvas.addEventListener('pointerup', end);
    edCanvas.addEventListener('pointercancel', end);
    // ホイールで表示の拡大縮小
    edCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = edPointer(e);
      const ip = toImage(p);
      ed.view.s *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
      ed.view.ox = p.x - ip.x * ed.view.s;
      ed.view.oy = p.y - ip.y * ed.view.s;
      drawEditor();
    }, { passive: false });
    window.addEventListener('resize', () => { if ($('scr-editor').classList.contains('show')) sizeEditor(); });

    const scaleShape = (f) => {
      if (!ed.handles.length) return;
      const c = centroid(ed.handles);
      for (const h of ed.handles) { h.x = c.x + (h.x - c.x) * f; h.y = c.y + (h.y - c.y) * f; }
      drawEditor();
    };
    $('ed-bigger').addEventListener('click', () => scaleShape(1.08));
    $('ed-smaller').addEventListener('click', () => scaleShape(1 / 1.08));
    $('ed-auto').addEventListener('click', () => autoDetect(true));
    $('ed-auto-face').addEventListener('click', () => autoDetect(false));
    $('ed-fit').addEventListener('click', fitView);
    $('ed-cancel').addEventListener('click', () => { ed.work = null; openManager(onClose); });
    $('ed-save').addEventListener('click', save);
  }

  async function save() {
    if (!ed.work || ed.busy || ed.handles.length < 3) return;
    ed.busy = true;
    status('保存しています…');
    try {
      const b = bbox(ed.handles);
      const k = Math.min(2, CROP_MAX / Math.max(b.w, b.h));
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round(b.w * k));
      crop.height = Math.max(1, Math.round(b.h * k));
      const c = crop.getContext('2d');
      c.scale(k, k);
      c.translate(-b.x, -b.y);
      c.beginPath();
      tracePath(c, ed.handles);
      c.clip();
      c.drawImage(ed.work, 0, 0);
      const rec = {
        level: ed.level,
        crop: await canvasToBlob(crop, 'image/png'),
        cw: crop.width,
        ch: crop.height,
        cropPoly: ed.handles.map((p) => ({ x: (p.x - b.x) * k, y: (p.y - b.y) * k })),
        original: await canvasToBlob(ed.work, 'image/jpeg', 0.9),
        handles: ed.handles.map((p) => ({ ...p })),
        updated: Date.now(),
      };
      let saved = true;
      try { await dbPut(rec); } catch { saved = false; }
      setCache(rec.level, await blobToImage(rec.crop), rec);
      ed.busy = false;
      ed.work = null;
      if (!saved) alert('この環境では端末に保存できませんでした（このプレイ中だけ使えます）');
      openManager(onClose);
    } catch (e) {
      ed.busy = false;
      status('保存に失敗しました');
      console.error(e);
    }
  }

  function bind() {
    bindEditor();
    $('face-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) openEditor(pendingLevel, file);
    });
    $('btn-faces-back').addEventListener('click', () => { if (onClose) onClose(); });
  }
  bind();

  return {
    init,
    openManager,
    get: (level) => cache.get(level),
    tracePath, area, centroid, resample, selfIntersects,
  };
})();
