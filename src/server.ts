import * as dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import multer from "multer";
import cron from "node-cron";
import axios from "axios";
import * as XLSX from "xlsx";
import { readEventInfoFromBuffer, readSheetListFromBuffer, debugReadSheetFromBuffer, SheetRow } from "./sheets/xlsx-reader";
import { makePreCredential, CredentialItemResult, checkCredential, CheckItemResult } from "./ligatech/accreditation";
import { findEventByMatch } from "./ligatech/events";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT) || 3333;

// ── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Bola de futebol clássica (Telstar) — SVG inline pra animar com CSS spin.
// Pentágono central preto + 5 raios conectando aos pentágonos das bordas,
// suficiente pra leitura visual mesmo em 32px. As classes ball-bg / ball-line
// permitem trocar cor via CSS.
const BALL_SVG = `
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle class="ball-bg" cx="32" cy="32" r="30"/>
  <circle cx="32" cy="32" r="30" fill="none" stroke="#0a0a0a" stroke-width="2"/>
  <polygon class="ball-line" points="32,18 43.4,26.3 39.1,39.7 24.9,39.7 20.6,26.3"/>
  <g stroke="#0a0a0a" stroke-width="2" fill="none" stroke-linecap="round">
    <line x1="32" y1="18" x2="32" y2="6"/>
    <line x1="43.4" y1="26.3" x2="55.5" y2="22.4"/>
    <line x1="39.1" y1="39.7" x2="46.5" y2="51.4"/>
    <line x1="24.9" y1="39.7" x2="17.5" y2="51.4"/>
    <line x1="20.6" y1="26.3" x2="8.5" y2="22.4"/>
  </g>
  <g class="ball-line">
    <polygon points="32,6 38,2 32,0 26,2"/>
    <polygon points="55.5,22.4 61,20 60.5,12 54,15"/>
    <polygon points="46.5,51.4 53,55 56,49 51,46"/>
    <polygon points="17.5,51.4 11,55 8,49 13,46"/>
    <polygon points="8.5,22.4 3,20 3.5,12 10,15"/>
  </g>
</svg>`.trim();

