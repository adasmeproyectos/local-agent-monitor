'use strict';

const fsp  = require('fs').promises;
const path = require('path');
const { extractMetadata } = require('./extractor');
const { classify }        = require('./classifier');
const { upsertFile, getFileByPath, startSession, completeSession } = require('./db');

const SKIP_NAMES = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information',
  'windows', 'program files', 'program files (x86)', 'programdata', 'recovery', 'perflogs',
  'windowsapps', 'packages', 'appdata', 'msocache', 'config.msi'
]);

function shouldSkipDir(name, fullPath) {
  if (!name || name.startsWith('.')) return true;
  const lowerName = name.toLowerCase();
  if (SKIP_NAMES.has(lowerName)) return true;
  const lowerPath = (fullPath || '').toLowerCase();
  if (lowerPath.includes('appdata\\local\\packages') ||
      lowerPath.includes('appdata/local/packages') ||
      lowerPath.includes('$recycle.bin') ||
      lowerPath.includes('system volume information') ||
      lowerPath.includes('windowsapps')) {
    return true;
  }
  return false;
}

// ─── Progress Emitter ─────────────────────────────────────────────────────────
let _progressCallback = null;
function onProgress(cb) { _progressCallback = cb; }
function emit(event, data) { if (_progressCallback) _progressCallback(event, data); }

// ─── Recursive File Walker (Unrestricted Initial / Delta) ─────────────────────

