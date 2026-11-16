/* OCR văn bản (bản web): chạy hoàn toàn trong trình duyệt, không gửi dữ liệu ra ngoài. */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v); }
  for (const c of kids.flat()) e.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- thư viện (IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open("ocr_nd30", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("docs", { keyPath: "id" });
      rq.onsuccess = () => { DB.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(mode, fn) { return new Promise((res, rej) => { const t = DB.db.transaction("docs", mode); const r = fn(t.objectStore("docs")); t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error); }); },
  all() { return DB.tx("readonly", (s) => s.getAll()).then((a) => a.sort((x, y) => y.id.localeCompare(x.id))); },
  get(id) { return DB.tx("readonly", (s) => s.get(id)); },
  put(d) { return DB.tx("readwrite", (s) => s.put(d)); },
  del(id) { return DB.tx("readwrite", (s) => s.delete(id)); },
};

/* ---------------- OCR ---------------- */
const pool = { workers: [], free: [], waiters: [], creating: 0, size: 0 };
const autoThreads = () => Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
async function makeWorker(onStatus) {
  onStatus?.("Đang nạp bộ nhận dạng tiếng Việt (lần đầu mất vài giây)…");
  const w = await Tesseract.createWorker("vie", 1, { workerPath: "vendor/worker.min.js", corePath: "vendor/", langPath: "lang", gzip: false, workerBlobURL: false, cacheMethod: "none" });
  await w.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" });
  return w;
}
async function acquire(onStatus) {
  if (pool.free.length) return pool.free.pop();
  if (pool.workers.length + pool.creating < (pool.size || autoThreads())) {
    pool.creating++;
    try { const w = await makeWorker(onStatus); pool.workers.push(w); return w; } finally { pool.creating--; }
  }
  return new Promise((r) => pool.waiters.push(r));
}
function release(w) { const n = pool.waiters.shift(); if (n) n(w); else pool.free.push(w); }

function estimateSkew(gray, w, h) {
  const f = Math.max(1, Math.round(w / 700)), sw = Math.floor(w / f), sh = Math.floor(h / f);
  const small = new Uint8Array(sw * sh), pts = [];
  let mean = 0; for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const v = gray[y * f * w + x * f]; small[y * sw + x] = v; mean += v; }
  mean /= small.length; const thr = Math.min(150, mean * 0.6);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (small[y * sw + x] < thr) pts.push(x, y);
  if (pts.length < 400) return 0;
  let best = 0, bestScore = -1;
  for (let a = -6; a <= 6.001; a += 0.25) {
    const t = Math.tan((a * Math.PI) / 180), bins = new Float32Array(sh + sw + 8);
    for (let i = 0; i < pts.length; i += 2) bins[Math.max(0, Math.round(pts[i + 1] + pts[i] * t) + sw)]++;
    let sc = 0; for (let i = 0; i < bins.length; i++) sc += bins[i] * bins[i];
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best;
}

function integralBlur(gray, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

/* Chuẩn bị ảnh: xoay, phóng/thu về ~300 dpi, làm trắng nền (chia cho nền ước lượng) để chịu ánh sáng không đều */
/* ---- tìm tờ giấy trong ảnh chụp và nắn phẳng phối cảnh ---- */
function otsu(vals) {
  const h = new Float64Array(256); vals.forEach((v) => h[v]++);
  let tot = vals.length, sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let wB = 0, sB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) { wB += h[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * h[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } }
  return thr;
}
function findPaper(canvas) {
  const k = 560 / Math.max(canvas.width, canvas.height), w = Math.round(canvas.width * k), h = Math.round(canvas.height * k);
  if (w < 50 || h < 50) return null;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  const thr = otsu(gray), mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] > thr ? 1 : 0;
  const lab = new Int32Array(w * h); let best = { n: 0, id: 0 }, id = 0; const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    id++; let sp = 0, n = 0; stack[sp++] = i; lab[i] = id;
    while (sp) { const p = stack[--sp]; n++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; } }
    if (n > best.n) best = { n, id };
  }
  if (best.n < 0.2 * w * h) return null;
  let tl = null, tr = null, bl = null, br = null, minX = w, maxX = 0, minY = h, maxY = 0;
  for (let i = 0; i < w * h; i++) {
    if (lab[i] !== best.id) continue;
    const x = i % w, y = (i / w) | 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (!tl || x + y < tl[0] + tl[1]) tl = [x, y]; if (!br || x + y > br[0] + br[1]) br = [x, y];
    if (!tr || x - y > tr[0] - tr[1]) tr = [x, y]; if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
  }
  if (maxX - minX > 0.96 * w && maxY - minY > 0.96 * h) return null;          // ảnh quét, không có viền nền
  const area = Math.abs((tl[0] * tr[1] - tr[0] * tl[1]) + (tr[0] * br[1] - br[0] * tr[1]) + (br[0] * bl[1] - bl[0] * br[1]) + (bl[0] * tl[1] - tl[0] * bl[1])) / 2;
  if (area < 0.25 * w * h || best.n / area < 0.8) return null;
  return [tl, tr, br, bl].map(([x, y]) => [x / k, y / k]);
}
function solveH(src, dst) {                                   // homography dst->src (8 ẩn), Gauss
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8; for (let i = 0; i < n; i++) A[i].push(b[i]);
  for (let i = 0; i < n; i++) {
    let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let sm = A[i][n]; for (let c = i + 1; c < n; c++) sm -= A[i][c] * x[c]; x[i] = sm / A[i][i]; }
  return x;
}
function warpPaper(canvas, quad, outW) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wTop = dist(quad[0], quad[1]), wBot = dist(quad[3], quad[2]), hL = dist(quad[0], quad[3]), hR = dist(quad[1], quad[2]);
  const ratio = ((hL + hR) / 2) / ((wTop + wBot) / 2);
  const outH = Math.round(outW * Math.min(Math.max(ratio, 0.6), 1.8));
  const H = solveH(quad, [[0, 0], [outW, 0], [outW, outH], [0, outH]]);
  const sctx = canvas.getContext("2d", { willReadFrequently: true }), sw = canvas.width, sh = canvas.height;
  const sd = sctx.getImageData(0, 0, sw, sh).data;
  const out = document.createElement("canvas"); out.width = outW; out.height = outH;
  const octx = out.getContext("2d"), od = octx.createImageData(outW, outH), o = od.data;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const den = H[6] * x + H[7] * y + 1, u = (H[0] * x + H[1] * y + H[2]) / den, v = (H[3] * x + H[4] * y + H[5]) / den;
    const x0 = Math.floor(u), y0 = Math.floor(v), i = (y * outW + x) * 4;
    if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { o[i] = o[i + 1] = o[i + 2] = 255; o[i + 3] = 255; continue; }
    const fx = u - x0, fy = v - y0, p = (y0 * sw + x0) * 4, q = p + sw * 4;
    for (let ch = 0; ch < 3; ch++) o[i + ch] = sd[p + ch] * (1 - fx) * (1 - fy) + sd[p + 4 + ch] * fx * (1 - fy) + sd[q + ch] * (1 - fx) * fy + sd[q + 4 + ch] * fx * fy;
    o[i + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return out;
}