const PAGE_CSS = `
  :root {
    --bg: #0a0a0a;
    --surface: #141414;
    --surface-hi: #1c1c1c;
    --border: #262626;
    --text: #f5f5f5;
    --muted: #8a8a8a;
    --accent: #ff7a00;
    --accent-hover: #e56e00;
    --success: #2fd07c;
    --warning: #ffb020;
    --error: #ff3b3b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, sans-serif;
    min-height: 100vh;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 1080px; margin: 0 auto; padding: 48px 24px; }
  header { margin-bottom: 48px; text-align: center; }
  .brand {
    font-family: 'Barlow', sans-serif;
    font-weight: 900;
    font-size: clamp(2.5rem, 7vw, 4rem);
    letter-spacing: -0.03em;
    color: var(--text);
    line-height: 1;
  }
  .brand .accent { color: var(--accent); }
  .tagline {
    color: var(--muted);
    font-size: 0.85rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-top: 8px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px;
    margin-bottom: 24px;
  }
  .card-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-bottom: 20px;
  }
  .event-name {
    font-family: 'Barlow', sans-serif;
    font-size: 1.1rem;
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .event-match {
    font-family: 'Barlow', sans-serif;
    font-size: clamp(1.6rem, 4.5vw, 2.4rem);
    font-weight: 800;
    line-height: 1.1;
    margin-bottom: 24px;
  }
  .event-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 16px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .meta-item .meta-label {
    font-size: 0.7rem;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .meta-item .meta-value {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text);
  }
  label.field-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  input[type="number"] {
    width: 100%;
    background: var(--surface-hi);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 1.05rem;
    font-family: inherit;
    padding: 16px 18px;
    border-radius: 10px;
    transition: border-color .15s;
  }
  input[type="number"]:focus {
    outline: none;
    border-color: var(--accent);
  }
  .dropzone {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 36px 20px;
    min-height: 180px;
    background: var(--surface-hi);
    border: 2px dashed var(--border);
    border-radius: 14px;
    cursor: pointer;
    text-align: center;
    transition: border-color .15s, background .15s, transform .1s;
  }
  .dropzone:hover { border-color: var(--accent); background: #1f1f1f; }
  .dropzone.dragging {
    border-color: var(--accent);
    background: rgba(255, 122, 0, 0.06);
    transform: scale(1.01);
  }
  .dropzone.has-file { border-style: solid; border-color: var(--accent); }
  .dropzone.loading { pointer-events: none; opacity: 0.85; }
  .dz-spinner { width: 72px; height: 72px; margin-bottom: 10px; }
  .ball-spinner {
    display: inline-block;
    animation: spin 1.1s linear infinite;
    transform-origin: 50% 50%;
    filter: drop-shadow(0 0 18px rgba(255, 122, 0, 0.6)) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));
  }
  .ball-spinner svg { display: block; width: 100%; height: 100%; }
  .ball-spinner .ball-bg { fill: #ffffff; }
  .ball-spinner .ball-line { fill: #0a0a0a; }
  /* Loading state vira overlay absoluto pra cobrir TODA a dropzone — assim nunca colapsa */
  .dz-loading-state {
    position: absolute;
    inset: 0;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: rgba(20, 20, 20, 0.96);
    border-radius: 12px;
    z-index: 2;
  }
  .dropzone.loading .dz-loading-state { display: flex; }
  .dz-loading-state .dz-loading-text {
    font-family: 'Barlow', sans-serif;
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .dz-loading-sub {
    font-size: 0.78rem;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-top: 2px;
  }
  .dz-loading-file {
    margin-top: 10px;
    padding: 6px 14px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: rgba(255, 122, 0, 0.08);
    color: var(--accent);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    max-width: 80%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dz-loading-text {
    font-family: 'Barlow', sans-serif;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.05em;
  }
  .dz-icon {
    width: 44px; height: 44px;
    color: var(--accent);
    margin-bottom: 4px;
  }
  .dz-title {
    font-family: 'Barlow', sans-serif;
    font-weight: 700;
    font-size: 1rem;
    color: var(--text);
    letter-spacing: 0.02em;
  }
  .dz-sub {
    font-size: 0.78rem;
    color: var(--muted);
    letter-spacing: 0.05em;
  }
  .dz-file {
    margin-top: 10px;
    padding: 8px 14px;
    background: rgba(255, 122, 0, 0.1);
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--accent);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    word-break: break-all;
    max-width: 100%;
  }
  button.primary, button.secondary {
    width: 100%;
    border: 0;
    font-family: 'Barlow', sans-serif;
    font-weight: 700;
    font-size: 1.1rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 18px 24px;
    border-radius: 10px;
    cursor: pointer;
    margin-top: 20px;
    transition: background .15s, transform .1s, border-color .15s;
  }
  button.primary { background: var(--accent); color: #000; }
  button.primary:hover { background: var(--accent-hover); }
  button.primary:active { transform: scale(0.98); }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    font-size: 0.95rem;
    padding: 14px 20px;
    margin-top: 0;
  }
  button.secondary:hover { background: rgba(255, 122, 0, 0.08); }
  .error-box {
    background: rgba(255, 59, 59, 0.1);
    border: 1px solid var(--error);
    color: var(--error);
    padding: 14px 18px;
    border-radius: 10px;
    margin-top: 16px;
    font-size: 0.9rem;
  }
  .loading {
    display: none;
    text-align: center;
    padding: 48px 24px;
  }
  .loading.active { display: block; }
  .spinner { width: 72px; height: 72px; margin: 0 auto 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text {
    font-family: 'Barlow', sans-serif;
    font-size: 1.2rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .loading-sub { color: var(--muted); margin-top: 6px; font-size: 0.9rem; }
  .progress-wrap {
    max-width: 560px;
    margin: 28px auto 0;
  }
  .progress-bar {
    width: 100%;
    height: 10px;
    background: var(--surface-hi);
    border: 1px solid var(--border);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--accent);
    width: 0%;
    transition: width .2s ease;
  }
  .progress-meta {
    display: flex;
    justify-content: space-between;
    margin-top: 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .progress-meta .pct { color: var(--accent); font-weight: 600; }
  .progress-current {
    margin-top: 14px;
    color: var(--text);
    font-size: 0.9rem;
    min-height: 1.4em;
  }
  .progress-current .cpf { font-family: 'JetBrains Mono', monospace; color: var(--muted); margin-left: 6px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 14px;
    margin-bottom: 24px;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    text-align: center;
  }
  .stat-value {
    font-family: 'Barlow', sans-serif;
    font-size: 2.2rem;
    font-weight: 800;
    line-height: 1;
  }
  .stat-label {
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-top: 8px;
  }
  .stat.total .stat-value { color: var(--text); }
  .stat.success .stat-value { color: var(--success); }
  .stat.warn .stat-value { color: var(--warning); }
  .stat.err .stat-value { color: var(--error); }
  .stat.success { border-color: rgba(47, 208, 124, 0.3); }
  .stat.warn { border-color: rgba(255, 176, 32, 0.3); }
  .stat.err { border-color: rgba(255, 59, 59, 0.3); }
  .actions-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 24px;
    align-items: center;
  }
  .actions-row .back-btn { margin-bottom: 0; flex: 1; min-width: 160px; }
  .actions-row button.secondary { width: auto; margin-top: 0; flex: 0 0 auto; }
  .table-wrap {
    overflow-x: auto;
    border-radius: 10px;
    border: 1px solid var(--border);
  }
  table.results {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    min-width: 720px;
  }
  table.results thead th {
    background: var(--surface-hi);
    color: var(--muted);
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    text-align: left;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  table.results tbody td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  table.results tbody tr:last-child td { border-bottom: 0; }
  table.results tbody tr:hover { background: rgba(255, 255, 255, 0.02); }
  td.col-cpf { font-family: 'JetBrains Mono', monospace; color: var(--muted); white-space: nowrap; }
  td.col-msg { color: var(--muted); font-size: 0.85rem; max-width: 320px; word-break: break-word; }
  .actions-stack { display: flex; flex-direction: column; gap: 10px; }
  .actions-stack button { width: 100%; }
  td.col-name { font-weight: 500; }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .status-pill.success { background: rgba(47, 208, 124, 0.12); color: var(--success); border: 1px solid rgba(47, 208, 124, 0.3); }
  .status-pill.warn    { background: rgba(255, 176, 32, 0.12); color: var(--warning); border: 1px solid rgba(255, 176, 32, 0.35); }
  .status-pill.err     { background: rgba(255, 59, 59, 0.12); color: var(--error); border: 1px solid rgba(255, 59, 59, 0.35); }
  .status-pill .dot { font-size: 0.9rem; line-height: 1; }
  .back-btn {
    display: inline-block;
    color: var(--muted);
    text-decoration: none;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 24px;
    cursor: pointer;
  }
  .back-btn:hover { color: var(--accent); }
  @media (max-width: 560px) {
    .container { padding: 32px 16px; }
    .card { padding: 24px 20px; }
    table.results { font-size: 0.85rem; }
    table.results thead th, table.results tbody td { padding: 10px 12px; }
  }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@600;700;800;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand">CONTRA<span class="accent">ATAQUE</span></div>
    <div class="tagline">Credenciamento · Ligatech</div>
  </header>
  ${body}
</div>
</body>
</html>`;
}

