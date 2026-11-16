/* Phiên scan bằng camera: đo độ nét/rung theo thời gian thực, tự chụp khi giữ yên, chụp loạt chọn ảnh nét nhất,
   quản lý trang (đặt tên, sắp xếp, xoay, chụp lại, xóa), lưu nháp, xuất Word/PDF, gửi. */
"use strict";

/* ---------- PDF (ảnh scan) tự viết, không cần thư viện ---------- */
function makePdf(scans) {
  const enc = new TextEncoder(), chunks = [], off = []; let pos = 0;
  const push = (u) => { chunks.push(u); pos += u.length; }, str = (s) => push(enc.encode(s));
  const obj = (id, fn) => { off[id] = pos; str(`${id} 0 obj\n`); fn(); str("endobj\n"); };
  const n = scans.length; str("%PDF-1.4\n");
  obj(1, () => str("<< /Type /Catalog /Pages 2 0 R >>\n"));
  obj(2, () => str(`<< /Type /Pages /Count ${n} /Kids [${scans.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>\n`));
  scans.forEach((sc, i) => {
    const pw = sc.w > sc.h ? 841.89 : 595.28, ph = (pw * sc.h) / sc.w, id = 3 + i * 3;
    const bin = atob(sc.data.split(",")[1]), u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm /Im0 Do Q`;
    obj(id, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>\n`));
    obj(id + 1, () => str(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\n`));
    obj(id + 2, () => { str(`<< /Type /XObject /Subtype /Image /Width ${sc.w} /Height ${sc.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${u.length} >>\nstream\n`); push(u); str("\nendstream\n"); });
  });
  const xref = pos, total = 3 + n * 3;
  str(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) str(String(off[i]).padStart(10, "0") + " 00000 n \n");
  str(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: "application/pdf" });
}
const pdfOf = (d) => makePdf(d.scans);

/* ---------- gửi / chia sẻ ---------- */
async function shareDoc(d, kind) {
  const isPdf = kind === "pdf", blob = isPdf ? pdfOf(d) : await docxBlob(d), name = stem(d.name) + (isPdf ? "_scan.pdf" : sfx(d) + ".docx");
  const type = isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const f = new File([blob], name, { type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: d.name, text: "Văn bản scan: " + d.name }); return "Đã mở bảng chia sẻ."; }
  } catch (e) { if (e.name === "AbortError") return "Đã hủy gửi."; }
  download(blob, name);
  return "Trình duyệt này không gửi trực tiếp được nên file đã được tải về; hãy đính kèm file vào email/Zalo. (Trên điện thoại, mở bằng Chrome/Safari để dùng nút chia sẻ.)";
}
const mailTo = (d) => `mailto:?subject=${encodeURIComponent(d.name)}&body=${encodeURIComponent("Gửi anh/chị văn bản scan: " + d.name + "\n(Đính kèm file vừa tải về.)")}`;
function shareRow(d, msg) {
  const kind = el("select", {}, el("option", { value: "docx" }, "Word"), ...(d.scans?.length ? [el("option", { value: "pdf" }, "PDF (ảnh scan)")] : []));
  return el("div", { class: "row" },
    el("button", { onclick: async () => { const b = kind.value === "pdf" ? pdfOf(d) : await docxBlob(d); download(b, stem(d.name) + (kind.value === "pdf" ? "_scan.pdf" : sfx(d) + ".docx")); } }, "⬇ Tải"), kind,
    el("button", { class: "primary", onclick: async () => { msg.textContent = await shareDoc(d, kind.value); } }, "📤 Gửi / chia sẻ"),
    el("a", { href: mailTo(d), class: "btn" }, "✉ Soạn email"));
}

/* ---------- đo ảnh ---------- */
function lapVar(ctx, sx, sy, sw, sh) {                         // độ nét = phương sai Laplacian trên một mảnh ảnh ở độ phân giải gốc
  const im = ctx.getImageData(sx, sy, sw, sh).data, g = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) g[i] = im[i * 4] * 0.299 + im[i * 4 + 1] * 0.587 + im[i * 4 + 2] * 0.114;
  let s = 0, s2 = 0, c = 0;
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) { const i = y * sw + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - sw] - g[i + sw]; s += l; s2 += l * l; c++; }
  const m = s / c; return s2 / c - m * m;
}
const patchOf = (c) => { const w = Math.min(560, c.width), h = Math.min(420, c.height); return [Math.floor((c.width - w) / 2), Math.floor((c.height - h) / 2), w, h]; };

/* ---------- trạng thái phiên (giữ khi chuyển tab) ---------- */
const SESS = { name: "", pages: [], q: Promise.resolve(), auto: true, retake: null, doc: null, loaded: false, torch: false, maxSharp: 1, lastShot: 0, lastTiny: null };
const defName = () => "Scan " + new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
let camStream = null, anTimer = null;
function stopCamera() { clearInterval(anTimer); anTimer = null; camStream?.getTracks().forEach((t) => t.stop()); camStream = null; }

let saveT = null;
const saveDraft = () => { clearTimeout(saveT); saveT = setTimeout(() => { if (!SESS.pages.length) return DB.draftDel().catch(() => {});
  DB.draftPut({ name: SESS.name, pages: SESS.pages.map((p) => ({ id: p.id, blob: p.blob, rot: p.rot, manual: p.manual, sharp: p.sharp, thumb: p.thumb, result: p.state === "done" ? p.result : null })) }).catch(() => {}); }, 600); };

async function runOcr(page, ui) {
  page.state = "ocr"; ui.redraw();
  try {
    const bmp = await createImageBitmap(page.blob, { imageOrientation: "from-image" });
    const p = prepare(bmp, page.rot); bmp.close?.(); p.keepScan = true; p.oriented = !!page.manual;
    const r = await ocrPage(p, (s) => ui.status(s)); page.result = r; page.thumb = r.thumb; page.state = "done";
  } catch (e) { console.error(e); page.state = "err"; page.err = e.message || String(e); }
  ui.redraw(); saveDraft();
}
const enqueue = (page, ui) => { page.state = "queued"; SESS.q = SESS.q.then(() => runOcr(page, ui)).catch(() => {}); };

function viewCamera() {
  const S = SESS, fmtSel = fmtSelect();
  if (!S.name) S.name = defName();
  const video = el("video", { autoplay: true, playsinline: true, muted: true, class: "cam" });
  const overlay = el("canvas", { class: "ovl" });
  const chip = el("div", { class: "chip" }, "Đang mở camera…"), meter = el("div", { class: "meter" }, el("i", {})), counter = el("div", { class: "counter" });
  const still = el("img", { class: "still", hidden: true, alt: "ảnh vừa chụp" }), badge = el("div", { class: "badge", hidden: true });
  const camwrap = el("div", { class: "camwrap" }, video, overlay, el("div", { class: "frame" }), still, badge, chip, meter, counter, el("div", { class: "offmsg" }, "Camera đang tắt"));
  const msg = el("div", { class: "muted" }), grid = el("div", { class: "pgrid" }), result = el("div", { class: "result" });
  const nameIn = el("input", { type: "text", value: S.name, placeholder: "Tên tài liệu", style: "flex:1 1 14rem", oninput: () => { S.name = nameIn.value; saveDraft(); } });
  const toggleCam = el("button", {}, "⏻ Tắt camera"), torchBtn = el("button", { hidden: true }, "🔦 Đèn"), zoom = el("input", { type: "range", hidden: true, title: "Thu phóng" });
  const autoCb = el("input", { type: "checkbox", checked: S.auto, onchange: () => { S.auto = autoCb.checked; } });
  const finish = el("button", { class: "primary", disabled: true }, "✅ Hoàn tất & lưu");
  const ui = { redraw: () => drawGrid(), status: (s) => (msg.textContent = s) };
  const alive = () => document.body.contains(camwrap);

  /* ---- lưới trang ---- */
  const stText = (p) => p.state === "done" ? `✓ đọc ${p.result.mean.toFixed(0)}%${p.result.rotated ? " · đã xoay " + p.result.rotated + "°" : ""}` : p.state === "err" ? "✘ lỗi: " + p.err : p.state === "ocr" ? "⏳ đang đọc…" : "⏳ chờ đọc";
  function drawGrid() {
    if (!alive()) return;
    const n = S.pages.length, busy = S.pages.some((p) => p.state === "ocr" || p.state === "queued");
    counter.textContent = n ? `📄 ${n} trang` : "";
    grid.replaceChildren(...S.pages.map((p, i) => el("div", { class: "pg" + (S.retake === i ? " sel" : "") },
      el("img", { src: p.thumb || p.small, alt: "trang " + (i + 1), onclick: () => zoomPage(p, i) }),
      el("div", { class: "pgt" }, `Trang ${i + 1}`), el("small", { class: p.state === "err" || (p.state === "done" && p.result.mean < 65) || p.blur ? "bad" : "muted" }, stText(p) + (p.blur ? " · ảnh mờ" : "")),
      el("div", { class: "pgb" },
        el("button", { title: "Lên trước", disabled: i === 0, onclick: () => { [S.pages[i - 1], S.pages[i]] = [S.pages[i], S.pages[i - 1]]; drawGrid(); saveDraft(); } }, "◀"),
        el("button", { title: "Xuống sau", disabled: i === n - 1, onclick: () => { [S.pages[i + 1], S.pages[i]] = [S.pages[i], S.pages[i + 1]]; drawGrid(); saveDraft(); } }, "▶"),
        el("button", { title: "Xoay 90°", onclick: () => { p.rot = (p.rot + 90) % 360; p.manual = true; p.result = null; enqueue(p, ui); drawGrid(); } }, "↻"),
        el("button", { title: "Chụp lại trang này", onclick: () => { S.retake = S.retake === i ? null : i; msg.textContent = S.retake === i ? `Lần chụp kế tiếp sẽ thay trang ${i + 1}.` : ""; drawGrid(); } }, "🔁"),
        el("button", { title: "Xóa trang", onclick: () => { if (confirm(`Xóa trang ${i + 1}?`)) { S.pages.splice(i, 1); S.retake = null; drawGrid(); saveDraft(); } } }, "🗑")))));
    finish.disabled = !n || busy; finish.textContent = busy ? "⏳ Đang đọc các trang…" : "✅ Hoàn tất & lưu";
    if (!n) grid.replaceChildren(el("p", { class: "muted" }, "Chưa có trang nào. Đặt tờ giấy vào khung rồi chụp; có thể chụp nhiều trang liên tiếp."));
  }
  function zoomPage(p, i) {
    const big = el("div", { class: "modal", onclick: (e) => { if (e.target === big) big.remove(); } },
      el("div", { class: "mbox" }, el("div", { class: "row" }, el("b", {}, `Trang ${i + 1}`), el("button", { onclick: () => big.remove() }, "Đóng")),
        el("img", { src: p.result?.scan?.data || p.thumb }), p.result ? el("pre", { class: "preview" }, p.result.text.trim().slice(0, 4000)) : ""));
    document.body.append(big);
  }

  /* ---- chụp ---- */
  const grab = () => { const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(video, 0, 0); return { c, g }; };
  async function snap(auto) {
    if (!camStream || !video.videoWidth) { msg.textContent = "Camera đang tắt hoặc chưa sẵn sàng."; return; }
    if (S.shooting) return; S.shooting = true; S.lastShot = Date.now();
    badge.hidden = false; badge.textContent = "📸 Giữ yên…"; camwrap.classList.add("flash"); setTimeout(() => camwrap.classList.remove("flash"), 200);
    let best = null;
    for (let i = 0; i < 3; i++) {                                  // chụp loạt 3 khung, lấy khung nét nhất
      const f = grab(), sp = patchOf(f.c), sv = lapVar(f.g, ...sp);
      if (!best || sv > best.sv) best = { ...f, sv }; if (i < 2) await sleep(90);
    }
    S.shooting = false;
    const rel = best.sv / Math.max(S.maxSharp, 1), blur = rel < 0.5 || best.sv < 12;
    const blob = await new Promise((r) => best.c.toBlob(r, "image/jpeg", 0.92));
    const small = document.createElement("canvas"); small.width = 240; small.height = Math.round((240 * best.c.height) / best.c.width); small.getContext("2d").drawImage(best.c, 0, 0, small.width, small.height);
    const smallUrl = small.toDataURL("image/jpeg", 0.6); still.src = smallUrl; still.hidden = false;
    const page = { id: Math.random().toString(36).slice(2, 9), blob, rot: 0, manual: false, sharp: best.sv, blur, small: smallUrl, thumb: smallUrl, state: "queued" };
    let idx;
    if (S.retake != null && S.pages[S.retake]) { idx = S.retake; S.pages[idx] = page; S.retake = null; } else { S.pages.push(page); idx = S.pages.length - 1; }
    S.lastTiny = tinyOf(); badge.textContent = `✅ ĐÃ CHỤP trang ${idx + 1}${blur ? " — ⚠ ảnh hơi mờ, nên chụp lại" : ""} — đang đọc chữ…`;
    drawGrid(); saveDraft(); enqueue(page, ui);
    SESS.q.then(() => { if (!alive()) return; badge.textContent = `✅ Đã chụp & đọc xong trang ${idx + 1}`; setTimeout(() => { still.hidden = true; badge.hidden = true; }, 1800); });
    if (blur) msg.textContent = "Trang vừa chụp hơi mờ. Bấm 🔁 ở trang đó để chụp lại (giữ chắc tay, chạm màn hình để lấy nét).";
    else msg.textContent = auto ? "Đã tự chụp. Lật sang trang tiếp theo, máy sẽ tự chụp khi giữ yên." : "Chụp tiếp trang sau hoặc bấm “Hoàn tất & lưu”.";
  }
  const tinyCv = document.createElement("canvas"); tinyCv.width = 32; tinyCv.height = 24; const tinyG = tinyCv.getContext("2d", { willReadFrequently: true });
  const tinyOf = () => { tinyG.drawImage(video, 0, 0, 32, 24); const d = tinyG.getImageData(0, 0, 32, 24).data, o = new Float32Array(768); for (let i = 0; i < 768; i++) o[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return o; };
  const diff = (a, b) => { if (!a || !b) return 99; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

  /* ---- vòng phân tích thời gian thực ---- */
  let prevTiny = null, stable = 0, tick = 0, paper = null, armed = true;
  const an = document.createElement("canvas"); an.width = 320;
  const analyse = () => {
    if (!alive()) { stopCamera(); return; }
    if (!camStream || !video.videoWidth || S.shooting) return;
    const vw = video.videoWidth, vh = video.videoHeight; tick++;
    const t = tinyOf(), motion = diff(t, prevTiny); prevTiny = t;
    stable = motion < 4 ? stable + 250 : 0;
    const cap = document.createElement("canvas"), [sx, sy, sw, sh] = patchOf({ width: vw, height: vh }); cap.width = sw; cap.height = sh;
    const cg = cap.getContext("2d", { willReadFrequently: true }); cg.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const sv = lapVar(cg, 0, 0, sw, sh); S.maxSharp = Math.max(S.maxSharp * 0.992, sv, 1);
    const rel = sv / S.maxSharp;
    if (tick % 3 === 0) { an.height = Math.round((320 * vh) / vw); an.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, an.width, an.height); try { paper = findPaper(an); } catch { paper = null; } drawQuad(); }
    meter.firstChild.style.width = Math.min(100, Math.round(rel * 100)) + "%"; meter.firstChild.style.background = rel > 0.75 ? "#16a34a" : rel > 0.5 ? "#eab308" : "#dc2626";
    const bright = t.reduce((a, b) => a + b, 0) / t.length, paperOK = !!paper || bright > 110;       // tờ giấy phủ kín khung (không thấy viền) vẫn được
    const sharpOK = rel >= 0.7 && sv >= 12, moving = motion >= 4;
    const changed = diff(t, S.lastTiny) > 9; if (changed) armed = true;
    let text, cls = "warn";
    if (S.pages.length >= 0 && moving) text = "Đang rung / di chuyển — giữ chắc tay";
    else if (!sharpOK) text = "Chưa nét — lùi ra xa một chút hoặc chạm vào màn hình để lấy nét";
    else if (!paperOK) text = "Chưa thấy tờ giấy — đưa cả tờ vào khung, đặt trên nền tối";
    else { text = S.auto ? (armed ? `Sẵn sàng ✓ giữ yên… ${Math.max(0, (700 - stable) / 1000).toFixed(1)}s` : "Đã chụp. Lật sang trang kế tiếp") : "Sẵn sàng ✓ bấm Chụp"; cls = "ok"; }
    chip.textContent = text; chip.className = "chip " + cls;
    if (S.auto && armed && paperOK && sharpOK && stable >= 700 && Date.now() - S.lastShot > 2500) { armed = false; snap(true); }
  };
  function drawQuad() {
    const r = camwrap.getBoundingClientRect(); overlay.width = Math.round(r.width); overlay.height = Math.round(r.height);
    const g = overlay.getContext("2d"); g.clearRect(0, 0, overlay.width, overlay.height); if (!paper) return;
    const vw = video.videoWidth, vh = video.videoHeight, sc = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * sc) / 2, oy = (r.height - vh * sc) / 2, k = vw / an.width * sc;
    g.strokeStyle = "#22c55e"; g.lineWidth = 3; g.beginPath(); paper.forEach(([x, y], i) => (i ? g.lineTo(ox + x * k, oy + y * k) : g.moveTo(ox + x * k, oy + y * k))); g.closePath(); g.stroke();
  }

  /* ---- bật/tắt camera, đèn, zoom, lấy nét ---- */
  let facing = "environment";
  const start = async () => {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Trình duyệt/địa chỉ này không cho dùng camera trực tiếp (cần https). Dùng nút “Chụp bằng ứng dụng máy ảnh”."; chip.textContent = "Không có camera"; return; }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
      video.srcObject = camStream; toggleCam.textContent = "⏻ Tắt camera"; camwrap.classList.remove("off");
      const tr = camStream.getVideoTracks()[0], caps = tr.getCapabilities?.() || {};
      try { if (caps.focusMode?.includes("continuous")) await tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
      torchBtn.hidden = !caps.torch;
      if (caps.zoom) { zoom.hidden = false; zoom.min = caps.zoom.min; zoom.max = Math.min(caps.zoom.max, caps.zoom.min * 4); zoom.step = caps.zoom.step || 0.1; zoom.value = tr.getSettings().zoom || caps.zoom.min; } else zoom.hidden = true;
      msg.textContent = "Đặt tờ giấy vào khung, đủ sáng. Máy tự chụp khi giữ yên và ảnh nét; hoặc bấm Chụp.";
      clearInterval(anTimer); prevTiny = null; stable = 0; S.maxSharp = 1; anTimer = setInterval(analyse, 250);
    } catch (e) { msg.textContent = "Không mở được camera: " + (e.message || e) + ". Hãy cho phép quyền camera hoặc dùng nút “Chụp bằng ứng dụng máy ảnh”."; chip.textContent = "Không mở được camera"; }
  };
  toggleCam.onclick = async () => { if (camStream) { stopCamera(); video.srcObject = null; toggleCam.textContent = "📷 Bật camera"; msg.textContent = "Camera đã tắt."; camwrap.classList.add("off"); chip.textContent = "Camera tắt"; } else await start(); };
  torchBtn.onclick = async () => { try { S.torch = !S.torch; await camStream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: S.torch }] }); torchBtn.textContent = S.torch ? "🔦 Tắt đèn" : "🔦 Bật đèn"; } catch { msg.textContent = "Máy không bật được đèn."; } };
  zoom.oninput = () => camStream?.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: +zoom.value }] }).catch(() => {});
  camwrap.addEventListener("click", async (e) => {                 // chạm để lấy nét
    const tr = camStream?.getVideoTracks()[0], caps = tr?.getCapabilities?.() || {}; if (!tr || !caps.focusMode) return;
    try { await tr.applyConstraints({ advanced: [{ focusMode: "single-shot" }] }); setTimeout(() => tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {}), 1800); msg.textContent = "Đang lấy nét…"; } catch {}
  });

  /* ---- hoàn tất ---- */
  finish.onclick = async () => {
    const results = S.pages.map((p) => p.result); if (results.some((r) => !r)) return;
    const d = assemble(S.name.trim() || defName(), results, fmtSel.value, true);
    stopCamera(); video.srcObject = null; toggleCam.textContent = "📷 Bật camera"; camwrap.classList.add("off");
    await DB.put(d); await DB.draftDel().catch(() => {}); S.doc = d; S.pages = []; S.name = ""; S.retake = null; showDone(); drawGrid();
  };
  function showDone() {
    const d = S.doc; if (!d) return result.replaceChildren();
    const m2 = el("div", { class: "muted" });
    result.replaceChildren(el("div", { class: "ok" }, `✅ Đã lưu “${d.name}” vào Thư viện (${d.pages} trang). ${d.model.warnings.length ? "⚠ " + d.model.warnings.length + " cảnh báo, hãy xem khi mở." : ""}`),
      shareRow(d, m2), m2,
      el("div", { class: "row" }, el("button", { onclick: () => setView("edit", d.id) }, "✏ Xem / sửa nội dung"),
        el("button", { class: "primary", onclick: () => { S.doc = null; S.name = defName(); nameIn.value = S.name; showDone(); start(); } }, "📷 Scan tài liệu mới")));
  }

  const fileCap = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, multiple: true });
  fileCap.addEventListener("change", async () => { for (const f of fileCap.files) { const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; c.getContext("2d").drawImage(bmp, 0, 0); bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92)), small = document.createElement("canvas"); small.width = 240; small.height = Math.round((240 * c.height) / c.width); small.getContext("2d").drawImage(c, 0, 0, small.width, small.height);
    const page = { id: Math.random().toString(36).slice(2, 9), blob, rot: 0, manual: false, sharp: 0, small: small.toDataURL("image/jpeg", 0.6), state: "queued" }; page.thumb = page.small; S.pages.push(page); drawGrid(); enqueue(page, ui); } fileCap.value = ""; saveDraft(); });

  /* khôi phục bản nháp nếu có */
  (async () => { if (!S.loaded) { S.loaded = true; try { const dr = await DB.draftGet(); if (dr && dr.pages?.length && !S.pages.length) {
      S.name = dr.name || S.name; nameIn.value = S.name;
      S.pages = dr.pages.map((p) => ({ ...p, small: p.thumb, state: p.result ? "done" : "queued" })); S.pages.forEach((p) => { if (p.state === "queued") enqueue(p, ui); });
      msg.textContent = `Đã khôi phục phiên scan dở dang (${S.pages.length} trang).`; } } catch {} } drawGrid(); })();
  setTimeout(() => { showDone(); drawGrid(); start(); }, 0);

  return el("main", {}, el("h2", {}, "Scan bằng camera"),
    el("div", { class: "row" }, el("label", { style: "flex:1 1 20rem;display:flex;gap:.5rem;align-items:center" }, "Tên tài liệu:", nameIn)),
    camwrap,
    el("div", { class: "row" }, el("button", { class: "primary big", onclick: () => snap(false) }, "📸 Chụp"), el("label", {}, autoCb, " Tự chụp khi nét & yên"), toggleCam, torchBtn, zoom,
      el("button", { onclick: () => { facing = facing === "environment" ? "user" : "environment"; start(); } }, "🔄 Đổi camera"),
      el("button", { onclick: () => fileCap.click() }, "Chụp bằng ứng dụng máy ảnh / chọn ảnh"), fileCap),
    msg, el("h3", {}, "Các trang đã chụp"), grid,
    el("div", { class: "row" }, el("label", {}, "Bộ đọc: ", engineSelect()), el("label", {}, "Kiểu Word: ", fmtSel), finish,
      el("button", { onclick: async () => { if (confirm("Bỏ phiên scan đang làm dở?")) { S.pages = []; S.name = defName(); nameIn.value = S.name; S.retake = null; await DB.draftDel().catch(() => {}); drawGrid(); } } }, "Hủy phiên")),
    result,
    el("p", { class: "muted" }, "Mẹo: đặt giấy trên nền tối, đủ sáng (bật đèn nếu có), cầm chắc hoặc tựa khuỷu tay. Thanh nét: xanh là đạt. Chữ chụp ngược/nằm ngang sẽ được tự xoay; nếu sai bấm ↻ để xoay tay. Phiên đang chụp được lưu nháp, tải lại trang vẫn còn."));
}
