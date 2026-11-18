/* Bộ đọc AI nhiều nhà cung cấp: Gemini, Groq, OpenRouter (có gói miễn phí) và Anthropic.
   Tự nhận diện nhà cung cấp theo dạng key, kiểm tra key thật bằng cách gọi danh sách model, tự chọn model phù hợp,
   xoay vòng nhiều key/model khi gặp giới hạn. Mọi thứ chạy trong trình duyệt, key chỉ lưu trong localStorage. */
(function (root) {
  "use strict";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const ORDER = ["gemini", "groq", "openrouter", "anthropic", "xai"];            // ưu tiên gói miễn phí trước
  const NAMES = { gemini: "Google Gemini", groq: "Groq", openrouter: "OpenRouter", anthropic: "Anthropic Claude", xai: "xAI Grok" };
  const FREE = { gemini: true, groq: true, openrouter: true, anthropic: false, xai: false };
  const cool = new Map();                                                 // "keyId|model" -> thời điểm dùng lại
  let rr = 0;

  const detect = (k) => /^sk-ant-/.test(k) ? "anthropic" : /^xai-/.test(k) ? "xai" : /^sk-or-/.test(k) ? "openrouter" : /^(AIza|AQ\.)/.test(k) ? "gemini" : /^gsk_/.test(k) ? "groq" : null;
  const keys = () => { try { return JSON.parse(get("ai_keys", "[]")); } catch { return []; } };
  const save = (a) => set("ai_keys", JSON.stringify(a));
  const mask = (k) => k.slice(0, 6) + "…" + k.slice(-4);

  async function jfetch(url, opt) {
    opt = opt && opt.method ? opt : { timeout: 15000, ...(opt || {}) };
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), (opt && opt.timeout) || 30000); let r;
    try { r = await fetch(url, { ...(opt || {}), signal: ctl.signal }); } catch (x) { clearTimeout(tm);
      if (x.name === "AbortError") { const e = new Error(`Quá thời gian chờ ${new URL(url).host} (${Math.round(((opt && opt.timeout) || 30000) / 1000)} giây)`); e.status = 0; e.net = true; e.timeout = true; throw e; }
      const e = new Error(`Không kết nối được tới ${new URL(url).host} (mạng bị chặn, tiện ích chặn quảng cáo/VPN, hoặc đang mở file trực tiếp thay vì qua https). Chi tiết: ${x.message}`); e.status = 0; e.net = true; throw e; }
    let j = null; try { j = await r.json(); } catch {} clearTimeout(tm);
    if (!r.ok) { const m = j && (j.error?.message || (typeof j.error === "string" ? j.error : "") || j.message); const st = j && j.error && typeof j.error === "object" ? [j.error.status, j.error.details?.[0]?.reason].filter(Boolean).join("/") : ""; const e = new Error(`${m || "Lỗi"} (HTTP ${r.status}${st ? " " + st : ""})`); e.status = r.status; throw e; }
    return j;
  }

  /* ---- kiểm tra key + chọn model ---- */
  const verOf = (s) => { const m = s.match(/(\d+(?:[.-]\d+)?)/); return m ? parseFloat(m[1].replace("-", ".")) : 0; };
  const verify = {
    async gemini(key) {
      const L = "https://generativelanguage.googleapis.com/v1beta/models";
      let j;
      try { j = await jfetch(L + "?pageSize=1000&key=" + encodeURIComponent(key)); }          // GET đơn giản, không cần preflight CORS
      catch (e1) {
        try { j = await jfetch(L + "?pageSize=1000", { headers: { "x-goog-api-key": key } }); }
        catch (e2) {
          if (e1.status === 401 || (e1.status === 400 && /API key not valid|invalid/i.test(e1.message))) throw e1;
          // không liệt kê được model (key bị giới hạn API?): thử gọi thật một model phổ biến
          for (const m of ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"]) {
            try { await jfetch(`${L}/${m}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 5 } }) }); return [m]; } catch (e3) { if (e3.status === 429) return [m]; }
          }
          throw e1;
        }
      }
      const all = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
      const bad = /embed|image|tts|audio|live|aqa|imagen|veo|robotics|computer|thinking-exp|-8b|learnlm|gemma|pro/i;
      const stable = all.filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
      const any = all.filter((n) => /flash/i.test(n) && !bad.test(n));
      const rank = (n) => verOf(n) * 10 + (/lite/.test(n) ? 0 : 5) - (/preview|exp/.test(n) ? 3 : 0);
      let pick = [...new Set([...stable.sort((a, b) => rank(b) - rank(a)), ...any.sort((a, b) => rank(b) - rank(a))])];
      if (!pick.length) pick = all.filter((n) => /^gemini/.test(n) && !bad.test(n));
      if (!pick.length) pick = ["gemini-2.5-flash", "gemini-flash-latest"];       // key hợp lệ nhưng danh sách lạ: thử tên phổ biến
      return pick.slice(0, 4);
    },
    async groq(key) {
      const j = await jfetch("https://api.groq.com/openai/v1/models", { headers: { authorization: "Bearer " + key } });
      const ids = (j.data || []).filter((m) => m.active !== false).map((m) => m.id);
      const bad = /guard|whisper|tts|orpheus|embed|safeguard/i;
      const vis = ids.filter((n) => /llama-4|vision|scout|maverick|qwen.*vl|pixtral/i.test(n) && !bad.test(n)).sort((a, b) => (/scout/.test(b) ? 1 : 0) - (/scout/.test(a) ? 1 : 0));
      return (vis.length ? vis : ["meta-llama/llama-4-scout-17b-16e-instruct"]).slice(0, 3);
    },
    async openrouter(key) {
      await jfetch("https://openrouter.ai/api/v1/auth/key", { headers: { authorization: "Bearer " + key } });
      const j = await jfetch("https://openrouter.ai/api/v1/models");
      const free = (j.data || []).filter((m) => /:free$/.test(m.id) && (m.architecture?.input_modalities || []).includes("image"));
      const pref = (m) => (/gemini/.test(m.id) ? 4 : /qwen.*vl|qwen2|qwen3/.test(m.id) ? 3 : /llama-4|mistral|gemma/.test(m.id) ? 2 : 1);
      free.sort((a, b) => pref(b) - pref(a) || (b.context_length || 0) - (a.context_length || 0));
      if (!free.length) throw new Error("Key đúng nhưng hiện không có model miễn phí đọc ảnh trên OpenRouter.");
      return free.slice(0, 3).map((m) => m.id);
    },
    async xai(key) {
      let ids = [];
      try { const j = await jfetch("https://api.x.ai/v1/language-models", { headers: { authorization: "Bearer " + key } });
        ids = (j.models || []).filter((m) => (m.input_modalities || []).includes("image")).map((m) => m.id); } catch (e) { if (e.status === 401 || e.status === 403 || e.net) throw e; }
      if (!ids.length) { const j = await jfetch("https://api.x.ai/v1/models", { headers: { authorization: "Bearer " + key } });
        ids = (j.data || []).map((m) => m.id).filter((n) => /grok/.test(n) && !/image|imagine|video/.test(n)); }
      if (!ids.length) throw new Error("Key đúng nhưng không thấy model Grok đọc ảnh.");
      return ids.sort((a, b) => verOf(b) - verOf(a)).slice(0, 2);
    },
    async anthropic(key) {
      const j = await jfetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } });
      const ids = (j.data || []).map((m) => m.id);                       // API trả theo thứ tự mới nhất trước
      const pick = [...ids.filter((n) => /haiku/.test(n)), ...ids.filter((n) => /sonnet/.test(n))];
      if (!pick.length) throw new Error("Key đúng nhưng không thấy model Claude phù hợp.");
      return pick.slice(0, 2);
    },
  };
  /* ---- kiểm thử thật: gửi một ảnh mẫu tiếng Việt qua từng model, chấm điểm, chọn model tốt nhất ---- */
  const TEST_LINES = ["CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", "Độc lập - Tự do - Hạnh phúc", "Số: 125/QĐ-UBND", "Về việc phê duyệt kế hoạch tổ chức hội nghị tổng kết", "Điều 1. Giao Văn phòng chủ trì, phối hợp thực hiện."];
  const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  function ratio(a, b) {
    a = norm(a); b = norm(b); if (!a.length && !b.length) return 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }
  function testImage() {
    const c = document.createElement("canvas"); c.width = 1100; c.height = 90 + TEST_LINES.length * 62; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#111"; g.font = "36px 'Times New Roman', Times, serif";
    TEST_LINES.forEach((t, i) => g.fillText(t, 40, 70 + i * 62)); return c;
  }
  const dispatch = (u, b64, mime, o) => u.k.provider === "gemini" ? call.gemini(u, b64, mime, o) : u.k.provider === "anthropic" ? call.anthropic(u, b64, mime, o)
    : call.openai(u, b64, mime, ({ groq: "https://api.groq.com/openai/v1/chat/completions", xai: "https://api.x.ai/v1/chat/completions" })[u.k.provider] || "https://openrouter.ai/api/v1/chat/completions", o);
  const listeners = new Set(); const emit = () => listeners.forEach((f) => { try { f(); } catch {} });
  const update = (id, fn) => { const arr = keys(), k = arr.find((x) => x.id === id); if (k) { fn(k); save(arr); emit(); } return k; };
  /* kiểm thử song song mọi model ứng viên; model đầu tiên đạt là key dùng được ngay, các model còn lại cập nhật dần */
  async function testKey(id) {
    const k0 = keys().find((x) => x.id === id); if (!k0) return;
    const img = testImage().toDataURL("image/jpeg", 0.85).split(",")[1], truth = TEST_LINES.join("\n");
    update(id, (k) => { k.status = k.status === "ok" ? "ok" : "testing"; k.report = k0.cand.map((m) => ({ m, pending: true })); k.err = ""; });
    await Promise.all(k0.cand.map(async (m, i) => {
      const t0 = performance.now(); let row = { m };
      try {
        const blocks = parse(await dispatch({ k: k0, m }, img, "image/jpeg", { test: true })), got = blocks.map((b) => b.text || "").join("\n");
        row.score = Math.round(ratio(got, truth) * 100); row.ms = Math.round(performance.now() - t0); row.ok = row.score >= 80; if (!row.ok) row.err = `đọc sai nhiều (${row.score}%)`;
      } catch (e) {
        row.ms = Math.round(performance.now() - t0);
        if (e.status === 429) { row.ok = true; row.score = null; row.err = "hết hạn mức tạm thời, chưa chấm được"; } else { row.ok = false; row.err = e.message; }
      }
      update(id, (k) => { k.report[i] = row; rank(k); });
    }));
    update(id, (k) => { rank(k, true); });
  }
  function rank(k, final) {
    const done = k.report.filter((r) => !r.pending), good = done.filter((r) => r.ok).sort((a, b) => (b.score ?? 70) - (a.score ?? 70) || a.ms - b.ms);
    k.models = good.map((r) => r.m);
    if (good.length) { k.status = "ok"; k.err = ""; }
    else if (final || !k.report.some((r) => r.pending)) { k.status = "err"; k.err = "Key đúng nhưng không model nào đọc ảnh đạt: " + done.map((r) => `${r.m}: ${r.err}`).join(" | "); }
  }
  async function addKey(raw, providerHint) {
    const key = raw.trim(); if (!key) throw new Error("Chưa nhập key.");
    let provider = providerHint && providerHint !== "auto" ? providerHint : detect(key), cand;
    if (keys().some((k) => k.key === key)) throw new Error("Key này đã có trong danh sách.");
    if (provider) cand = await verify[provider](key);
    else {
      const errs = [];
      const res = await Promise.all(ORDER.map(async (p) => { try { return { p, c: await verify[p](key) }; } catch (e) { errs.push(`${NAMES[p]}: ${e.message}`); return null; } }));
      const hit = res.find(Boolean); if (!hit) throw new Error("Không nhận ra loại key và không nhà cung cấp nào chấp nhận. " + errs.join(" | "));
      provider = hit.p; cand = hit.c;
    }
    const k = { id: Math.random().toString(36).slice(2, 8), provider, key, cand, models: [], status: "testing", report: [] };
    const arr = keys(); arr.push(k); save(arr); emit();
    testKey(k.id);                                   // chạy nền, giao diện tự cập nhật qua onChange
    return k;
  }
  async function recheck(id) {
    const k = keys().find((x) => x.id === id); if (!k) return;
    try { const cand = await verify[k.provider](k.key); update(id, (x) => { x.cand = cand; x.status = "testing"; }); testKey(id); }
    catch (e) { update(id, (x) => { x.status = (e.status === 401 || e.status === 403 || (e.status === 400 && /key/i.test(e.message))) ? "bad" : "err"; x.err = e.message; }); }
  }
  const removeKey = (id) => save(keys().filter((k) => k.id !== id));

  /* ---- chọn đơn vị (key, model) kế tiếp ---- */
  const st_ = (id) => { st(id).fail++; };
  const stats = new Map();                                              // "keyId|model" -> {fail, ok, ms}
  const st = (id) => { let x = stats.get(id); if (!x) stats.set(id, (x = { fail: 0, ok: 0, ms: 0 })); return x; };
  function eff(k, m) {                                                    // điểm tổng hợp: chất lượng đo được − chậm − hay lỗi − tính phí
    const r = (k.report || []).find((x) => x.m === m) || {}, s2 = st(k.id + "|" + m);
    const q = r.score ?? 70, ms = s2.ok ? s2.ms / s2.ok : (r.ms || 4000);
    return q - Math.min(8, ms / 3000) - s2.fail * 6 - (FREE[k.provider] ? 0 : 3);
  }
  function units() {
    const now = Date.now(), out = [];
    for (const k of keys()) if (k.status === "ok") for (const m of k.models) out.push({ k, m, c: cool.get(k.id + "|" + m) || 0, e: eff(k, m) });
    out.sort((a, b) => b.e - a.e);
    return { out, now };
  }
  function pick(skip) {
    const { out, now } = units(), ready = out.filter((u) => u.c <= now && !skip.has(u.k.id + "|" + u.m));
    if (!ready.length) return { none: true, soonest: Math.min(...out.filter((u) => !skip.has(u.k.id + "|" + u.m)).map((u) => u.c), Infinity) - now };
    const same = ready.filter((u) => ready[0].e - u.e <= 3);              // các lựa chọn ngang chất lượng thì xoay vòng để chia tải
    return same[rr++ % same.length];
  }
  const limits = () => ({ each: Math.max(5, +get("ai_each", "30") || 30), total: Math.max(10, +get("ai_total", "90") || 90), pause: Math.max(0, +get("ai_pause", "120") || 0) });
  let pausedUntil = 0;                                                     // sau khi bỏ AI vì quá chậm, tạm dùng Tesseract một lúc rồi thử lại
  const usable = () => get("engine", "auto") !== "off" && Date.now() >= pausedUntil && keys().some((k) => k.status === "ok");
  const pausedLeft = () => Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000));

  /* ---- gọi model ---- */
  const prompt = `Bạn là hệ thống OCR chính xác cao cho văn bản hành chính tiếng Việt. Hãy chép lại TOÀN BỘ chữ trong ảnh, đúng từng ký tự, đầy đủ dấu thanh và dấu mũ tiếng Việt. Không tóm tắt, không sửa nội dung, không thêm bớt, không đoán chữ không thấy rõ (đánh dấu [?] ngay sau từ không chắc). Bỏ qua con dấu, chữ ký, hình vẽ (không tả chúng).
Chỉ trả về MỘT đối tượng JSON, không kèm giải thích, theo dạng:
{"blocks":[{"role":"...","text":"...","align":"left|center|right","bold":false,"italic":false}, {"role":"table","rows":[["ô","ô"],["ô","ô"]]}]}
Các block theo thứ tự đọc (đọc hết cột trái rồi mới tới cột phải ở phần đầu văn bản). Mỗi đoạn văn là MỘT block (không ngắt dòng cứng giữa đoạn). Bảng thì dùng block "table" đủ hàng, đủ cột.
"role" là một trong: head_left (tên cơ quan ban hành / cơ quan chủ quản bên trái), head_right (Quốc hiệu, Tiêu ngữ bên phải), so (Số, ký hiệu), dia_danh (địa danh, ngày tháng), ten_loai (tên loại văn bản như QUYẾT ĐỊNH, THÔNG BÁO), trich_yeu (trích yếu nội dung), kinh_gui (dòng Kính gửi), body (nội dung), noi_nhan (từng dòng của mục Nơi nhận, kể cả chữ "Nơi nhận:"), chuc_vu (quyền hạn, chức vụ người ký), ho_ten (họ tên người ký), other (không thuộc loại nào, vd. tờ phiếu, biểu mẫu). Nếu văn bản không theo mẫu công văn thì dùng "body" hoặc "other" cho mọi thứ.`;
  const call = {
    async gemini(u, b64, mime, o = {}) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${u.m}:generateContent?key=${encodeURIComponent(u.k.key)}`;
      const body = (think) => JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: o.prompt || prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: o.test ? 1500 : 16000, ...(think ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } });
      const send = (think) => jfetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body(think), timeout: o.timeout || (o.test ? 30000 : 120000) });
      let j; try { j = await send(/flash/.test(u.m)); } catch (e) { if (e.status === 400 && /think/i.test(e.message)) j = await send(false); else throw e; }   // tắt "suy nghĩ" cho nhanh
      const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); if (!t) throw new Error("Gemini không trả nội dung (" + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "?") + ")"); return t;
    },
    async openai(u, b64, mime, url, o = {}) {
      const j = await jfetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + u.k.key },
        body: JSON.stringify({ model: u.m, temperature: 0, max_tokens: o.test ? 1500 : 8000, messages: [{ role: "user", content: [{ type: "text", text: o.prompt || prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }] }), timeout: o.timeout || (o.test ? 30000 : 120000) });
      const t = j.choices?.[0]?.message?.content; if (!t) throw new Error("Model không trả nội dung"); return t;
    },
    async anthropic(u, b64, mime, o = {}) {
      const j = await jfetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": u.k.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: u.m, max_tokens: o.test ? 1500 : 16000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: o.prompt || prompt }] }] }), timeout: o.timeout || (o.test ? 30000 : 120000) });
      return (j.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
    },
  };
  const parse = (txt) => {
    const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error("AI không trả về JSON");
    const o = JSON.parse(m[0]); if (!Array.isArray(o.blocks)) throw new Error("AI trả về sai định dạng"); return o.blocks;
  };

  /* đọc một trang: thử lần lượt các (key, model); lỗi giới hạn → nghỉ đơn vị đó rồi chuyển key khác */
  async function read(canvas, onStatus, popt) {
    const long = Math.max(canvas.width, canvas.height), k = Math.min(1, 2600 / long); let c = canvas;
    if (k < 1) { c = document.createElement("canvas"); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k); c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height); }
    const b64 = c.toDataURL("image/jpeg", 0.92).split(",")[1], skip = new Set(); let last = null;
    const L = limits(), T0 = Date.now(), left = () => L.total * 1000 - (Date.now() - T0);
    for (let tries = 0; tries < 12; tries++) {
      if (left() <= 0) { pausedUntil = Date.now() + L.pause * 1000; throw new Error(`AI trả lời quá ${L.total} giây, bỏ AI${L.pause ? ` và dùng Tesseract trong ${L.pause} giây tới` : ""}`); }
      const u = pick(skip);
      if (u.none) {
        if (u.soonest < Math.min(70000, left()) && u.soonest > 0 && tries < 8) { onStatus?.(`Các key đang chờ hạn mức, đợi ${Math.ceil(u.soonest / 1000)} giây…`); await wait(u.soonest + 500); continue; }
        break;
      }
      const o = { timeout: Math.max(3000, Math.min(L.each * 1000, left())), prompt: popt && popt.prompt };
      try {
        onStatus?.(`AI (${NAMES[u.k.provider]} · ${u.m}) đang đọc trang…`); var t1 = performance.now();
        const txt = u.k.provider === "gemini" ? await call.gemini(u, b64, "image/jpeg", o) : u.k.provider === "anthropic" ? await call.anthropic(u, b64, "image/jpeg", o)
          : await call.openai(u, b64, "image/jpeg", ({ groq: "https://api.groq.com/openai/v1/chat/completions", xai: "https://api.x.ai/v1/chat/completions" })[u.k.provider] || "https://openrouter.ai/api/v1/chat/completions", o);
        const blocks = parse(txt); const sx = st(u.k.id + "|" + u.m); sx.ok++; sx.ms += performance.now() - t1; sx.fail = Math.max(0, sx.fail - 0.5); return { blocks, via: `${NAMES[u.k.provider]} · ${u.m}` };
      } catch (e) {
        last = e; const id = u.k.id + "|" + u.m, st = e.status; st_(id);
        if (e.timeout) { cool.set(id, Date.now() + 90e3); onStatus?.(`${NAMES[u.k.provider]} · ${u.m} chậm quá ${L.each} giây, chuyển sang AI khác…`); } else if (e.net) cool.set(id, Date.now() + 30e3); else if (st === 429 || (st >= 500 && st < 600) || /quota|rate|limit|overload|busy/i.test(e.message || "")) cool.set(id, Date.now() + (/day|daily|quota/i.test(e.message || "") && st === 429 ? 3600e3 : 45e3));
        else if (st === 401 || st === 403) { const arr = keys(), kk = arr.find((x) => x.id === u.k.id); if (kk) { kk.status = "bad"; kk.err = e.message; save(arr); } skip.add(id); }
        else if (st === 404) { skip.add(id); recheck(u.k.id); }
        else skip.add(id);                                               // lỗi khác (JSON hỏng, bị chặn nội dung…): thử key/model khác
      }
    }
    if (last && last.timeout && L.pause) pausedUntil = Date.now() + L.pause * 1000;    // mọi AI đều quá chậm: tạm bỏ AI một lúc
    throw last || new Error("Không có key AI nào dùng được lúc này");
  }

  root.AIX = { onChange: (f) => { listeners.add(f); return () => listeners.delete(f); }, read, addKey, recheck, removeKey, keys, usable, limits, pausedLeft, NAMES, FREE, mask, get, set, detect };
})(window);