app.get("/ping", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/", async (_req: Request, res: Response) => {
  const body = `
    <div class="card">
      <div class="card-title">Planilha do jogo</div>
      <label class="dropzone" id="dropzone" for="sheetFile">
        <div class="dz-default">
          <svg class="dz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
          </svg>
          <div class="dz-title">Arraste a planilha do jogo aqui ou clique para selecionar</div>
          <div class="dz-sub">Arquivo .xlsx · até 10 MB</div>
          <div class="dz-file" id="dzFile" style="display:none"></div>
        </div>
        <div class="dz-loading-state" id="dzLoadingState">
          <div class="dz-spinner ball-spinner">${BALL_SVG}</div>
          <div class="dz-loading-text">Buscando jogo na Ligatech…</div>
          <div class="dz-loading-sub">Lendo planilha e identificando o evento</div>
          <div class="dz-loading-file" id="dzLoadingFile" style="display:none"></div>
        </div>
        <input type="file" id="sheetFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      </label>
      <button class="primary" id="loadBtn" onclick="loadEvent()" style="margin-top:16px;display:none">Carregar jogo</button>
      <div id="sheetError" class="error-box" style="display:none"></div>
    </div>

    <div id="eventCardWrap"></div>

    <div id="setup" style="display:none">
      <div class="card">
        <div class="card-title">Credenciar</div>
        <div id="eventIdField">
          <label class="field-label" for="eventId">ID do evento na Ligatech</label>
          <input type="number" id="eventId" placeholder="Ex: 12345" autocomplete="off">
        </div>
        <div id="autoEventNotice" style="display:none;color:var(--accent);font-size:0.85rem;margin-bottom:14px;letter-spacing:0.05em">✓ Evento identificado automaticamente</div>
        <div class="actions-stack">
          <button class="primary" id="startBtn" onclick="startAccredit()">Solicitar credenciamento</button>
          <button class="secondary" id="verifyBtn" onclick="startVerify()">Verificar status (sem solicitar)</button>
        </div>
        <div id="error" class="error-box" style="display:none"></div>
      </div>
    </div>

    <div id="loading" class="loading">
      <div class="spinner ball-spinner">${BALL_SVG}</div>
      <div class="loading-text" id="loadingText">Credenciando…</div>
      <div class="loading-sub" id="loadingSub">Isso pode levar alguns minutos.</div>
      <div class="progress-wrap" id="progressWrap" style="display:none">
        <div class="progress-bar"><div class="progress-bar-fill" id="progressFill"></div></div>
        <div class="progress-meta">
          <span id="progressCount">0 de 0</span>
          <span class="pct" id="progressPct">0%</span>
        </div>
        <div class="progress-current" id="progressCurrent"></div>
      </div>
    </div>

    <div id="results" style="display:none"></div>

    <script>
      const sheetFileInput = document.getElementById('sheetFile');
      const sheetError = document.getElementById('sheetError');
      const eventCardWrap = document.getElementById('eventCardWrap');
      const setup = document.getElementById('setup');
      const loading = document.getElementById('loading');
      const results = document.getElementById('results');
      const errorBox = document.getElementById('error');
      const btn = document.getElementById('startBtn');
      const input = document.getElementById('eventId');
      const dropzone = document.getElementById('dropzone');
      const dzFile = document.getElementById('dzFile');
      const dzDefault = document.querySelector('.dz-default');
      const dzLoadingState = document.getElementById('dzLoadingState');
      const eventIdField = document.getElementById('eventIdField');
      const autoEventNotice = document.getElementById('autoEventNotice');
      const progressWrap = document.getElementById('progressWrap');
      const progressFill = document.getElementById('progressFill');
      const progressCount = document.getElementById('progressCount');
      const progressPct = document.getElementById('progressPct');
      const progressCurrent = document.getElementById('progressCurrent');

      let resolvedEventId = null;
      let lastResults = null;
      let lastEventName = '';

      function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      }

      function currentFile() {
        return sheetFileInput.files && sheetFileInput.files[0];
      }

      function setSelectedFile(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        sheetFileInput.files = dt.files;
        dzFile.textContent = file.name;
        dzFile.style.display = 'inline-block';
        dropzone.classList.add('has-file');
        loadEvent();
      }

      ['dragenter','dragover'].forEach(ev =>
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.add('dragging');
        })
      );
      ['dragleave','drop'].forEach(ev =>
        dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.remove('dragging');
        })
      );
      dropzone.addEventListener('drop', e => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) setSelectedFile(f);
      });
      sheetFileInput.addEventListener('change', () => {
        const f = currentFile();
        if (f) setSelectedFile(f);
      });

      function setDropzoneLoading(on) {
        const dzLoadingFile = document.getElementById('dzLoadingFile');
        if (on) {
          dropzone.classList.add('loading');
          const f = currentFile();
          if (f && dzLoadingFile) {
            dzLoadingFile.textContent = f.name;
            dzLoadingFile.style.display = 'inline-block';
          }
        } else {
          dropzone.classList.remove('loading');
          if (dzLoadingFile) dzLoadingFile.style.display = 'none';
        }
      }

      async function loadEvent() {
        sheetError.style.display = 'none';
        eventCardWrap.innerHTML = '';
        setup.style.display = 'none';
        resolvedEventId = null;

        const file = currentFile();
        if (!file) {
          sheetError.textContent = 'Selecione o arquivo .xlsx da planilha.';
          sheetError.style.display = 'block';
          return;
        }

        setDropzoneLoading(true);
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/find-event', { method: 'POST', body: fd });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || 'Falha ao carregar planilha');

          renderEventCard(data.info);
          lastEventName = (data.info && (data.info.match || data.info.name)) || '';

          if (data.event && data.event.id) {
            resolvedEventId = data.event.id;
            eventIdField.style.display = 'none';
            autoEventNotice.style.display = 'block';
            autoEventNotice.textContent = '✓ Evento #' + data.event.id + ' identificado automaticamente';
          } else {
            eventIdField.style.display = 'block';
            autoEventNotice.style.display = 'none';
            const card = document.createElement('div');
            card.className = 'error-box';
            card.style.display = 'block';
            card.style.marginTop = '12px';
            card.textContent = 'Evento não encontrado automaticamente na Ligatech. Informe o ID manualmente abaixo.';
            eventCardWrap.appendChild(card);
          }
          setup.style.display = 'block';
        } catch (e) {
          sheetError.textContent = e.message || 'Falha ao carregar planilha';
          sheetError.style.display = 'block';
        } finally {
          setDropzoneLoading(false);
        }
      }

      function renderEventCard(info) {
        const has = info.name || info.match || info.date;
        if (!has) {
          eventCardWrap.innerHTML = '<div class="card"><div class="card-title">Jogo</div><p style="color:var(--muted)">Nenhum jogo encontrado no topo da planilha (linhas "Transmissão:", "Data da Transmissão:", "Local:").</p></div>';
          return;
        }
        const meta = [
          info.date ? '<div class="meta-item"><div class="meta-label">Data</div><div class="meta-value">' + esc(info.date) + '</div></div>' : '',
          info.time ? '<div class="meta-item"><div class="meta-label">Horário</div><div class="meta-value">' + esc(info.time) + '</div></div>' : '',
          info.venue ? '<div class="meta-item"><div class="meta-label">Local</div><div class="meta-value">' + esc(info.venue) + '</div></div>' : '',
        ].join('');
        eventCardWrap.innerHTML =
          '<div class="card">' +
            '<div class="card-title">Próximo jogo</div>' +
            (info.name ? '<div class="event-name">' + esc(info.name) + '</div>' : '') +
            (info.match ? '<div class="event-match">' + esc(info.match) + '</div>' : '') +
            '<div class="event-meta">' + meta + '</div>' +
          '</div>';
      }

      function resetProgress() {
        progressWrap.style.display = 'none';
        progressFill.style.width = '0%';
        progressCount.textContent = '0 de 0';
        progressPct.textContent = '0%';
        progressCurrent.textContent = '';
      }

      function updateProgress(done, total, item) {
        progressWrap.style.display = 'block';
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        progressFill.style.width = pct + '%';
        progressCount.textContent = done + ' de ' + total;
        progressPct.textContent = pct + '%';
        if (item) {
          progressCurrent.innerHTML = 'Credenciando ' + esc(item.name || '') +
            (item.cpf ? '<span class="cpf">' + esc(item.cpf) + '</span>' : '');
        }
      }

      async function runStream(url, loadingTitle) {
        const eventId = resolvedEventId || Number(input.value);
        errorBox.style.display = 'none';
        if (!eventId) {
          errorBox.textContent = 'Informe o ID do evento na Ligatech.';
          errorBox.style.display = 'block';
          return;
        }
        setup.style.display = 'none';
        eventCardWrap.style.display = 'none';
        loading.classList.add('active');
        const loadingTextEl = document.getElementById('loadingText');
        if (loadingTextEl) loadingTextEl.textContent = loadingTitle;
        resetProgress();

        try {
          const file = currentFile();
          if (!file) throw new Error('Selecione o arquivo .xlsx da planilha.');
          const fd = new FormData();
          fd.append('file', file);
          fd.append('eventId', String(eventId));

          const r = await fetch(url, { method: 'POST', body: fd });
          if (!r.ok || !r.body) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.error || 'Erro na execução');
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finalLog = null;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\\n')) !== -1) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line) continue;
              let evt;
              try { evt = JSON.parse(line); } catch { continue; }
              if (evt.type === 'start') {
                updateProgress(0, evt.total, null);
              } else if (evt.type === 'progress') {
                updateProgress(evt.index, evt.total, evt.item);
              } else if (evt.type === 'done') {
                finalLog = evt.log;
              } else if (evt.type === 'error') {
                throw new Error(evt.message || 'Erro');
              }
            }
          }
          if (!finalLog) throw new Error('Resposta incompleta do servidor');
          renderResults(finalLog);
        } catch (e) {
          loading.classList.remove('active');
          eventCardWrap.style.display = '';
          setup.style.display = 'block';
          errorBox.textContent = e.message || 'Falha';
          errorBox.style.display = 'block';
        }
      }

      function startVerify() {
        return runStream('/api/verify/stream', 'Verificando…');
      }

      async function startAccredit() {
        const eventId = resolvedEventId || Number(input.value);
        errorBox.style.display = 'none';
        if (!eventId) {
          errorBox.textContent = 'Informe o ID do evento na Ligatech.';
          errorBox.style.display = 'block';
          return;
        }
        setup.style.display = 'none';
        eventCardWrap.style.display = 'none';
        loading.classList.add('active');
        resetProgress();

        try {
          const file = currentFile();
          if (!file) throw new Error('Selecione o arquivo .xlsx da planilha.');
          const fd = new FormData();
          fd.append('file', file);
          fd.append('eventId', String(eventId));

          const r = await fetch('/api/accredit/stream', { method: 'POST', body: fd });
          if (!r.ok || !r.body) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.error || 'Erro no credenciamento');
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finalLog = null;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\\n')) !== -1) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line) continue;
              let evt;
              try { evt = JSON.parse(line); } catch { continue; }
              if (evt.type === 'start') {
                updateProgress(0, evt.total, null);
              } else if (evt.type === 'progress') {
                updateProgress(evt.index, evt.total, evt.item);
              } else if (evt.type === 'done') {
                finalLog = evt.log;
              } else if (evt.type === 'error') {
                throw new Error(evt.message || 'Erro no credenciamento');
              }
            }
          }
          if (!finalLog) throw new Error('Resposta incompleta do servidor');
          renderResults(finalLog);
        } catch (e) {
          loading.classList.remove('active');
          eventCardWrap.style.display = '';
          setup.style.display = 'block';
          errorBox.textContent = e.message || 'Falha ao credenciar';
          errorBox.style.display = 'block';
        }
      }

      function statusMeta(s) {
        if (s === 'success') return { cls: 'success', label: 'Credenciado', icon: '✅' };
        if (s === 'credenciado') return { cls: 'success', label: 'Credenciado', icon: '✅' };
        if (s === 'pre_credenciado') return { cls: 'success', label: 'Solicitado', icon: '⏳' };
        if (s === 'nao_solicitado') return { cls: 'warn', label: 'Sem solicitação', icon: '⚠️' };
        if (s === 'pessoa_nao_encontrada') return { cls: 'warn', label: 'Não cadastrada na zona', icon: '⚠️' };
        if (s === 'cpf_nao_cadastrado') return { cls: 'warn', label: 'Não cadastrado', icon: '⚠️' };
        if (s === 'cpf_invalido') return { cls: 'err', label: 'CPF inválido', icon: '❌' };
        return { cls: 'err', label: 'Erro', icon: '❌' };
      }

      function renderResults(log) {
        loading.classList.remove('active');
        lastResults = log.results || [];

        const rows = lastResults.map(r => {
          const m = statusMeta(r.status);
          return '<tr>' +
            '<td class="col-name">' + esc(r.name || '—') + '</td>' +
            '<td class="col-cpf">' + esc(r.cpf || '') + '</td>' +
            '<td>' + esc(r.zoneSlug || '—') + '</td>' +
            '<td>' + esc(r.supplier || '—') + '</td>' +
            '<td><span class="status-pill ' + m.cls + '"><span class="dot">' + m.icon + '</span>' + m.label + '</span></td>' +
            '<td class="col-msg">' + esc(r.message || '—') + '</td>' +
          '</tr>';
        }).join('');

        // Modo verify tem stats próprias; modo solicitar mantém as antigas
        const isVerify = typeof log.pre_credenciado !== 'undefined';
        const stats = isVerify
          ? '<div class="stat total"><div class="stat-value">' + log.total + '</div><div class="stat-label">Total</div></div>' +
            '<div class="stat success"><div class="stat-value">' + ((log.credenciado||0) + (log.pre_credenciado||0)) + '</div><div class="stat-label">Solicitados/Credenciados</div></div>' +
            '<div class="stat warn"><div class="stat-value">' + (log.nao_solicitado||0) + '</div><div class="stat-label">Sem solicitação</div></div>' +
            '<div class="stat warn"><div class="stat-value">' + (log.pessoa_nao_encontrada||0) + '</div><div class="stat-label">Não cadastradas</div></div>' +
            '<div class="stat err"><div class="stat-value">' + (log.erro||0) + '</div><div class="stat-label">Erros</div></div>'
          : '<div class="stat total"><div class="stat-value">' + log.total + '</div><div class="stat-label">Total</div></div>' +
            '<div class="stat success"><div class="stat-value">' + log.success + '</div><div class="stat-label">Credenciados</div></div>' +
            '<div class="stat warn"><div class="stat-value">' + log.not_found + '</div><div class="stat-label">Não cadastrados</div></div>' +
            '<div class="stat err"><div class="stat-value">' + log.failed + '</div><div class="stat-label">Erros</div></div>';

        const backLabel = isVerify ? '← Nova verificação' : '← Novo credenciamento';

        results.innerHTML =
          '<div class="actions-row">' +
            '<a class="back-btn" onclick="location.reload()">' + backLabel + '</a>' +
            '<button class="secondary" onclick="exportXlsx()">Exportar resultado (.xlsx)</button>' +
          '</div>' +
          '<div class="stats">' + stats + '</div>' +
          '<div class="card">' +
            '<div class="card-title">Detalhes</div>' +
            '<div class="table-wrap"><table class="results">' +
              '<thead><tr><th>Nome</th><th>CPF</th><th>Zona</th><th>Fornecedor</th><th>Status</th><th>Mensagem</th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table></div>' +
          '</div>';
        results.style.display = 'block';
      }

      async function exportXlsx() {
        if (!lastResults || !lastResults.length) return;
        try {
          const r = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ results: lastResults, eventName: lastEventName }),
          });
          if (!r.ok) throw new Error('Falha ao exportar');
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().slice(0, 10);
          const safe = (lastEventName || 'credenciamento').replace(/[^a-z0-9\\-]+/gi, '-').toLowerCase();
          a.href = url;
          a.download = 'resultado-' + safe + '-' + stamp + '.xlsx';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          alert(e.message || 'Falha ao exportar');
        }
      }

      input.addEventListener('keydown', e => { if (e.key === 'Enter') startAccredit(); });
    </script>`;

  res.send(page("Contra Ataque · Credenciamento", body));
});

