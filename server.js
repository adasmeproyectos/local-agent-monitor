'use strict';

const express  = require('express');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const fsp      = require('fs').promises;
const { spawn, exec } = require('child_process');

const { getFiles, getStats, reclassifyFile, closeDb, getDb, DB_PATH } = require('./modules/db');
const { runScan, onProgress, organizeAcademicFiles } = require('./modules/crawler');
const { getProcessSnapshot }     = require('./modules/process-monitor');
const { classify }               = require('./modules/classifier');
const {
  getInstalledApplications,
  uninstallApplication,
  getLauncherCaches,
  purgeLauncherCaches,
} = require('./modules/game-scanner');

const PORT       = 3141;
const PUBLIC_DIR = path.join(__dirname, 'public');
const app        = express();

// ─── Asset Bootstrap — copy navi assets from Downloads to public/ on first run
(async () => {
  const srcDir = path.join(os.homedir(), 'Downloads');
  for (const asset of ['navi.gif', 'navi.png']) {
    const src  = path.join(srcDir, asset);
    const dest = path.join(PUBLIC_DIR, asset);
    try {
      await fsp.access(dest);
    } catch {
      try {
        await fsp.copyFile(src, dest);
        console.log(`  📦 Copied asset: ${asset} → public/`);
      } catch { /* skip */ }
    }
  }
})();

// ─── Admin privilege detection ────────────────────────────────────────────────
let _isAdmin = false;
(async () => {
  try {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      _isAdmin = out.trim().toLowerCase() === 'true';
      console.log(_isAdmin
        ? '  ✅ Administrator privileges confirmed — full path resolution enabled.'
        : '  ⚠️  Not elevated. Launch via start-admin.bat for full process path resolution.');
    });
  } catch { /* ignore */ }
})();

// ─── MIME type map ────────────────────────────────────────────────────────────
const MIME_MAP = {
  '.pdf':  'application/pdf',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.png':  'image/png',  '.gif':  'image/gif',
  '.webp': 'image/webp', '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',  '.webm': 'video/webm',
};

// ─── Default scan targets (includes root-level elevated discovery C:\) ────────
const DEFAULT_TARGETS = [
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  'C:\\',
];

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─── Scan State ───────────────────────────────────────────────────────────────
let scanState = {
  running: false, indexed: 0, currentDir: '', sessionId: null, startedAt: null,
};

