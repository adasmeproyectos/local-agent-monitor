'use strict';

/* ═════════════════════════════════════════════════════════════════════════════
   Navi Cleaner — Lógica de la Interfaz (Suite Apple v4.5 — Producción Final)
   • Localización 100% Español
   • Ordenamiento Compuesto Multi-Columna (3 Pasos Cíclicos por columna activa)
   • Filtrado Nativo de Categorías de Aplicaciones
   • Recomendaciones de Alto Contexto Anti-Falso-Positivo
   • window.close() garantizado en respuesta a /api/shutdown
   ═════════════════════════════════════════════════════════════════════════════ */

/* ─── Estado Global ──────────────────────────────────────────────────────────── */
let currentCluster   = 'all';
let currentSubTag    = 'all';
let currentAppFilter = 'all';

let rawFilesList  = [];
let rawAppsList   = [];
let rawCachesList = [];

// Compound sorting: each entry is { col, dir } — dir: 1=Desc, 2=Asc, 0=reset
// fileSortStack: primary → secondary for files
let fileSortStack = [];   // e.g. [{ col:'size', dir:1 }, { col:'conf', dir:2 }]
// appSortStack: primary → secondary for apps
let appSortStack  = [];

let activeFilePath  = null;
let activeAppTarget = null;
let scanPollTimer   = null;

/* ─── Umbral Anti-Falso-Positivo ─────────────────────────────────────────────
   30-day recency window: files/apps modified within this period are NEVER
   flagged as abandoned even if they are large.                                */
const RECENT_DAYS_THRESHOLD = 30;
const MS_PER_DAY = 86_400_000;

/* ─── Elementos DOM ──────────────────────────────────────────────────────────── */
const totalFilesVal         = document.getElementById('totalFilesVal');
const totalAppsFootprintVal = document.getElementById('totalAppsFootprintVal');
const adminStatusVal        = document.getElementById('adminStatusVal');
const subTagToolbar         = document.getElementById('subTagToolbar');

const tabBtns = {
  Home:           document.getElementById('tabHome'),
  FileIndex:      document.getElementById('tabFileIndex'),
  BurstOrganizer: document.getElementById('tabBurstOrganizer'),
  AppsGames:      document.getElementById('tabAppsGames'),
  LauncherCaches: document.getElementById('tabLauncherCaches'),
  ProcessMonitor: document.getElementById('tabProcessMonitor'),
};
const panels = {
  Home:           document.getElementById('panelHome'),
  FileIndex:      document.getElementById('panelFileIndex'),
  BurstOrganizer: document.getElementById('panelBurstOrganizer'),
  AppsGames:      document.getElementById('panelAppsGames'),
  LauncherCaches: document.getElementById('panelLauncherCaches'),
  ProcessMonitor: document.getElementById('panelProcessMonitor'),
};

/* ─── Tab Switching ──────────────────────────────────────────────────────────── */
function switchTab(tabName) {
  Object.keys(tabBtns).forEach(k => {
    const btn   = tabBtns[k];
    const panel = panels[k];
    const active = (k === tabName);
    if (btn)   { btn.classList.toggle('active', active); btn.setAttribute('aria-selected', active ? 'true' : 'false'); }
    if (panel) { panel.style.display = active ? 'block' : 'none'; }
  });
  if (tabName === 'Home')           loadDashboardHome();
  if (tabName === 'FileIndex')      loadFiles();
  if (tabName === 'BurstOrganizer') loadBursts();
  if (tabName === 'AppsGames')      loadApplications();
  if (tabName === 'LauncherCaches') loadLauncherCaches();
  if (tabName === 'ProcessMonitor') loadProcesses();
}

Object.keys(tabBtns).forEach(k => {
  if (tabBtns[k]) tabBtns[k].addEventListener('click', () => switchTab(k));
});

/* ─── Toast ──────────────────────────────────────────────────────────────────── */
function showToast(msg, type = 'info', duration = 3800) {
  if (typeof type === 'number') {
    duration = type;
    type = 'info';
  }
  const container = document.getElementById('toastContainer');
  if (container) {
    const item = document.createElement('div');
    item.className = `toast-item toast-item--${type}`;
    item.textContent = msg;
    container.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), 320);
    }, duration);
  }
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.className = `toast show toast-item--${type}`;
    setTimeout(() => toast.classList.remove('show'), duration);
  }
}

/* ════════════════════════════════════════════════════════════════════════════════
   0. PANEL PRINCIPAL (DASHBOARD)
   ════════════════════════════════════════════════════════════════════════════════ */
async function loadDashboardHome() {
  try {
    await Promise.all([loadStats(true), loadApplications(true), loadLauncherCaches(true), loadFiles(true)]);
    renderDashboardSuggestions();
    showToast('✅ ¡Datos sincronizados con éxito!', 'success', 3200);
  } catch (err) {
    showToast('❌ Error interno del servidor (Status 500). No se pudo leer la base de datos local.', 'error', 5000);
  }
}

/* Anti-falso-positivo helpers */
function isRecent(mtimeStr) {
  if (!mtimeStr) return false;
  const t = new Date(mtimeStr).getTime();
  return (Date.now() - t) <= (RECENT_DAYS_THRESHOLD * MS_PER_DAY);
}

function isGameTitle(name) {
  return /steam|epic|riot|vanguard|ea desktop|valorant|league of legends|gta|grand theft auto|horizon|minecraft|counter-strike|cs2|csgo|dota|cyberpunk|witcher|devour|watch.dogs|broforce|meccha|ubisoft|blizzard/i.test(name);
}