app.post("/api/event-info", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo .xlsx obrigatório" });
  try {
    const info = readEventInfoFromBuffer(req.file.buffer);
    res.json(info);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Erro ao ler planilha" });
  }
});

app.post("/api/preview-sheet", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo .xlsx obrigatório" });
  try {
    const info = debugReadSheetFromBuffer(req.file.buffer);
    res.json(info);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Erro ao ler planilha" });
  }
});

app.post("/api/find-event", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo .xlsx obrigatório" });
  try {
    const info = readEventInfoFromBuffer(req.file.buffer);
    if (!info.match || !info.date) {
      return res.json({ event: null, info, reason: "match_or_date_missing" });
    }
    const event = await findEventByMatch({ match: info.match, date: info.date });
    res.json({ event, info });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Erro ao buscar evento" });
  }
});

// ── Credenciamento com progresso em streaming (NDJSON) ───────────────────────

interface EnrichedResult extends CredentialItemResult {
  name?: string;
  supplier?: string;
}

app.post("/api/accredit/stream", upload.single("file"), async (req: Request, res: Response) => {
  const eventId = Number(req.body.eventId);
  if (!eventId) return res.status(400).json({ error: "eventId obrigatório" });
  if (!req.file) return res.status(400).json({ error: "Arquivo .xlsx obrigatório" });

  let rows: SheetRow[];
  try {
    rows = readSheetListFromBuffer(req.file.buffer);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? "Erro ao ler planilha" });
  }

  const toProcess = rows.filter((r) => r.zoneSlug && r.cpfValid);
  const skipped = rows.length - toProcess.length;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const emit = (obj: unknown) => {
    res.write(JSON.stringify(obj) + "\n");
  };

  emit({ type: "start", total: toProcess.length, skipped });

  const results: EnrichedResult[] = [];
  // Dedup: mesmo CPF+zona repetido na planilha (ex: pessoa com 2 fornecedores)
  // não dispara 2 chamadas — a 2ª reaproveita resultado da 1ª.
  const dedupCache = new Map<string, CredentialItemResult>();

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const row = toProcess[i];
      emit({
        type: "progress",
        index: i,
        total: toProcess.length,
        item: { name: row.name, cpf: row.cpf, zoneSlug: row.zoneSlug },
      });

      const dedupKey = `${row.cpf.replace(/\D/g, "")}|${row.zoneSlug.toLowerCase()}`;
      let result: CredentialItemResult;
      const cached = dedupCache.get(dedupKey);
      if (cached) {
        result = {
          ...cached,
          message: cached.message
            ? `${cached.message} (duplicado na planilha)`
            : "Duplicado na planilha — usado resultado da 1ª linha",
        };
      } else {
        result = await makePreCredential(eventId, {
          cpf: row.cpf,
          zoneSlug: row.zoneSlug,
        });
        dedupCache.set(dedupKey, result);
      }
      const enriched: EnrichedResult = {
        ...result,
        name: row.name,
        supplier: row.supplier,
      };
      results.push(enriched);

      emit({
        type: "progress",
        index: i + 1,
        total: toProcess.length,
        item: { name: row.name, cpf: row.cpf, zoneSlug: row.zoneSlug, status: enriched.status },
      });

      if (i < toProcess.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const log = {
      timestamp: new Date().toISOString(),
      eventId,
      total: results.length,
      success: results.filter((r) => r.status === "success").length,
      not_found: results.filter((r) => r.status === "cpf_nao_cadastrado").length,
      failed: results.filter((r) => r.status === "erro_api" || r.status === "cpf_invalido").length,
      results,
    };
    emit({ type: "done", log });
  } catch (e: any) {
    emit({ type: "error", message: e?.message ?? "Erro desconhecido" });
  } finally {
    res.end();
  }
});