const PREP = { min: 1800, max: 1800, mode: "none", thr: 165, refine: true };
function prepare(src, rotate) {
  let sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  const rot = rotate % 180 !== 0;
  const srcW = rot ? sh : sw;
  /* 1) ảnh làm việc (tối đa ~2600 px) → tìm tờ giấy và nắn phẳng nếu là ảnh chụp có nền */
  const wk = Math.min(1, 2600 / Math.max(srcW, rot ? sw : sh)), ww = Math.round((rot ? sh : sw) * wk), wh = Math.round((rot ? sw : sh) * wk);
  const work = document.createElement("canvas"); work.width = ww; work.height = wh;
  { const wg = work.getContext("2d", { willReadFrequently: true }); wg.fillStyle = "#fff"; wg.fillRect(0, 0, ww, wh);
    wg.save(); wg.translate(ww / 2, wh / 2); wg.rotate((rotate * Math.PI) / 180); wg.imageSmoothingQuality = "high";
    wg.drawImage(src, (-sw * wk) / 2, (-sh * wk) / 2, sw * wk, sh * wk); wg.restore(); }
  let flat = work, warped = false;
  if (PREP.warp !== false) { const quad = findPaper(work); if (quad) { flat = warpPaper(work, quad, Math.min(PREP.max, Math.max(PREP.min, Math.round(Math.max(ww, wh) * 0.7)))); warped = true; } }
  const base = flat, bw = flat.width, bh = flat.height;
  const target = warped ? bw : Math.min(PREP.max, Math.max(PREP.min, srcW));
  const scale = target / bw;
  const w = Math.round(bw * scale), h = Math.round(bh * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high"; g.drawImage(base, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), d = img.data, N = w * h;
  const gray = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  const f = 8, sw2 = Math.ceil(w / f), sh2 = Math.ceil(h / f), small = new Float32Array(sw2 * sh2);
  for (let y = 0; y < sh2; y++) for (let x = 0; x < sw2; x++) {         // nền = giá trị lớn (giấy) trong ô f×f
    let mx = 0; for (let yy = y * f; yy < Math.min(h, y * f + f); yy++) for (let xx = x * f; xx < Math.min(w, x * f + f); xx++) mx = Math.max(mx, gray[yy * w + xx]);
    small[y * sw2 + x] = mx;
  }
  const bg = integralBlur(small, sw2, sh2, 5);
  if (PREP.mode !== "none") for (let i = 0; i < N; i++) {
    const x = (i % w) / f | 0, y = ((i / w) | 0) / f | 0;
    const b = Math.max(bg[Math.min(y, sh2 - 1) * sw2 + Math.min(x, sw2 - 1)], 60);
    const v = Math.min(255, (gray[i] / b) * 255);
    const o = PREP.mode === "hard" ? (v < PREP.thr ? 0 : 255) : v < 235 ? Math.max(0, (v - 90) * 1.25) : 255;   // tăng tương phản nhẹ, nền về trắng
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = o; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const ang = estimateSkew(gray, w, h);                 // chỉnh nghiêng (tối đa ±6°) bằng phép chiếu ngang
  if (Math.abs(ang) >= 0.3) {
    const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
    const g2 = c2.getContext("2d"); g2.fillStyle = "#fff"; g2.fillRect(0, 0, w, h);
    g2.translate(w / 2, h / 2); g2.rotate((-ang * Math.PI) / 180); g2.drawImage(c, -w / 2, -h / 2);
    return { canvas: c2, lowRes: srcW < 1200, srcW, skew: ang, warped };
  }
  return { canvas: c, lowRes: srcW < 1200, srcW, skew: 0, warped };
}

async function bitmapOf(file) {
  let bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (bmp.width > 6000) {                                   // ảnh khổng lồ: thu nhỏ ngay để khỏi tràn bộ nhớ
    const k = 3600 / bmp.width, small = await createImageBitmap(bmp, { resizeWidth: 3600, resizeHeight: Math.round(bmp.height * k), resizeQuality: "high" });
    bmp.close(); bmp = small;
  }
  return bmp;
}
async function loadPages(file, rotate, onStatus) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjs = await import("./vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    return { count: pdf.numPages, async *pages() {
      for (let i = 1; i <= pdf.numPages; i++) {
        onStatus?.(`Đang đọc PDF trang ${i}/${pdf.numPages}…`);
        const page = await pdf.getPage(i), vp0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 2400 / vp0.width });
        const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        page.cleanup(); yield prepare(c, rotate);
      }
    } };
  }
  return { count: 1, async *pages() { const b = await bitmapOf(file); yield prepare(b, rotate); b.close?.(); } };
}

/* Nhận dạng lại các dòng kém chắc chắn: cắt riêng từng dòng, phóng/thu về cỡ chữ lý tưởng, đọc ở chế độ "một dòng"
   rồi chỉ thay khi độ tin cậy cao hơn rõ rệt. */
const lineConf = (l) => l.words.reduce((a, x) => a + x.confidence, 0) / Math.max(l.words.length, 1);
async function refineLines(w, canvas, tl, onStatus) {
  const cand = tl.map((l, i) => ({ l, i, c: lineConf(l) })).filter((x) => x.l.words.length && x.c < 88).sort((a, b) => a.c - b.c).slice(0, 60);
  if (!cand.length) return tl;
  const out = tl.slice();
  await w.setParameters({ tessedit_pageseg_mode: "7" });
  try {
    for (const { l, i, c } of cand) {
      const ws = l.words, x0 = Math.min(...ws.map((x) => x.bbox.x0)), x1 = Math.max(...ws.map((x) => x.bbox.x1));
      const y0 = Math.min(...ws.map((x) => x.bbox.y0)), y1 = Math.max(...ws.map((x) => x.bbox.y1));
      const pad = Math.round((y1 - y0) * 0.35), cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad);
      const cw = Math.min(canvas.width, x1 + pad) - cx0, ch = Math.min(canvas.height, y1 + pad) - cy0;
      if (cw < 8 || ch < 8) continue;
      const k = Math.min(3, Math.max(0.6, 56 / (y1 - y0)));
      const c2 = document.createElement("canvas"); c2.width = Math.round(cw * k) + 40; c2.height = Math.round(ch * k) + 40;
      const g = c2.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c2.width, c2.height); g.imageSmoothingQuality = "high";
      g.drawImage(canvas, cx0, cy0, cw, ch, 20, 20, cw * k, ch * k);
      const { data } = await w.recognize(c2, {}, { blocks: true });
      const nw = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((pp) => pp.lines.flatMap((q) => q.words))).filter((q) => q.text && q.text.trim());
      if (!nw.length) continue;
      const nc = nw.reduce((a, x) => a + x.confidence, 0) / nw.length;
      if (nc > c + 3) {
        out[i] = { ...l, words: nw.map((q) => ({ ...q, bbox: { x0: cx0 + (q.bbox.x0 - 20) / k, x1: cx0 + (q.bbox.x1 - 20) / k, y0: cy0 + (q.bbox.y0 - 20) / k, y1: cy0 + (q.bbox.y1 - 20) / k } })).sort((a, b) => a.bbox.x0 - b.bbox.x0) };
      }
    }
  } finally { await w.setParameters({ tessedit_pageseg_mode: "3" }); }
  return out;
}