async function* walkDir(dirPath, depth = 0, maxDepth = 12) {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Permission denied or broken symlink — skip silently
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, fullPath)) continue;
      yield* walkDir(fullPath, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

// ─── Batch Processor (with Delta-Only Optimization) ───────────────────────────

async function processBatch(filePaths, options = {}) {
  const tasks = filePaths.map(async (filePath) => {
    const name = path.basename(filePath);
    const ext  = path.extname(filePath).toLowerCase();

    // Delta-only check: if subsequent scan and file mtime unchanged, skip extraction
    if (!options.isInitialScan) {
      try {
        const stat = await fsp.stat(filePath);
        const mtimeStr = stat.mtime.toISOString();
        const existing = getFileByPath(filePath);
        if (existing && existing.mtime === mtimeStr) {
          return { path: filePath, cluster: existing.cluster, deltaSkipped: true };
        }
      } catch { /* proceed to fresh extraction */ }
    }

    const { textSample, info, size, mtime } = await extractMetadata(filePath, ext);

    const richSample = [
      info?.title, info?.subject, info?.keywords, info?.author,
      name, textSample
    ].filter(Boolean).join(' ');

    const { cluster, subTag, confidence, matchedKeywords } = classify(name, ext, richSample);

    upsertFile({
      path:       filePath,
      name,
      ext:        ext || '(none)',
      size,
      mtime,
      cluster,
      sub_tag:    subTag || null,
      confidence,
      keywords:   matchedKeywords.join(', '),
      indexed_at: new Date().toISOString(),
    });

    return { path: filePath, cluster, confidence };
  });

  return Promise.allSettled(tasks);
}

// ─── Main Scan Entry Point ────────────────────────────────────────────────────

async function runScan(targetDirs, options = {}) {
  const isInitialScan = Boolean(options.isInitialScan);
  let effectiveDirs = targetDirs;
  if (!effectiveDirs || effectiveDirs.length === 0 || isInitialScan) {
    effectiveDirs = await discoverStorageDrives();
  }
  const maxDepth  = isInitialScan ? 14 : 8;
  const batchSize = isInitialScan ? 100 : 50;

  const sessionId = startSession(effectiveDirs);
  emit('start', { sessionId, targetDirs: effectiveDirs, isInitialScan });

  let indexed = 0;
  let batch   = [];

  for (const dir of effectiveDirs) {
    emit('dir', { dir });
    for await (const filePath of walkDir(dir, 0, maxDepth)) {
      batch.push(filePath);

      if (batch.length >= batchSize) {
        await processBatch(batch, { isInitialScan });
        indexed += batch.length;
        emit('progress', { indexed, currentDir: dir, isInitialScan });
        batch = [];
      }
    }
  }

  if (batch.length) {
    await processBatch(batch, { isInitialScan });
    indexed += batch.length;
  }

  completeSession(sessionId, indexed);
  emit('done', { indexed, sessionId, isInitialScan });

  return { indexed, sessionId, isInitialScan };
}

// ─── Transaction-Safe Semantic File Sorter ────────────────────────────────────

const ORGANIZER_ALLOWED_EXTS = new Set(['.pdf','.docx','.doc','.txt','.md','.png','.jpg','.jpeg','.xlsx','.pptx']);

const GAMING_PATH_BLOCKLIST = [
  'steam', 'epic games', 'riot games', 'vanguard', 'ea desktop',
  'steamapps', 'epicgames', 'riotgames', 'eadesktop',
];

function isGamingPath(filePath) {
  const normalized = (filePath || '').toLowerCase();
  return GAMING_PATH_BLOCKLIST.some(b => normalized.includes(b));
}

function sanitizeSubTagName(subTag) {
  let tag = subTag;
  try {
    if (typeof subTag === 'string' && subTag.startsWith('[')) {
      const arr = JSON.parse(subTag);
      tag = Array.isArray(arr) && arr.length ? arr[0] : subTag;
    }
  } catch { /* keep original */ }

  return String(tag || 'Documentación General')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// ─── Multi-Drive Comprehensive Discovery Engine (Windows & macOS) ─────────────

async function discoverStorageDrives() {
  const drives = [];
  if (process.platform === 'win32') {
    const letters = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\'];
    for (const letter of letters) {
      try {
        await fsp.access(letter);
        drives.push(letter);
      } catch { /* drive not mounted or unreadable */ }
    }
    // Ensure primary user directories are explicitly included if C:\ is readable
    const homeDir = require('os').homedir();
    if (!drives.includes(homeDir)) drives.push(homeDir);
  } else if (process.platform === 'darwin') {
    const homeDir = require('os').homedir();
    drives.push(homeDir);
    try {
      const volEntries = await fsp.readdir('/Volumes', { withFileTypes: true });
      for (const ent of volEntries) {
        const volPath = path.join('/Volumes', ent.name);
        drives.push(volPath);
      }
    } catch { /* /Volumes not accessible */ }
  } else {
    drives.push(require('os').homedir());
  }
  return [...new Set(drives)];
}

async function organizeAcademicFiles(destRoot, files = [], targetCluster = null, options = {}) {
  // CRITICAL FAIL-SAFE HUMAN-CONFIRMATION MATRIX
  if (!options || !options.explicitUserAuthorized) {
    throw new Error('FAIL-SAFE SAFETY RESTRICTION: Autonomous file movement is strictly forbidden without explicit user confirmation click.');
  }

  let moved   = 0;
  let skipped = 0;
  const errors = [];

  const targets = files.filter(f => {
    const ext = (f.ext || path.extname(f.path || '')).toLowerCase();
    const clusterMatches = !targetCluster || f.cluster === targetCluster || f.cluster?.includes(targetCluster);
    return (
      clusterMatches
      && ORGANIZER_ALLOWED_EXTS.has(ext)
      && !isGamingPath(f.path)
    );
  });

  for (const file of targets) {
    try {
      if (isGamingPath(file.path)) { skipped++; continue; }
      try { await fsp.access(file.path); } catch { skipped++; continue; }

      const folderName = sanitizeSubTagName(file.sub_tag);
      const targetDir  = path.join(destRoot, folderName);

      await fsp.mkdir(targetDir, { recursive: true });
      const destPath = path.join(targetDir, path.basename(file.path));

      try { await fsp.access(destPath); skipped++; continue; } catch { /* dest safe */ }

      await fsp.rename(file.path, destPath);
      moved++;
    } catch (err) {
      errors.push(`[${path.basename(file.path || '')}] ${err.message}`);
      skipped++;
    }
  }

  return { moved, skipped, errors, total: targets.length };
}

module.exports = { runScan, onProgress, organizeAcademicFiles, discoverStorageDrives };