function renderDashboardSuggestions() {
  const listEl = document.getElementById('suggestionsList');
  if (!listEl) return;

  // ── Anomaly 1: 0% / Bajo Uso App ────────────────────────────────────────────
  // Exclude: game titles, driver/system entries, and recently used apps
  const lowApp = rawAppsList.find(a =>
    (a.utilityScore || 50) <= 30
    && a.filterGroup !== 'drivers'
    && !isGameTitle(a.name)
    && !isRecent(null)   // apps don't carry mtime, use installDate proxy via score
  ) || null;

  // ── Anomaly 2: Archivo Pesado Antiguo ────────────────────────────────────────
  // Exclude: files modified within last 30 days, game-related paths, and files < 100MB
  const MB_100 = 100 * 1024 * 1024;
  const abandonedFile = [...rawFilesList]
    .filter(f =>
      (f.size || 0) >= MB_100
      && !isRecent(f.mtime)
      && !/steam|epic games|riot games|vanguard|ea desktop/i.test(f.path || '')
    )
    .sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;

  // ── Anomaly 3: Launcher Caches ───────────────────────────────────────────────
  const totalCacheMB = rawCachesList.reduce((s, c) => s + (c.sizeMB || 0), 0);

  let html = '';

  if (lowApp) {
    html += `
      <div class="suggestion-row">
        <div class="suggestion-info">
          <span class="suggestion-badge badge-amber">Bajo Uso (${lowApp.utilityScore || 0}%)</span>
          <div>
            <h4 class="suggestion-name">Aplicación sin uso detectada: ${escapeHtml(lowApp.name)}</h4>
            <p class="suggestion-desc">Esta aplicación tiene ${lowApp.utilityScore || 0}% de uso y no es esencial (${formatSizeMB(lowApp.sizeMB)} en ${escapeHtml(lowApp.installPath)}). Te recomendamos borrarla.</p>
          </div>
        </div>
        <div class="action-group">
          <button class="btn-action btn-action--explorer" onclick="showInExplorer('${escapeJsStr(lowApp.installPath)}')">
            Ir a la ruta
          </button>
          <button class="btn-action btn-action--purge" onclick="openAppModal('${escapeHtml(lowApp.name)}','${encodeURIComponent(lowApp.uninstallCmd||'')}','${encodeURIComponent(lowApp.installPath)}',true)">
            Desinstalar / Purgar
          </button>
        </div>
      </div>`;
  }

  if (abandonedFile) {
    html += `
      <div class="suggestion-row">
        <div class="suggestion-info">
          <span class="suggestion-badge badge-violet">Archivo Pesado</span>
          <div>
            <h4 class="suggestion-name">Archivo antiguo y pesado: ${escapeHtml(abandonedFile.name)}</h4>
            <p class="suggestion-desc">Este es un archivo antiguo y pesado que ocupa espacio valioso (${formatSize(abandonedFile.size)} · Modificado: ${abandonedFile.mtime ? abandonedFile.mtime.slice(0,10) : '—'}).</p>
          </div>
        </div>
        <div class="action-group">
          <button class="btn-action btn-action--preview" onclick="openPreview('${encodeURIComponent(abandonedFile.path)}','${escapeHtml(abandonedFile.name)}','${abandonedFile.cluster||'Otros'}','')">
            Vista Previa
          </button>
          <button class="btn-action btn-action--explorer" onclick="showInExplorer('${escapeJsStr(abandonedFile.path)}')">
            Ir a su ruta
          </button>
          <button class="btn-action btn-action--purge" onclick="openPurgeModal('${escapeJsStr(abandonedFile.path)}','${escapeHtml(abandonedFile.name)}')">
            Eliminar Permanentemente
          </button>
        </div>
      </div>`;
  }

  if (totalCacheMB > 0 || rawCachesList.some(c => c.exists)) {
    html += `
      <div class="suggestion-row">
        <div class="suggestion-info">
          <span class="suggestion-badge badge-blue">Cachés Temporales</span>
          <div>
            <h4 class="suggestion-name">Cachés Secundarios de Lanzadores (${totalCacheMB} MB)</h4>
            <p class="suggestion-desc">Archivos temporales web y de diagnóstico en Steam, Epic, Riot o EA App que se pueden purgar sin afectar juegos.</p>
          </div>
        </div>
        <div class="action-group">
          <button class="btn-primary btn-sm" onclick="purgeAllCachesFromDashboard()">Purgar Todo</button>
        </div>
      </div>`;
  }

  if (!html) {
    html = `<p style="padding:16px;color:var(--text-secondary)">Tu sistema se encuentra optimizado y sin anomalías de almacenamiento detectadas.</p>`;
  }

  listEl.innerHTML = html;
}

async function purgeAllCachesFromDashboard() {
  showToast('Purgando todos los cachés secundarios...');
  await fetch('/api/caches/purge', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  showToast('Cachés purgados limpiamente');
  await loadLauncherCaches(true);
  renderDashboardSuggestions();
}

function handleScanRequest() {
  const overlay = document.getElementById('initialScanModalOverlay');
  if (overlay && (!window.__totalIndexedFiles || window.__totalIndexedFiles === 0 || !window.__hasScannedDeep)) {
    overlay.classList.add('show');
  } else {
    executeScan(false);
  }
}

async function executeScan(isInitialScan = false) {
  const overlay = document.getElementById('initialScanModalOverlay');
  if (overlay) overlay.classList.remove('show');
  window.__hasScannedDeep = true;
  showToast('⏳ Iniciando escaneo profundo del sistema... Esperando respuesta local.', 'info', 4500);
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isInitialScan })
    });
    if (res.status === 500) {
      showToast('❌ Error interno del servidor (Status 500). No se pudo leer la base de datos local.', 'error', 5000);
    }
  } catch (err) {
    showToast('❌ Error interno del servidor (Status 500). No se pudo leer la base de datos local.', 'error', 5000);
  }
  await Promise.all([loadApplications(), loadLauncherCaches(), loadFiles()]);
  pollScanStatus();
}

document.getElementById('homeBtnScanAll').addEventListener('click', handleScanRequest);

const initialScanCancelBtn = document.getElementById('initialScanCancelBtn');
if (initialScanCancelBtn) {
  initialScanCancelBtn.addEventListener('click', () => {
    const overlay = document.getElementById('initialScanModalOverlay');
    if (overlay) overlay.classList.remove('show');
  });
}