/* nhận dạng một trang đã chuẩn bị */
const mkRuns = (t) => { const out = []; String(t || "").split(/(\[\?\])/).forEach((x) => { if (x === "[?]") { if (out.length) out[out.length - 1].u = true; } else if (x) out.push({ t: x, u: false }); });
  return out.length ? out : [{ t: "", u: false }]; };
function plainFromBlocks(blocks) {
  return blocks.map((b) => b.role === "table" ? { table: (b.rows || []).map((r) => r.map((c) => String(c ?? ""))), runs: [], center: false }
    : { runs: mkRuns(b.text), center: b.align === "center", right: b.align === "right", bold: !!b.bold, italic: !!b.italic });
}
function modelFromBlocks(blocks) {
  const m = { warnings: [], head: { left: [], right: [] }, so: "", dia_danh: "", loai: "", ten_loai: "", trich_yeu: [], vv: "", kinh_gui: "", body: [], noi_nhan: [], chuc_vu: [], ho_ten: "", quyen: "" };
  const T = (b) => String(b.text || "").replace(/\[\?\]/g, "").trim();
  for (const b of blocks) {
    if (b.role === "table") { (b.rows || []).forEach((r) => m.body.push({ runs: [{ t: r.join(" | "), u: false }] })); continue; }
    const t = T(b); if (!t) continue;
    switch (b.role) {
      case "head_left": m.head.left.push({ t, runs: mkRuns(b.text) }); break;
      case "head_right": m.head.right.push({ t, runs: mkRuns(b.text) }); break;
      case "so": m.so = t; break; case "dia_danh": m.dia_danh = t; break; case "ten_loai": m.ten_loai = t; break;
      case "trich_yeu": if (/^V\/v/i.test(t)) m.vv = t.replace(/^V\/v\s*/i, ""); else m.trich_yeu.push({ t, runs: mkRuns(b.text) }); break;
      case "kinh_gui": m.kinh_gui = t; break;
      case "noi_nhan": if (!/^N[oơ]i nhận\s*:?\s*$/i.test(t)) m.noi_nhan.push(t); break;
      case "chuc_vu": m.chuc_vu.push(t); break; case "ho_ten": m.ho_ten = t; break;
      default: m.body.push({ runs: mkRuns(b.text), bold: !!b.bold, italic: !!b.italic, heading: /^(Điều\s+\d+|Chương|Mục)/i.test(t) });
    }
  }
  const unc = m.body.reduce((n, p) => n + p.runs.filter((r) => r.u).length, 0);
  if (unc) m.warnings.push(`${unc} chỗ AI không chắc chắn được tô vàng trong Word. Hãy rà soát.`);
  if (!m.head.right.length) m.warnings.push("Không thấy Quốc hiệu. Nếu không phải công văn theo NĐ 30, hãy dùng Word văn bản trơn.");
  return m;
}

async function ocrPage(p, onStatus) {
  let aiFail = null;
  if (AIX.usable()) {
    try {
      onStatus?.("AI đang đọc trang…");
      const { blocks, via } = await AIX.read(p.canvas, onStatus);
      const t = document.createElement("canvas"); const k = Math.min(1, 800 / p.canvas.width); t.width = Math.round(p.canvas.width * k); t.height = Math.round(p.canvas.height * k);
      t.getContext("2d").drawImage(p.canvas, 0, 0, t.width, t.height);
      return { ai: blocks, via, words: [], tl: [], mean: 97, W: p.canvas.width, H: p.canvas.height, lowRes: false, srcW: p.srcW, thumb: t.toDataURL("image/jpeg", 0.55),
        text: blocks.map((b) => b.text || (b.rows || []).map((r) => r.join(" | ")).join("\n")).join("\n") };
    } catch (e) { console.error(e); aiFail = e.message || String(e); }
  }
  const r = await ocrPageTess(p, onStatus); if (aiFail) r.aiFail = aiFail; return r;
}
async function ocrPageTess(p, onStatus) {
  const w = await acquire(onStatus);
  try {
    const { data } = await w.recognize(p.canvas, {}, { blocks: true });
    let words = data.words;
    if (!words) words = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((pp) => pp.lines.flatMap((l) => l.words)));
    let tl = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((pp) => pp.lines));
    if (PREP.refine && tl.length) { tl = await refineLines(w, p.canvas, tl, onStatus); words = tl.flatMap((l) => l.words); }
    const mean = words.length ? words.reduce((s, x) => s + x.confidence, 0) / words.length : 0;
    const t = document.createElement("canvas"); const k = Math.min(1, 800 / p.canvas.width); t.width = Math.round(p.canvas.width * k); t.height = Math.round(p.canvas.height * k);
    t.getContext("2d").drawImage(p.canvas, 0, 0, t.width, t.height);
    return { words, tl, mean, W: p.canvas.width, H: p.canvas.height, lowRes: p.lowRes, srcW: p.srcW, thumb: t.toDataURL("image/jpeg", 0.55), text: tl.length ? tl.map((l) => l.words.map((x) => x.text).join(" ")).join("\n") : (data.text || "") };
  } finally { release(w); }
}

