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
    opensans: "'OpenSansEmbed','Open Sans','Segoe UI',Arial,sans-serif",
    calibri: "'CalibriEmbed',Calibri,Carlito,'Segoe UI',Arial,sans-serif",
  };
  const CAL_ERR = "Font Calibri belum termuat. Pastikan fonts.js versi terbaru ada di folder yang sama dengan index.html, lalu muat ulang halaman.";
  // Open Sans is not built into jsPDF, so the four TTF files are loaded and embedded when needed.
  const OS_DIR = "vendor/fonts/";
  const OS_FILES = { normal: "OpenSans-Regular.ttf", bold: "OpenSans-Bold.ttf", italic: "OpenSans-Italic.ttf", bolditalic: "OpenSans-BoldItalic.ttf" };
  const OS_ERR = "File font Open Sans tidak ditemukan. Taruh fonts.js di folder yang sama dengan index.html (atau keempat file OpenSans-*.ttf di vendor/fonts/ lewat hosting), lalu muat ulang halaman.";
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
  let selId = null, curPage = 0, addMode = false, zoom = 1, hotKey = null, drag = null;
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
  // Values are stored per page: "<pageId>::<key>", so the same key on two pages holds two separate values.
  const vkey = (pid, k) => pid + "::" + k;
  function valueFor(f) {
    const page = tpl.pages[f.page] || tpl.pages[0], raw = (k) => values[vkey(page.id, k)] || "";
    let v = raw(f.key).trim();
    if (!v && f.key === "hari_ini") return todayStr();
    if (!v && f.key === "umur") v = ageFrom(raw("tanggal_lahir") || raw("tgl_lahir"));
    if (f.type === "date") v = fmtDate(v);
    return v;
  }

  /* ---------- measuring & layout, shared by preview and PDF ---------- */
  let measureDoc = null; const measureHas = {};
  let osData = null, osPromise = null, osFailed = false;
  const fontOf = (f) => (f && f.font) || tpl.font; // a field's own font, else the template font
  // Fonts embedded from fonts.js (jsPDF only knows times/helvetica/courier by itself).
  const EMB = {
    opensans: { family: "OpenSans", data: () => osData },
    calibri: { family: "Calibri", data: () => window.CALIBRI || null },
  };
  const embData = (fn) => (EMB[fn] ? EMB[fn].data() : null);
  const pdfFamily = (font) => (EMB[font] ? EMB[font].family : font);
  const usedEmb = () => {
    const set = {}; [tpl.font].concat(tpl.fields.map((f) => f.font)).forEach((k) => { if (EMB[k]) set[k] = 1; });
    return Object.keys(set);
  };
  let calFailed = false;
  // Embedded fonts are also registered as web fonts, so the preview and the PNG/JPG export use the same glyphs as the PDF (and work offline).
  const FACE = { opensans: "OpenSansEmbed", calibri: "CalibriEmbed" };
  const facePromise = {};
  function b64ToBuf(b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function loadFaces(key) {
    if (facePromise[key]) return facePromise[key];
    const d = embData(key);
    if (!d || !window.FontFace) return Promise.resolve();
    facePromise[key] = Promise.all(Object.keys(d).map((st) => {
      const face = new FontFace(FACE[key], b64ToBuf(d[st]), { weight: /bold/.test(st) ? "700" : "400", style: /italic/.test(st) ? "italic" : "normal" });
      return face.load().then(() => { document.fonts.add(face); }).catch(() => { /* falls back to another font */ });
    })).then(() => { if (tpl) renderFields(); });
    return facePromise[key];
  }
  const usesOs = () => !!tpl && (tpl.font === "opensans" || tpl.fields.some((f) => f.font === "opensans"));
  function bufToB64(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function loadOpenSans() {
    if (osData) return Promise.resolve(osData);
    if (window.OPENSANS && window.OPENSANS.normal) { osData = window.OPENSANS; return Promise.resolve(osData); }
    if (!osPromise) {
      osPromise = Promise.all(Object.keys(OS_FILES).map(async (st) => {
        const r = await fetch(OS_DIR + OS_FILES[st]);
        if (!r.ok) throw new Error("missing " + OS_FILES[st]);
        return [st, bufToB64(await r.arrayBuffer())];
      })).then((arr) => { osData = {}; arr.forEach(([st, b64]) => { osData[st] = b64; }); return osData; })
        .catch((e) => { osPromise = null; throw e; });
    }
    return osPromise;
  }
  function registerEmb(doc, key) {
    const d = embData(key); if (!d) return;
    Object.keys(d).forEach((st) => { const file = key + "-" + st + ".ttf"; doc.addFileToVFS(file, d[st]); doc.addFont(file, EMB[key].family, st); });
  }
  function ensureFont() {
    if (tpl && usedEmb().indexOf("calibri") !== -1) {
      if (window.CALIBRI) loadFaces("calibri"); else if (!calFailed) { calFailed = true; status(CAL_ERR, "err"); }
    }
    if (!tpl || !usesOs() || osData || osFailed) return;
    loadOpenSans().then(() => { loadFaces("opensans"); if (tpl) renderFields(); }).catch(() => { osFailed = true; status(OS_ERR, "err"); });
  }
  // Picks the jsPDF style to use. If an embedded font lacks a style, bold is simulated with an outline
  // (fake: true) and a missing italic is skipped, so preview and PDF stay identical.
  function resolveStyle(fn, bold, italic) {
    const want = bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal";
    const d = embData(fn);
    if (!d || d[want]) return { sty: want, fake: false };
    if (italic && d.italic) return { sty: "italic", fake: bold };
    return { sty: "normal", fake: bold };
  }
  function textWidth(t, size, style, font) {
    const st = style || "normal", fn = font || tpl.font;
    if (!window.jspdf || (EMB[fn] && !embData(fn))) return t.length * size * PT * (fn === "opensans" ? 0.56 : fn === "calibri" ? 0.49 : 0.5) * (/bold/.test(st) ? 1.06 : 1);
    if (!measureDoc) measureDoc = new window.jspdf.jsPDF({ unit: "mm" });
    if (EMB[fn] && !measureHas[fn]) { registerEmb(measureDoc, fn); measureHas[fn] = true; }
    measureDoc.setFont(pdfFamily(fn), st);
    measureDoc.setFontSize(size);
    return measureDoc.getTextWidth(t);
  }
  function wrapText(text, maxW, size, style, font) {
    const words = text.split(/\s+/).filter(Boolean), out = []; let cur = "";
    words.forEach((w) => { const t = cur ? cur + " " + w : w; if (cur && textWidth(t, size, style, font) > maxW) { out.push(cur); cur = w; } else cur = t; });
    if (cur) out.push(cur);
    return out.length ? out : [""];
  }
  function fieldLayout(f) {
    const page = tpl.pages[f.page] || tpl.pages[0];
    const raw = valueFor(f), empty = !raw;
    const text = (empty ? f.label : raw).replace(/\s*\n\s*/g, " ");
    const maxW = f.w || Math.max(10, page.w - f.x - 10);
    const gap = f.gap || f.size * PT * 1.45;
    const rs = resolveStyle(fontOf(f), !!f.bold, !!f.italic || empty), sty = rs.sty;
    const lines = f.type === "long" ? wrapText(text, maxW, f.size, sty, fontOf(f)) : [text];
    const th = Math.max(0.12, f.size * PT * 0.06) * (f.bold ? 1.25 : 1), dy = f.size * PT * 0.13; // underline thickness and offset below baseline (mm)
    return {
      empty, gap, sty, th, dy, fake: rs.fake, bw: f.size * PT * 0.03,
      lines: lines.map((t, i) => {
        const fn = fontOf(f), w = textWidth(t, f.size, sty, fn), y = f.y + i * gap, al = f.align || "left";
        if (al === "justify" && f.type === "long" && !empty && i < lines.length - 1) {
          // stretch the gaps between words so the line fills the whole width (the last line stays left-aligned)
          const words = t.split(" ").filter(Boolean);
          if (words.length > 1) {
            const ws = words.map((wd) => textWidth(wd, f.size, sty, fn)), sp = (maxW - ws.reduce((a, b) => a + b, 0)) / (words.length - 1);
            if (sp >= 0) { let x = f.x; return { t, w: maxW, x: f.x, y, segs: words.map((wd, k) => { const sg = { t: wd, x }; x += ws[k] + sp; return sg; }) }; }
          }
        }
        const x = al === "center" ? f.x - w / 2 : al === "right" ? f.x - w : f.x;
        return { t, w, x, y, segs: [{ t, x }] };
      }),
    };
  }

  /* ---------- paper rendering ---------- */
  function renderPaper() {
    const desk = $("desk");
    tpl.pages.forEach((p) => { if (!p.id) p.id = uid(); });
    if (curPage >= tpl.pages.length) curPage = tpl.pages.length - 1;
    if (curPage < 0) curPage = 0;
    desk.innerHTML = tpl.pages.map((p, i) => `
      <div class="sheet${i === curPage ? " cur" : ""}"><span class="pno">Halaman ${i + 1} dari ${tpl.pages.length}</span>
      <svg data-page="${i}" viewBox="0 0 ${p.w} ${p.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Halaman ${i + 1}">
        <image href="${p.src}" x="0" y="0" width="${p.w}" height="${p.h}" preserveAspectRatio="none"/>
        <g id="flds-${i}"></g>
      </svg></div>`).join("");
    desk.classList.toggle("multi", tpl.pages.length > 1);
    sizeSheets();
    renderFields();
    if (MODE === "edit") { bindSvgs(); updatePageInfo(); }
    updatePdfSel();
    ensureFont();
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
    const famOf = (f) => esc(PREVIEW_FONT[fontOf(f)] || PREVIEW_FONT.times);
    tpl.pages.forEach((p, i) => {
      const g = $("flds-" + i); if (!g) return;
      g.innerHTML = tpl.fields.filter((f) => f.page === i).map((f) => {
        const L = fieldLayout(f), fs = (f.size * PT).toFixed(3);
        const minX = Math.min(...L.lines.map((l) => l.x)), maxX = Math.max(...L.lines.map((l) => l.x + l.w));
        const lo = f.align === "center" ? f.x - 9 : f.align === "right" ? f.x - 18 : f.x, hi = f.align === "center" ? f.x + 9 : f.align === "right" ? f.x : f.x + 18;
        const bx = Math.min(minX, lo) - 0.8;
        const bw = Math.max(maxX, hi) - bx + 0.8;
        const by = f.y - f.size * PT * 0.92, bh = (L.lines.length - 1) * L.gap + f.size * PT * 1.25;
        const fill = L.empty ? "#3438a8" : tpl.ink, op = L.empty ? ' fill-opacity="0.45"' : "";
        const wt = /bold/.test(L.sty) ? ' font-weight="700"' : "", it = /italic/.test(L.sty) ? ' font-style="italic"' : "";
        const texts = L.lines.map((l) =>
          `<text y="${l.y.toFixed(2)}" font-size="${fs}" font-family="${famOf(f)}" fill="${fill}"${op}${wt}${it}${L.fake ? ` stroke="${fill}" stroke-width="${L.bw.toFixed(3)}" stroke-linejoin="round"${L.empty ? ' stroke-opacity="0.45"' : ""}` : ""} xml:space="preserve">${l.segs.map((sg) => `<tspan x="${sg.x.toFixed(2)}">${esc(sg.t)}</tspan>`).join("")}</text>`).join("")
          + (f.underline ? L.lines.filter((l) => l.t.trim()).map((l) =>
          `<line x1="${l.x.toFixed(2)}" y1="${(l.y + L.dy).toFixed(2)}" x2="${(l.x + l.w).toFixed(2)}" y2="${(l.y + L.dy).toFixed(2)}" stroke="${fill}"${L.empty ? ' stroke-opacity="0.45"' : ""} stroke-width="${L.th.toFixed(3)}"/>`).join("") : "");
        const cls = "fld" + (f.id === selId ? " sel" : "") + (hotKey && vkey(p.id, f.key) === hotKey ? " hot" : "");
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
        setCur(pageIdx);
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
    if (f) setCur(f.page);
    if (panel) panel.hidden = !f;
    if (f) {
      $("sLabel").value = f.label; $("sKey").value = f.key; $("sType").value = f.type; setAlignBtns(f);
      $("sSize").value = f.size; $("sW").value = f.w || ""; $("sGap").value = f.gap || "";
      $("sGap").placeholder = (f.size * PT * 1.45).toFixed(1);
      setStyleBtns(f); $("sFont").value = f.font || "";
      $("sGapWrap").hidden = f.type !== "long";
    }
    renderFields();
  }
  const STYLE_BTNS = [["sBold", "bold"], ["sItalic", "italic"], ["sUnder", "underline"]];
  function setStyleBtns(f) { STYLE_BTNS.forEach(([id, k]) => { const b = $(id); if (b) b.setAttribute("aria-pressed", f[k] ? "true" : "false"); }); }
  function setAlignBtns(f) { document.querySelectorAll("[data-al]").forEach((b) => b.setAttribute("aria-pressed", (f.align || "left") === b.dataset.al ? "true" : "false")); }
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

  /* ---------- editor: pages ---------- */
  let scrollLock = 0;
  function setCur(i, scroll) {
    if (!tpl || i < 0 || i >= tpl.pages.length) return;
    curPage = i;
    const desk = $("desk"), sheets = document.querySelectorAll("#desk .sheet");
    sheets.forEach((el, k) => el.classList.toggle("cur", k === i));
    updatePageInfo();
    buildForm(); // the data form only shows the active page
    if (scroll && sheets[i] && desk) {
      scrollLock = Date.now() + 700; // ignore scroll events caused by this smooth scroll
      const top = sheets[i].getBoundingClientRect().top - desk.getBoundingClientRect().top + desk.scrollTop - 12;
      desk.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }
  function updatePageInfo() {
    const el = $("pgInfo"); if (!el) return;
    const n = tpl.pages.length;
    el.textContent = "Halaman " + (curPage + 1) + " dari " + n;
    $("pgPrev").disabled = curPage <= 0; $("pgNext").disabled = curPage >= n - 1;
    $("pgUp").disabled = curPage <= 0; $("pgDown").disabled = curPage >= n - 1;
    $("pgDel").disabled = n <= 1;
    $("pgCount").textContent = tpl.fields.filter((f) => f.page === curPage).length + " kolom di halaman ini";
  }
  function afterPageChange(go, msg) {
    curPage = go; selId = null;
    const p = $("selPanel"); if (p) p.hidden = true;
    saveDraft(); renderPaper(); buildForm(true); setCur(go, true);
    if (msg) status(msg, "ok");
  }
  function insertPages(at, pages) {
    tpl.fields.forEach((f) => { if (f.page >= at) f.page += pages.length; });
    tpl.pages.splice(at, 0, ...pages);
  }
  function swapPages(a, b) {
    [tpl.pages[a], tpl.pages[b]] = [tpl.pages[b], tpl.pages[a]];
    tpl.fields.forEach((f) => { if (f.page === a) f.page = b; else if (f.page === b) f.page = a; });
  }
  async function fileToPages(file) {
    return /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? pdfToPages(file) : [await imageToPage(file)];
  }
  function wirePages() {
    on("pgPrev", "click", () => setCur(curPage - 1, true));
    on("pgNext", "click", () => setCur(curPage + 1, true));
    on("pgAdd", "click", () => {
      const cp = tpl.pages[curPage];
      insertPages(curPage + 1, [{ src: blankPage(), w: cp.w, h: cp.h }]);
      afterPageChange(curPage + 1, "Halaman kosong ditambahkan. Pasang background-nya lewat \"Ganti background hal. ini\" kalau perlu.");
    });
    on("pgFile", "change", async () => {
      const input = $("pgFile"), file = input.files[0]; input.value = ""; if (!file) return;
      status("Membaca " + file.name + "…", "busy");
      try {
        const pages = await fileToPages(file);
        insertPages(curPage + 1, pages);
        afterPageChange(curPage + 1, pages.length + " halaman ditambahkan setelah halaman " + (curPage + 1) + ".");
      } catch (e) { readFail(e); }
    });
    on("pgReplaceFile", "change", async () => {
      const input = $("pgReplaceFile"), file = input.files[0]; input.value = ""; if (!file) return;
      status("Membaca " + file.name + "…", "busy");
      try {
        const pages = await fileToPages(file), at = curPage;
        pages[0].id = tpl.pages[at].id; // keep the data typed on this page
        tpl.pages[at] = pages[0];
        if (pages.length > 1) insertPages(at + 1, pages.slice(1));
        afterPageChange(at, pages.length > 1
          ? "Background halaman " + (at + 1) + " diganti, sisa " + (pages.length - 1) + " halaman PDF disisipkan sesudahnya."
          : "Background halaman " + (at + 1) + " diganti. Kolomnya tetap di tempat.");
      } catch (e) { readFail(e); }
    });
    on("pgDup", "click", () => {
      const at = curPage, src = tpl.pages[at], mine = tpl.fields.filter((f) => f.page === at);
      insertPages(at + 1, [Object.assign({}, src, { id: uid() })]);
      mine.forEach((f) => tpl.fields.push(Object.assign({}, f, { id: uid(), page: at + 1 })));
      afterPageChange(at + 1, "Halaman " + (at + 1) + " diduplikat beserta kolomnya.");
    });
    on("pgUp", "click", () => { if (curPage > 0) { swapPages(curPage, curPage - 1); afterPageChange(curPage - 1, "Halaman dipindah ke posisi " + curPage + "."); } });
    on("pgDown", "click", () => { if (curPage < tpl.pages.length - 1) { swapPages(curPage, curPage + 1); afterPageChange(curPage + 1, "Halaman dipindah ke posisi " + (curPage + 2) + "."); } });
    on("pgDel", "click", () => {
      if (tpl.pages.length <= 1) return;
      const at = curPage, n = tpl.fields.filter((f) => f.page === at).length;
      if (!confirm("Hapus halaman " + (at + 1) + (n ? " beserta " + n + " kolomnya" : "") + "?")) return;
      tpl.fields = tpl.fields.filter((f) => f.page !== at);
      tpl.fields.forEach((f) => { if (f.page > at) f.page--; });
      tpl.pages.splice(at, 1);
      afterPageChange(Math.min(at, tpl.pages.length - 1), "Halaman " + (at + 1) + " dihapus.");
    });
  }

  /* ---------- data form ---------- */
  let formSig = "";
  function formGroups() {
    return tpl.pages.map((p, i) => {
      const seen = {}, fs = [];
      tpl.fields.filter((f) => f.page === i).sort((x, y) => x.y - y.y || x.x - y.x).forEach((f) => { if (!seen[f.key]) { seen[f.key] = 1; fs.push(f); } });
      return { p, i, fs };
    }).filter((g) => g.fs.length);
  }
  function buildForm(force) {
    const groups = formGroups(), multi = tpl.pages.length > 1;
    if (curPage >= tpl.pages.length) curPage = tpl.pages.length - 1;
    if (curPage < 0) curPage = 0;
    const sig = groups.map((g) => g.i + g.p.id + ":" + g.fs.map((f) => f.key + "|" + f.label + "|" + f.type).join(";")).join("#") + "#" + tpl.pages.length + "@" + curPage;
    const nf = $("noFields"); if (nf) nf.hidden = groups.length > 0;
    if (sig === formSig && !force) return;
    formSig = sig;
    const count = {}; groups.forEach((g) => { count[g.i] = g.fs.length; });
    const shown = multi ? groups.filter((g) => g.i === curPage) : groups;
    const nav = multi
      ? `<div class="pgnav"><button type="button" class="btn small" data-go="-1" aria-label="Halaman sebelumnya"${curPage <= 0 ? " disabled" : ""}>‹</button>`
        + `<select data-pgsel aria-label="Pilih halaman">${tpl.pages.map((p, i) => `<option value="${i}"${i === curPage ? " selected" : ""}>Halaman ${i + 1} dari ${tpl.pages.length}${count[i] ? " (" + count[i] + " isian)" : " (tanpa isian)"}</option>`).join("")}</select>`
        + `<button type="button" class="btn small" data-go="1" aria-label="Halaman berikutnya"${curPage >= tpl.pages.length - 1 ? " disabled" : ""}>›</button></div>`
      : "";
    const empty = multi && !shown.length ? '<p class="note">Halaman ini belum punya kolom isian.</p>' : "";
    $("form").innerHTML = nav + empty + shown.map((g) => g.fs.map((f) => {
      const vk = vkey(g.p.id, f.key), id = "v_" + g.p.id + "_" + f.key, v = esc(values[vk] || "");
      let ph = "";
      if (f.key === "hari_ini") ph = ' placeholder="Kosong = tanggal hari ini"';
      if (f.key === "umur") ph = ' placeholder="Kosong = dihitung dari tanggal lahir"';
      const input = f.type === "long"
        ? `<textarea id="${id}" data-vk="${esc(vk)}">${v}</textarea>`
        : `<input id="${id}" data-vk="${esc(vk)}" type="${f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}" value="${v}"${ph}>`;
      const keyTag = MODE === "edit" ? `<code>${esc(f.key)}</code>` : "";
      return `<div class="field" data-fk="${esc(vk)}"><label for="${id}"><span>${esc(f.label)}</span>${keyTag}</label>${input}</div>`;
    }).join("")).join("");
  }
  // One-time move of old flat values ("nama") onto the first page.
  function migrateValues() {
    const first = tpl.pages[0].id; let changed = false;
    Object.keys(values).forEach((k) => {
      if (k.indexOf("::") !== -1) return;
      const nk = vkey(first, k); if (values[nk] === undefined) values[nk] = values[k];
      delete values[k]; changed = true;
    });
    if (changed) saveValues();
  }
  function setHot(k) {
    hotKey = k;
    document.querySelectorAll(".field[data-fk]").forEach((el) => el.classList.toggle("hot", el.dataset.fk === k));
    renderFields();
  }

  // Explains why a background file failed, instead of one generic message.
  function readFail(e) {
    console.error(e);
    let d = e && e.message ? e.message : (e && e.type === "error" ? "browser tidak bisa membuka gambar ini (format tidak didukung atau file rusak)" : String(e || ""));
    if (e && e.name === "PasswordException") d = "PDF dikunci dengan password";
    else if (/pdf\.js not loaded/.test(d)) d = "pustaka PDF belum termuat (cek folder vendor: pdf.min.js dan pdf.worker.min.js)";
    else if (/worker/i.test(d)) d = "pdf.worker.min.js gagal dimuat (buka lewat localhost/hosting, bukan klik dua kali). " + d;
    else if (/canvas too large/.test(d)) d = "halaman terlalu besar untuk browser (turunkan BG_DPI di app.js)";
    status("File tidak bisa dibaca. Pakai gambar PNG/JPG atau PDF yang tidak terkunci. Detail: " + d, "err");
  }

  /* ---------- status line ---------- */
  function status(msg, kind) { const s = $("status"); if (!s) return; s.textContent = msg || ""; s.className = "status" + (kind ? " " + kind : ""); }

  /* ---------- editor: background upload ---------- */
  // Background quality. 600 dpi is the maximum; lower BG_DPI (e.g. 300) if template.js gets too heavy.
  const BG_DPI = 600, BG_QUALITY = 0.98, BG_MAX_SIDE = 8192;
  // Draws onto a white canvas and returns a JPEG data URL. If the browser refuses a canvas this big, it retries smaller.
  async function rasterJpeg(w, h, draw) {
    let f = Math.min(1, BG_MAX_SIDE / Math.max(w, h));
    for (let tries = 0; tries < 8; tries++, f *= 0.8) {
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * f)); c.height = Math.max(1, Math.round(h * f));
      const g = c.getContext("2d"); if (!g) continue;
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = "high";
      await draw(g, c.width, c.height);
      const url = c.toDataURL("image/jpeg", BG_QUALITY);
      if (url && url.length > 1000) return url;
    }
    throw new Error("canvas too large");
  }
  function imageToPage(file) {
    return new Promise((res, rej) => {
      const r = new FileReader(); r.onerror = rej;
      r.onload = () => {
        const img = new Image(); img.onerror = rej;
        img.onload = () => {
          // Keep the picture's own pixels (an image cannot be sharpened beyond its source); only cap absurd sizes.
          rasterJpeg(img.width, img.height, (g, cw, ch) => g.drawImage(img, 0, 0, cw, ch))
            .then((src) => res({ src, w: 210, h: +(210 * img.height / img.width).toFixed(2) }), rej);
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
      status(`Membaca halaman ${i} dari ${pdf.numPages} (resolusi tinggi, mohon tunggu)…`, "busy");
      const pg = await pdf.getPage(i), v1 = pg.getViewport({ scale: 1 });
      const src = await rasterJpeg(v1.width * BG_DPI / 72, v1.height * BG_DPI / 72, async (g, cw) => {
        await pg.render({ canvasContext: g, viewport: pg.getViewport({ scale: cw / v1.width }) }).promise;
      });
      out.push({ src, w: +(v1.width * 25.4 / 72).toFixed(2), h: +(v1.height * 25.4 / 72).toFixed(2) });
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
    const out = Object.assign({ version: 1, title: "Template", font: "times", ink: "#111111", fname: "dokumen", withBg: true }, t);
    out.pages.forEach((p, i) => { if (!p.id) p.id = "h" + (i + 1); }); // stable ids so each page keeps its own data
    return out;
  }

  /* ---------- PDF page choice ---------- */
  function updatePdfSel() {
    const s = $("pdfSel"); if (!s) return;
    const prev = s.value, n = tpl.pages.length;
    let h = '<option value="all">Semua halaman</option>';
    if (n > 1) {
      for (let i = 0; i < n; i++) h += '<option value="p' + i + '">Halaman ' + (i + 1) + '</option>';
      h += '<option value="custom">Pilih beberapa…</option>';
    }
    s.innerHTML = h;
    s.value = [...s.options].some((o) => o.value === prev) ? prev : "all";
    s.hidden = n < 2;
    togglePdfRange();
  }
  function togglePdfRange() { const s = $("pdfSel"), r = $("pdfRange"); if (s && r) r.hidden = s.hidden || s.value !== "custom"; }
  function pdfPageList() {
    const n = tpl.pages.length, s = $("pdfSel"), all = tpl.pages.map((_, i) => i);
    if (!s || s.hidden || s.value === "all") return all;
    if (s.value !== "custom") return [+s.value.slice(1)];
    const txt = ($("pdfRange").value || "").replace(/\s+/g, ""), out = [];
    if (!txt) throw new Error("Isi nomor halaman, misalnya 1,3-4.");
    txt.split(",").filter(Boolean).forEach((part) => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) throw new Error("Format halaman tidak dikenali: \"" + part + "\". Contoh yang benar: 1,3-4.");
      let a = +m[1], b = m[2] ? +m[2] : a;
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > n) throw new Error("Nomor halaman harus antara 1 dan " + n + ".");
      for (let k = a; k <= b; k++) if (!out.includes(k - 1)) out.push(k - 1);
    });
    if (!out.length) throw new Error("Isi nomor halaman, misalnya 1,3-4.");
    return out;
  }

  /* ---------- PNG / JPG export (full resolution, no extra compression) ---------- */
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  // Minimal ZIP writer, "store" method (no compression), used when several pages are exported as images.
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    files.forEach((f) => {
      const nm = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nm);
      offset += 30 + nm.length + size;
    });
    const cdSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/zip" });
  }
  function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
  async function prepareFonts() {
    const keys = usedEmb();
    if (keys.indexOf("opensans") !== -1) await loadOpenSans();
    await Promise.all(keys.map((k) => loadFaces(k)));
    if (document.fonts && document.fonts.load) {
      const specs = {};
      tpl.fields.forEach((f) => {
        const rs = resolveStyle(fontOf(f), !!f.bold, !!f.italic);
        specs[(/italic/.test(rs.sty) ? "italic " : "") + (/bold/.test(rs.sty) ? "700 " : "400 ") + "20px " + (PREVIEW_FONT[fontOf(f)] || PREVIEW_FONT.times)] = 1;
      });
      await Promise.all(Object.keys(specs).map((s) => document.fonts.load(s).catch(() => {})));
    }
  }
  // s = pixels per millimetre
  function drawFields(g, pageIdx, s) {
    g.textBaseline = "alphabetic"; g.textAlign = "left"; g.lineJoin = "round";
    if ("fontKerning" in g) g.fontKerning = "none"; // the PDF does not kern either
    if ("textRendering" in g) g.textRendering = "geometricPrecision";
    tpl.fields.filter((f) => f.page === pageIdx).forEach((f) => {
      const L = fieldLayout(f); if (L.empty) return;
      g.font = (/italic/.test(L.sty) ? "italic " : "") + (/bold/.test(L.sty) ? "700 " : "400 ") + (f.size * PT * s).toFixed(2) + "px " + (PREVIEW_FONT[fontOf(f)] || PREVIEW_FONT.times);
      g.fillStyle = tpl.ink; g.strokeStyle = tpl.ink;
      L.lines.forEach((l) => {
        l.segs.forEach((sg) => {
          if (L.fake) { g.lineWidth = L.bw * s; g.strokeText(sg.t, sg.x * s, l.y * s); }
          g.fillText(sg.t, sg.x * s, l.y * s);
        });
        if (f.underline && l.t.trim()) {
          g.lineWidth = L.th * s; g.beginPath(); g.moveTo(l.x * s, (l.y + L.dy) * s); g.lineTo((l.x + l.w) * s, (l.y + L.dy) * s); g.stroke();
        }
      });
    });
  }
  // Renders one page at the background's own pixel size (at least 300 dpi). PNG is lossless; JPG is saved at maximum quality.
  async function pageToBlob(i, mime) {
    const p = tpl.pages[i], img = await loadImg(p.src);
    const s0 = Math.max(img.naturalWidth / p.w, 300 / 25.4);
    let f = Math.min(1, BG_MAX_SIDE / (Math.max(p.w, p.h) * s0));
    for (let tries = 0; tries < 8; tries++, f *= 0.8) {
      const cw = Math.max(1, Math.round(p.w * s0 * f)), ch = Math.max(1, Math.round(p.h * s0 * f));
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const g = c.getContext("2d"); if (!g) continue;
      g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch);
      if (tpl.withBg !== false) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, cw, ch); }
      drawFields(g, i, cw / p.w);
      const blob = await new Promise((res) => c.toBlob(res, mime, 1));
      if (blob && blob.size > 0) return blob;
    }
    throw new Error("halaman terlalu besar untuk browser ini");
  }
  async function exportImages(list, fmt) {
    const mime = fmt === "png" ? "image/png" : "image/jpeg", ext = fmt === "png" ? "png" : "jpg";
    try {
      status("Menyiapkan font dan gambar…", "busy");
      await prepareFonts();
      const base = fileName(list).replace(/\.pdf$/i, ""), multi = tpl.pages.length > 1, files = [];
      for (let k = 0; k < list.length; k++) {
        status("Membuat gambar halaman " + (list[k] + 1) + " (" + (k + 1) + " dari " + list.length + "), resolusi penuh…", "busy");
        await new Promise((r) => setTimeout(r, 30));
        files.push({ page: list[k], blob: await pageToBlob(list[k], mime) });
      }
      const nm = (pg) => base + (multi ? " (hal " + (pg + 1) + ")" : "") + "." + ext;
      const mb = (n) => (n / 1048576).toFixed(1) + " MB";
      if (files.length === 1) {
        saveBlob(files[0].blob, nm(files[0].page));
        status(nm(files[0].page) + " sudah dibuat (" + mb(files[0].blob.size) + ").", "ok");
      } else {
        const entries = [];
        for (const f of files) entries.push({ name: nm(f.page), data: new Uint8Array(await f.blob.arrayBuffer()) });
        const zip = makeZip(entries);
        saveBlob(zip, base + ".zip");
        status(base + ".zip sudah dibuat, berisi " + files.length + " gambar " + ext.toUpperCase() + " (" + mb(zip.size) + ").", "ok");
      }
    } catch (e) {
      console.error(e);
      status("Gambar gagal dibuat: " + (e && e.message ? e.message : e) + ". Coba ekspor satu halaman saja, atau pakai PDF.", "err");
    }
  }
  const fmtValue = () => { const s = $("expFmt"); return s ? s.value : "pdf"; };
  function updateDlLabel() { const b = $("download"); if (b) b.textContent = (b.dataset.verb || "Unduh") + " " + fmtValue().toUpperCase(); }

  /* ---------- PDF ---------- */
  function hexRgb(h) { const n = parseInt((h || "#111111").slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function buildPdf(list) {
    const { jsPDF } = window.jspdf; let doc = null;
    (list || tpl.pages.map((_, i) => i)).forEach((i) => {
      const p = tpl.pages[i];
      const o = p.w > p.h ? "landscape" : "portrait";
      if (!doc) { doc = new jsPDF({ unit: "mm", format: [p.w, p.h], orientation: o }); usedEmb().forEach((k) => registerEmb(doc, k)); } else doc.addPage([p.w, p.h], o);
      if (tpl.withBg !== false) doc.addImage(p.src, "JPEG", 0, 0, p.w, p.h, undefined, "FAST");
      doc.setTextColor(...hexRgb(tpl.ink)); doc.setDrawColor(...hexRgb(tpl.ink));
      tpl.fields.filter((f) => f.page === i).forEach((f) => {
        const L = fieldLayout(f); if (L.empty) return;
        doc.setFont(pdfFamily(fontOf(f)), L.sty); doc.setFontSize(f.size);
        L.lines.forEach((l) => {
          l.segs.forEach((sg) => {
            if (L.fake) { doc.setLineWidth(L.bw); doc.text(sg.t, sg.x, l.y, { renderingMode: "fillThenStroke" }); } else doc.text(sg.t, sg.x, l.y);
          });
          if (f.underline && l.t.trim()) { doc.setLineWidth(L.th); doc.line(l.x, l.y + L.dy, l.x + l.w, l.y + L.dy); }
        });
      });
    });
    return doc;
  }
  function fileName(list) {
    const order = list && list.length ? list : tpl.pages.map((_, i) => i);
    let n = (tpl.fname || "dokumen").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => {
      const c = tpl.fields.filter((x) => x.key === k);
      const f = order.map((i) => c.find((x) => x.page === i)).find(Boolean) || c[0] || { key: k, type: "text", page: 0 };
      return valueFor(f);
    });
    n = n.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/[\s-]+$/, "").trim().replace(/\.pdf$/i, "");
    return (n || "dokumen") + ".pdf";
  }

  /* ---------- wiring ---------- */
  function wireCommon() {
    on("form", "input", (e) => { const k = e.target.dataset.vk; if (!k) return; values[k] = e.target.value; saveValues(); renderFields(); });
    on("form", "focusin", (e) => { const k = e.target.dataset && e.target.dataset.vk; if (k) setHot(k); });
    on("form", "focusout", () => setHot(null));
    on("form", "click", (e) => { const b = e.target.closest && e.target.closest("[data-go]"); if (b && !b.disabled) setCur(curPage + (+b.dataset.go), true); });
    on("form", "change", (e) => { if (e.target.hasAttribute && e.target.hasAttribute("data-pgsel")) setCur(+e.target.value, true); });
    on("desk", "click", (e) => {
      const sh = e.target.closest && e.target.closest(".sheet"); if (!sh) return;
      const i = [...$("desk").querySelectorAll(".sheet")].indexOf(sh); if (i >= 0 && i !== curPage) setCur(i);
    });
    let scrollT = null;
    on("desk", "scroll", () => {
      if (Date.now() < scrollLock) return;
      clearTimeout(scrollT);
      scrollT = setTimeout(() => {
        const desk = $("desk"), sheets = [...desk.querySelectorAll(".sheet")]; if (sheets.length < 2) return;
        const dr = desk.getBoundingClientRect(), ref = dr.top + dr.height * 0.35;
        let best = 0, bd = Infinity;
        sheets.forEach((el, k) => { const r = el.getBoundingClientRect(), d = ref < r.top ? r.top - ref : ref > r.bottom ? ref - r.bottom : 0; if (d < bd) { bd = d; best = k; } });
        if (best !== curPage) setCur(best);
      }, 80);
    });
    on("clearData", "click", () => { values = {}; saveValues(); buildForm(true); renderFields(); status("Isian dikosongkan."); });
    on("pdfSel", "change", togglePdfRange);
    on("zoom", "change", () => { zoom = parseFloat($("zoom").value) || 1; sizeSheets(); });
    window.addEventListener("resize", sizeSheets);
    on("expFmt", "change", updateDlLabel); updateDlLabel();
    on("download", "click", async () => {
      const fmt = fmtValue();
      if (!window.jspdf) { status("Pembuat PDF belum termuat. Muat ulang halaman.", "err"); return; }
      let list;
      try { list = pdfPageList(); } catch (e) { status(e.message, "err"); return; }
      if (usedEmb().indexOf("calibri") !== -1 && !window.CALIBRI) { status(CAL_ERR, "err"); return; }
      if (usesOs()) {
        status("Memuat font Open Sans…", "busy");
        try { await loadOpenSans(); } catch (e) { status(OS_ERR, "err"); return; }
      }
      if (fmt !== "pdf") { await exportImages(list, fmt); return; }
      try {
        const subset = list.length !== tpl.pages.length, nums = list.map((i) => i + 1).join(",");
        const name = subset ? fileName(list).replace(/\.pdf$/i, " (hal " + nums + ").pdf") : fileName(list);
        buildPdf(list).save(name);
        status(name + " sudah dibuat" + (subset ? " (halaman " + nums + ")." : " (semua halaman)."), "ok");
      } catch (e) { status("PDF gagal dibuat. Coba muat ulang halaman.", "err"); }
    });
  }

  function wireEditor() {
    wirePages();
    bindSel("sLabel", "label");
    bindSel("sKey", "key", (v) => slug(v));
    on("sKey", "change", () => { const f = selected(); if (f) $("sKey").value = f.key; });
    bindSel("sType", "type");
    document.querySelectorAll("[data-al]").forEach((b) => b.addEventListener("click", () => {
      const f = selected(); if (!f) return;
      f.align = b.dataset.al; saveDraft(); setAlignBtns(f); renderFields();
    }));
    bindSel("sSize", "size", (v) => Math.min(100, Math.max(6, parseFloat(v) || 11)));
    bindSel("sW", "w", (v) => parseFloat(v) || 0);
    bindSel("sGap", "gap", (v) => parseFloat(v) || 0);
    on("sFont", "input", () => {
      const f = selected(); if (!f) return;
      const v = $("sFont").value; if (v) f.font = v; else delete f.font;
      saveDraft(); ensureFont(); renderFields();
    });
    STYLE_BTNS.forEach(([id, k]) => on(id, "click", () => {
      const f = selected(); if (!f) return;
      if (f[k]) delete f[k]; else f[k] = true;
      saveDraft(); setStyleBtns(f); renderFields();
    }));
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
      if (tpl.pages.length > 1 && !confirm("Ini mengganti SEMUA " + tpl.pages.length + " halaman dengan file baru. Lanjutkan?\n\nUntuk mengganti satu halaman saja, pakai panel Halaman → Ganti background hal. ini.")) return;
      status("Membaca " + file.name + "…", "busy");
      try {
        const pages = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? await pdfToPages(file) : [await imageToPage(file)];
        pages.forEach((p, i) => { if (tpl.pages[i]) p.id = tpl.pages[i].id; });
        tpl.pages = pages; curPage = 0;
        tpl.fields = tpl.fields.filter((f) => f.page < pages.length);
        saveDraft(); select(null); renderPaper(); buildForm(true);
        status(`Background terpasang (${pages.length} halaman). Tekan "+ Tambah kolom" lalu ketuk tempat isian di kertas.`, "ok");
      } catch (e) { readFail(e); }
    });

    on("importJson", "change", async () => {
      const input = $("importJson"), file = input.files[0]; input.value = ""; if (!file) return;
      try { tpl = parseTemplateFile(await file.text()); curPage = 0; saveDraft(); loadSettings(); select(null); renderPaper(); buildForm(true); status("Template dibuka.", "ok"); }
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

    ["title", "font", "ink", "fname"].forEach((k) => on("set_" + k, "input", () => { tpl[k] = $("set_" + k).value; saveDraft(); if (k === "font") ensureFont(); renderFields(); }));
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
    migrateValues();
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
