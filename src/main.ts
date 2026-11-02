import "./styles.css";
import { login, type Session } from "./auth";
import { icons } from "./icons";
import { extractInvoice, FIELD_KEYS, formatMoney, parseMoney, findDate, type FieldKey } from "./parser";
import { isSupported, preloadOcr, recognizeFile, SUPPORTED_EXTENSIONS } from "./ocr";
import {
  COLUMN_LABELS,
  fieldConfidence,
  isLowConfidence,
  reviewState,
  rowConfidence,
  rowIssues,
  STATUS_LABELS,
  sumField,
} from "./review";
import { buildExcel, buildPdf, exportFileName } from "./export";
import { isDesktop, revealFile, saveBytes } from "./save";
import type { InvoiceRow } from "./types";

// ================================================================ state

type Filter = "all" | "review" | "ok" | "reviewed";

const state = {
  session: null as Session | null,
  rows: [] as InvoiceRow[],
  previews: new Map<string, string>(),
  filter: "all" as Filter,
  search: "",
  drawerId: null as string | null,
  processing: false,
};

const app = document.getElementById("app")!;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtMoney = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const emptyValues = (): Record<FieldKey, string> =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, ""])) as Record<FieldKey, string>;
const zeroConfidence = (): Record<FieldKey, number> =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, 0])) as Record<FieldKey, number>;

// ================================================================ persistence

const storageKey = () => `evolve-ap-ocr:worksheet:${state.session?.username}`;
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const rows = state.rows.filter((r) => r.status === "done" || r.status === "error");
      localStorage.setItem(storageKey(), JSON.stringify(rows));
    } catch {
      /* storage full / unavailable - worksheet still works in memory */
    }
  }, 300);
}

function restore() {
  try {
    const raw = localStorage.getItem(storageKey());
    state.rows = raw ? (JSON.parse(raw) as InvoiceRow[]) : [];
  } catch {
    state.rows = [];
  }
}

// ================================================================ login

function renderLogin(error = "") {
  document.title = "Sign in – Evolve AP Invoice OCR";
  app.innerHTML = `
  <div class="login">
    <section class="login-brand">
      <div class="brand-mark">${icons.logo(28)}</div>
      <h1>Evolve AP<br/>Invoice OCR</h1>
      <p class="lead">Turn supplier invoices into a clean, reviewed AP register in minutes.</p>
      <ul class="features">
        <li>${icons.zap(18)}<span><b>Automatic extraction</b> of vendor, invoice no., date, amount, GST, total &amp; description</span></li>
        <li>${icons.table(18)}<span><b>Editable worksheet</b> with confidence flags so you know what to check</span></li>
        <li>${icons.excel(18)}<span><b>Export</b> to Excel and PDF in one click</span></li>
        <li>${icons.shield(18)}<span><b>100% local</b> – documents never leave this computer</span></li>
      </ul>
    </section>
    <section class="login-panel">
      <form class="login-card" id="login-form" autocomplete="off">
        <h2>Welcome back</h2>
        <p class="muted">Sign in to continue</p>
        <label class="field">
          <span>Username</span>
          <div class="input-icon">${icons.user(16)}<input id="username" name="username" required autofocus placeholder="admin" /></div>
        </label>
        <label class="field">
          <span>Password</span>
          <div class="input-icon">${icons.lock(16)}<input id="password" name="password" type="password" required placeholder="••••••••" /></div>
        </label>
        <div class="form-error" role="alert">${esc(error)}</div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <div class="demo-hint">
          <b>Demo accounts</b>
          <span><code>admin</code> / <code>admin123</code></span>
          <span><code>finance</code> / <code>finance2026</code></span>
        </div>
      </form>
    </section>
  </div>`;

  $<HTMLFormElement>("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const session = login($<HTMLInputElement>("#username").value, $<HTMLInputElement>("#password").value);
    if (!session) {
      renderLogin("Incorrect username or password.");
      return;
    }
    state.session = session;
    restore();
    renderShell();
    preloadOcr();
  });
  if (error) $<HTMLInputElement>("#password").focus();
}