/* ghép kết quả các trang thành một văn bản */
function assemble(name, results, format) {
  let model = null; const warnings = []; const plain = [];
  results.forEach((r, i) => {
    if (r.lowRes && !r.ai) warnings.push(`Trang ${i + 1}: ảnh gốc chỉ rộng ${r.srcW}px, quá nhỏ để OCR chính xác. Hãy dùng ảnh gốc từ điện thoại/máy scan (từ ~1700px).`);
    if (!r.ai && (r.words.length < 10 || r.mean < 50)) warnings.push(`Trang ${i + 1}: gần như không đọc được (độ tin cậy ${r.mean.toFixed(0)}%). Ảnh quá mờ/nhỏ hoặc không phải tiếng Việt.`);
    if (r.aiFail) warnings.push(`Trang ${i + 1}: AI lỗi (${r.aiFail}), đã dùng bộ đọc Tesseract thay thế.`);
    if (r.ai) { warnings.splice(warnings.length, 0); }
    plain.push(...(r.ai ? plainFromBlocks(r.ai) : ND30.plainParse(r.words, r.W, r.H, r.tl)));
    const m = r.ai ? modelFromBlocks(r.ai) : ND30.parse(r.words, r.W, r.H, r.tl);
    if (!model) model = m;
    else {
      model.body.push(...m.body);
      if (m.noi_nhan.length) { model.noi_nhan = m.noi_nhan; model.chuc_vu = m.chuc_vu; model.ho_ten = m.ho_ten; }
      m.warnings.forEach((x) => { if (!/Quốc hiệu|Nơi nhận/.test(x)) model.warnings.push(x); });
    }
  });
  model.warnings = [...warnings, ...model.warnings];
  const unc = model.body.reduce((n, p) => n + p.runs.filter((r) => r.u).length, 0);
  return { id: new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "_" + Math.random().toString(36).slice(2, 6),
    name, date: new Date().toLocaleString("vi-VN"), status: "chua_kiem", format: format || getFormat(), plain, pages: results.length, thumbs: results.slice(0, 6).map((r) => r.thumb), model, uncertain: unc,
    conf: results.reduce((a, r) => a + r.mean, 0) / results.length };
}

async function convertFile(file, opts, onStatus) {
  const src = await loadPages(file, opts.rotate, onStatus), results = [];
  let i = 0;
  for await (const p of src.pages()) { onStatus?.(`Đang nhận dạng trang ${++i}/${src.count}…`); results.push(await ocrPage(p, onStatus)); }
  return assemble(file.name, results);
}

/* ---------------- xuất Word ---------------- */
function getFormat() { try { return localStorage.getItem("fmt") || "plain"; } catch { return "plain"; } }
function setFormat(v) { try { localStorage.setItem("fmt", v); } catch {} }
const fmtSelect = () => { const sel = el("select", { title: "Kiểu file Word xuất ra", onchange: () => setFormat(sel.value) },
  el("option", { value: "plain" }, "Word văn bản trơn (chỉ nội dung)"), el("option", { value: "nd30" }, "Word dựng thể thức Nghị định 30"));
  sel.value = getFormat(); return sel; };
const engineSelect = () => { const sel = el("select", { title: "Bộ đọc chữ", onchange: () => { AIX.set("engine", sel.value); render(); } },
  el("option", { value: "auto" }, AIX.usable() ? "Tự động: AI (đã có key)" : "Tự động: Tesseract (chưa có key AI)"), el("option", { value: "off" }, "Chỉ Tesseract (không gửi ảnh đi)"));
  sel.value = AIX.get("engine", "auto") === "off" ? "off" : "auto"; return sel; };