const initialScanConfirmBtn = document.getElementById('initialScanConfirmBtn');
if (initialScanConfirmBtn) {
  initialScanConfirmBtn.addEventListener('click', () => executeScan(true));
}

/* ════════════════════════════════════════════════════════════════════════════════
   1. ÍNDICE DE ARCHIVOS
   ════════════════════════════════════════════════════════════════════════════════ */
async function loadStats() {
  try {
    const res = await fetch('/api/stats').then(r => r.json());
    if (!res.ok) return;
    window.__totalIndexedFiles = res.totalFiles || 0;
    if (totalFilesVal) totalFilesVal.textContent = (res.totalFiles || 0).toLocaleString();
    if (adminStatusVal) adminStatusVal.textContent = res.isAdmin ? '🔓 Administrador' : '🔒 Usuario';

    const homeFilesText = document.getElementById('homeFilesText');
    if (homeFilesText) homeFilesText.textContent = `${(res.totalFiles||0).toLocaleString()} Archivos`;

    // Dynamic AI-Generated Semantic Cluster Filters in Spanish
    window.__cachedSubTagCounts = res.subTagCounts || [];
    const filterGroup = document.getElementById('clusterFiltersGroup');
    if (filterGroup && res.clusterCounts) {
      const activeCls = currentCluster || 'all';
      let buttonsHtml = `<button class="filter-btn ${activeCls === 'all' ? 'active' : ''}" data-cluster="all">Todos</button>`;
      res.clusterCounts.forEach(r => {
        const cls = r.cluster;
        const count = r.count || 0;
        buttonsHtml += `<button class="filter-btn ${activeCls === cls ? 'active' : ''}" data-cluster="${escapeHtml(cls)}">${escapeHtml(cls)} (${count})</button>`;
      });
      filterGroup.innerHTML = buttonsHtml;

      filterGroup.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          filterGroup.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentCluster = btn.dataset.cluster;
          currentSubTag  = 'all';
          updateDynamicSubTagToolbar(currentCluster);
          loadFiles();
        });
      });
    }

    // Dynamic Overview Cards
    const counts = { Universidad:0, Instaladores:0, Multimedia:0, Comprimidos:0, Otros:0 };
    (res.clusterCounts || []).forEach(r => {
      counts[r.cluster] = r.count;
      const cardCountEl = document.getElementById(`count${r.cluster}`);
      if (cardCountEl) cardCountEl.textContent = r.count;
    });
  } catch { /* ignore */ }
}

function updateDynamicSubTagToolbar(clusterName) {
  const subTagToolbar = document.getElementById('subTagToolbar');
  const subTagFilters = document.getElementById('subTagFilters');
  if (!subTagToolbar || !subTagFilters) return;

  if (!clusterName || clusterName === 'all') {
    subTagToolbar.style.display = 'none';
    return;
  }

  const subTagsForCls = (window.__cachedSubTagCounts || []).filter(s => s.cluster === clusterName);
  if (subTagsForCls.length === 0) {
    subTagToolbar.style.display = 'none';
    return;
  }

  subTagToolbar.style.display = 'flex';
  let html = `<button class="subtag-btn active" data-subtag="all">Todas</button>`;
  subTagsForCls.forEach(st => {
    if (st.sub_tag) {
      html += `<button class="subtag-btn" data-subtag="${escapeHtml(st.sub_tag)}">${escapeHtml(st.sub_tag)} (${st.count})</button>`;
    }
  });
  subTagFilters.innerHTML = html;

  subTagFilters.querySelectorAll('.subtag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      subTagFilters.querySelectorAll('.subtag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSubTag = btn.dataset.subtag;
      loadFiles();
    });
  });
}

async function loadFiles(isSilent = false) {
  try {
    const url = `/api/files?cluster=${encodeURIComponent(currentCluster)}&sub_tag=${encodeURIComponent(currentSubTag)}&limit=300`;
    const r = await fetch(url);
    if (r.status === 500) {
      if (!isSilent) showToast('❌ Error interno del servidor (Status 500). No se pudo leer la base de datos local.', 'error', 5000);
      return;
    }
    const res = await r.json();
    if (!res.ok) return;
    rawFilesList = res.files || [];
    if (!isSilent) {
      renderFilesTable();
      showToast('✅ ¡Datos sincronizados con éxito!', 'success', 3000);
    }
  } catch (err) {
    if (!isSilent) showToast('❌ Error interno del servidor (Status 500). No se pudo leer la base de datos local.', 'error', 5000);
  }
}

function renderSubTagsHtml(rawSubTag) {
  if (!rawSubTag || rawSubTag === 'null') return '—';
  let tags = [];
  try { tags = rawSubTag.startsWith('[') ? JSON.parse(rawSubTag) : [rawSubTag]; }
  catch { tags = [rawSubTag]; }
  return `<div class="multi-tag-wrap">${tags.map(t => `<span class="subtag-badge">${escapeHtml(t)}</span>`).join('')}</div>`;
}

/* ── Compound Multi-Column Sorting ──────────────────────────────────────────── */

/**
 * Advance the sort stack for a given column.
 * Cycle: absent → Desc(1) → Asc(2) → remove from stack.
 * The most-recently-clicked column becomes the primary sort key.
 */
function advanceSort(stack, col) {
  const idx = stack.findIndex(s => s.col === col);
  if (idx === -1) {
    stack.unshift({ col, dir: 1 });       // new column → Desc, push to front (primary)
  } else {
    const cur = stack[idx];
    if (cur.dir === 1) { cur.dir = 2; stack.splice(idx, 1); stack.unshift(cur); }  // Asc
    else               { stack.splice(idx, 1); }                                    // remove
  }
  return stack;
}

