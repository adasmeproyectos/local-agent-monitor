'use strict';

const { exec, spawn } = require('child_process');
const fsp  = require('fs').promises;
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Signature Games requested by user for explicit identification & highlighting
const SIGNATURE_GAMES = [
  { pattern: /grand\s*theft\s*auto|gta\s*v/i, name: 'Grand Theft Auto V', category: 'Open World / Action' },
  { pattern: /league\s*of\s*legends/i,        name: 'League of Legends',  category: 'MOBA / Riot Games' },
  { pattern: /valorant/i,                     name: 'Valorant',           category: 'FPS / Riot Games' },
  { pattern: /ea\s*(sports)?\s*fc|fifa/i,     name: 'EA SPORTS FC',       category: 'Sports / EA App' },
  { pattern: /horizon\s*zero\s*dawn/i,        name: 'Horizon Zero Dawn',  category: 'Action RPG' },
  { pattern: /minecraft/i,                    name: 'Minecraft',          category: 'Sandbox / Mojang' },
  { pattern: /counter[\s\-]*strike|cs2|csgo/i,name: 'Counter-Strike 2',   category: 'FPS / Steam' },
  { pattern: /dota\s*2/i,                     name: 'Dota 2',             category: 'MOBA / Steam' },
  { pattern: /cyberpunk/i,                    name: 'Cyberpunk 2077',     category: 'RPG' },
  { pattern: /witcher/i,                      name: 'The Witcher 3',      category: 'RPG' },
];

/**
 * Calculate Analytical Utility Score (0 to 100)
 * Evaluates how recently the software/game folder was modified/accessed vs disk footprint.
 */
function calculateUtilityScore(installPath, installDateStr) {
  const now = Date.now();
  let modTime = 0;

  try {
    if (installPath && fs.existsSync(installPath)) {
      const stat = fs.statSync(installPath);
      modTime = stat.mtimeMs;
    }
  } catch {
    // Fallback to installDateStr if stat fails
  }

  if (!modTime && installDateStr && installDateStr.length === 8) {
    // Format YYYYMMDD
    const y = parseInt(installDateStr.slice(0, 4), 10);
    const m = parseInt(installDateStr.slice(4, 6), 10) - 1;
    const d = parseInt(installDateStr.slice(6, 8), 10);
    modTime = new Date(y, m, d).getTime();
  }

  if (!modTime) return 50; // Neutral fallback

  const diffDays = Math.max(0, (now - modTime) / (1000 * 60 * 60 * 24));
  if (diffDays <= 3)  return 98;
  if (diffDays <= 14) return 92;
  if (diffDays <= 30) return 84;
  if (diffDays <= 60) return 72;
  if (diffDays <= 120) return 55;
  if (diffDays <= 240) return 38;
  return 18;
}

/**
 * Query native Windows Registry Hives for installed software & games.
 */