const fmtOf = (d) => d.format || "plain";
const sfx = (d) => (fmtOf(d) === "nd30" ? "_nd30" : "_ocr");
const docxOf = (d) => docx.Packer.toBlob(fmtOf(d) === "nd30" ? ND30.build(d.model, docx) : ND30.plainBuild(d.plain || d.model.body, docx));
const docxBlob = docxOf;
const stem = (n) => n.replace(/\.[^.]+$/, "");
function download(blob, name) { const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
const csvEsc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
function summaryCsv(docs) {
  const rows = [["Tên file", "Loại văn bản", "Số ký hiệu", "Trích yếu / V/v", "Số trang", "Đoạn nghi sai", "Cảnh báo", "Trạng thái", "Ngày chuyển"]];
  docs.forEach((d) => rows.push([d.name, d.model.ten_loai, d.model.so, d.model.trich_yeu.map((x) => x.t).join(" ") || d.model.vv, d.pages, d.uncertain, d.model.warnings.length,
    d.status === "da_kiem" ? "Đã kiểm" : "Chưa kiểm", d.date]));
  return "﻿" + rows.map((r) => r.map(csvEsc).join(",")).join("\r\n");
}
async function exportZip(docs) {
  const z = new JSZip(), used = new Set();
  for (const d of docs) {
    let n = stem(d.name) + sfx(d) + ".docx", k = 2; while (used.has(n)) n = `${stem(d.name)}_${k++}${sfx(d)}.docx`; used.add(n);
    z.file(n, await docxBlob(d));
  }
  z.file("tong_hop.csv", summaryCsv(docs));
  return z.generateAsync({ type: "blob" });
}

/* ---------------- giao diện ---------------- */
const app = { view: "convert", openId: null, busy: false, lastBatch: [], cancel: false, cam: { pages: [], results: [], doc: null } };
function setView(v, id = null) { if (app.view === "camera" && v !== "camera") stopCamera(); app.view = v; app.openId = id; render(); }

function header() {
  const tab = (v, t) => el("button", { class: "tab" + (app.view === v || (v === "library" && app.view === "edit") ? " on" : ""), onclick: () => setView(v) }, t);
  return el("header", {}, el("h1", {}, "📄 OCR văn bản"), el("nav", {}, tab("convert", "Hàng loạt"), tab("camera", "Chụp & OCR"), tab("library", "Thư viện"), tab("settings", "⚙ AI")),
    el("span", { class: "tag" }, AIX.usable() ? "Bộ đọc AI đang bật · ảnh được gửi tới nhà cung cấp AI đã nhập key" : "Chạy ngay trong trình duyệt · không gửi dữ liệu ra ngoài"));
}

const fmtMB = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + " MB";
const fmtMin = (s) => (s < 90 ? `~${Math.max(1, Math.round(s))} giây` : `~${Math.round(s / 60)} phút`);

function viewConvert() {
  const status = el("div", { class: "log", id: "log" });
  const bar = el("progress", { value: 0, max: 1, hidden: true }), summary = el("div", { class: "muted", id: "sum" });
  const rotate = el("select", {}, ...[[0, "Giữ nguyên"], [90, "Xoay phải 90°"], [180, "Xoay 180°"], [270, "Xoay trái 90°"]].map(([v, t]) => el("option", { value: v }, t)));
  const threads = el("select", {}, ...[[0, `Tự động (${autoThreads()})`], [1, "1"], [2, "2"], [3, "3"], [4, "4"]].map(([v, t]) => el("option", { value: v }, t)));
  const input = el("input", { type: "file", multiple: true, accept: "image/*,.pdf", hidden: true });
  const folder = el("input", { type: "file", webkitdirectory: true, multiple: true, hidden: true });
  const stop = el("button", { hidden: true, onclick: () => { app.cancel = true; stop.textContent = "Đang dừng…"; } }, "⏹ Dừng");
  const drop = el("div", { class: "drop", tabindex: 0, onclick: () => input.click() },
    el("strong", {}, "Kéo thả ảnh / PDF vào đây hoặc bấm để chọn nhiều file"),
    el("small", {}, "Không giới hạn số file và dung lượng: các file được đọc và xử lý lần lượt nên không chiếm hết bộ nhớ."));
  const after = el("div", { class: "row" });

  const run = async (list) => {
    const files = [...list].filter((f) => /\.(jpe?g|png|webp|bmp|gif|pdf)$/i.test(f.name) || f.type.startsWith("image/") || f.type === "application/pdf");
    if (!files.length) { status.textContent = "Chưa có file ảnh/PDF hợp lệ."; return; }
    if (app.busy) return;
    const total = files.reduce((n, f) => n + f.size, 0), big = files.filter((f) => f.size > 40 * 1048576);
    const nT = +threads.value || autoThreads(), pdfs = files.filter((f) => /\.pdf$/i.test(f.name)).length;
    const estSec = (files.length - pdfs) * 3 / nT + pdfs * 12 / nT;
    const warns = [];
    if (files.length > 100 || total > 500 * 1048576) warns.push(`Lô lớn: ${files.length} file, ${fmtMB(total)}. Ước tính ${fmtMin(estSec)} với ${nT} luồng; hãy để trang này mở và máy không ngủ.`);
    if (big.length) warns.push(`${big.length} file lớn hơn 40 MB (${big.slice(0, 3).map((f) => f.name).join(", ")}${big.length > 3 ? "…" : ""}) có thể chạy chậm hoặc thiếu bộ nhớ trên máy yếu.`);
    try { const e = await navigator.storage?.estimate?.(); if (e && e.quota && e.usage + files.length * 150000 > e.quota * 0.9) warns.push("Dung lượng lưu của trình duyệt sắp đầy: hãy tải zip về và xóa bớt trong Thư viện."); } catch (_) {}
    if (AIX.usable() && !app.aiAck) { warns.push(`Đã có key AI nên ảnh sẽ được gửi tới máy chủ của nhà cung cấp AI (Gemini/Groq/OpenRouter/Anthropic). Nếu là văn bản mật, hãy chọn “Chỉ Tesseract” ở ô Bộ đọc.`); app.aiAck = true; }
    if (warns.length && !confirm(warns.join("\n\n") + "\n\nVẫn tiếp tục?")) return;
    pool.size = nT; app.busy = true; app.cancel = false; app.lastBatch = []; bar.hidden = false; stop.hidden = false; stop.textContent = "⏹ Dừng"; bar.max = files.length; bar.value = 0; status.textContent = "";
    let done = 0, ok = 0, next = 0; const t0 = performance.now();
    const worker = async () => {
      while (!app.cancel && next < files.length) {
        const f = files[next++], line = el("div", {}, `⏳ ${f.name}`); status.prepend(line);
        try {
          const d = await convertFile(f, { rotate: +rotate.value }, (s) => { line.textContent = `⏳ ${f.name}: ${s}`; });
          await DB.put(d); app.lastBatch.push(d.id); ok++;
          line.textContent = `✅ ${f.name}` + (d.model.warnings.length ? `  (⚠ ${d.model.warnings.length} cảnh báo)` : "");
        } catch (e) { console.error(e); line.textContent = `❌ ${f.name}: ${e.message || e}`; }
        bar.value = ++done;
        const el_s = (performance.now() - t0) / 1000;
        summary.textContent = `${done}/${files.length} file · ${ok} thành công · còn ${fmtMin((el_s / done) * (files.length - done))}`;
        await sleep(0);
      }
    };
    await Promise.all(Array.from({ length: nT }, worker));
    app.busy = false; stop.hidden = true;
    summary.textContent += app.cancel ? " · đã dừng (các file xong vẫn được lưu)" : " · hoàn tất";
    render(true);
  };
  input.addEventListener("change", () => run(input.files)); folder.addEventListener("change", () => run(folder.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => { e.preventDefault(); drop.classList.remove("over"); run(await filesFromDrop(e.dataTransfer)); });
  if (app.lastBatch.length) {
    const get = async () => (await Promise.all(app.lastBatch.map((i) => DB.get(i)))).filter(Boolean);
    after.append(el("button", { class: "primary", onclick: async () => download(await exportZip(await get()), "ket_qua_ocr.zip") }, "⬇ Tải tất cả Word (.zip + bảng tổng hợp)"),
      el("button", { onclick: () => setView("library") }, "Mở Thư viện"));
  }
  return el("main", {}, el("h2", {}, "OCR hàng loạt"),
    el("p", { class: "muted" }, "Chọn nhiều ảnh/PDF hoặc cả thư mục. Mặc định xuất Word văn bản trơn (chỉ chép nội dung); chọn “Kiểu Word” để dựng theo thể thức Nghị định 30. Mỗi văn bản được lưu vào Thư viện của trình duyệt này. Lần đầu mở sẽ tải bộ nhận dạng tiếng Việt (~10 MB)."),
    drop, input, folder,
    el("div", { class: "row" }, el("label", {}, "Hướng ảnh: ", rotate), el("label", {}, "Số luồng: ", threads), el("label", {}, "Bộ đọc: ", engineSelect()), el("label", {}, "Kiểu Word: ", fmtSelect()), el("button", { onclick: () => folder.click() }, "Chọn cả thư mục…"), stop),
    bar, summary, status, after,
    el("details", { class: "note" }, el("summary", {}, "Giới hạn của bản chạy trên trình duyệt"),
      el("ul", {}, el("li", {}, "Không có giới hạn cứng về số file hay dung lượng; phần mềm chỉ cảnh báo khi lô lớn (trên 100 file hoặc 500 MB), file trên 40 MB, hoặc bộ nhớ lưu của trình duyệt sắp đầy."),
        el("li", {}, "Tốc độ phụ thuộc máy: khoảng 3 giây một trang mỗi luồng. Nhiều luồng dùng nhiều RAM (mỗi luồng ~150–300 MB)."),
        el("li", {}, "Chưa có: vẽ lại bảng, giữ hình/con dấu/chữ ký, nắn phẳng ảnh chụp nghiêng nhiều (có ở bản Python). Luôn rà soát trước khi dùng; chữ OCR kém chắc chắn được tô vàng."))));
}

/* kéo thả cả thư mục */
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return dt.files;
  const out = [];
  const walk = async (en) => {
    if (en.isFile) out.push(await new Promise((r, j) => en.file(r, j)));
    else if (en.isDirectory) {
      const rd = en.createReader();
      for (;;) { const batch = await new Promise((r, j) => rd.readEntries(r, j)); if (!batch.length) break; for (const c of batch) await walk(c); }
    }
  };
  for (const en of items) await walk(en);
  return out;
}

/* ---------------- Chụp & OCR ---------------- */
let camStream = null;
function stopCamera() { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; }

function viewCamera() {
  const C = app.cam;
  const video = el("video", { autoplay: true, playsinline: true, muted: true, class: "cam" });
  const msg = el("div", { class: "muted" }), shots = el("div", { class: "shots" }), result = el("div", { class: "result" });
  const fileCap = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
  let facing = "environment";
  const showShots = () => {
    shots.replaceChildren(...C.results.map((r, i) => el("div", { class: "shot" }, el("img", { src: r.thumb, alt: "trang " + (i + 1) }),
      el("small", {}, `Trang ${i + 1} · tin cậy ${r.mean.toFixed(0)}%`),
      r.mean < 65 || r.words.length < 10 ? el("small", { class: "bad" }, "Ảnh mờ/thiếu chữ: nên chụp lại") : "",
      el("button", { onclick: () => { C.results.splice(i, 1); showShots(); updCounter(); } }, "Xóa"))));
    finish.disabled = !C.results.length;
  };
  const start = async () => {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Trình duyệt/địa chỉ này không cho dùng camera trực tiếp (cần https). Dùng nút “Chụp bằng ứng dụng máy ảnh”."; return; }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
      video.srcObject = camStream; toggleCam.textContent = "⏻ Tắt camera"; camwrap.classList.remove("off"); msg.textContent = "Đặt tờ giấy vào khung, đủ sáng, cầm chắc tay rồi bấm Chụp.";
    } catch (e) { msg.textContent = "Không mở được camera: " + (e.message || e) + ". Hãy cho phép quyền camera hoặc dùng nút “Chụp bằng ứng dụng máy ảnh”."; }
  };
  const process = async (canvasOrBitmap) => {
    msg.textContent = "Đang nhận dạng…";
    try {
      const p = prepare(canvasOrBitmap, 0);
      const r = await ocrPage(p, (s) => (msg.textContent = s));
      C.results.push(r); C.doc = null; showShots();
      msg.textContent = r.mean < 65 ? "Đọc chưa rõ, nên chụp lại (đủ sáng, gần hơn, không rung)." : `Đã đọc trang ${C.results.length}. Chụp tiếp trang sau hoặc bấm “Hoàn tất”.`;
      preview.textContent = r.text.trim().slice(0, 1200);
    } catch (e) { console.error(e); msg.textContent = "Lỗi OCR: " + (e.message || e); }
  };
  const still = el("img", { class: "still", hidden: true, alt: "ảnh vừa chụp" }), badge = el("div", { class: "badge" }), counter = el("div", { class: "counter" });
  const updCounter = () => { counter.textContent = C.pages.length || C.results.length ? `📄 Đã chụp ${C.results.length} trang` : ""; };
  let flashT = null;
  const snap = () => {
    if (!camStream || !video.videoWidth) { msg.textContent = "Camera đang tắt hoặc chưa sẵn sàng."; return; }
    const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext("2d").drawImage(video, 0, 0);
    still.src = c.toDataURL("image/jpeg", 0.6); still.hidden = false; badge.textContent = `✅ ĐÃ CHỤP trang ${C.results.length + 1} — đang đọc chữ…`; badge.hidden = false;
    camwrap.classList.add("flash"); setTimeout(() => camwrap.classList.remove("flash"), 250);
    clearTimeout(flashT);
    process(c).then(() => { badge.textContent = `✅ Đã chụp & đọc xong trang ${C.results.length}`; flashT = setTimeout(() => { still.hidden = true; badge.hidden = true; }, 2200); updCounter(); });
  };
  const toggleCam = el("button", { onclick: async () => { if (camStream) { stopCamera(); video.srcObject = null; toggleCam.textContent = "📷 Bật camera"; msg.textContent = "Camera đã tắt."; camwrap.classList.add("off"); } else { camwrap.classList.remove("off"); await start(); } } }, "⏻ Tắt camera");
  const preview = el("pre", { class: "preview" }); const fmtSel = fmtSelect();
  const camwrap = el("div", { class: "camwrap" }, video, el("div", { class: "frame" }), still, badge, counter, el("div", { class: "offmsg" }, "Camera đang tắt"));
  const finish = el("button", { class: "primary", disabled: !C.results.length, onclick: async () => {
    const d = assemble("chup_" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""), C.results, fmtSel.value);
    stopCamera(); video.srcObject = null; toggleCam.textContent = "📷 Bật camera"; camwrap.classList.add("off");
    await DB.put(d); C.doc = d; showDone();
  } }, "✅ Hoàn tất → Word");
  const showDone = () => {
    const d = C.doc; if (!d) return result.replaceChildren();
    result.replaceChildren(el("div", { class: "ok" }, `Đã lưu vào Thư viện (${d.pages} trang). ${d.model.warnings.length ? "⚠ " + d.model.warnings.length + " cảnh báo, hãy xem khi mở." : ""}`),
      el("div", { class: "row" }, el("button", { class: "primary", onclick: async () => download(await docxBlob(d), stem(d.name) + sfx(d) + ".docx") }, "⬇ Tải Word"),
        el("button", { onclick: () => setView("edit", d.id) }, "Xem / sửa"),
        el("button", { onclick: () => { C.results = []; C.doc = null; preview.textContent = ""; showShots(); showDone(); } }, "📷 Chụp văn bản mới")));
  };
  fileCap.addEventListener("change", async () => { for (const f of fileCap.files) { const b = await bitmapOf(f); await process(b); b.close?.(); } fileCap.value = ""; });
  setTimeout(() => { showShots(); showDone(); updCounter(); start(); }, 0);
  return el("main", {}, el("h2", {}, "Chụp & OCR ra liền"),
    camwrap,
    el("div", { class: "row" }, el("button", { class: "primary big", onclick: snap }, "📸 Chụp"), toggleCam,
      el("button", { onclick: () => { facing = facing === "environment" ? "user" : "environment"; start(); } }, "🔄 Đổi camera"),
      el("button", { onclick: () => fileCap.click() }, "Chụp bằng ứng dụng máy ảnh"), fileCap, el("label", {}, "Bộ đọc: ", engineSelect()), el("label", {}, "Kiểu Word: ", fmtSel), finish),
    msg, shots, preview, result,
    el("p", { class: "muted" }, "Mẹo: đặt giấy trên nền tối, đủ sáng, chụp thẳng góc, giữ cả tờ trong khung. Chụp nhiều trang rồi “Hoàn tất” để gộp thành một file Word."));
}