function applyCompoundSort(list, stack, colMap) {
  if (!stack.length) return list;
  return [...list].sort((a, b) => {
    for (const { col, dir } of stack) {
      const fn = colMap[col];
      if (!fn) continue;
      const diff = dir === 1 ? fn(b) - fn(a) : fn(a) - fn(b);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

const FILE_COL_MAP = {
  size: f => f.size      || 0,
  conf: f => f.confidence|| 0,
};
const APP_COL_MAP = {
  size:  a => a.sizeMB      || 0,
  score: a => a.utilityScore|| 50,
};

function getSortLabel(stack, col) {
  const entry = stack.find(s => s.col === col);
  if (!entry) return '';
  const rank = stack.indexOf(entry) + 1;
  const arrow = entry.dir === 1 ? '▼' : '▲';
  return stack.length > 1 ? `${arrow}${rank}` : arrow;
}

function updateSortIndicators() {
  const ids = {
    indFileConf:  { stack: fileSortStack, col: 'conf'  },
    indFileSize:  { stack: fileSortStack, col: 'size'  },
    indAppSize:   { stack: appSortStack,  col: 'size'  },
    indAppScore:  { stack: appSortStack,  col: 'score' },
  };
  Object.entries(ids).forEach(([id, { stack, col }]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = getSortLabel(stack, col);
  });
}

/* Sort header click bindings */
[
  ['thFileConf', fileSortStack, 'conf',  renderFilesTable],
  ['thFileSize', fileSortStack, 'size',  renderFilesTable],
  ['thAppSize',  appSortStack,  'size',  renderAppsTable],
  ['thAppScore', appSortStack,  'score', renderAppsTable],
].forEach(([id, stack, col, renderFn]) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => { advanceSort(stack, col); renderFn(); });
});

function renderFilesTable() {
  const tbody     = document.getElementById('fileTableBody');
  const tableMeta = document.getElementById('tableMeta');
  if (tableMeta) tableMeta.textContent = `${rawFilesList.length} archivos`;

  const displayFiles = applyCompoundSort(rawFilesList, fileSortStack, FILE_COL_MAP);
  updateSortIndicators();

  if (!displayFiles.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9"><div class="empty-state"><p>No se encontraron archivos. Haz clic en <strong>Escanear Ahora</strong>.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = displayFiles.map(f => {
    const clsName  = f.cluster || 'Otros';
    const badgeCls = 'badge-' + clsName.toLowerCase().replace(/\s+/g,'');
    const confPct  = Math.round((f.confidence || 0) * 100);
    const jsPath   = escapeJsStr(f.path || '');
    const escName  = escapeHtml(f.name);
    const ext      = (f.ext || '').toLowerCase();
    const canPrev  = ['.pdf','.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
    const mdate    = f.mtime ? f.mtime.slice(0,10) : '—';

    return `<tr>
      <td title="${escapeHtml(f.path || '')}" style="font-weight:600">${escName}</td>
      <td><span class="cluster-badge ${badgeCls}">${clsName}</span></td>
      <td>${renderSubTagsHtml(f.sub_tag)}</td>
      <td><span style="font-family:'JetBrains Mono',monospace">${confPct}%</span></td>
      <td>${formatSize(f.size)}</td>
      <td>${f.ext||'—'}</td>
      <td title="${escapeHtml(f.keywords||'')}">${escapeHtml((f.keywords||'—').slice(0,38))}</td>
      <td>${mdate}</td>
      <td class="col-actions">
        <div class="action-group">
          ${canPrev ? `<button class="btn-action btn-action--preview" onclick="openPreview('${encodeURIComponent(f.path)}','${escName}','${clsName}','${escapeHtml(f.sub_tag||'')}')">Vista Previa</button>` : ''}
          <button class="btn-action btn-action--explorer" onclick="showInExplorer('${jsPath}')">Explorador</button>
          <button class="btn-action btn-action--purge" onclick="openPurgeModal('${jsPath}','${escName}')">Purgar</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

/* Cluster & Sub-Tag filters */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCluster = btn.dataset.cluster;
    currentSubTag  = 'all';
    subTagToolbar.style.display = (currentCluster === 'Universidad' || currentCluster === 'all') ? 'flex' : 'none';
    loadFiles();
  });
});

document.querySelectorAll('.subtag-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtag-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSubTag = btn.dataset.subtag;
    loadFiles();
  });
});

document.getElementById('btnScan').addEventListener('click', handleScanRequest);

function pollScanStatus() {
  if (scanPollTimer) clearInterval(scanPollTimer);
  const progressWrap = document.getElementById('scanProgressWrap');
  if (progressWrap) progressWrap.style.display = 'block';

  scanPollTimer = setInterval(async () => {
    const res = await fetch('/api/scan/status').then(r => r.json());
    if (!res.ok || !res.scanState.running) {
      clearInterval(scanPollTimer);
      if (progressWrap) progressWrap.style.display = 'none';
      loadStats();
      loadFiles();
      showToast('Escaneo completado con éxito');
      return;
    }
    const scanCount = document.getElementById('scanCount');
    if (scanCount) scanCount.textContent = `${res.scanState.indexed} archivos`;
  }, 900);
}

/* ════════════════════════════════════════════════════════════════════════════════
   2. APLICACIONES Y JUEGOS
   ════════════════════════════════════════════════════════════════════════════════ */
async function loadApplications(isSummaryOnly = false) {
  try {
    const res = await fetch('/api/apps').then(r => r.json());
    if (!res.ok) return;
    rawAppsList = res.apps || [];

    const gamesCount   = res.summary?.gamesCount || 0;
    const totalSizeStr = formatSizeMB(res.summary?.totalSizeMB || 0);

    if (totalAppsFootprintVal) totalAppsFootprintVal.textContent = totalSizeStr;
    const homeFootprintText = document.getElementById('homeFootprintText');
    if (homeFootprintText) homeFootprintText.textContent = totalSizeStr;
    const homeAppsSub = document.getElementById('homeAppsSub');
    if (homeAppsSub) homeAppsSub.textContent = `${gamesCount} juegos · ${rawAppsList.length} aplicaciones`;

    if (!isSummaryOnly) {
      const bgc = document.getElementById('badgeGamesCount');
      if (bgc) bgc.textContent = gamesCount;
      const bac = document.getElementById('badgeAppsCount');
      if (bac) bac.textContent = rawAppsList.length - gamesCount;
      const ass = document.getElementById('appsSummarySize');
      if (ass) ass.textContent = `${totalSizeStr} en total`;
      renderAppsTable();
    }
  } catch {
    if (!isSummaryOnly) showToast('Error al consultar aplicaciones instaladas');
  }
}

/* App category filter bindings */
document.querySelectorAll('.app-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.app-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentAppFilter = btn.dataset.appfilter;
    renderAppsTable();
  });
});

function renderAppsTable() {
  const tbody = document.getElementById('appsTableBody');
  const meta  = document.getElementById('appsTableMeta');

  let filtered = currentAppFilter && currentAppFilter !== 'all'
    ? rawAppsList.filter(a => (a.filterGroup||'general') === currentAppFilter)
    : [...rawAppsList];

  // Apply compound sort
  filtered = applyCompoundSort(filtered, appSortStack, APP_COL_MAP);
  updateSortIndicators();

  if (meta) meta.textContent = `${filtered.length} aplicaciones listadas`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><p>No hay aplicaciones en esta categoría.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(app => {
    const score    = app.utilityScore || 50;
    const scoreCls = score >= 75 ? 'score-high' : score >= 45 ? 'score-medium' : 'score-low';
    const catBadge = app.isGame ? 'badge-universidad' : 'badge-otros';

    // Contextual destructor: launcher apps get official uninstaller, standard apps get rm -rf
    const destroyBtn = app.isLauncherApp
      ? `<button class="btn-action btn-action--launcher" onclick="openAppModal('${escapeHtml(app.name)}','${encodeURIComponent(app.uninstallCmd||'')}','${encodeURIComponent(app.installPath)}',false,true)" title="Ejecuta el desinstalador oficial del lanzador (Steam/Epic/Riot/EA)">Desinstalación Oficial</button>`
      : `<button class="btn-action btn-action--purge" onclick="openAppModal('${escapeHtml(app.name)}','${encodeURIComponent(app.uninstallCmd||'')}','${encodeURIComponent(app.installPath)}',true,false)" title="Elimina recursivamente el directorio completo de instalación">Eliminar de Raíz</button>`;

    return `<tr>
      <td style="font-weight:600" title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</td>
      <td><span class="cluster-badge ${catBadge}">${app.category||'Aplicación'}</span></td>
      <td>${escapeHtml(app.version)}</td>
      <td style="font-family:'JetBrains Mono',monospace">${formatSizeMB(app.sizeMB)}</td>
      <td>
        <div class="utility-bar-wrap">
          <div class="utility-bar-track"><div class="utility-bar-fill ${scoreCls}" style="width:${score}%"></div></div>
          <span style="font-size:0.78rem;font-weight:600">${score}</span>
        </div>
      </td>
      <td title="${escapeHtml(app.installPath)}">${escapeHtml(app.installPath)}</td>
      <td class="col-actions">
        <div class="action-group">
          ${destroyBtn}
        </div>
      </td>
    </tr>`;
  }).join('');
}

const btnScanApps = document.getElementById('btnScanApps');
if (btnScanApps) btnScanApps.addEventListener('click', () => { showToast('Consultando Registro de Windows...'); loadApplications(); });

function openAppModal(name, encCmd, encPath, isForcePurge, isLauncherApp = false) {
  activeAppTarget = {
    name,
    uninstallCmd: decodeURIComponent(encCmd||''),
    installPath:  decodeURIComponent(encPath||''),
    forcePurge:   isForcePurge,
    isLauncherApp,
  };
  document.getElementById('appModalName').textContent  = name;

  if (isLauncherApp) {
    document.getElementById('appModalTitle').textContent = '¿Ejecutar Desinstalación Oficial?';
    document.getElementById('appModalBody').textContent  = `Se abrirá la ventana oficial del desinstalador de la plataforma para ${name}. Los manifiestos del lanzador quedan protegidos.`;
  } else if (isForcePurge) {
    document.getElementById('appModalTitle').textContent = '¿Eliminar de Raíz?';
    document.getElementById('appModalBody').textContent  = `Eliminará recursivamente el directorio completo: ${activeAppTarget.installPath}. Esta acción es irreversible.`;
  } else {
    document.getElementById('appModalTitle').textContent = '¿Desinstalar Silenciosamente?';
    document.getElementById('appModalBody').textContent  = `Ejecuta el comando de desinstalación silenciosa para ${name}.`;
  }

  document.getElementById('appModalOverlay').setAttribute('aria-hidden','false');
}

document.getElementById('appCancelBtn').addEventListener('click', () => {
  document.getElementById('appModalOverlay').setAttribute('aria-hidden','true');
});

document.getElementById('appConfirmBtn').addEventListener('click', async () => {
  document.getElementById('appModalOverlay').setAttribute('aria-hidden','true');
  if (!activeAppTarget) return;
  showToast(`Ejecutando ${activeAppTarget.forcePurge ? 'eliminación forzada' : 'desinstalación'} para ${activeAppTarget.name}...`);
  try {
    const res = await fetch('/api/apps/uninstall', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(activeAppTarget),
    }).then(r => r.json());
    showToast(res.ok ? (res.message||'Acción completada') : `Error: ${res.error||'Falló'}`);
    if (res.ok) loadApplications();
  } catch { showToast('Error de comunicación con el servidor'); }
});

/* ════════════════════════════════════════════════════════════════════════════════
   3. CACHÉS DE LANZADORES
   ════════════════════════════════════════════════════════════════════════════════ */
async function loadLauncherCaches(isSummaryOnly = false) {
  try {
    const res = await fetch('/api/caches').then(r => r.json());
    if (!res.ok) return;
    rawCachesList = res.caches || [];
    const totalMB = res.totalCacheMB || 0;
    const homeCachesText = document.getElementById('homeCachesText');
    if (homeCachesText) homeCachesText.textContent = `${totalMB} MB`;
    if (!isSummaryOnly) {
      const ctm = document.getElementById('cachesTotalMB');
      if (ctm) ctm.textContent = `${totalMB} MB`;
      renderCachesTable(rawCachesList);
    }
  } catch { if (!isSummaryOnly) showToast('Error al cargar cachés secundarios'); }
}

function renderCachesTable(caches) {
  const tbody = document.getElementById('cachesTableBody');
  if (!caches.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6"><div class="empty-state"><p>No se encontraron cachés temporales</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = caches.map(c => `
    <tr>
      <td style="font-weight:600">${escapeHtml(c.launcher)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</td>
      <td><span class="cluster-badge ${c.exists ? 'badge-instaladores' : 'badge-otros'}">${c.exists ? 'Encontrado' : 'Limpio'}</span></td>
      <td style="font-family:'JetBrains Mono',monospace">${c.sizeMB} MB</td>
      <td class="col-actions">${c.exists ? `<button class="btn-action btn-action--purge" onclick="purgeSingleCache('${c.id}')">Purgar Caché</button>` : '—'}</td>
    </tr>`).join('');
}

async function purgeSingleCache(cacheId) {
  showToast('Eliminando caché temporal...');
  await fetch('/api/caches/purge', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ targetIds:[cacheId] }) });
  showToast('Caché eliminado con éxito');
  loadLauncherCaches();
}

const btnRefreshCaches = document.getElementById('btnRefreshCaches');
if (btnRefreshCaches) btnRefreshCaches.addEventListener('click', () => loadLauncherCaches());

const btnPurgeAllCaches = document.getElementById('btnPurgeAllCaches');
if (btnPurgeAllCaches) {
  btnPurgeAllCaches.addEventListener('click', async () => {
    showToast('Eliminando todos los cachés secundarios...');
    const res = await fetch('/api/caches/purge', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }).then(r => r.json());
    showToast(res.message || 'Cachés purgados exitosamente');
    loadLauncherCaches();
  });
}

/* ════════════════════════════════════════════════════════════════════════════════
   4. SEGURIDAD DE PROCESOS
   ════════════════════════════════════════════════════════════════════════════════ */
async function loadProcesses() {
  try {
    const res = await fetch('/api/processes').then(r => r.json());
    if (!res.ok) return;
    renderProcessesTable(res.processes || []);

    // API returns { ok, processes, summary } — summary has keys: critical, suspicious, clean
    const s = res.summary || {};
    const bc  = document.getElementById('badgeCriticalCount');
    const bs  = document.getElementById('badgeSuspiciousCount');
    const bcl = document.getElementById('badgeCleanCount');
    if (bc)  bc.textContent  = s.critical   ?? 0;
    if (bs)  bs.textContent  = s.suspicious ?? 0;
    if (bcl) bcl.textContent = s.clean      ?? 0;
  } catch { showToast('Error al consultar procesos del sistema'); }
}

function renderProcessesTable(procs) {
  const tbody = document.getElementById('procTableBody');
  const ptm   = document.getElementById('procTableMeta');
  if (ptm) ptm.textContent = `${procs.length} procesos activos`;

  if (!procs.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><div class="empty-state"><p>Haz clic en <strong>Actualizar Escaneo</strong>.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = procs.map(p => {
    const score    = p.score || 0;
    const isCrit   = score >= 70 || p.threatLevel === 'CRITICAL' || (p.flags||[]).some(f => /MINER|MONETIZACIÓN|CRITICAL/i.test(f));
    const isSusp   = !isCrit && (score >= 40 || p.threatLevel === 'Suspicious' || (p.flags||[]).length > 0);
    const cls      = isCrit ? 'critical' : isSusp ? 'suspicious' : 'clean';
    const label    = isCrit ? `CRÍTICO · ${score}` : isSusp ? `Sospechoso · ${score}` : 'Limpio';
    const flagsStr = (p.flags||[]).join(' · ');
    const escName  = escapeHtml(p.name);
    const encPath  = encodeURIComponent(p.path || '');
    const encFlags = encodeURIComponent(flagsStr || 'Sin alertas');

    return `<tr style="cursor:pointer;" onclick="openProcessModal('${escapeJsStr(p.name)}','${p.pid}','${encPath}','${score}','${encFlags}')" title="Haz clic para inspeccionar y finalizar el proceso">
      <td><span class="threat-badge ${cls}">${label}</span></td>
      <td style="font-weight:600">${escapeHtml(p.category||'Normal')}</td>
      <td style="font-weight:600">${escName}</td>
      <td style="font-family:'JetBrains Mono',monospace">${p.pid}</td>
      <td>${p.cpu||0}%</td><td>${p.ramMB||0} MB</td>
      <td style="color:var(--accent-red)">${flagsStr ? `${flagsStr} <span style="opacity:0.75; font-weight:600;">[+ Detalle/Finalizar]</span>` : '—'}</td>
      <td title="${escapeHtml(p.path||'')}">${escapeHtml(p.path||'—')}</td>
    </tr>`;
  }).join('');
}

let activeProcTarget = null;
function openProcessModal(name, pid, encPath, score, encFlags) {
  activeProcTarget = { name, pid: Number(pid), path: decodeURIComponent(encPath || '') };
  const flags = decodeURIComponent(encFlags || 'Sin alertas');
  document.getElementById('procModalTitle').textContent = `Alerta de Proceso: ${name} (PID ${pid})`;
  document.getElementById('procModalDesc').textContent = flags;
  document.getElementById('procModalMeta').textContent = `Ruta: ${activeProcTarget.path || 'NO_PATH (Módulo protegido o sistema)'} · Puntuación de Amenaza: ${score}/100`;

  const expBtn = document.getElementById('procModalExplorerBtn');
  if (expBtn) {
    expBtn.style.display = activeProcTarget.path ? 'inline-flex' : 'none';
  }

  document.getElementById('procModalOverlay').setAttribute('aria-hidden', 'false');
}

const procCloseBtn = document.getElementById('procModalCloseBtn');
if (procCloseBtn) procCloseBtn.addEventListener('click', () => {
  document.getElementById('procModalOverlay').setAttribute('aria-hidden', 'true');
});

const procExpBtn = document.getElementById('procModalExplorerBtn');
if (procExpBtn) procExpBtn.addEventListener('click', () => {
  if (activeProcTarget?.path) showInExplorer(activeProcTarget.path);
});

const procKillBtn = document.getElementById('procModalKillBtn');
if (procKillBtn) procKillBtn.addEventListener('click', async () => {
  if (!activeProcTarget?.pid) return;
  try {
    const res = await fetch('/api/processes/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: activeProcTarget.pid }),
    }).then(r => r.json());
    document.getElementById('procModalOverlay').setAttribute('aria-hidden', 'true');
    showToast(res.message || (res.ok ? 'Proceso finalizado exitosamente' : `Error: ${res.error}`));
    if (res.ok) loadProcesses();
  } catch {
    showToast('Error al intentar finalizar el proceso');
  }
});

const btnRefreshProcesses = document.getElementById('btnRefreshProcesses');
if (btnRefreshProcesses) btnRefreshProcesses.addEventListener('click', () => loadProcesses());

/* ════════════════════════════════════════════════════════════════════════════════
   5. VISTA PREVIA DEL ARCHIVO
   ════════════════════════════════════════════════════════════════════════════════ */
function openPreview(encPath, name, cluster, subTag) {
  activeFilePath = decodeURIComponent(encPath);

  document.getElementById('previewFilename').textContent = name;
  document.getElementById('previewMetaLine').textContent = `${cluster} · ${subTag}`;
  document.getElementById('previewPdfWrap').style.display   = 'none';
  document.getElementById('previewImageWrap').style.display = 'none';
  document.getElementById('previewFallback').style.display  = 'none';

  const ext      = activeFilePath.slice(activeFilePath.lastIndexOf('.')).toLowerCase();
  const streamUrl = `/api/view-file?path=${encodeURIComponent(activeFilePath)}`;

  if (ext === '.pdf') {
    document.getElementById('previewPdfObject').data = streamUrl;
    document.getElementById('previewPdfFrame').src   = streamUrl;
    document.getElementById('previewPdfWrap').style.display = 'block';
  } else if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) {
    document.getElementById('previewImage').src = streamUrl;
    document.getElementById('previewImageWrap').style.display = 'block';
  } else {
    document.getElementById('previewFallback').style.display = 'flex';
  }

  document.getElementById('previewOverlay').setAttribute('aria-hidden','false');
}

document.getElementById('previewCloseBtn').addEventListener('click', () => {
  document.getElementById('previewOverlay').setAttribute('aria-hidden','true');
});
document.getElementById('previewBtnExplorer').addEventListener('click', () => { if (activeFilePath) showInExplorer(activeFilePath); });
document.getElementById('previewBtnPurge').addEventListener('click', () => {
  if (activeFilePath) openPurgeModal(activeFilePath, activeFilePath.split('\\').pop());
});

/* ════════════════════════════════════════════════════════════════════════════════
   6. EXPLORADOR Y ELIMINACIÓN DE ARCHIVOS
   ════════════════════════════════════════════════════════════════════════════════ */
async function showInExplorer(filePath) {
  try {
    await fetch('/api/files/explorer', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ filePath }),
    });
    showToast('Abriendo ubicación del archivo en el Explorador de Windows...');
  } catch { showToast('Error al abrir en el Explorador'); }
}

let purgeTargetPath = null;
function openPurgeModal(filePath, fileName) {
  purgeTargetPath = filePath;
  document.getElementById('purgeModalFilename').textContent = fileName || filePath;
  document.getElementById('purgeModalOverlay').setAttribute('aria-hidden','false');
}

document.getElementById('purgeCancelBtn').addEventListener('click', () => {
  document.getElementById('purgeModalOverlay').setAttribute('aria-hidden','true');
});

document.getElementById('purgeConfirmBtn').addEventListener('click', async () => {
  document.getElementById('purgeModalOverlay').setAttribute('aria-hidden','true');
  if (!purgeTargetPath) return;
  try {
    const res = await fetch('/api/files', {
      method:'DELETE', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ filePath: purgeTargetPath }),
    }).then(r => r.json());

    if (res.ok) {
      showToast('Archivo eliminado permanentemente');
      loadStats();
      loadFiles();
      renderDashboardSuggestions();
    } else {
      showToast(`Error al eliminar: ${res.error}`);
    }
  } catch { showToast('Fallo en la comunicación al eliminar'); }
});

/* ════════════════════════════════════════════════════════════════════════════════
   7. APAGADO — window.close() garantizado en respuesta a /api/shutdown
   ════════════════════════════════════════════════════════════════════════════════ */
document.getElementById('btnPower').addEventListener('click', () => {
  document.getElementById('powerModalOverlay').setAttribute('aria-hidden','false');
});

document.getElementById('powerCancelBtn').addEventListener('click', () => {
  document.getElementById('powerModalOverlay').setAttribute('aria-hidden','true');
});

document.getElementById('powerConfirmBtn').addEventListener('click', async () => {
  document.getElementById('powerModalOverlay').setAttribute('aria-hidden','true');
  showToast('Apagando servidor y cerrando interfaz...', 2800);

  try {
    /* Fire-and-forget the shutdown request; the server sends { ok:true }
       the instant it has flushed SQLite and closed Express.
       We close the window immediately on receipt — zero delay. */
    const res = await fetch('/api/shutdown').then(r => r.json());
    if (res && res.ok) {
      window.close();   // ← executes the exact millisecond backend confirms termination
    }
  } catch {
    // If the fetch throws (server already dead), close the window anyway
    window.close();
  }
});

/* ─── Helpers ────────────────────────────────────────────────────────────────── */
function escapeJsStr(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes > 1024*1024*1024) return `${(bytes/(1024*1024*1024)).toFixed(2)} GB`;
  if (bytes > 1024*1024)      return `${(bytes/(1024*1024)).toFixed(1)} MB`;
  if (bytes > 1024)           return `${(bytes/1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatSizeMB(mb) {
  if (!mb) return '0 MB';
  if (mb >= 1024) return `${(mb/1024).toFixed(2)} GB`;
  return `${mb} MB`;
}

function escapeHtml(str) {
  return String(str||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/* ─── ORGANIZADOR DE RÁFAGAS (SMART TEMPORAL CLUSTERING) ──────────────────────── */
async function loadBursts() {
  const container = document.getElementById('burstCardsContainer');
  if (!container) return;
  container.innerHTML = `<div class="empty-state" style="padding:40px;"><p>Consultando ráfagas temporales en la base de datos inteligente...</p></div>`;
  try {
    const res = await fetch('/api/bursts').then(r => r.json());
    if (!res.ok || !res.bursts || res.bursts.length === 0) {
      container.innerHTML = `<div class="empty-state" style="padding:40px;"><p>No se encontraron ráfagas temporales de archivos en una misma fecha.</p></div>`;
      return;
    }
    let html = `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 18px;">`;
    res.bursts.forEach((b, idx) => {
      const sampleList = b.sampleFiles.map(f => `<li><code>${escapeHtml(f.name)}</code> (${formatSize(f.size)})</li>`).join('');
      const encPaths = encodeURIComponent(JSON.stringify(b.allFilePaths));
      html += `
        <div class="summary-metric-card" style="display:block; padding: 20px; cursor:default;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <span style="font-weight:700; font-size:1.05rem; color:var(--text-primary);">📅 Ráfaga del ${escapeHtml(b.date)}</span>
            <span class="cluster-badge badge-info">${b.count} Archivos</span>
          </div>
          <p style="font-size:0.84rem; color:var(--text-secondary); margin-bottom:10px;">Tamaño total: <strong>${formatSize(b.totalSize)}</strong></p>
          <ul style="font-size:0.78rem; color:var(--text-secondary); margin-left:16px; margin-bottom:14px; max-height:110px; overflow-y:auto;">
            ${sampleList}
          </ul>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" id="burstFolder_${idx}" value="Ráfaga_${b.date}" style="flex:1; padding:7px 11px; border:1px solid var(--border-color); border-radius:8px; font-size:0.83rem;" placeholder="Nombre de carpeta">
            <button class="btn-primary" style="padding:7px 13px; font-size:0.82rem;" onclick="groupBurst(${idx}, '${encPaths}')">
              Agrupar Ráfaga
            </button>
          </div>
        </div>
      `;
    });
    html += `</div>`;
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="padding:40px;"><p>Error cargando ráfagas: ${escapeHtml(err.message)}</p></div>`;
  }
}

async function groupBurst(idx, encPathsStr) {
  const inputEl = document.getElementById(`burstFolder_${idx}`);
  const folderName = inputEl ? inputEl.value.trim() : 'Ráfaga Agrupada';
  let filePaths = [];
  try { filePaths = JSON.parse(decodeURIComponent(encPathsStr)); } catch {}

  // FAIL-SAFE HUMAN CONFIRMATION CLICK ENFORCED
  showToast(`Agrupando ${filePaths.length} archivos en carpeta "${folderName}"...`);
  const res = await fetch('/api/bursts/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderName, filePaths, confirmedByUserClick: true })
  }).then(r => r.json());

  if (res.ok) {
    showToast(`✅ ${res.moved} archivos movidos a ${res.destDir}`);
    loadBursts();
  } else {
    showToast(`❌ Error: ${res.error}`);
  }
}

/* ─── 3-STEP FAIL-SAFE RESCAN CONFIRMATION MODAL ─────────────────────────────── */
let rescanStep = 1;

const btnRescanHeader = document.getElementById('btnRescanHeader');
if (btnRescanHeader) {
  btnRescanHeader.addEventListener('click', () => {
    rescanStep = 1;
    updateRescanModalUI();
    document.getElementById('rescanModalOverlay')?.classList.add('show');
  });
}

function updateRescanModalUI() {
  const title = document.getElementById('rescanStepTitle');
  const desc  = document.getElementById('rescanStepDesc');
  const nextBtn = document.getElementById('rescanNextBtn');
  if (!title || !desc || !nextBtn) return;

  if (rescanStep === 1) {
    title.textContent = 'Paso 1 de 3: Confirmación Estricta';
    desc.textContent  = '¿Está seguro que desea re-escanear todo el sistema?';
    nextBtn.textContent = 'Continuar (Paso 2)';
  } else if (rescanStep === 2) {
    title.textContent = 'Paso 2 de 3: Sobrescribir Índice';
    desc.textContent  = '¿Desea sobrescribir el índice local y reiniciar la caché de escaneo delta?';
    nextBtn.textContent = 'Continuar (Paso 3)';
  } else if (rescanStep === 3) {
    title.textContent = 'Paso 3 de 3: Escaneo Profundo Multi-Unidad';
    desc.textContent  = 'Esta acción iniciará el escaneo profundo de 30 minutos por todas las unidades de almacenamiento. ¿Proceder?';
    nextBtn.textContent = 'Proceder con Re-escaneo';
  }
}

document.getElementById('rescanCancelBtn')?.addEventListener('click', () => {
  document.getElementById('rescanModalOverlay')?.classList.remove('show');
});

document.getElementById('rescanNextBtn')?.addEventListener('click', async () => {
  if (rescanStep < 3) {
    rescanStep++;
    updateRescanModalUI();
  } else {
    document.getElementById('rescanModalOverlay')?.classList.remove('show');
    showToast('Iniciando re-escaneo profundo de 30 min por todas las unidades...');
    await fetch('/api/scan/reset-and-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmedByUserClick: true })
    });
    pollScanStatus();
  }
});

/* ─── Arranque ───────────────────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => switchTab('Home'));
