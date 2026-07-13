'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

// ─── Portable & Isolated Storage ──────────────────────────────────────────────
// Stored strictly inside the host's user profile directory (%USERPROFILE%\.navi-cleaner\navi.db)
// Ensuring complete portability across any Windows machine.
const NAVI_DIR = path.join(os.homedir(), '.navi-cleaner');
const DB_PATH  = path.join(NAVI_DIR, 'navi.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  // Ensure directory exists
  if (!fs.existsSync(NAVI_DIR)) {
    fs.mkdirSync(NAVI_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Enable WAL mode for high performance synchronous reads/writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -12000'); // 12MB page cache

  _db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    UNIQUE NOT NULL,
      name        TEXT    NOT NULL,
      ext         TEXT,
      size        INTEGER,
      mtime       TEXT,
      cluster     TEXT,
      sub_tag     TEXT,
      confidence  REAL,
      keywords    TEXT,
      indexed_at  TEXT,
      volume      TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL,
      completed_at TEXT,
      total_files  INTEGER DEFAULT 0,
      target_dirs  TEXT
    );

    CREATE TABLE IF NOT EXISTS dynamic_categories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_name TEXT UNIQUE NOT NULL,
      description  TEXT,
      created_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_cluster ON files(cluster);
    CREATE INDEX IF NOT EXISTS idx_files_sub_tag ON files(sub_tag);
    CREATE INDEX IF NOT EXISTS idx_files_ext     ON files(ext);
    CREATE INDEX IF NOT EXISTS idx_files_volume  ON files(volume);
  `);

  try {
    _db.exec('ALTER TABLE files ADD COLUMN volume TEXT');
  } catch { /* column already exists */ }

  return _db;
}

function extractVolume(filePath) {
  if (!filePath) return 'C:\\';
  if (process.platform === 'win32') {
    const match = filePath.match(/^([a-zA-Z]:\\)/);
    return match ? match[1].toUpperCase() : 'C:\\';
  } else {
    const match = filePath.match(/^(\/Volumes\/[^/]+)/);
    return match ? match[1] : '/';
  }
}

// ─── File Index CRUD ──────────────────────────────────────────────────────────

const upsertFile = (file) => {
  const db = getDb();
  const volume = file.volume || extractVolume(file.path);
  const stmt = db.prepare(`
    INSERT INTO files (path, name, ext, size, mtime, cluster, sub_tag, confidence, keywords, indexed_at, volume)
    VALUES (@path, @name, @ext, @size, @mtime, @cluster, @sub_tag, @confidence, @keywords, @indexed_at, @volume)
    ON CONFLICT(path) DO UPDATE SET
      size       = excluded.size,
      mtime      = excluded.mtime,
      cluster    = excluded.cluster,
      sub_tag    = excluded.sub_tag,
      confidence = excluded.confidence,
      keywords   = excluded.keywords,
      indexed_at = excluded.indexed_at,
      volume     = excluded.volume
  `);
  return stmt.run({
    ...file,
    volume,
    sub_tag: file.sub_tag || null,
  });
};

function getFileByPath(filePath) {
  const db = getDb();
  return db.prepare('SELECT path, size, mtime, cluster, sub_tag FROM files WHERE path = ?').get(filePath);
}

function registerDynamicCategory(clusterName, description = '') {
  if (!clusterName) return;
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO dynamic_categories (cluster_name, description, created_at)
      VALUES (?, ?, ?)
    `).run(clusterName, description, new Date().toISOString());
  } catch (err) { /* ignore duplicate */ }
}

function getFiles({ cluster, sub_tag, ext, limit = 300, offset = 0 } = {}) {
  try {
    const db = getDb();
    let query = 'SELECT * FROM files';
    const params = [];
    const conditions = [];

    if (cluster && cluster !== 'all') {
      conditions.push('cluster = ?');
      params.push(String(cluster));
    }
    if (sub_tag && sub_tag !== 'all') {
      conditions.push('(sub_tag = ? OR sub_tag LIKE ?)');
      params.push(String(sub_tag), `%${sub_tag}%`);
    }
    if (ext) {
      conditions.push('ext = ?');
      params.push(String(ext));
    }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY indexed_at DESC LIMIT ? OFFSET ?';

    const safeLimit = (Number.isFinite(Number(limit)) && Number(limit) > 0) ? Math.floor(Number(limit)) : 300;
    const safeOffset = (Number.isFinite(Number(offset)) && Number(offset) >= 0) ? Math.floor(Number(offset)) : 0;
    params.push(safeLimit, safeOffset);

    return db.prepare(query).all(...params) || [];
  } catch (err) {
    console.error('[db.getFiles error]', err.message);
    return [];
  }
}

function getStats() {
  try {
    const db = getDb();

    const clusterCounts = db.prepare(`
      SELECT cluster, COUNT(*) as count, SUM(size) as total_size
      FROM files
      GROUP BY cluster
      ORDER BY count DESC
    `).all() || [];

    const subTagCounts = db.prepare(`
      SELECT cluster, sub_tag, COUNT(*) as count
      FROM files
      WHERE sub_tag IS NOT NULL
      GROUP BY cluster, sub_tag
      ORDER BY count DESC
    `).all() || [];

    const dynamicCategories = db.prepare(`
      SELECT * FROM dynamic_categories ORDER BY id ASC
    `).all() || [];

    const lastSession = db.prepare(`
      SELECT * FROM scan_sessions ORDER BY id DESC LIMIT 1
    `).get() || null;

    const totalRow = db.prepare('SELECT COUNT(*) as n FROM files').get();
    const totalFiles = totalRow ? (totalRow.n || 0) : 0;

    return { clusterCounts, subTagCounts, dynamicCategories, lastSession, totalFiles, dbPath: DB_PATH };
  } catch (err) {
    console.error('[db.getStats error]', err.message);
    return { clusterCounts: [], subTagCounts: [], dynamicCategories: [], lastSession: null, totalFiles: 0, dbPath: DB_PATH };
  }
}

function reclassifyFile(filePath, cluster, sub_tag, confidence) {
  const db = getDb();
  return db.prepare(`
    UPDATE files SET cluster = ?, sub_tag = ?, confidence = ? WHERE path = ?
  `).run(cluster, sub_tag || null, confidence, filePath);
}

// ─── Scan Session CRUD ────────────────────────────────────────────────────────

function startSession(targetDirs) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO scan_sessions (started_at, target_dirs)
    VALUES (?, ?)
  `).run(new Date().toISOString(), JSON.stringify(targetDirs));
  return result.lastInsertRowid;
}

function completeSession(sessionId, totalFiles) {
  const db = getDb();
  db.prepare(`
    UPDATE scan_sessions SET completed_at = ?, total_files = ? WHERE id = ?
  `).run(new Date().toISOString(), totalFiles, sessionId);
}

function resetDeltaCache() {
  const db = getDb();
  db.prepare('DELETE FROM files').run();
  db.prepare('DELETE FROM scan_sessions').run();
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  upsertFile,
  getFileByPath,
  registerDynamicCategory,
  getFiles,
  getStats,
  reclassifyFile,
  startSession,
  completeSession,
  resetDeltaCache,
  extractVolume,
  closeDb,
  DB_PATH,
};