function viewSettings() {
  const msg = el("div", { class: "muted" }), list = el("div", { class: "list" });
  const key = el("input", { type: "password", placeholder: "Dán API key (Gemini AIza…, Groq gsk_…, xAI Grok xai-…, OpenRouter sk-or-…, Anthropic sk-ant-…)", autocomplete: "off", style: "flex:1 1 20rem" });
  const draw = () => {
    const arr = AIX.keys();
    list.replaceChildren(...(arr.length ? arr.map((k) => el("div", { class: "card" },
      el("div", { class: "info" }, el("b", {}, `${k.status === "ok" ? "✅" : k.status === "bad" ? "❌" : "⚠"} ${AIX.NAMES[k.provider]}${AIX.FREE[k.provider] ? " (miễn phí)" : " (tính phí)"}`),
        el("div", { class: "muted" }, `${AIX.mask(k.key)} · ${k.status === "ok" ? "đang dùng: " + k.models[0] : (k.err || "lỗi")}`),
        ...(k.report || []).map((r) => el("small", { class: r.ok ? "" : "bad", style: "display:block" }, `${r.ok ? "✔" : "✘"} ${r.m}: ` + (r.ok ? (r.score == null ? r.err : `đọc đúng ${r.score}% · ${(r.ms / 1000).toFixed(1)} giây`) : r.err)))),
      el("button", { onclick: async () => { msg.textContent = "Đang kiểm tra…"; await AIX.recheck(k.id, (t) => (msg.textContent = t)); msg.textContent = ""; render(); } }, "Kiểm tra lại"),
      el("button", { onclick: () => { AIX.removeKey(k.id); render(); } }, "Xóa"))) : [el("p", { class: "muted" }, "Chưa có key nào. Khi chưa có key, ứng dụng dùng Tesseract trong máy.")]));
  };
  const add = el("button", { class: "primary", onclick: async () => {
    const lines = key.value.split(/[\s,;]+/).filter(Boolean); if (!lines.length) return;
    add.disabled = true; const out = [];
    for (const kv of lines) { msg.textContent = `Đang kiểm tra key ${AIX.mask(kv)}…`;
      try { const k = await AIX.addKey(kv, "auto", (t) => (msg.textContent = t)); out.push(k.status === "ok" ? `✅ ${AIX.NAMES[k.provider]}: dùng ${k.models[0]} (đạt kiểm thử)` : `⚠ ${AIX.NAMES[k.provider]}: ${k.err}`); } catch (e) { out.push(`❌ ${AIX.mask(kv)}: ${e.message || e}`); } }
    add.disabled = false; key.value = ""; msg.textContent = out.join("  |  "); draw();
  } }, "Kiểm tra, kiểm thử và thêm key");
  const main = el("main", {}, el("h2", {}, "Bộ đọc AI (tự động khi có key)"),
    el("p", { class: "muted" }, "Có ít nhất một key hợp lệ thì mọi lần quét/chụp tự dùng AI; không có key (hoặc AI lỗi) thì dùng Tesseract trong máy. Có thể nhập nhiều key, hết hạn mức key này sẽ tự chuyển key khác."),
    el("div", { class: "warn" }, el("b", {}, "Lưu ý"), el("ul", {},
      el("li", {}, "Ảnh từng trang được gửi thẳng từ trình duyệt tới nhà cung cấp AI của key. Không dùng với văn bản mật nếu quy định không cho phép (chọn “Chỉ Tesseract” ở ô Bộ đọc)."),
      el("li", {}, "Key được tự lưu trong trình duyệt này (chỉ lưu khi kiểm tra thành công), lần sau mở lại vẫn còn. Mất nếu xóa dữ liệu trình duyệt hoặc đổi trình duyệt/máy; không gửi đi nơi nào khác. Không dùng máy công cộng."),
      el("li", {}, "Ưu tiên key miễn phí: Gemini → Groq → OpenRouter, rồi mới tới Anthropic (tính phí). Gói miễn phí có giới hạn số lượt/ngày và có thể dùng dữ liệu để cải thiện dịch vụ."))),
    el("div", { class: "row" }, key, add), msg, list,
    el("details", { class: "note" }, el("summary", {}, "Lấy key miễn phí ở đâu?"), el("ul", {},
      el("li", {}, "Gemini: aistudio.google.com/apikey (khuyến nghị, đọc tiếng Việt tốt)"), el("li", {}, "Groq: console.groq.com/keys"),
      el("li", {}, "OpenRouter: openrouter.ai/keys (dùng model có đuôi :free)"), el("li", {}, "Anthropic: console.anthropic.com (tính phí)"), el("li", {}, "xAI Grok (xai-…): console.x.ai (tính phí). Lưu ý Groq (gsk_…) và Grok (xai-…) là hai dịch vụ khác nhau."))));
  draw(); return main;
}