// ── Verificação de status (não solicita, só consulta) ───────────────────────

interface EnrichedCheck extends CheckItemResult {
  name?: string;
  supplier?: string;
}

app.post("/api/verify/stream", upload.single("file"), async (req: Request, res: Response) => {
  const eventId = Number(req.body.eventId);
  if (!eventId) return res.status(400).json({ error: "eventId obrigatório" });
  if (!req.file) return res.status(400).json({ error: "Arquivo .xlsx obrigatório" });

  let rows: SheetRow[];
  try {
    rows = readSheetListFromBuffer(req.file.buffer);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? "Erro ao ler planilha" });
  }

  const toProcess = rows.filter((r) => r.zoneSlug && r.cpfValid);
  const skipped = rows.length - toProcess.length;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const emit = (obj: unknown) => {
    res.write(JSON.stringify(obj) + "\n");
  };

  emit({ type: "start", total: toProcess.length, skipped });

  const results: EnrichedCheck[] = [];
  const dedupCache = new Map<string, CheckItemResult>();

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const row = toProcess[i];
      emit({
        type: "progress",
        index: i,
        total: toProcess.length,
        item: { name: row.name, cpf: row.cpf, zoneSlug: row.zoneSlug },
      });

      const dedupKey = `${row.cpf.replace(/\D/g, "")}|${row.zoneSlug.toLowerCase()}`;
      let result: CheckItemResult;
      const cached = dedupCache.get(dedupKey);
      if (cached) {
        result = { ...cached };
      } else {
        result = await checkCredential(eventId, { cpf: row.cpf, zoneSlug: row.zoneSlug });
        dedupCache.set(dedupKey, result);
      }

      const enriched: EnrichedCheck = { ...result, name: row.name, supplier: row.supplier };
      results.push(enriched);

      emit({
        type: "progress",
        index: i + 1,
        total: toProcess.length,
        item: { name: row.name, cpf: row.cpf, zoneSlug: row.zoneSlug, status: enriched.status },
      });

      if (i < toProcess.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const log = {
      timestamp: new Date().toISOString(),
      eventId,
      total: results.length,
      credenciado: results.filter((r) => r.status === "credenciado").length,
      pre_credenciado: results.filter((r) => r.status === "pre_credenciado").length,
      nao_solicitado: results.filter((r) => r.status === "nao_solicitado").length,
      pessoa_nao_encontrada: results.filter((r) => r.status === "pessoa_nao_encontrada").length,
      erro: results.filter((r) => r.status === "erro_api" || r.status === "cpf_invalido").length,
      results,
    };
    emit({ type: "done", log });
  } catch (e: any) {
    emit({ type: "error", message: e?.message ?? "Erro desconhecido" });
  } finally {
    res.end();
  }
});