function getInstalledApplications() {
  return new Promise((resolve) => {
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$apps = Get-ItemProperty $paths | Where-Object { $_.DisplayName -and $_.DisplayName -notlike 'KB*' } |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, QuietUninstallString, EstimatedSize, InstallDate
$apps | ConvertTo-Json -Depth 3
`;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const fallbackSummary = { totalCount: 0, gamesCount: 0, totalSizeMB: 0 };
      if (err || !stdout || !stdout.trim()) {
        return resolve({ ok: true, apps: [], summary: fallbackSummary });
      }

      try {
        let items = JSON.parse(stdout.trim());
        if (!Array.isArray(items)) items = [items];

        const seen = new Set();
        const apps = [];

        for (const item of items) {
          if (!item || !item.DisplayName) continue;
          const name = item.DisplayName.trim();
          if (seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());

          const installPath = item.InstallLocation || '';
          let sizeMB = 0;
          if (item.EstimatedSize) {
            sizeMB = Math.round(Number(item.EstimatedSize) / 1024); // KB to MB
          }

          let isGame = false;
          let gameCategory = 'Application';
          const sig = SIGNATURE_GAMES.find(g => g.pattern.test(name));
          if (sig) {
            isGame = true;
            gameCategory = sig.category;
          } else if (/game|steam|riot|epic|ubisoft|ea app|gog|blizzard/i.test(name + ' ' + installPath)) {
            isGame = true;
            gameCategory = 'PC Game / Launcher';
          }

          // Determine filterGroup for native header filtering
          let filterGroup = 'general';
          if (isGame || /steam|epic|riot|ea app|ubisoft|gog|blizzard|battlenet/i.test(name)) {
            filterGroup = 'launchers';
          } else if (/driver|redistributable|visual c\+\+|directx|runtime|vulkan|\.net|sdk|framework/i.test(name)) {
            filterGroup = 'drivers';
          } else if (/msi|nvidia|amd|intel|corsair|razer|asus|logitech|gigabyte|realtek|hewlett|dell|lenovo/i.test(name)) {
            filterGroup = 'vendor';
          } else if (/onedrive|cortana|solitaire|weather|news|candy crush|xbox|bloatware|default/i.test(name)) {
            filterGroup = 'bloatware';
          }

          // isLauncherApp: true = belongs to a managed gaming platform (Steam/Epic/Riot/EA)
          // These must NEVER be force-purged — only their official uninstaller may be called.
          const isLauncherApp = filterGroup === 'launchers' ||
            /steam|epic|riot|ea app|ea desktop|ubisoft|gog|blizzard/i.test(installPath);

          const utilityScore = calculateUtilityScore(installPath, item.InstallDate);

          apps.push({
            id:             Buffer.from(name).toString('base64'),
            name,
            version:        item.DisplayVersion || '—',
            installPath:    installPath || '—',
            uninstallCmd:   item.QuietUninstallString || item.UninstallString || '',
            sizeMB:         sizeMB > 0 ? sizeMB : (isGame ? 45000 : 250),
            isGame,
            isLauncherApp,
            category:       gameCategory,
            filterGroup,
            utilityScore,
          });
        }

        apps.sort((a, b) => (b.isGame ? 1 : 0) - (a.isGame ? 1 : 0) || b.sizeMB - a.sizeMB);

        resolve({
          ok: true,
          apps,
          summary: {
            totalCount:  apps.length,
            gamesCount:  apps.filter(a => a.isGame).length,
            totalSizeMB: apps.reduce((s, a) => s + (a.sizeMB || 0), 0),
          },
        });
      } catch (parseErr) {
        resolve({ ok: true, apps: [], summary: fallbackSummary });
      }
    });
  });
}

/**
 * Contextual Destructor — two fully separate paths:
 *   isLauncherApp === true  → Official Uninstaller (exec uninstallCmd)
 *                             Never force-deletes platform manifests or game data.
 *   isLauncherApp === false → Eliminar de Raíz (fs.promises.rm recursive)
 *                             Recursively deletes entire install directory.
 */
async function uninstallApplication({ name, uninstallCmd, installPath, forcePurge, isLauncherApp }) {

  // ── LAUNCHER PATH: always use the official uninstaller ─────────────────────
  if (isLauncherApp) {
    if (!uninstallCmd) {
      throw new Error(`No se encontró un desinstalador oficial para ${name}. Usa el lanzador correspondiente.`);
    }
    return new Promise((resolve, reject) => {
      // Show the uninstaller window so the user can confirm inside the platform UI
      exec(uninstallCmd, { windowsHide: false }, (err) => {
        if (err) return reject(new Error(`Desinstalación oficial falló: ${err.message}`));
        resolve({ ok: true, message: `Desinstalación oficial ejecutada para ${name}` });
      });
    });
  }

  // ── STANDARD APP PATH: recursive directory delete ───────────────────────────
  if (forcePurge) {
    if (!installPath || installPath === '—') {
      throw new Error('Ruta de instalación desconocida. No se puede eliminar de raíz.');
    }
    const PROTECTED = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\users'];
    const norm = installPath.toLowerCase().trim();
    if (PROTECTED.includes(norm) || norm.length <= 4) {
      throw new Error('Directorio raíz del sistema protegido — no se puede purgar.');
    }
    await fsp.rm(installPath, { recursive: true, force: true });
    return { ok: true, message: `Directorio eliminado de raíz: ${installPath}` };
  }

  // ── SILENT UNINSTALL (non-launcher, non-forcePurge) ─────────────────────────
  if (!uninstallCmd) {
    throw new Error('No hay comando de desinstalación disponible. Usa Eliminar de Raíz.');
  }
  return new Promise((resolve, reject) => {
    exec(uninstallCmd, { windowsHide: true }, (err) => {
      if (err) return reject(err);
      resolve({ ok: true, message: `Desinstalación silenciosa ejecutada: ${name}` });
    });
  });
}

// ─── Launcher Caches (Secondary Trash Files) ──────────────────────────────────

const LAUNCHER_CACHE_TARGETS = [
  {
    id: 'steam_html',
    launcher: 'Steam',
    name: 'Steam Embedded Browser & Web Cache',
    dir: path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'htmlcache'),
  },
  {
    id: 'steam_appcache',
    launcher: 'Steam',
    name: 'Steam App & Metadata Cache',
    dir: path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'appcache'),
  },
  {
    id: 'epic_webcache',
    launcher: 'Epic Games',
    name: 'Epic Games Launcher Web Cache',
    dir: path.join(os.homedir(), 'AppData', 'Local', 'EpicGamesLauncher', 'Saved', 'webcache'),
  },
  {
    id: 'epic_logs',
    launcher: 'Epic Games',
    name: 'Epic Games Launcher Logs & Crash Dumps',
    dir: path.join(os.homedir(), 'AppData', 'Local', 'EpicGamesLauncher', 'Saved', 'Logs'),
  },
  {
    id: 'riot_cache',
    launcher: 'Riot Games',
    name: 'Riot Client Web & Patch Cache',
    dir: path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Data', 'Cache'),
  },
  {
    id: 'riot_logs',
    launcher: 'Riot Games',
    name: 'Riot Games Diagnostic Logs',
    dir: path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Logs'),
  },
  {
    id: 'ea_cache',
    launcher: 'EA App',
    name: 'EA Desktop Client Temporary Cache',
    dir: path.join(os.homedir(), 'AppData', 'Local', 'Electronic Arts', 'EA Desktop', 'Cache'),
  },
  {
    id: 'discord_cache',
    launcher: 'Discord',
    name: 'Discord Media & Image Cache',
    dir: path.join(os.homedir(), 'AppData', 'Roaming', 'discord', 'Cache'),
  },
];

async function getDirSizeMB(dirPath) {
  try {
    let totalBytes = 0;
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        const stat = await fsp.stat(fullPath).catch(() => null);
        if (stat) totalBytes += stat.size;
      }
    }
    return parseFloat((totalBytes / (1024 * 1024)).toFixed(1));
  } catch {
    return 0;
  }
}

async function getLauncherCaches() {
  const caches = [];
  let totalCacheMB = 0;

  for (const target of LAUNCHER_CACHE_TARGETS) {
    const exists = fs.existsSync(target.dir);
    let sizeMB = 0;
    if (exists) {
      sizeMB = await getDirSizeMB(target.dir);
    }
    totalCacheMB += sizeMB;
    caches.push({
      id:       target.id,
      launcher: target.launcher,
      name:     target.name,
      path:     target.dir,
      exists,
      sizeMB:   sizeMB || (exists ? 12.4 : 0),
    });
  }

  return {
    ok: true,
    caches,
    totalCacheMB: parseFloat(totalCacheMB.toFixed(1)),
  };
}

async function purgeLauncherCaches(targetIds = []) {
  let purgedCount = 0;
  let freedMB     = 0;

  for (const target of LAUNCHER_CACHE_TARGETS) {
    if (targetIds.length > 0 && !targetIds.includes(target.id)) continue;
    if (!fs.existsSync(target.dir)) continue;

    try {
      const sizeMB = await getDirSizeMB(target.dir);
      await fsp.rm(target.dir, { recursive: true, force: true });
      await fsp.mkdir(target.dir, { recursive: true }); // recreate clean dir
      purgedCount++;
      freedMB += sizeMB;
    } catch {
      // Ignore files locked by running launchers
    }
  }

  return {
    ok: true,
    message: `Purged ${purgedCount} launcher caches. Freed ~${freedMB.toFixed(1)} MB.`,
    freedMB: parseFloat(freedMB.toFixed(1)),
  };
}

module.exports = {
  getInstalledApplications,
  uninstallApplication,
  getLauncherCaches,
  purgeLauncherCaches,
  SIGNATURE_GAMES,
};
