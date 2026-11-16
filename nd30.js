/* Phân tích bố cục văn bản hành chính từ kết quả OCR và dựng .docx theo thể thức Nghị định 30/2020/NĐ-CP.
   Bản web đơn giản hơn bản Python: không vẽ lại bảng, không giữ con dấu/chữ ký (chỉ chừa chỗ). */
(function (root) {
  "use strict";

  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toUpperCase();
  const TYPES = ["QUYẾT ĐỊNH", "THÔNG BÁO", "BÁO CÁO", "TỜ TRÌNH", "KẾ HOẠCH", "CHỈ THỊ", "NGHỊ QUYẾT", "THÔNG TƯ",
    "CÔNG ĐIỆN", "BIÊN BẢN", "GIẤY MỜI", "HƯỚNG DẪN", "QUY CHẾ", "QUY ĐỊNH", "CHƯƠNG TRÌNH", "ĐỀ ÁN", "PHƯƠNG ÁN",
    "HỢP ĐỒNG", "GIẤY GIỚI THIỆU", "GIẤY ĐI ĐƯỜNG", "THƯ CÔNG", "THÔNG CÁO", "KẾT LUẬN", "NGHỊ ĐỊNH"].map(strip);
  const CONF_LOW = 72;

  /* ---------- gom từ -> dòng ---------- */
  function fromTessLines(tl) {
    const lines = [];
    for (const l of tl) {
      const ws = (l.words || []).filter((w) => w.text && w.text.trim()).map((w) => ({
        text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence,
        cx: (w.bbox.x0 + w.bbox.x1) / 2, cy: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 })).sort((a, b) => a.x0 - b.x0);
      if (ws.length) lines.push({ words: ws, cy: median(ws.map((x) => x.cy)), h: median(ws.map((x) => x.h)) });
    }
    return lines.sort((a, b) => a.cy - b.cy);
  }
  function groupLines(words, tl) {
    if (tl && tl.length) return fromTessLines(tl);
    const ws = words.filter((w) => w.text && w.text.trim()).map((w) => ({
      text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence,
      cx: (w.bbox.x0 + w.bbox.x1) / 2, cy: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0,
    }));
    ws.sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const w of ws) {
      let hit = null;
      for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
        const l = lines[i];
        if (Math.abs(w.cy - l.cy) <= 0.5 * l.h) { hit = l; break; }
      }
      if (hit) { hit.words.push(w); hit.cy = median(hit.words.map((x) => x.cy)); hit.h = median(hit.words.map((x) => x.h)); }
      else lines.push({ words: [w], cy: w.cy, h: w.h });
    }
    for (const l of lines) l.words.sort((a, b) => a.x0 - b.x0);
    lines.sort((a, b) => a.cy - b.cy);
    return lines;
  }
  function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; }

  /* tách một dòng thành các cụm (span) theo khoảng trắng lớn (đầu văn bản hai cột) */
  function spans(line, gap) {
    const out = [[line.words[0]]];
    for (let i = 1; i < line.words.length; i++) {
      const p = line.words[i - 1], c = line.words[i];
      if (c.x0 - p.x1 > gap) out.push([c]); else out[out.length - 1].push(c);
    }
    return out.map((ws) => ({
      words: ws, x0: ws[0].x0, x1: ws[ws.length - 1].x1, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)),
      text: ws.map((w) => w.text).join(" "), h: median(ws.map((w) => w.h)),
    }));
  }
  const runsOf = (ws) => {
    const runs = [];
    for (const w of ws) {
      const u = w.conf < CONF_LOW;
      if (runs.length && runs[runs.length - 1].u === u) runs[runs.length - 1].t += " " + w.text;
      else { if (runs.length) runs[runs.length - 1].t += " "; runs.push({ t: w.text, u }); }
    }
    return runs;
  };

  /* ---------- phân tích ---------- */
  function parse(words, W, H, tessLines) {
    const lines = groupLines(words, tessLines);
    const medH = median(lines.map((l) => l.h)) || 20;
    const m = { warnings: [], head: { left: [], right: [] }, so: "", dia_danh: "", loai: "", ten_loai: "", trich_yeu: [], vv: "",
      kinh_gui: "", body: [], noi_nhan: [], chuc_vu: [], ho_ten: "", quyen: "" };
    if (!lines.length) { m.warnings.push("Không đọc được chữ nào trong ảnh."); return m; }

    const allSpans = lines.map((l) => ({ line: l, sp: spans(l, Math.max(2.2 * medH, 0.04 * W)) }));
    const left0 = Math.min(...lines.map((l) => l.words[0].x0));
    let i = 0;

    /* 1) đầu văn bản: các dòng chứa quốc hiệu/tiêu ngữ và cơ quan ở cột trái */
    const hdrEnd = lines.findIndex((l, k) => k > 0 && l.cy > 0.3 * H);
    const headLimit = hdrEnd < 0 ? lines.length : hdrEnd;
    let qh = -1;
    for (let k = 0; k < Math.min(headLimit, 10); k++) {
      if (/CONG HOA XA HOI|CHU NGHIA VIET NAM/.test(strip(lines[k].words.map((w) => w.text).join(" ")))) { qh = k; break; }
    }
    if (qh < 0) m.warnings.push("Không tìm thấy Quốc hiệu. Nếu đây không phải công văn theo NĐ 30, kết quả có thể chưa phù hợp.");
    let bodyStart = 0, headerBottom = 0;
    for (let k = 0; k < headLimit; k++) {
      const spl = allSpans[k].sp;
      for (const s of spl) {
        const side = (s.x0 + s.x1) / 2 < 0.5 * W && s.x0 < 0.45 * W ? "left" : "right";
        const t = s.text;
        const isDate = /ngày\s*\S*\s*tháng/i.test(t) || /^[\p{L} .]+,\s*ngày/iu.test(t);
        const isSo = /^Số\s*[:.]?\s*\S/i.test(t) && side === "left";
        if (isDate) m.dia_danh = t;
        else if (isSo) m.so = t;
        else if (side === "left" && !/^V\/v/i.test(t)) m.head.left.push({ t, runs: runsOf(s.words) });
        else if (side === "right") m.head.right.push({ t, runs: runsOf(s.words) });
      }
      headerBottom = k + 1;
      const txt = lines[k].words.map((w) => w.text).join(" ");
      if (m.so && (m.dia_danh || k > 1) && /^Số/i.test(txt)) { break; }
    }
    /* sau số ký hiệu có thể còn dòng địa danh ngày ở dòng kế */
    let k = headerBottom;
    if (!m.dia_danh && k < lines.length) {
      const t = lines[k].words.map((w) => w.text).join(" ");
      if (/ngày\s*\S*\s*tháng/i.test(t)) { m.dia_danh = t; k++; }
    }
    // tách quốc hiệu/tiêu ngữ khỏi phần cột phải
    m.head.right = m.head.right.filter((x) => !/^[-–—_.\s]+$/.test(x.t));
    i = k;

    /* 2) tên loại, trích yếu / V/v, Kính gửi */
    const txtOf = (l) => l.words.map((w) => w.text).join(" ");
    const centered = (l) => { const c = (l.words[0].x0 + l.words[l.words.length - 1].x1) / 2; return Math.abs(c - W / 2) < 0.08 * W && l.words[0].x0 > left0 + 0.12 * W; };
    for (let q = k; q < Math.min(lines.length, k + 8); q++) {     // tìm dòng tên loại ngay dưới đầu văn bản
      const t0 = strip(txtOf(lines[q]));
      if (TYPES.some((t) => t0 === t || t0.startsWith(t + " "))) { i = q; break; }
      if (/^V\/v|^VE VIEC|^KINH GUI|^CAN CU/.test(t0)) { i = q; break; }
    }
    const tl = strip(i < lines.length ? txtOf(lines[i]) : "");
    if (i < lines.length && TYPES.some((t) => tl === t || tl.startsWith(t + " "))) {
      m.loai = txtOf(lines[i]).trim(); i++;
      m.ten_loai = m.loai;
      while (i < lines.length && centered(lines[i]) && !/^Căn cứ|^Điều/i.test(txtOf(lines[i])) && m.trich_yeu.length < 3) {
        m.trich_yeu.push({ t: txtOf(lines[i]), runs: runsOf(lines[i].words) }); i++;
      }
    } else if (i < lines.length && /^V\/v|^Về việc/i.test(txtOf(lines[i]))) {
      m.vv = txtOf(lines[i]); i++;
      if (i < lines.length && !/^Kính gửi/i.test(txtOf(lines[i])) && lines[i].words[0].x0 > left0 + 0.25 * W) { m.vv += " " + txtOf(lines[i]); i++; }
    }
    // trường hợp công văn: V/v nằm cạnh số ký hiệu (dòng bên dưới số)
    if (!m.vv) {
      for (let q = 0; q < Math.min(lines.length, headLimit + 3); q++) {
        const t = txtOf(lines[q]);
        const mm = t.match(/V\/v\s*.*/i);
        if (mm && !m.loai) { m.vv = mm[0]; break; }
      }
    }
    if (m.vv) m.head.left = m.head.left.filter((x) => !/^V\/v/i.test(x.t));

    /* 3) nơi nhận: dòng 'Nơi nhận' */
    let nn = -1;
    for (let q = lines.length - 1; q >= i; q--) { if (/^N[oơ]i\s*nh[aậ]n\s*:?/i.test(strip(txtOf(lines[q])).replace(/^NOI NHAN/, "Noi nhan")) || /^Nơi nhận/i.test(txtOf(lines[q]))) { nn = q; break; } }
    const bodyEnd = nn >= 0 ? nn : lines.length;

    /* 4) thân văn bản: gom dòng thành đoạn */
    const bodyLines = lines.slice(i, bodyEnd);
    const textLeft = median(bodyLines.map((l) => l.words[0].x0)) || left0;
    let cur = null, prev = null;
    const flush = () => { if (cur) { m.body.push(cur); cur = null; } };
    for (const l of bodyLines) {
      const t = txtOf(l);
      if (/^Kính gửi/i.test(t) && !m.kinh_gui) { m.kinh_gui = t; prev = l; continue; }
      if (m.kinh_gui && prev && prev.__kg && !/^[-–•]/.test(t) && l.words[0].x0 > left0 + 0.15 * W) { m.kinh_gui += " " + t; continue; }
      const gap = prev ? l.cy - prev.cy : 0;
      const indent = l.words[0].x0 > textLeft + 1.5 * l.h;
      const bullet = /^(Điều\s+\d+|\d+(\.\d+)*[.)]|[a-zđ]\)|[-–•+])\s/i.test(t) || /^(Căn cứ|Chương|Mục)\b/.test(t);
      const endsSentence = prev && /[.;:!?…]$/.test(txtOf(prev).trim());
      const heading = /^(Điều\s+\d+|Chương\s+[IVXLC\d]+|Mục\s+\d+)/i.test(t);
      const newPara = !cur || indent || bullet || heading || gap > 1.7 * medH || (endsSentence && gap > 1.25 * l.h && !/^[a-zà-ỹ]/.test(t));
      if (newPara) {
        flush();
        cur = { runs: runsOf(l.words), heading, italic: /^Căn cứ/.test(t), bold: heading && /^Điều/i.test(t) };
      } else {
        const lastRun = cur.runs[cur.runs.length - 1];
        lastRun.t += " ";
        for (const r of runsOf(l.words)) cur.runs.push(r);
      }
      prev = l;
    }
    flush();
    // gộp các run liền nhau cùng trạng thái
    for (const p of m.body) {
      const out = [];
      for (const r of p.runs) { if (out.length && out[out.length - 1].u === r.u) out[out.length - 1].t += r.t; else out.push({ ...r }); }
      p.runs = out;
    }

    /* 5) nơi nhận + chữ ký */
    if (nn >= 0) {
      const sigLines = [];
      for (let q = nn; q < lines.length; q++) {
        for (const s of spans(lines[q], Math.max(2.2 * medH, 0.04 * W))) {
          const rightSide = s.x0 > 0.45 * W;
          if (rightSide) sigLines.push({ t: s.text, y: lines[q].cy }); else if (q > nn || !/^N[oơ]i nhận/i.test(s.text)) m.noi_nhan.push(s.text);
        }
      }
      const sig = sigLines.filter((x) => x.t.length > 1);
      if (sig.length) {
        m.ho_ten = sig[sig.length - 1].t;
        m.chuc_vu = sig.slice(0, -1).map((x) => x.t);
      }
    } else {
      m.warnings.push("Không tìm thấy mục \"Nơi nhận\".");
    }
    m.noi_nhan = m.noi_nhan.filter((t) => !/^N[oơ]i nhận\s*:?\s*$/i.test(t));
    const unc = m.body.reduce((n, p) => n + p.runs.filter((r) => r.u).length, 0);
    if (unc) m.warnings.push(`${unc} đoạn chữ OCR kém chắc chắn được tô vàng trong Word. Hãy rà soát.`);
    if (!m.body.length) m.warnings.push("Không nhận ra phần nội dung văn bản.");
    return m;
  }

  /* ---------- dựng .docx ---------- */
  function build(model, D) {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, Header,
      PageNumber, TableLayoutType, VerticalAlign, LineRuleType } = D;
    const FONT = "Times New Roman", MM = 56.7;
    const mm = (x) => Math.round(x * MM);
    const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
    const run = (t, o = {}) => new TextRun({ text: t, font: FONT, size: Math.round((o.size || 14) * 2), bold: !!o.bold, italics: !!o.italics,
      allCaps: !!o.caps, highlight: o.hl ? "yellow" : undefined });
    const runsFrom = (runs, o = {}) => (runs && runs.length ? runs.map((r) => run(r.t, { ...o, hl: r.u })) : [run("", o)]);
    const P = (children, o = {}) => new Paragraph({ children, alignment: o.align, spacing: { before: o.before || 0, after: o.after ?? 0, line: o.line || 240, lineRule: LineRuleType.AUTO },
      indent: o.indent ? { firstLine: mm(12.7) } : undefined, keepNext: !!o.keepNext, border: o.border });
    const centerP = (t, o) => P([run(t, o)], { align: AlignmentType.CENTER, ...o });
    const lineRule = (len) => new Paragraph({ children: [], alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000", space: 1 } }, indent: { left: mm(len), right: mm(len) } });

    /* đầu văn bản: bảng 2 cột */
    const leftKids = [], rightKids = [];
    const leftTexts = model.head.left.map((x) => x.t);
    leftTexts.forEach((t, k) => leftKids.push(centerP(t, { size: 13, bold: k === leftTexts.length - 1 || k > 0, caps: k === 0 })));
    if (leftTexts.length) leftKids.push(lineRule(18));
    if (model.so) leftKids.push(centerP(model.so, { size: 13, before: 60 }));
    if (model.vv) leftKids.push(centerP(model.vv, { size: 12, before: 60 }));
    rightKids.push(centerP("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", { size: 13, bold: true }));
    rightKids.push(centerP("Độc lập - Tự do - Hạnh phúc", { size: 14, bold: true }));
    rightKids.push(lineRule(22));
    if (model.dia_danh) rightKids.push(P([run(model.dia_danh, { size: 14, italics: true })], { align: AlignmentType.CENTER, before: 120 }));
    const cell = (kids, w) => new TableCell({ children: kids, width: { size: w, type: WidthType.DXA }, borders: noBorders, verticalAlign: VerticalAlign.TOP });
    const total = mm(210 - 30 - 15);
    const children = [new Table({ rows: [new TableRow({ children: [cell(leftKids, Math.round(total * 0.36)), cell(rightKids, Math.round(total * 0.64))] })],
      width: { size: total, type: WidthType.DXA }, columnWidths: [Math.round(total * 0.36), Math.round(total * 0.64)], layout: TableLayoutType.FIXED,
      borders: { ...noBorders, insideHorizontal: noBorder, insideVertical: noBorder } })];

    /* tên loại, trích yếu */
    if (model.ten_loai) {
      children.push(centerP(model.ten_loai.toUpperCase(), { size: 14, bold: true, before: 240 }));
      const ty = model.trich_yeu.map((x) => x.t).join(" ").trim();
      if (ty) { children.push(centerP(ty, { size: 14, bold: true })); children.push(lineRule(25)); }
    }
    if (model.kinh_gui) children.push(P([run(model.kinh_gui, { size: 14 })], { align: AlignmentType.CENTER, before: 200, after: 80 }));
    /* nội dung */
    model.body.forEach((p) => {
      children.push(P(runsFrom(p.runs, { size: 14, bold: p.bold, italics: p.italic }), { align: AlignmentType.JUSTIFIED, indent: true, before: 120, line: 276 }));
    });
    /* nơi nhận + chữ ký */
    const nnKids = [P([run("Nơi nhận:", { size: 12, bold: true, italics: true })], { keepNext: true })];
    model.noi_nhan.forEach((t) => nnKids.push(P([run(t, { size: 11 })], { keepNext: true })));
    const sgKids = model.chuc_vu.map((t, k) => centerP(t, { size: 14, bold: true, keepNext: true }));
    sgKids.push(P([run("", { size: 14 })], { after: 1200 }));
    if (model.ho_ten) sgKids.push(centerP(model.ho_ten, { size: 14, bold: true }));
    children.push(new Paragraph({ children: [], spacing: { before: 120, after: 0 }, keepNext: true }));
    children.push(new Table({ rows: [new TableRow({ cantSplit: true, children: [cell(nnKids, Math.round(total * 0.5)), cell(sgKids, Math.round(total * 0.5))] })],
      width: { size: total, type: WidthType.DXA }, columnWidths: [Math.round(total * 0.5), Math.round(total * 0.5)], layout: TableLayoutType.FIXED,
      borders: { ...noBorders, insideHorizontal: noBorder, insideVertical: noBorder } }));

    return new Document({
      creator: "OCR văn bản (web)", title: model.ten_loai || "Văn bản",
      styles: { default: { document: { run: { font: FONT, size: 28 } } } },
      sections: [{
        properties: { titlePage: true, page: { size: { width: mm(210), height: mm(297) }, margin: { top: mm(20), bottom: mm(20), left: mm(30), right: mm(15), header: mm(10) } } },
        headers: {
          first: new Header({ children: [new Paragraph({ children: [] })] }),
          default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 26 })] })] }),
        },
        children,
      }],
    });
  }


  /* ---------- văn bản trơn: chỉ chép nội dung, không dựng thể thức ---------- */
  function plainParse(words, W, H, tessLines) {
    const raw = groupLines(words, tessLines);
    const medH = median(raw.map((l) => l.h)) || 20;
    const left = median(raw.map((l) => l.words[0].x0)) || 0;
    const right = median(raw.map((l) => l.words[l.words.length - 1].x1)) || W;
    /* các dòng liền nhau chia 2 cột (quốc hiệu | tên cơ quan) → đọc hết cột trái rồi tới cột phải */
    const lines = []; let run = [];
    const mk = (ws, ref) => ({ words: ws, cy: median(ws.map((x) => x.cy)), h: ref.h });
    const flushRun = () => {
      if (run.length && run.length <= 6) { const L = [], R = [];
        run.forEach(({ l, sp }) => { L.push(mk(sp[0], l)); R.push(mk(sp[1], l)); }); lines.push(...L, ...R); }
      else run.forEach(({ l }) => lines.push(l));
      run = [];
    };
    for (const l of raw) {
      const sp = spans(l, Math.max(2.2 * medH, 0.04 * W)).map((x) => x.words);
      if (sp.length === 2 && sp[0][0].x0 < 0.5 * W && sp[1][0].x0 > 0.4 * W) run.push({ l, sp }); else { flushRun(); lines.push(l); }
    }
    flushRun();
    const paras = []; let cur = null, prev = null;
    for (const l of lines) {
      const t = l.words.map((w) => w.text).join(" "), x0 = l.words[0].x0, x1 = l.words[l.words.length - 1].x1;
      const lm = x0 - left, rm = right - x1, width = x1 - x0;
      const center = width < 0.8 * (right - left) && Math.abs(lm - rm) < 0.06 * W && lm > 0.04 * W;
      const gap = prev ? l.cy - prev.cy : 0;
      const bullet = /^(Điều\s+\d+|\d+(\.\d+)*[.)]|[a-zđ]\)|[-–•+])\s/i.test(t);
      const indent = x0 > left + 1.5 * l.h;
      const endS = prev && /[.;:!?…]$/.test(prev.t.trim());
      const nl = !cur || center || cur.center || bullet || indent || gap > 1.6 * medH || (endS && gap > 1.2 * l.h && !/^[a-zà-ỹ]/.test(t)) ||
        (prev && prev.right < right - 0.12 * W && endS);
      if (nl) { cur = { runs: runsOf(l.words), center }; paras.push(cur); }
      else { cur.runs[cur.runs.length - 1].t += " "; runsOf(l.words).forEach((r) => cur.runs.push(r)); }
      prev = { t, right: x1 };
    }
    for (const p of paras) { const o = []; for (const r of p.runs) { if (o.length && o[o.length - 1].u === r.u) o[o.length - 1].t += r.t; else o.push({ ...r }); } p.runs = o; }
    return paras;
  }
  function plainBuild(paras, D) {
    const { Document, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } = D;
    const mm = (x) => Math.round(x * 56.7);
    return new Document({ sections: [{ properties: { page: { size: { width: mm(210), height: mm(297) }, margin: { top: mm(20), bottom: mm(20), left: mm(25), right: mm(20) } } },
      children: (paras.length ? paras : [{ runs: [{ t: "" }] }]).flatMap((p) => {
        if (p.table) {
          const cols = Math.max(1, ...p.table.map((r) => r.length)), bd = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
          return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: bd, bottom: bd, left: bd, right: bd, insideHorizontal: bd, insideVertical: bd },
            rows: p.table.map((r) => new TableRow({ children: Array.from({ length: cols }, (_, c) => new TableCell({ width: { size: 100 / cols, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: r[c] || "", font: "Times New Roman", size: 24 })] })] })) })) }),
            new Paragraph({ children: [] })];
        }
        return [new Paragraph({ alignment: p.center ? AlignmentType.CENTER : p.right ? AlignmentType.RIGHT : AlignmentType.LEFT, spacing: { after: 100 },
          children: p.runs.map((r) => new TextRun({ text: r.t, font: "Times New Roman", size: 26, bold: !!p.bold, italics: !!p.italic, highlight: r.u ? "yellow" : undefined })) })];
      }) }] });
  }
  root.ND30 = { plainParse, plainBuild, parse, build, groupLines, strip };
})(typeof window !== "undefined" ? window : globalThis);
