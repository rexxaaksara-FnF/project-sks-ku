// Shared logic for the fill page (index.html) and the layout editor (editor.html).
(function () {
  "use strict";

  const MODE = document.body.dataset.mode; // "fill" | "edit"
  const PT = 0.352778; // millimetres per point
  const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const PREVIEW_FONT = {
    times: "Tinos,'Times New Roman',Times,serif",
    helvetica: "Arimo,Arial,Helvetica,sans-serif",
    courier: "Cousine,'Courier New',monospace",
  };
  const $ = (id) => document.getElementById(id);
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

  /* ---------- storage ---------- */
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  function openDb() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open("isi-template", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  async function idbGet(k) {
    try {
      const db = await openDb();
      return await new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
    } catch (e) { return undefined; }
  }
  async function idbSet(k, v) { try { const db = await openDb(); db.transaction("kv", "readwrite").objectStore("kv").put(v, k); } catch (e) { /* ignore */ } }
  async function idbDel(k) { try { const db = await openDb(); db.transaction("kv", "readwrite").objectStore("kv").delete(k); } catch (e) { /* ignore */ } }

  /* ---------- state ---------- */
  let tpl = null; // { version, title, font, ink, fname, withBg, pages:[{src,w,h}], fields:[...] }
  let values = {};
  let selId = null, addMode = false, zoom = 1, hotKey = null, drag = null;
  const VALUES_KEY = MODE === "edit" ? "isi-template.editor-values" : "isi-template.values";
  const uid = () => Math.random().toString(36).slice(2, 9);
  let draftTimer = null;
  function saveDraft() {
    if (MODE !== "edit") return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => idbSet("draft", tpl), 300);
    markDirty(true);
  }
  const saveValues = () => lsSet(VALUES_KEY, values);

  /* ---------- text helpers ---------- */
  function fmtDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? (+m[3]) + " " + MONTHS[+m[2] - 1] + " " + m[1] : iso; }
  function todayStr() { const d = new Date(); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  function ageFrom(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return "";
    const n = new Date(); let a = n.getFullYear() - (+m[1]);
    if (n.getMonth() + 1 < +m[2] || (n.getMonth() + 1 === +m[2] && n.getDate() < +m[3])) a--;
    return a >= 0 ? String(a) : "";
  }
  function slug(s) {
    return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "kolom";
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function valueFor(f) {
    let v = (values[f.key] || "").trim();
    if (!v && f.key === "hari_ini") return todayStr();
    if (!v && f.key === "umur") v = ageFrom(values.tanggal_lahir || values.tgl_lahir || "");
    if (f.type === "date") v = fmtDate(v);
    return v;
  }

  /* ---------- measuring & layout, shared by preview and PDF ---------- */
  let measureDoc = null;
  function textWidth(t, size) {
    if (!window.jspdf) return t.length * size * PT * 0.5;
    if (!measureDoc) measureDoc = new window.jspdf.jsPDF({ unit: "mm" });
    measureDoc.setFont(tpl.font, "normal");
    measureDoc.setFontSize(size);
    return measureDoc.getTextWidth(t);
  }
  function wrapText(text, maxW, size) {
    const words = text.split(/\s+/).filter(Boolean), out = []; let cur = "";
    words.forEach((w) => { const t = cur ? cur + " " + w : w; if (cur && textWidth(t, size) > maxW) { out.push(cur); cur = w; } else cur = t; });
    if (cur) out.push(cur);
    return out.length ? out : [""];
  }
  function fieldLayout(f) {
    const page = tpl.pages[f.page] || tpl.pages[0];
    const raw = valueFor(f), empty = !raw;
    const text = (empty ? f.label : raw).replace(/\s*\n\s*/g, " ");
    const maxW = f.w || Math.max(10, page.w - f.x - 10);
    const gap = f.gap || f.size * PT * 1.45;
    const lines = f.type === "long" ? wrapText(text, maxW, f.size) : [text];
    return {
      empty, gap,
      lines: lines.map((t, i) => { const w = textWidth(t, f.size); return { t, w, x: f.align === "center" ? f.x - w / 2 : f.x, y: f.y + i * gap }; }),
    };
  }

  /* ---------- paper rendering ---------- */
  function renderPaper() {
    const desk = $("desk");
    desk.innerHTML = tpl.pages.map((p, i) => `
      <div class="sheet"><span class="pno">Halaman ${i + 1} dari ${tpl.pages.length}</span>
      <svg data-page="${i}" viewBox="0 0 ${p.w} ${p.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Halaman ${i + 1}">
        <image href="${p.src}" x="0" y="0" width="${p.w}" height="${p.h}" preserveAspectRatio="none"/>
        <g id="flds-${i}"></g>
      </svg></div>`).join("");
    sizeSheets();
    renderFields();
    if (MODE === "edit") bindSvgs();
  }
  function sizeSheets() {
    const desk = $("desk"); if (!desk) return;
    const avail = Math.max(200, desk.clientWidth - 32);
    desk.querySelectorAll("svg").forEach((svg) => {
      const p = tpl.pages[+svg.dataset.page];
      const base = Math.min(avail, 820);
      svg.style.width = (base * zoom) + "px";
      svg.style.height = (base * zoom * p.h / p.w) + "px";
      svg.classList.toggle("adding", addMode);
    });
  }
  function renderFields() {
    const fam = esc(PREVIEW_FONT[tpl.font] || PREVIEW_FONT.times);
    tpl.pages.forEach((p, i) => {
      const g = $("flds-" + i); if (!g) return;
      g.innerHTML = tpl.fields.filter((f) => f.page === i).map((f) => {
        const L = fieldLayout(f), fs = (f.size * PT).toFixed(3);
        const minX = Math.min(...L.lines.map((l) => l.x)), maxX = Math.max(...L.lines.map((l) => l.x + l.w));
        const bx = Math.min(minX, f.align === "center" ? f.x - 9 : f.x) - 0.8;
        const bw = Math.max(maxX, f.align === "center" ? f.x + 9 : f.x + 18) - bx + 0.8;
        const by = f.y - f.size * PT * 0.92, bh = (L.lines.length - 1) * L.gap + f.size * PT * 1.25;
        const texts = L.lines.map((l) =>
          `<text x="${l.x.toFixed(2)}" y="${l.y.toFixed(2)}" font-size="${fs}" font-family="${fam}" fill="${L.empty ? "#3438a8" : tpl.ink}"${L.empty ? ' fill-opacity="0.45" font-style="italic"' : ""} xml:space="preserve">${esc(l.t)}</text>`).join("");
        const cls = "fld" + (f.id === selId ? " sel" : "") + (hotKey && f.key === hotKey ? " hot" : "");
        return `<g class="${cls}" data-id="${f.id}"><rect class="box" x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="0.6"/>${texts}</g>`;
      }).join("");
    });
  }

  /* ---------- editor: placing and dragging fields ---------- */
  function svgPoint(svg, e) { const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); }
  function bindSvgs() {
    $("desk").querySelectorAll("svg").forEach((svg) => {
      svg.addEventListener("pointerdown", (e) => {
        const pageIdx = +svg.dataset.page, pt = svgPoint(svg, e), g = e.target.closest(".fld");
        if (addMode && !g) {
          const n = tpl.fields.length + 1;
          const f = { id: uid(), page: pageIdx, key: "kolom_" + n, label: "Kolom " + n, x: +pt.x.toFixed(1), y: +pt.y.toFixed(1), size: 11, type: "text", align: "left" };
          tpl.fields.push(f); saveDraft(); setAddMode(false); select(f.id); buildForm();
          status("Kolom ditambahkan. Ganti label dan kuncinya di panel Kolom terpilih.", "ok");
          return;
        }
        if (!g) { select(null); return; }
        const f = tpl.fields.find((x) => x.id === g.dataset.id); if (!f) return;
        e.preventDefault(); select(f.id);
        drag = { f, svg, sx: pt.x, sy: pt.y, ox: f.x, oy: f.y, moved: false };
        try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      });
      svg.addEventListener("pointermove", (e) => {
        if (!drag || drag.svg !== svg) return;
        const pt = svgPoint(svg, e), dx = pt.x - drag.sx, dy = pt.y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 0.6) return;
        drag.moved = true; drag.f.x = +(drag.ox + dx).toFixed(1); drag.f.y = +(drag.oy + dy).toFixed(1); renderFields();
      });
      const end = () => { if (drag && drag.svg === svg) { if (drag.moved) saveDraft(); drag = null; } };
      svg.addEventListener("pointerup", end);
      svg.addEventListener("pointercancel", end);
    });
  }
  function setAddMode(v) {
    addMode = v;
    const b = $("addMode"); if (!b) return;
    b.classList.toggle("on", v);
    b.textContent = v ? "Ketuk tempatnya di kertas…" : "+ Tambah kolom";
    $("paperHint").textContent = v ? "Ketuk titik awal tulisan, sejajar dengan garis dasar label." : "Ketuk kolom untuk memilih, seret untuk memindahkan.";
    sizeSheets();
  }

  /* ---------- editor: selected field panel ---------- */
  const selected = () => tpl.fields.find((f) => f.id === selId);
  function select(id) {
    selId = id;
    const f = selected(), panel = $("selPanel");
    if (panel) panel.hidden = !f;
    if (f) {
      $("sLabel").value = f.label; $("sKey").value = f.key; $("sType").value = f.type; $("sAlign").value = f.align || "left";
      $("sSize").value = f.size; $("sW").value = f.w || ""; $("sGap").value = f.gap || "";
      $("sGap").placeholder = (f.size * PT * 1.45).toFixed(1);
      $("sGapWrap").hidden = f.type !== "long";
    }
    renderFields();
  }
  function bindSel(id, prop, conv) {
    on(id, "input", () => {
      const f = selected(); if (!f) return;
      f[prop] = conv ? conv($(id).value) : $(id).value;
      if (prop === "type") $("sGapWrap").hidden = f.type !== "long";
      saveDraft(); renderFields();
      if (prop === "label" || prop === "key" || prop === "type") buildForm();
    });
  }
  function nudge(dx, dy) { const f = selected(); if (!f) return; f.x = +(f.x + dx).toFixed(1); f.y = +(f.y + dy).toFixed(1); saveDraft(); renderFields(); }
  function removeSelected() { const f = selected(); if (!f) return; tpl.fields = tpl.fields.filter((x) => x !== f); saveDraft(); select(null); buildForm(); }

  /* ---------- data form ---------- */
  let formSig = "";
  function uniqueKeyFields() {
    const seen = {}, out = [];
    [...tpl.fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x).forEach((f) => { if (!seen[f.key]) { seen[f.key] = 1; out.push(f); } });
    return out;
  }
  function buildForm(force) {
    const keys = uniqueKeyFields(), sig = keys.map((f) => f.key + "|" + f.label + "|" + f.type).join(";");
    const nf = $("noFields"); if (nf) nf.hidden = keys.length > 0;
    if (sig === formSig && !force) return;
    formSig = sig;
    $("form").innerHTML = keys.map((f) => {
      const id = "v_" + f.key, v = esc(values[f.key] || "");
      let ph = "";
      if (f.key === "hari_ini") ph = ' placeholder="Kosong = tanggal hari ini"';
      if (f.key === "umur") ph = ' placeholder="Kosong = dihitung dari tanggal lahir"';
      const input = f.type === "long"
        ? `<textarea id="${id}" data-k="${f.key}">${v}</textarea>`
        : `<input id="${id}" data-k="${f.key}" type="${f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}" value="${v}"${ph}>`;
      const keyTag = MODE === "edit" ? `<code>${esc(f.key)}</code>` : "";
      return `<div class="field" data-fk="${f.key}"><label for="${id}"><span>${esc(f.label)}</span>${keyTag}</label>${input}</div>`;
    }).join("");
  }
  function setHot(k) {
    hotKey = k;
    document.querySelectorAll(".field[data-fk]").forEach((el) => el.classList.toggle("hot", el.dataset.fk === k));
    renderFields();
  }

  /* ---------- status line ---------- */
  function status(msg, kind) { const s = $("status"); if (!s) return; s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }

  /* ---------- editor: background upload ---------- */
  function imageToPage(file) {
    return new Promise((res, rej) => {
      const r = new FileReader(); r.onerror = rej;
      r.onload = () => {
        const img = new Image(); img.onerror = rej;
        img.onload = () => {
          const max = 1800, sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
          c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
          const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          res({ src: c.toDataURL("image/jpeg", 0.88), w: 210, h: +(210 * img.height / img.width).toFixed(2) });
        };
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });
  }
  async function pdfToPages(file) {
    const lib = window.pdfjsLib; if (!lib) throw new Error("pdf.js not loaded");
    lib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      status(`Membaca halaman ${i} dari ${pdf.numPages}…`, "busy");
      const pg = await pdf.getPage(i), v1 = pg.getViewport({ scale: 1 }), v = pg.getViewport({ scale: 1600 / v1.width });
      const c = document.createElement("canvas"); c.width = Math.round(v.width); c.height = Math.round(v.height);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: v }).promise;
      out.push({ src: c.toDataURL("image/jpeg", 0.88), w: +(v1.width * 25.4 / 72).toFixed(2), h: +(v1.height * 25.4 / 72).toFixed(2) });
    }
    return out;
  }

  /* ---------- file helpers ---------- */
  function saveBlob(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function blankPage() {
    const c = document.createElement("canvas"); c.width = 620; c.height = 877;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  }
  function markDirty(v) { const el = $("dirty"); if (el) el.hidden = !v; }
  // Loads the published layout. template.js works even when the page is opened straight from disk;
  // template.json is kept for older exports. The newest savedAt wins (a json file wins ties).
  async function loadTemplate() {
    const found = [];
    try {
      const r = await fetch("template.json", { cache: "no-cache" });
      if (r.ok) found.push(Object.assign(normalizeTemplate(await r.json()), { _src: "template.json" }));
    } catch (e) { /* missing or file:// */ }
    if (window.TEMPLATE) { try { found.push(Object.assign(normalizeTemplate(window.TEMPLATE), { _src: "template.js" })); } catch (e) { /* invalid */ } }
    if (!found.length) throw new Error("no template");
    found.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return found[0];
  }
  function stampText(t) {
    if (!t.savedAt) return `Template: ${t._src || "bawaan"} (belum pernah diekspor dari editor)`;
    const d = new Date(t.savedAt);
    const hm = String(d.getHours()).padStart(2, "0") + "." + String(d.getMinutes()).padStart(2, "0");
    return `Template: ${t._src || "editor"}, diekspor ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} pukul ${hm}`;
  }
  function parseTemplateFile(text) {
    const body = text.trim().replace(/^window\.TEMPLATE\s*=\s*/, "").replace(/;\s*$/, "");
    return normalizeTemplate(JSON.parse(body));
  }
  function normalizeTemplate(t) {
    if (!t || !Array.isArray(t.pages) || !t.pages.length || !Array.isArray(t.fields)) throw new Error("invalid template");
    return Object.assign({ version: 1, title: "Template", font: "times", ink: "#111111", fname: "dokumen", withBg: true }, t);
  }

  /* ---------- PDF ---------- */
  function hexRgb(h) { const n = parseInt((h || "#111111").slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function buildPdf() {
    const { jsPDF } = window.jspdf; let doc = null;
    tpl.pages.forEach((p, i) => {
      const o = p.w > p.h ? "landscape" : "portrait";
      if (!doc) doc = new jsPDF({ unit: "mm", format: [p.w, p.h], orientation: o }); else doc.addPage([p.w, p.h], o);
      if (tpl.withBg !== false) doc.addImage(p.src, "JPEG", 0, 0, p.w, p.h, undefined, "FAST");
      doc.setTextColor(...hexRgb(tpl.ink));
      tpl.fields.filter((f) => f.page === i).forEach((f) => {
        const L = fieldLayout(f); if (L.empty) return;
        doc.setFont(tpl.font, "normal"); doc.setFontSize(f.size);
        L.lines.forEach((l) => doc.text(l.t, l.x, l.y));
      });
    });
    return doc;
  }
  function fileName() {
    let n = (tpl.fname || "dokumen").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => valueFor(tpl.fields.find((x) => x.key === k) || { key: k, type: "text" }));
    n = n.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/[\s-]+$/, "").trim().replace(/\.pdf$/i, "");
    return (n || "dokumen") + ".pdf";
  }

  /* ---------- wiring ---------- */
  function wireCommon() {
    on("form", "input", (e) => { const k = e.target.dataset.k; if (!k) return; values[k] = e.target.value; saveValues(); renderFields(); });
    on("form", "focusin", (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) setHot(k); });
    on("form", "focusout", () => setHot(null));
    on("clearData", "click", () => { values = {}; saveValues(); buildForm(true); renderFields(); status("Isian dikosongkan."); });
    on("zoom", "change", () => { zoom = parseFloat($("zoom").value) || 1; sizeSheets(); });
    window.addEventListener("resize", sizeSheets);
    on("download", "click", () => {
      if (!window.jspdf) { status("Pembuat PDF belum termuat. Muat ulang halaman.", "err"); return; }
      try { const name = fileName(); buildPdf().save(name); status(name + " sudah dibuat.", "ok"); }
      catch (e) { status("PDF gagal dibuat. Coba muat ulang halaman.", "err"); }
    });
  }

  function wireEditor() {
    bindSel("sLabel", "label");
    bindSel("sKey", "key", (v) => slug(v));
    on("sKey", "change", () => { const f = selected(); if (f) $("sKey").value = f.key; });
    bindSel("sType", "type"); bindSel("sAlign", "align");
    bindSel("sSize", "size", (v) => Math.min(28, Math.max(6, parseFloat(v) || 11)));
    bindSel("sW", "w", (v) => parseFloat(v) || 0);
    bindSel("sGap", "gap", (v) => parseFloat(v) || 0);
    document.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", () => { const [dx, dy] = b.dataset.n.split(",").map(Number); nudge(dx, dy); }));
    on("sDup", "click", () => { const f = selected(); if (!f) return; const c = Object.assign({}, f, { id: uid(), y: +(f.y + 8).toFixed(1) }); tpl.fields.push(c); saveDraft(); select(c.id); });
    on("sDel", "click", removeSelected);
    on("addMode", "click", () => setAddMode(!addMode));
    document.addEventListener("keydown", (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || !selected()) return;
      const s = e.shiftKey ? 2 : 0.5;
      if (e.key === "ArrowUp") { nudge(0, -s); e.preventDefault(); }
      else if (e.key === "ArrowDown") { nudge(0, s); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { nudge(-s, 0); e.preventDefault(); }
      else if (e.key === "ArrowRight") { nudge(s, 0); e.preventDefault(); }
      else if (e.key === "Delete" || e.key === "Backspace") { removeSelected(); e.preventDefault(); }
      else if (e.key === "Escape") { select(null); setAddMode(false); }
    });

    on("upload", "change", async () => {
      const input = $("upload"), file = input.files[0]; input.value = ""; if (!file) return;
      status("Membaca " + file.name + "…", "busy");
      try {
        const pages = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? await pdfToPages(file) : [await imageToPage(file)];
        tpl.pages = pages;
        tpl.fields = tpl.fields.filter((f) => f.page < pages.length);
        saveDraft(); select(null); renderPaper(); buildForm(true);
        status(`Background terpasang (${pages.length} halaman). Tekan "+ Tambah kolom" lalu ketuk tempat isian di kertas.`, "ok");
      } catch (e) { status("File tidak bisa dibaca. Pakai gambar PNG/JPG atau PDF yang tidak terkunci.", "err"); }
    });

    on("importJson", "change", async () => {
      const input = $("importJson"), file = input.files[0]; input.value = ""; if (!file) return;
      try { tpl = parseTemplateFile(await file.text()); saveDraft(); loadSettings(); select(null); renderPaper(); buildForm(true); status("Template dibuka.", "ok"); }
      catch (e) { status("Ini bukan file template yang valid (template.js atau template.json).", "err"); }
    });
    on("exportJson", "click", () => {
      const out = Object.assign({}, tpl, { savedAt: Date.now() }); delete out._src;
      saveBlob(new Blob(["window.TEMPLATE = " + JSON.stringify(out) + ";\n"], { type: "text/javascript" }), "template.js");
      markDirty(false);
      const s = $("stamp"); if (s) s.textContent = stampText(Object.assign({}, out, { _src: "template.js" }));
      status("template.js diunduh. Cek namanya di folder Downloads harus persis template.js, lalu timpa file template.js di folder website.", "ok");
    });
    on("resetDraft", "click", async () => {
      await idbDel("draft");
      try { tpl = await loadTemplate(); } catch (e) { /* keep current */ }
      markDirty(false); loadSettings(); select(null); renderPaper(); buildForm(true); status("Editor dikembalikan ke template.json yang sedang online.", "ok");
    });

    ["title", "font", "ink", "fname"].forEach((k) => on("set_" + k, "input", () => { tpl[k] = $("set_" + k).value; saveDraft(); renderFields(); }));
    on("set_withBg", "change", () => { tpl.withBg = $("set_withBg").checked; saveDraft(); });
  }
  function loadSettings() {
    ["title", "font", "ink", "fname"].forEach((k) => { const el = $("set_" + k); if (el) el.value = tpl[k] || ""; });
    const bg = $("set_withBg"); if (bg) bg.checked = tpl.withBg !== false;
  }

  /* ---------- boot ---------- */
  (async function init() {
    values = lsGet(VALUES_KEY, {});
    const wantsDraft = MODE === "edit" || /[?&]draft\b/.test(location.search);
    if (wantsDraft) { try { const d = await idbGet("draft"); if (d) tpl = normalizeTemplate(d); } catch (e) { tpl = null; } }
    if (!tpl) {
      try {
        tpl = await loadTemplate();
      } catch (e) {
        if (MODE === "edit") {
          // No template file found: start from a blank A4 page so the editor still works.
          tpl = normalizeTemplate({ title: "Formulir", fname: "dokumen", pages: [{ src: blankPage(), w: 210, h: 297 }], fields: [] });
          status('Belum ada file template di folder ini. Tekan "Ganti background" untuk mulai, atau "Buka template" untuk melanjutkan template lama.', "busy");
        } else {
          $("desk").innerHTML = '<p class="note" style="padding:40px 0">File template tidak ditemukan. Pastikan template.js ada di folder yang sama dengan index.html.</p>';
          return;
        }
      }
    }
    const stamp = $("stamp");
    if (stamp) stamp.textContent = wantsDraft && MODE === "fill" ? "Pratinjau dari editor (belum diekspor)" : stampText(tpl);
    if (MODE === "fill" && wantsDraft) status("Mode pratinjau: memakai layout dari editor di browser ini, bukan file template di website.", "busy");
    if (MODE === "fill") {
      document.title = tpl.title;
      const h = $("docTitle"); if (h) h.textContent = tpl.title;
    } else {
      loadSettings(); wireEditor();
    }
    wireCommon();
    renderPaper(); buildForm(true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderFields);
  })();
})();