onProgress((event, data) => {
  switch (event) {
    case 'start':    scanState.running = true;  scanState.indexed = 0; scanState.sessionId = data.sessionId; scanState.startedAt = new Date().toISOString(); break;
    case 'progress': scanState.indexed = data.indexed; scanState.currentDir = data.currentDir; break;
    case 'dir':      scanState.currentDir = data.dir; break;
    case 'done':     scanState.running = false; scanState.indexed = data.indexed; break;
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  try { res.json({ ok: true, ...getStats(), scanState, isAdmin: _isAdmin, dbPath: DB_PATH }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/scan', (req, res) => {
  if (scanState.running) return res.json({ ok: false, message: 'Scan already in progress', scanState });
  const dirs = (req.body?.dirs && Array.isArray(req.body.dirs)) ? req.body.dirs : DEFAULT_TARGETS;
  const isInitialScan = Boolean(req.body?.isInitialScan);
  res.json({ ok: true, message: 'Scan started', dirs, scanState, isInitialScan });
  runScan(dirs, { isInitialScan }).catch(err => { console.error('[Crawler error]', err); scanState.running = false; });
});

app.get('/api/scan/status', (req, res) => res.json({ ok: true, scanState }));

app.get('/api/files', (req, res) => {
  try {
    const cluster  = req.query.cluster || 'all';
    const sub_tag  = req.query.sub_tag || 'all';
    const limit    = Math.min(parseInt(req.query.limit  || '300'), 500);
    const offset   = parseInt(req.query.offset || '0');
    const files    = getFiles({ cluster, sub_tag, limit, offset });
    res.json({ ok: true, files, count: files.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/classify', (req, res) => {
  try {
    const { filePath, cluster, subTag, confidence } = req.body;
    if (!filePath || !cluster) return res.status(400).json({ ok: false, error: 'filePath and cluster required' });
    reclassifyFile(filePath, cluster, subTag, confidence ?? 1.0);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/processes', async (req, res) => {
  try { res.json({ ok: true, ...await getProcessSnapshot() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/processes/kill', (req, res) => {
  const { pid } = req.body;
  if (!pid || isNaN(Number(pid))) return res.status(400).json({ ok: false, error: 'PID inválido o faltante' });
  exec(`taskkill /F /PID ${Number(pid)}`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, message: `Proceso PID ${pid} finalizado exitosamente.` });
  });
});

// ─── Installed Applications & Games API ───────────────────────────────────────

app.get('/api/apps', async (req, res) => {
  try {
    const data = await getInstalledApplications();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/apps/uninstall', async (req, res) => {
  try {
    const { name, uninstallCmd, installPath, forcePurge } = req.body;
    const result = await uninstallApplication({ name, uninstallCmd, installPath, forcePurge });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Launcher Caches API ──────────────────────────────────────────────────────

app.get('/api/caches', async (req, res) => {
  try {
    const data = await getLauncherCaches();
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/caches/purge', async (req, res) => {
  try {
    const { targetIds } = req.body || {};
    const result = await purgeLauncherCaches(targetIds);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Show in Explorer ─────────────────────────────────────────────────────────
app.post('/api/files/explorer', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ ok: false, error: 'filePath required' });
  if (/[;&|`$<>]/.test(filePath)) return res.status(400).json({ ok: false, error: 'Invalid path characters' });

  // Resolve to absolute path, then normalize all slashes to Windows backslashes
  const windowsPath = path.resolve(filePath).replace(/\//g, '\\');
  exec(`explorer.exe /select,"${windowsPath}"`, (err) => {
    // explorer.exe returns exit code 1 on success in many Windows versions — safe to ignore
    if (err && err.message?.includes('ENOENT')) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, note: 'Explorer launched — file highlighted', path: windowsPath });
  });
});

// ─── Purge File ───────────────────────────────────────────────────────────────
app.delete('/api/files', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ ok: false, error: 'filePath required' });
  const blocked = ['\\windows\\', '\\program files\\', '\\programdata\\system'];
  if (blocked.some(b => filePath.toLowerCase().includes(b))) return res.status(403).json({ ok: false, error: 'System paths are protected' });
  try {
    await fsp.unlink(filePath);
    getDb().prepare('DELETE FROM files WHERE path = ?').run(filePath);
    res.json({ ok: true, deleted: filePath });
  } catch (err) {
    if (err.code === 'ENOENT') {
      try { getDb().prepare('DELETE FROM files WHERE path = ?').run(filePath); } catch {}
      return res.json({ ok: true, note: 'File already removed; index cleaned.' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SECURE FILE STREAMING — /api/view-file
//  Bypasses CORS restrictions and provides HTTP Range support for PDF seek.
// ═══════════════════════════════════════════════════════════════════════════════
function streamFileHandler(req, res) {
  const rawPath  = req.query.path || req.query.p || '';
  const filePath = decodeURIComponent(rawPath);

  if (!filePath) return res.status(400).send('path parameter is required');

  const BLOCKED = ['\\windows\\', '\\system32\\', '/etc/', '/sys/', '/proc/', '../'];
  if (BLOCKED.some(b => filePath.toLowerCase().includes(b.toLowerCase()))) {
    return res.status(403).send('Path forbidden');
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  fs.stat(filePath, (statErr, stat) => {
    if (statErr) {
      return statErr.code === 'ENOENT'
        ? res.status(404).send('File not found')
        : res.status(500).send('File stat error');
    }

    const fileSize    = stat.size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts     = rangeHeader.replace(/bytes=/, '').split('-');
      const start     = parseInt(parts[0], 10);
      const end       = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mimeType,
        'Cache-Control':  'no-store',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length':         fileSize,
        'Content-Type':           mimeType,
        'Content-Disposition':    'inline',
        'Accept-Ranges':          'bytes',
        'Cache-Control':          'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

app.get('/api/view-file',    streamFileHandler);
app.get('/api/files/stream', streamFileHandler);

// ─── Academic File Organizer (transaction-safe rename pipeline) ──────────────────
app.post('/api/files/organize', async (req, res) => {
  try {
    const { destRoot } = req.body;
    if (!destRoot) return res.status(400).json({ ok: false, error: 'destRoot required' });

    // Retrieve all indexed files for pipeline input
    const { getFiles } = require('./modules/db');
    const files = getFiles({ cluster: 'Universidad', sub_tag: 'all', limit: 1000, offset: 0 });

    const result = await organizeAcademicFiles(destRoot, files);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────
app.get('/api/shutdown', (req, res) => {
  res.json({ ok: true, message: 'Navi Cleaner shutting down...' });
  setTimeout(() => gracefulShutdown('Power button / frontend shutdown'), 400);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let _server = null;

function gracefulShutdown(reason = 'unknown') {
  console.log(`\n[Shutdown] ${reason}`);
  closeDb();
  if (_server) {
    _server.close(() => {
      console.log('[Shutdown] Server closed. All resources freed. ✅');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── Start ────────────────────────────────────────────────────────────────────
_server = app.listen(PORT, '127.0.0.1', async () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     Navi Cleaner  ✦  Elevated Desktop Suite      ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Server  → ${url}                      ║`);
  console.log(`║   PID     → ${process.pid}                               ║`);
  console.log(`║   Database→ ${DB_PATH}  ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