// ================================================================ shell

function renderShell() {
  document.title = "Evolve AP Invoice OCR";
  const s = state.session!;
  app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">${icons.logo(22)}<span>Evolve <b>AP Invoice OCR</b></span></div>
      <div class="topbar-right">
        <span class="privacy-pill">${icons.shield(14)} Local OCR · offline</span>
        <div class="user-chip"><span class="avatar">${esc(s.displayName[0])}</span><span><b>${esc(s.displayName)}</b><small>${esc(s.role)}</small></span></div>
        <button class="btn btn-ghost" id="logout" title="Sign out">${icons.logout(16)} Sign out</button>
      </div>
    </header>

    <main class="content">
      <section class="hero-row">
        <div>
          <h1>Invoice worksheet</h1>
          <p class="muted">Upload invoices, check the highlighted cells, then export.</p>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" id="export-xlsx">${icons.excel(16)} Export Excel</button>
          <button class="btn btn-secondary" id="export-pdf">${icons.pdf(16)} Export PDF</button>
        </div>
      </section>

      <section class="dropzone" id="dropzone" tabindex="0">
        <div class="dz-icon">${icons.upload(26)}</div>
        <div class="dz-text">
          <span><b>Drop invoices here</b> or <button class="link" id="browse">browse files</button></span>
          <small>PDF, PNG, JPG, JPEG, TIFF · multiple files supported · English</small>
        </div>
        <button class="btn btn-primary" id="upload-btn">${icons.upload(16)} Upload invoices</button>
        <input type="file" id="file-input" multiple accept="${SUPPORTED_EXTENSIONS.map((e) => "." + e).join(",")}" hidden />
      </section>

      <section class="stats" id="stats"></section>

      <section class="sheet-card">
        <div class="sheet-toolbar">
          <div class="tabs" id="tabs"></div>
          <div class="toolbar-right">
            <label class="search">${icons.search(15)}<input id="search" placeholder="Search vendor, invoice no…" value="${esc(state.search)}" /></label>
            <button class="btn btn-ghost" id="add-row">${icons.plus(16)} Add row</button>
            <button class="btn btn-ghost danger" id="clear-all">${icons.trash(16)} Clear</button>
          </div>
        </div>
        <div class="sheet-scroll">
          <table class="sheet" id="sheet">
            <colgroup>
              <col style="width:40px" /><col style="width:124px" /><col style="width:200px" /><col style="width:132px" />
              <col style="width:112px" /><col style="width:100px" /><col style="width:86px" /><col style="width:100px" />
              <col /><col style="width:70px" /><col style="width:130px" /><col style="width:100px" />
            </colgroup>
            <thead><tr>
              <th class="c-no">#</th>
              <th class="c-status">Status</th>
              <th class="c-vendor">Vendor</th>
              <th class="c-inv">Invoice No.</th>
              <th class="c-date">Date</th>
              <th class="c-num">Amount</th>
              <th class="c-num">GST</th>
              <th class="c-num">Total</th>
              <th class="c-desc">Description</th>
              <th class="c-conf" title="Average OCR confidence">Conf.</th>
              <th class="c-file">File</th>
              <th class="c-act"></th>
            </tr></thead>
            <tbody id="tbody"></tbody>
            <tfoot id="tfoot"></tfoot>
          </table>
          <div class="empty" id="empty"></div>
        </div>
        <div class="sheet-foot muted">
          <span><i class="legend low"></i> Low confidence – please check</span>
          <span><i class="legend edited"></i> Edited by you</span>
          <span>Tip: press <kbd>Enter</kbd> to move down a column. Your worksheet is saved automatically.</span>
        </div>
      </section>
    </main>

    <aside class="drawer" id="drawer" aria-hidden="true"></aside>
    <div class="drawer-backdrop" id="drawer-backdrop"></div>
    <div class="drop-overlay" id="drop-overlay"><div>${icons.upload(40)}<b>Drop to upload invoices</b></div></div>
    <div class="toasts" id="toasts"></div>
  </div>`;

  wireShell();
  renderAll();
}

function wireShell() {
  const input = $<HTMLInputElement>("#file-input");
  const openPicker = () => input.click();
  $("#upload-btn").addEventListener("click", openPicker);
  $("#browse").addEventListener("click", openPicker);
  $("#dropzone").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") openPicker();
  });
  input.addEventListener("change", () => {
    if (input.files?.length) addFiles(Array.from(input.files));
    input.value = "";
  });

  // Drag & drop anywhere in the window
  let dragDepth = 0;
  const overlay = $("#drop-overlay");
  window.ondragenter = (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add("show");
  };
  window.ondragleave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.remove("show");
  };
  window.ondragover = (e) => e.preventDefault();
  window.ondrop = (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove("show");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) addFiles(files);
  };

  $("#logout").addEventListener("click", async () => {
    if (state.processing && !(await confirmDialog("Invoices are still being processed. Sign out anyway?", "Sign out"))) return;
    state.session = null;
    state.rows = [];
    state.previews.clear();
    closeDrawer();
    renderLogin();
  });

  $("#export-xlsx").addEventListener("click", () => doExport("xlsx"));
  $("#export-pdf").addEventListener("click", () => doExport("pdf"));
  $("#add-row").addEventListener("click", addManualRow);
  $("#clear-all").addEventListener("click", async () => {
    if (!state.rows.length) return;
    if (!(await confirmDialog(`Remove all ${state.rows.length} rows from the worksheet?`, "Clear worksheet", true))) return;
    state.rows = state.rows.filter((r) => r.status === "processing" || r.status === "queued");
    persist();
    closeDrawer();
    renderAll();
  });
  $<HTMLInputElement>("#search").addEventListener("input", (e) => {
    state.search = (e.target as HTMLInputElement).value;
    renderTable();
  });
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.drawerId) closeDrawer();
  });

  const tbody = $("#tbody");
  tbody.addEventListener("input", onCellInput);
  tbody.addEventListener("change", onCellCommit);
  tbody.addEventListener("keydown", onCellKey);
  tbody.addEventListener("click", onRowAction);
}

// ================================================================ rendering

function renderAll() {
  renderStats();
  renderTabs();
  renderTable();
  if (state.drawerId) renderDrawer();
}

function counts() {
  const done = state.rows.filter((r) => r.status === "done" || r.status === "error");
  const c = { all: state.rows.length, review: 0, ok: 0, reviewed: 0 };
  for (const r of done) c[reviewState(r)]++;
  return c;
}

function renderStats() {
  const c = counts();
  const rows = state.rows.filter((r) => r.status === "done");
  const busy = state.rows.filter((r) => r.status === "processing" || r.status === "queued").length;
  $("#stats").innerHTML = `
    <div class="stat"><span>Invoices</span><b>${c.all}</b><small>${busy ? `${busy} processing…` : "in worksheet"}</small></div>
    <div class="stat ${c.review ? "warn" : ""}"><span>Needs review</span><b>${c.review}</b><small>${c.review ? "check highlighted cells" : "all clear"}</small></div>
    <div class="stat"><span>Amount (excl. GST)</span><b>${fmtMoney(sumField(rows, "amount"))}</b><small>sum of rows</small></div>
    <div class="stat"><span>GST</span><b>${fmtMoney(sumField(rows, "gst"))}</b><small>sum of rows</small></div>
    <div class="stat accent"><span>Grand total</span><b>${fmtMoney(sumField(rows, "total"))}</b><small>sum of rows</small></div>`;
}

function renderTabs() {
  const c = counts();
  const tabs: [Filter, string, number][] = [
    ["all", "All", c.all],
    ["review", "Needs Review", c.review],
    ["ok", "OK", c.ok],
    ["reviewed", "Reviewed", c.reviewed],
  ];
  $("#tabs").innerHTML = tabs
    .map(([f, label, n]) => `<button class="tab ${state.filter === f ? "active" : ""} ${f === "review" && n ? "has-warn" : ""}" data-filter="${f}">${label}<span>${n}</span></button>`)
    .join("");
  $("#tabs").querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter as Filter;
      renderTabs();
      renderTable();
    }),
  );
}

function visibleRows(): InvoiceRow[] {
  const q = state.search.trim().toLowerCase();
  return state.rows.filter((r) => {
    if (state.filter !== "all") {
      if (r.status === "processing" || r.status === "queued") return false;
      if (reviewState(r) !== state.filter) return false;
    }
    if (!q) return true;
    return [r.fileName, ...FIELD_KEYS.map((k) => r.values[k])].some((v) => v.toLowerCase().includes(q));
  });
}

const INPUT_COLS: { key: FieldKey; cls: string; placeholder: string }[] = [
  { key: "vendor", cls: "c-vendor", placeholder: "Vendor name" },
  { key: "invoiceNo", cls: "c-inv", placeholder: "Invoice no." },
  { key: "date", cls: "c-date", placeholder: "DD/MM/YYYY" },
  { key: "amount", cls: "c-num", placeholder: "0.00" },
  { key: "gst", cls: "c-num", placeholder: "0.00" },
  { key: "total", cls: "c-num", placeholder: "0.00" },
  { key: "description", cls: "c-desc", placeholder: "Description" },
];

function statusBadge(r: InvoiceRow): string {
  if (r.status === "queued") return `<span class="badge muted">Queued</span>`;
  if (r.status === "processing") return `<span class="badge info"><i class="spinner"></i>${Math.round(r.progress * 100)}%</span>`;
  if (r.status === "error") return `<span class="badge error" title="${esc(r.error || "")}">${icons.alert(13)} Error</span>`;
  const st = reviewState(r);
  const issues = rowIssues(r);
  const title = st === "review" ? issues.join("\n") : st === "reviewed" ? "Marked as reviewed" : "All checks passed";
  const icon = st === "review" ? icons.alert(13) : icons.check(13);
  return `<span class="badge ${st}" title="${esc(title)}">${icon} ${STATUS_LABELS[st]}</span>`;
}

function confidenceMeter(r: InvoiceRow): string {
  if (r.status !== "done") return "";
  if (r.source === "manual") return `<span class="muted small">Manual</span>`;
  const c = rowConfidence(r);
  const level = c >= 85 ? "high" : c >= 70 ? "mid" : "low";
  return `<span class="conf-pill ${level}" title="Average field confidence ${c}%">${c}%</span>`;
}

function cellClass(r: InvoiceRow, key: FieldKey): string {
  const cls: string[] = [];
  if (isLowConfidence(r, key)) cls.push("low");
  if (r.edited[key]) cls.push("edited");
  return cls.join(" ");
}

function cellTitle(r: InvoiceRow, key: FieldKey): string {
  if (r.edited[key]) return "Edited by you";
  if (r.source === "manual") return "";
  const c = fieldConfidence(r, key);
  if (!r.values[key]) return "Not found – please enter";
  return `OCR confidence ${c}%`;
}

function rowHtml(r: InvoiceRow, index: number): string {
  const actions = `
    <button class="icon-btn" data-act="view" title="Preview &amp; details">${icons.eye(16)}</button>
    ${r.status === "done" ? `<button class="icon-btn ${r.reviewed ? "on" : ""}" data-act="review" title="${r.reviewed ? "Unmark reviewed" : "Mark as reviewed"}">${icons.check(16)}</button>` : ""}
    <button class="icon-btn danger" data-act="delete" title="Remove row">${icons.trash(16)}</button>`;

  if (r.status === "processing" || r.status === "queued") {
    return `<tr data-id="${r.id}" class="busy">
      <td class="c-no">${index + 1}</td>
      <td class="c-status">${statusBadge(r)}</td>
      <td colspan="8"><div class="progress"><i style="width:${Math.max(3, r.progress * 100)}%"></i></div><span class="small muted">${esc(r.progressLabel || "Waiting…")}</span></td>
      <td class="c-file" title="${esc(r.fileName)}">${esc(r.fileName)}</td>
      <td class="c-act"></td>
    </tr>`;
  }

  const st = r.status === "error" ? "error" : reviewState(r);
  return `<tr data-id="${r.id}" class="row-${st}">
    <td class="c-no">${index + 1}</td>
    <td class="c-status">${statusBadge(r)}</td>
    ${INPUT_COLS.map(
      (c) => `<td class="${c.cls}"><input data-key="${c.key}" class="${cellClass(r, c.key)}" value="${esc(r.values[c.key])}" placeholder="${c.placeholder}" title="${esc(cellTitle(r, c.key))}" spellcheck="false" /></td>`,
    ).join("")}
    <td class="c-conf">${confidenceMeter(r)}</td>
    <td class="c-file" title="${esc(r.fileName)}">${esc(r.fileName)}</td>
    <td class="c-act">${actions}</td>
  </tr>`;
}

function renderTable() {
  const rows = visibleRows();
  const tbody = $("#tbody");
  tbody.innerHTML = rows.map((r) => rowHtml(r, state.rows.indexOf(r))).join("");

  const empty = $("#empty");
  if (!state.rows.length) {
    empty.innerHTML = `${icons.folder(34)}<b>No invoices yet</b><span>Upload PDF or image invoices to start your worksheet.</span>`;
    empty.style.display = "";
  } else if (!rows.length) {
    empty.innerHTML = `${icons.search(30)}<b>Nothing to show</b><span>No rows match this filter.</span>`;
    empty.style.display = "";
  } else empty.style.display = "none";

  renderFooter(rows);
}

function renderFooter(rows: InvoiceRow[]) {
  const done = rows.filter((r) => r.status === "done");
  $("#tfoot").innerHTML = done.length
    ? `<tr><td></td><td></td><td class="c-vendor"><b>Total (${done.length})</b></td><td></td><td></td>
        <td class="c-num">${fmtMoney(sumField(done, "amount"))}</td>
        <td class="c-num">${fmtMoney(sumField(done, "gst"))}</td>
        <td class="c-num"><b>${fmtMoney(sumField(done, "total"))}</b></td>
        <td colspan="4"></td></tr>`
    : "";
}

/** Re-render one row's derived parts without touching the input being typed in. */
function refreshRowMeta(r: InvoiceRow) {
  const tr = document.querySelector<HTMLTableRowElement>(`tr[data-id="${r.id}"]`);
  if (tr && r.status === "done") {
    tr.className = `row-${reviewState(r)}`;
    tr.querySelector(".c-status")!.innerHTML = statusBadge(r);
    tr.querySelector(".c-conf")!.innerHTML = confidenceMeter(r);
    tr.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((inp) => {
      const k = inp.dataset.key as FieldKey;
      inp.className = cellClass(r, k);
      inp.title = cellTitle(r, k);
    });
  }
  renderStats();
  renderTabs();
  renderFooter(visibleRows());
  if (state.drawerId === r.id) renderDrawer();
}

// ================================================================ editing

const rowFromEvent = (e: Event) => {
  const tr = (e.target as HTMLElement).closest("tr[data-id]") as HTMLElement | null;
  return tr ? state.rows.find((r) => r.id === tr.dataset.id) : undefined;
};

function onCellInput(e: Event) {
  const inp = e.target as HTMLInputElement;
  const key = inp.dataset.key as FieldKey | undefined;
  const r = rowFromEvent(e);
  if (!key || !r) return;
  r.values[key] = inp.value;
  r.edited[key] = true;
  r.reviewed = false;
  refreshRowMeta(r);
  persist();
}

function normaliseCell(key: FieldKey, value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (key === "amount" || key === "gst" || key === "total") {
    const n = parseMoney(v);
    return n === null ? v : formatMoney(n);
  }
  if (key === "date") return findDate(v) ?? v;
  return v;
}

function onCellCommit(e: Event) {
  const inp = e.target as HTMLInputElement;
  const key = inp.dataset.key as FieldKey | undefined;
  const r = rowFromEvent(e);
  if (!key || !r) return;
  const v = normaliseCell(key, inp.value);
  inp.value = v;
  r.values[key] = v;
  refreshRowMeta(r);
  persist();
}

function onCellKey(e: KeyboardEvent) {
  const inp = e.target as HTMLInputElement;
  if (!inp.dataset.key || (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
  const tr = inp.closest("tr")!;
  const sibling = (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? tr.previousElementSibling : tr.nextElementSibling) as HTMLElement | null;
  const target = sibling?.querySelector<HTMLInputElement>(`input[data-key="${inp.dataset.key}"]`);
  if (e.key === "Enter") e.preventDefault();
  if (target) {
    e.preventDefault();
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    target.focus();
    target.select();
  } else if (e.key === "Enter") inp.blur();
}

async function onRowAction(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  const r = rowFromEvent(e);
  if (!btn || !r) return;
  const act = btn.dataset.act;
  if (act === "view") openDrawer(r.id);
  else if (act === "review") toggleReviewed(r);
  else if (act === "delete") {
    if (r.status === "processing") return toast("This file is still being processed.", "info");
    state.rows = state.rows.filter((x) => x !== r);
    state.previews.delete(r.id);
    if (state.drawerId === r.id) closeDrawer();
    persist();
    renderAll();
  }
}

function toggleReviewed(r: InvoiceRow) {
  r.reviewed = !r.reviewed;
  persist();
  renderAll();
}

function addManualRow() {
  const r: InvoiceRow = {
    id: uid(),
    fileName: "(manual entry)",
    values: emptyValues(),
    confidence: zeroConfidence(),
    edited: {},
    ocrConfidence: 100,
    extractionIssues: [],
    reviewed: false,
    status: "done",
    progress: 1,
    progressLabel: "",
    source: "manual",
    pages: 0,
    rawText: "",
    addedAt: Date.now(),
  };
  state.rows.push(r);
  state.filter = "all";
  persist();
  renderAll();
  document.querySelector<HTMLInputElement>(`tr[data-id="${r.id}"] input[data-key="vendor"]`)?.focus();
}

// ================================================================ processing

function addFiles(files: File[]) {
  const ok = files.filter(isSupported);
  const rejected = files.filter((f) => !isSupported(f));
  if (rejected.length) {
    toast(`Skipped ${rejected.length} unsupported file${rejected.length > 1 ? "s" : ""}: ${rejected.map((f) => f.name).join(", ")}`, "error");
  }
  if (!ok.length) return;

  const queue = ok.map((file) => {
    const row: InvoiceRow = {
      id: uid(),
      fileName: file.name,
      values: emptyValues(),
      confidence: zeroConfidence(),
      edited: {},
      ocrConfidence: 0,
      extractionIssues: [],
      reviewed: false,
      status: "queued",
      progress: 0,
      progressLabel: "Waiting…",
      source: "ocr",
      pages: 0,
      rawText: "",
      addedAt: Date.now(),
    };
    state.rows.push(row);
    return { row, file };
  });
  state.filter = "all";
  renderAll();
  toast(`Processing ${ok.length} file${ok.length > 1 ? "s" : ""}…`, "info");
  void runQueue(queue);
}

let pending: { row: InvoiceRow; file: File }[] = [];

async function runQueue(items: { row: InvoiceRow; file: File }[]) {
  pending.push(...items);
  if (state.processing) return;
  state.processing = true;
  let processed = 0;
  let flagged = 0;

  while (pending.length) {
    const { row, file } = pending.shift()!;
    if (!state.rows.includes(row)) continue; // removed / signed out
    row.status = "processing";
    let lastPaint = 0;
    const paint = () => {
      const tr = document.querySelector(`tr[data-id="${row.id}"]`);
      if (!tr) return;
      tr.outerHTML = rowHtml(row, state.rows.indexOf(row));
    };
    paint();
    try {
      const result = await recognizeFile(file, (p, label) => {
        row.progress = p;
        row.progressLabel = label;
        const now = performance.now();
        if (now - lastPaint > 120) {
          lastPaint = now;
          paint();
        }
      });
      const ex = extractInvoice(result.text, result.confidence);
      row.values = Object.fromEntries(FIELD_KEYS.map((k) => [k, ex.fields[k].value])) as Record<FieldKey, string>;
      row.confidence = Object.fromEntries(FIELD_KEYS.map((k) => [k, ex.fields[k].confidence])) as Record<FieldKey, number>;
      row.extractionIssues = ex.issues;
      row.ocrConfidence = Math.round(result.confidence);
      row.source = result.source;
      row.pages = result.pages;
      row.rawText = result.text;
      row.status = "done";
      row.progress = 1;
      state.previews.set(row.id, result.preview);
      if (reviewState(row) === "review") flagged++;
    } catch (err) {
      console.error(err);
      row.status = "error";
      row.error = err instanceof Error ? err.message : String(err);
    }
    processed++;
    if (!state.session) break;
    persist();
    renderAll();
  }

  state.processing = false;
  if (state.session && processed) {
    toast(
      flagged
        ? `Done – ${processed} processed, ${flagged} need${flagged === 1 ? "s" : ""} review.`
        : `Done – ${processed} invoice${processed > 1 ? "s" : ""} extracted.`,
      flagged ? "warn" : "success",
    );
  }
}

// ================================================================ drawer

function openDrawer(id: string) {
  state.drawerId = id;
  renderDrawer();
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawer-backdrop").classList.add("show");
}

function closeDrawer() {
  state.drawerId = null;
  document.getElementById("drawer")?.classList.remove("open");
  document.getElementById("drawer")?.setAttribute("aria-hidden", "true");
  document.getElementById("drawer-backdrop")?.classList.remove("show");
}

function renderDrawer() {
  const r = state.rows.find((x) => x.id === state.drawerId);
  const drawer = $("#drawer");
  if (!r) return closeDrawer();
  const preview = state.previews.get(r.id);
  const issues = rowIssues(r);
  const sourceLabel = r.source === "pdf-text" ? "PDF text layer (exact)" : r.source === "manual" ? "Manual entry" : "OCR (Tesseract)";

  drawer.innerHTML = `
    <div class="drawer-head">
      <div><small class="muted">Invoice details</small><h3 title="${esc(r.fileName)}">${esc(r.fileName)}</h3></div>
      <button class="icon-btn" id="drawer-close" title="Close">${icons.x(18)}</button>
    </div>
    <div class="drawer-body">
      <div class="preview">${
        preview
          ? `<img src="${preview}" alt="Invoice preview" />`
          : `<div class="no-preview">${icons.eye(26)}<span>${r.source === "manual" ? "Manual row – no document" : "Preview not available after restart.<br/>Re-upload the file to see it."}</span></div>`
      }</div>
      <div class="meta">
        <div><span>Status</span>${statusBadge(r)}</div>
        <div><span>Source</span><b>${sourceLabel}</b></div>
        ${r.source === "manual" ? "" : `<div><span>OCR quality</span><b>${r.ocrConfidence}%</b></div><div><span>Pages</span><b>${r.pages}</b></div>`}
      </div>
      ${
        issues.length && !r.reviewed
          ? `<div class="issues">${icons.alert(16)}<div><b>Please check</b><ul>${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div></div>`
          : ""
      }
      ${
        r.status === "done"
          ? `<table class="conf-table"><thead><tr><th>Field</th><th>Value</th><th>Confidence</th></tr></thead><tbody>
          ${FIELD_KEYS.map((k) => {
            const c = fieldConfidence(r, k);
            const level = c >= 85 ? "high" : c >= 70 ? "mid" : "low";
            return `<tr><td>${COLUMN_LABELS[k]}</td><td>${esc(r.values[k]) || '<span class="muted">—</span>'}</td><td>${
              r.edited[k] ? '<span class="tag edited">Edited</span>' : `<div class="meter ${level}"><i style="width:${c}%"></i></div><span class="small">${c}%</span>`
            }</td></tr>`;
          }).join("")}</tbody></table>`
          : ""
      }
      ${r.rawText ? `<details class="raw"><summary>Extracted text</summary><pre>${esc(r.rawText)}</pre></details>` : ""}
    </div>
    ${
      r.status === "done"
        ? `<div class="drawer-foot"><button class="btn ${r.reviewed ? "btn-secondary" : "btn-primary"} btn-block" id="drawer-review">${icons.check(16)} ${r.reviewed ? "Unmark reviewed" : "Mark as reviewed"}</button></div>`
        : ""
    }`;
  $("#drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-review")?.addEventListener("click", () => toggleReviewed(r));
}

// ================================================================ export

async function doExport(kind: "xlsx" | "pdf") {
  const rows = state.rows.filter((r) => r.status === "done");
  if (!rows.length) return toast("Nothing to export yet – upload some invoices first.", "info");
  if (state.processing) toast("Some files are still processing; exporting finished rows only.", "info");
  const needs = rows.filter((r) => reviewState(r) === "review").length;
  if (needs && !(await confirmDialog(`${needs} row${needs > 1 ? "s" : ""} still need review. Export anyway?`, "Export"))) return;

  const user = state.session!.displayName;
  try {
    const bytes = kind === "xlsx" ? await buildExcel(rows, user) : await buildPdf(rows, user);
    const res = await saveBytes(bytes, exportFileName(kind), kind === "xlsx" ? { name: "Excel workbook", extensions: ["xlsx"] } : { name: "PDF document", extensions: ["pdf"] });
    if (!res) return;
    toast(`Saved ${res.path}`, "success", res.desktop ? { label: "Show in folder", run: () => revealFile(res.path) } : undefined);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// ================================================================ toasts & dialogs

function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info", action?: { label: string; run: () => void }) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ""}<button class="icon-btn" aria-label="Dismiss">${icons.x(14)}</button>`;
  if (action) el.querySelector(".link")!.addEventListener("click", action.run);
  el.querySelector(".icon-btn")!.addEventListener("click", () => el.remove());
  host.appendChild(el);
  setTimeout(() => el.classList.add("hide"), kind === "error" ? 9000 : 5000);
  setTimeout(() => el.remove(), kind === "error" ? 9400 : 5400);
}

function confirmDialog(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p>${esc(message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-v="0">Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-v="1">${esc(okLabel)}</button></div></div>`;
    const done = (v: boolean) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
      if (b) done(b.dataset.v === "1");
      else if (e.target === wrap) done(false);
    });
    document.body.appendChild(wrap);
    wrap.querySelector<HTMLButtonElement>('button[data-v="1"]')!.focus();
  });
}

// ================================================================ boot

if (isDesktop()) {
  // Disable the browser right-click menu (feels more like a native app), except in inputs.
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("input, textarea, pre")) e.preventDefault();
  });
}
renderLogin();