async function viewLibrary() {
  const docs = await DB.all();
  const q = el("input", { type: "search", placeholder: "Tìm theo tên file, số ký hiệu, trích yếu…" });
  const flt = el("select", {}, ...[["all", "Tất cả"], ["chua_kiem", "Chưa kiểm"], ["da_kiem", "Đã kiểm"]].map(([v, t]) => el("option", { value: v }, t)));
  const list = el("div", { class: "list" }), bulk = el("div", { class: "row bulk" });
  const picked = new Set();
  const draw = () => {
    const kw = q.value.trim().toLowerCase();
    const shown = docs.filter((d) => (flt.value === "all" || d.status === flt.value) &&
      (!kw || [d.name, d.model.so, d.model.ten_loai, d.model.vv, d.model.trich_yeu.map((x) => x.t).join(" ")].join(" ").toLowerCase().includes(kw)));
    list.replaceChildren(...(shown.length ? shown.map((d) => {
      const cb = el("input", { type: "checkbox", checked: picked.has(d.id), onchange: (e) => { e.target.checked ? picked.add(d.id) : picked.delete(d.id); drawBulk(); } });
      return el("div", { class: "card" }, cb,
        el("div", { class: "info" }, el("b", {}, `${d.status === "da_kiem" ? "✅" : "🟡"} ${d.model.ten_loai || "Chưa nhận diện"} ${d.model.so}`),
          el("div", {}, d.model.trich_yeu.map((x) => x.t).join(" ") || d.model.vv || d.name),
          el("small", { class: "muted" }, `${d.date} · ${d.pages} trang · ${d.name}` + (d.model.warnings.length ? ` · ⚠ ${d.model.warnings.length}` : ""))),
        el("button", { onclick: () => setView("edit", d.id) }, "Mở / sửa"),
        el("button", { onclick: async () => download(await docxBlob(d), stem(d.name) + sfx(d) + ".docx") }, "⬇ Word"));
    }) : [el("p", { class: "muted" }, docs.length ? "Không có văn bản khớp bộ lọc." : "Chưa có văn bản nào. Vào “Hàng loạt” hoặc “Chụp & OCR” để thêm.")]));
    drawBulk(shown);
  };
  const drawBulk = (shown) => {
    shown = shown || docs;
    const all = el("button", { onclick: () => { shown.forEach((d) => picked.add(d.id)); draw(); } }, "Chọn tất cả đang hiện");
    const sel = docs.filter((d) => picked.has(d.id));
    bulk.replaceChildren(all, el("span", { class: "muted" }, `Đã chọn ${sel.length}`),
      el("button", { disabled: !sel.length, onclick: async () => download(await exportZip(sel), "ket_qua_ocr.zip") }, "⬇ Word (zip) + tổng hợp"),
      el("button", { disabled: !sel.length, onclick: () => download(new Blob([summaryCsv(sel)], { type: "text/csv" }), "tong_hop.csv") }, "⬇ Bảng tổng hợp .csv"),
      el("button", { disabled: !sel.length, onclick: async () => { for (const d of sel) { d.status = "da_kiem"; await DB.put(d); } render(); } }, "✅ Đánh dấu đã kiểm"),
      el("button", { disabled: !sel.length, onclick: async () => { if (confirm(`Xóa ${sel.length} văn bản?`)) { for (const d of sel) await DB.del(d.id); render(); } } }, "🗑 Xóa"));
  };
  q.addEventListener("input", draw); flt.addEventListener("change", draw);
  const main = el("main", {}, el("h2", {}, "Thư viện văn bản"), el("div", { class: "row" }, q, flt), bulk, list,
    el("p", { class: "muted" }, "Dữ liệu nằm trong trình duyệt này (IndexedDB). Xóa dữ liệu trình duyệt sẽ mất; hãy tải zip để sao lưu."));
  draw(); return main;
}