// ── Export .xlsx ─────────────────────────────────────────────────────────────

function statusLabel(s: string): string {
  if (s === "success") return "Credenciado";
  if (s === "cpf_nao_cadastrado") return "Não cadastrado na Ligatech";
  if (s === "cpf_invalido") return "CPF inválido";
  if (s === "erro_api") return "Erro na API";
  return s;
}

app.post("/api/export", (req: Request, res: Response) => {
  const results: EnrichedResult[] = Array.isArray(req.body?.results) ? req.body.results : [];
  const eventName: string = String(req.body?.eventName ?? "Credenciamento");
  if (!results.length) return res.status(400).json({ error: "Sem resultados para exportar" });

  const rows = results.map((r) => ({
    Nome: r.name ?? "",
    CPF: r.cpf ?? "",
    Zona: r.zoneSlug ?? "",
    Fornecedor: r.supplier ?? "",
    Status: statusLabel(r.status),
    Mensagem: r.message ?? "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["Nome", "CPF", "Zona", "Fornecedor", "Status", "Mensagem"],
  });
  ws["!cols"] = [
    { wch: 34 }, // Nome
    { wch: 16 }, // CPF
    { wch: 16 }, // Zona
    { wch: 22 }, // Fornecedor
    { wch: 30 }, // Status
    { wch: 60 }, // Mensagem
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Credenciamento");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const safe = eventName.replace(/[^a-z0-9\-]+/gi, "-").toLowerCase() || "credenciamento";
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="resultado-${safe}-${stamp}.xlsx"`);
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
});

// Keep-alive: evita o Render free dormir após 15min de inatividade.
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  cron.schedule("*/10 * * * *", async () => {
    try {
      await axios.get(`${SELF_URL.replace(/\/$/, "")}/ping`, { timeout: 10000 });
    } catch (e: any) {
      console.warn(`[keep-alive] ping falhou: ${e?.message ?? e}`);
    }
  });
  console.log(`[keep-alive] ativo em ${SELF_URL}/ping (a cada 10 min)`);
} else {
  console.log("[keep-alive] desativado (defina SELF_URL ou RENDER_EXTERNAL_URL)");
}