async function viewEdit() {
  const d = await DB.get(app.openId); if (!d) return setView("library");
  const m = d.model;
  const warn = m.warnings.length ? el("div", { class: "warn" }, el("b", {}, "Cần kiểm tra:"), el("ul", {}, ...[...new Set(m.warnings)].map((w) => el("li", {}, w)))) : "";
  const field = (label, get, set, multi) => {
    const i = multi ? el("textarea", { rows: Math.max(2, get().split("\n").length) }) : el("input", { type: "text" });
    i.value = get(); i.addEventListener("input", () => set(i.value)); return el("label", { class: "f" }, el("span", {}, label), i);
  };
  const plain = (runs) => runs.map((r) => r.t).join("");
  if (!d.plain) d.plain = m.body.map((p) => ({ runs: p.runs, center: false }));
  const fmtSel = el("select", { onchange: async () => { d.format = fmtSel.value; await DB.put(d); render(); } },
    el("option", { value: "plain" }, "Word văn bản trơn"), el("option", { value: "nd30" }, "Word thể thức Nghị định 30")); fmtSel.value = fmtOf(d);
  const body = (fmtOf(d) === "nd30" ? m.body : d.plain).map((p, k) => p.table ? field(`Bảng (mỗi dòng một hàng, các ô cách bằng “ | ”)`, () => p.table.map((r) => r.join(" | ")).join("\n"), (v) => { p.table = v.split("\n").filter(Boolean).map((r) => r.split("|").map((c) => c.trim())); }, true) : field(`Đoạn ${k + 1}${p.runs.some((r) => r.u) ? " (có chữ nghi sai)" : ""}`, () => plain(p.runs), (v) => { p.runs = [{ t: v, u: false }]; }, true));
  const imgs = d.thumbs.map((t) => el("img", { src: t, alt: "trang" }));
  const msg = el("span", { class: "muted" });
  const save = async () => { await DB.put(d); msg.textContent = "Đã lưu."; };
  return el("main", { class: "edit" },
    el("div", { class: "row" }, el("button", { onclick: () => setView("library") }, "← Thư viện"), el("h2", {}, `${m.ten_loai || "Văn bản"} ${m.so}`)),
    warn,
    el("div", { class: "cols" }, el("div", { class: "pics" }, el("b", {}, "Ảnh đã xử lý"), ...imgs),
      el("div", { class: "form" }, el("label", { class: "f" }, el("span", {}, "Kiểu file Word xuất ra"), fmtSel),
        ...(fmtOf(d) === "plain" ? body : [field("Cơ quan ban hành (mỗi dòng một dòng)", () => m.head.left.map((x) => x.t).join("\n"), (v) => { m.head.left = v.split("\n").filter(Boolean).map((t) => ({ t, runs: [{ t, u: false }] })); }, true),
        field("Số, ký hiệu", () => m.so, (v) => (m.so = v)), field("Địa danh, ngày tháng", () => m.dia_danh, (v) => (m.dia_danh = v)),
        field("Tên loại văn bản", () => m.ten_loai, (v) => (m.ten_loai = v)), field("Trích yếu", () => m.trich_yeu.map((x) => x.t).join(" "), (v) => { m.trich_yeu = v ? [{ t: v, runs: [{ t: v, u: false }] }] : []; }, true),
        field("V/v (công văn)", () => m.vv, (v) => (m.vv = v)), field("Kính gửi", () => m.kinh_gui, (v) => (m.kinh_gui = v)),
        ...body,
        field("Nơi nhận (mỗi dòng một nơi)", () => m.noi_nhan.join("\n"), (v) => { m.noi_nhan = v.split("\n").filter(Boolean); }, true),
        field("Quyền hạn, chức vụ người ký (mỗi dòng)", () => m.chuc_vu.join("\n"), (v) => { m.chuc_vu = v.split("\n").filter(Boolean); }, true),
        field("Họ tên người ký", () => m.ho_ten, (v) => (m.ho_ten = v))]),
        el("div", { class: "row" },
          el("button", { class: "primary", onclick: async () => { await save(); download(await docxBlob(d), stem(d.name) + sfx(d) + ".docx"); } }, "💾 Lưu và tải Word"),
          el("button", { onclick: async () => { d.status = d.status === "da_kiem" ? "chua_kiem" : "da_kiem"; await save(); render(); } }, d.status === "da_kiem" ? "↩ Bỏ đánh dấu đã kiểm" : "✅ Đánh dấu đã kiểm"),
          el("button", { onclick: save }, "Lưu"), el("button", { onclick: async () => { if (confirm("Xóa văn bản này?")) { await DB.del(d.id); setView("library"); } } }, "🗑 Xóa"), msg))));
}

async function render(keep) {
  const root = $("#app"), prevLog = keep ? $("#log")?.innerHTML : null;
  const prevSum = keep ? $("#sum")?.textContent : null;
  const body = app.view === "convert" ? viewConvert() : app.view === "camera" ? viewCamera() : app.view === "settings" ? viewSettings() : app.view === "library" ? await viewLibrary() : await viewEdit();
  root.replaceChildren(header(), body);
  if (prevLog) $("#log").innerHTML = prevLog;
  if (prevSum && $("#sum")) $("#sum").textContent = prevSum;
}

window.addEventListener("DOMContentLoaded", async () => {
  try { await DB.open(); } catch (e) { $("#app").textContent = "Trình duyệt không cho lưu dữ liệu (IndexedDB). Hãy tắt chế độ ẩn danh."; return; }
  render();
});
window.__ocr = { PREP, convertFile, ocrPage, prepare, assemble, DB, docxBlob, exportZip, summaryCsv };
