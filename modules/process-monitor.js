'use strict';

const { spawn } = require('child_process');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════════════════
//  THREAT HEURISTIC ENGINE v2 — Advanced Detection with Silent Monetization
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Heuristic Weights ────────────────────────────────────────────────────────
const WEIGHTS = {
  TEMP_PATH:              35,  // Running from %TEMP% or AppData\Local\Temp
  APPDATA_ROAMING:        25,  // Non-whitelisted AppData\Roaming persistence
  ENTROPY_NAME:           20,  // Random-looking exe name (low vowel ratio)
  HIGH_CPU:               30,  // CPU > 25% sustained
  HIGH_RAM_HIDDEN:        15,  // RAM > 500MB + no company signature
  NO_PATH:                30,  // Path unreadable (may be admin-protected, not hollow)
  SILENT_MONETIZATION:    80,  // Background P2P/bandwidth-sharing/mining daemon
  MINER_KEYWORD_PATH:     60,  // Miner keyword found in exe path
  MINER_KEYWORD_DESC:     55,  // Miner keyword in process description/company
  SUSPICIOUS_PORT_MARKER: 40,  // Known stratum/mining port in process name/desc
};

// Threat level thresholds
const THREAT = {
  CRITICAL:   70,
  SUSPICIOUS: 40,
  CLEAN:       0,
};

// ─── Verified MSI Hardware Whitelist ─────────────────────────────────────────
// These MSI system utilities show NO_PATH due to kernel-protected modules.
// They are verified OEM hardware tools — not flagged.
const MSI_VERIFIED = new Set([
  'ledkeeper2',         // MSI Mystic Light / RGB LED controller
  'nvsphelper64',       // NVIDIA ShadowPlay helper service
  'msi.terminalserver', // MSI Remote Desktop / Dragon Center service
  'msi_lan_manager_tool',// MSI LAN Manager network QoS tool
  'x6',                 // MSI X6 game controller service
  'nahimicservice',     // MSI Nahimic audio service
  'msibg',              // MSI background service
  'msiafterburner',     // MSI Afterburner GPU OC tool
  'rtss',               // RivaTuner Statistics Server (bundled with AB)
  'networx',            // NetWorX bandwidth meter (bundled)
]);

// ─── Full Process Whitelist ──────────────────────────────────────────────────
// Known-safe process names (lowercase). Never flagged regardless of heuristics.
const WHITELIST = new Set([
  // Windows core
  'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'dwm', 'explorer', 'taskhostw', 'conhost', 'sihost',
  'searchindexer', 'spoolsv', 'wuauclt', 'ctfmon', 'fontdrvhost',
  'runtimebroker', 'applicationframehost', 'securityhealthservice',
  'securityhealthsystray', 'shellexperiencehost', 'startmenuexperiencehost',
  'audiodg', 'dllhost', 'wermgr', 'wlanext', 'dashost', 'uhssvc',
  'msiexec', 'taskeng', 'taskmgr', 'regedit', 'cmd', 'powershell',
  'wsl', 'wslhost', 'vmmem', 'vmcompute',
  // This app
  'node', 'node.exe',
  // Browsers
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'iexplore',
  // IDEs & Dev
  'code', 'code.exe', 'electron', 'devenv', 'idea64', 'pycharm64',
  // Comms
  'discord', 'teams', 'slack', 'zoom', 'telegram', 'signal',
  // Gaming platforms
  'steam', 'steamwebhelper', 'gameoverlayui', 'steamservice',
  'epicgameslauncher', 'easyanticheat', 'battleye',
  'gog', 'gogalaxy', 'xboxapp', 'gamingservices',
  // GPU / drivers
  'nvcontainer', 'nvdisplay.container', 'nvcplui', 'nvtelemetrycontainer',
  'amdow', 'radeonupdate', 'amdrsserv', 'ccc',
  // AV / Security
  'mbam', 'avastui', 'avgsvc', 'avgui', 'mcshield', 'msseces', 'msmpeng',
  'bdagent', 'ekrn', 'nod32', 'kaspersky',
  // MSI verified OEM
  ...MSI_VERIFIED,
  // Streaming
  'sunshine', 'obs64', 'obs32',
]);

// ─── Crypto Miner Signatures ─────────────────────────────────────────────────
// Exact process name matches (lowercase, no extension)
const MINER_EXACT = new Set([
  'xmrig', 'xmr-stak', 'xmrstak', 'ethminer', 'claymore', 'claymoreminer',
  'phoenixminer', 'nbminer', 'gminer', 't-rex', 'lolminer', 'minerd',
  'cpuminer', 'cpuminer-opt', 'bfgminer', 'cgminer', 'ccminer', 'sgminer',
  'kawpowminer', 'nanominer', 'wildrig', 'srbminer', 'teamredminer',
  'minizcpuminer', 'cryptonote', 'xmr', 'randomx', 'stratum',
]);

// ─── Silent Monetization / Bandwidth-Sharing / P2P Backdoor Signatures ───────
// These are legitimate-looking programs that silently sell your bandwidth,
// compute, or act as proxy nodes without clear disclosure.
const MONETIZATION_EXACT = new Set([
  // Bandwidth sharing
  'honeygain',          // Honeygain — sells your internet bandwidth
  'honeygainservice',
  'pawns',              // Pawns.app (formerly IPRoyal Pawns) — bandwidth sale
  'iproyal',
  'iproyalpawns',
  'packetstream',       // PacketStream — bandwidth resale
  'psclient',
  'traffmonetizer',     // TraffMonetizer — bandwidth resale
  'earnapp',            // EarnApp by Bright Data — bandwidth proxy
  'bright',
  'brightdata',
  'luminati',           // Luminati (now Bright Data) — proxy network
  'peer2profit',        // Peer2Profit — bandwidth monetization
  'myst',               // Mysterium Network — decentralized VPN/proxy
  'mysterium',
  'repocket',           // Repocket — bandwidth sharing
  'flowbucks',          // FlowBucks — bandwidth sharing
  'grass',              // Grass — web scraping proxy network
  // Compute sharing / cloud mining
  'nicehash',           // NiceHash — GPU rental / mining
  'nicehashquickminer',
  'nhm',
  'cudo',               // Cudo Miner — CPU/GPU mining
  'cudominer',
  'kryptex',            // Kryptex — background GPU mining
  'kryptexagent',
  'honeyminer',         // Honey Miner
  'unmineable',
  // Silent P2P / Botnets disguised as helpers
  'p2phelper',
  'p2pclient',
  'p2pservice',
  'bitworker',
]);

// ─── Keyword Patterns (substring match on name/path/description) ──────────────
const MONETIZATION_KEYWORDS = [
  'honeygain', 'pawns', 'packetstream', 'traffmonetizer', 'earnapp',
  'luminati', 'brightdata', 'peer2profit', 'mysterium', 'repocket',
  'nicehash', 'kryptex', 'cudominer', 'unmineable',
  'bandwidth sharing', 'passive income', 'sell bandwidth',
  'stratum+tcp', 'pool.minexmr', 'xmrpool', 'supportxmr',
  'nanopool', 'ethermine', 'f2pool', '2miners',
];

const MINER_KEYWORDS = [
  'xmrig', 'xmrstak', 'minerd', 'cryptonight', 'randomx', 'kawpow',
  'ethminer', 'stratum', 'mining', 'miner', 'cpuminer', 'gpuminer',
  'hashrate', 'monero', 'zcash', 'ravencoin', 'ergo',
];

// ─── Entropy Heuristic ────────────────────────────────────────────────────────
function hasHighEntropy(name) {
  const n = name.replace(/\.(exe|dll|com|bat|cmd|scr|vbs|ps1)$/i, '').toLowerCase();
  if (n.length < 5 || n.length > 20) return false;
  const vowels = (n.match(/[aeiou]/g) || []).length;
  const ratio  = vowels / n.length;
  return ratio < 0.1 && /^[a-z0-9]+$/.test(n);
}

// ─── Path Heuristics ─────────────────────────────────────────────────────────
const tempRoot    = (os.tmpdir() || 'C:\\Windows\\Temp').toLowerCase();
const appDataPath = (process.env.APPDATA     || '').toLowerCase();
const localApp    = (process.env.LOCALAPPDATA || '').toLowerCase();

function isFromTemp(p) {
  if (!p) return false;
  const lp = p.toLowerCase();
  return lp.includes('\\temp\\') || lp.includes('\\tmp\\') || lp.startsWith(tempRoot);
}

function isFromAppDataRoaming(p) {
  if (!p) return false;
  const lp = p.toLowerCase();
  const SAFE_ROAMING = [
    '\\microsoft\\', '\\discord\\', '\\teams\\', '\\slack\\',
    '\\zoom\\', '\\code\\', '\\spotify\\', '\\obs\\', '\\telegram\\',
  ];
  return lp.startsWith(appDataPath) && !SAFE_ROAMING.some(s => lp.includes(s));
}

// ─── Keyword Scanner ──────────────────────────────────────────────────────────
function containsKeyword(haystack, keywords) {
  const h = (haystack || '').toLowerCase();
  return keywords.find(kw => h.includes(kw)) || null;
}

// ─── PowerShell Bridge (Elevated-Aware) ──────────────────────────────────────
// Uses $ErrorActionPreference = SilentlyContinue so protected kernel processes
// don't abort the pipeline. When running elevated (admin), MainModule.FileName
// resolves for all user-space processes.
const PS_CMD = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-Process | Where-Object { $_.Id -gt 4 }
$result = foreach ($p in $procs) {
  $path = $null; $desc = ''; $company = ''
  try {
    $m = $p.MainModule
    if ($m) {
      $path    = $m.FileName
      $fvi     = $m.FileVersionInfo
      if ($fvi) { $desc = [string]$fvi.FileDescription; $company = [string]$fvi.CompanyName }
    }
  } catch {}
  [PSCustomObject]@{
    Name       = $p.ProcessName
    Id         = $p.Id
    CPU        = if ($p.CPU) { [math]::Round($p.CPU,2) } else { 0 }
    WorkingSet = [math]::Round($p.WorkingSet64 / 1MB, 2)
    Path       = $path
    Description= $desc
    Company    = $company
    CommandLine= ''
  }
}
$result | ConvertTo-Json -Depth 2 -Compress
`.trim();

async function getRawProcesses() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_CMD,
    ], { windowsHide: true });

    let stdout = '';
    ps.stdout.on('data', d => { stdout += d.toString(); });
    ps.stderr.on('data', () => {});

    ps.on('close', () => {
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        let raw = JSON.parse(trimmed);
        if (!Array.isArray(raw)) raw = [raw];
        resolve(raw.filter(p => p && p.Name));
      } catch (e) {
        console.error('[process-monitor] JSON parse error:', e.message);
        resolve([]);
      }
    });

    const timer = setTimeout(() => { try { ps.kill(); } catch {} resolve([]); }, 20000);
    ps.on('close', () => clearTimeout(timer));
  });
}

// ─── Core Heuristic Scorer ────────────────────────────────────────────────────
function scoreProcess(proc) {
  const nameLower  = (proc.Name        || '').toLowerCase().replace(/\.exe$/i, '');
  const pathLower  = (proc.Path        || '').toLowerCase();
  const descLower  = (proc.Description || '').toLowerCase();
  const compLower  = (proc.Company     || '').toLowerCase();
  const combined   = `${nameLower} ${pathLower} ${descLower} ${compLower}`;

  // ── 1. Full whitelist bypass ──────────────────────────────────────────────
  if (WHITELIST.has(nameLower) || WHITELIST.has(nameLower + '.exe')) {
    return { score: 0, flags: [], threatLevel: 'Clean', category: 'Sistema / Verificado' };
  }

  // ── 2. MSI verified — show as clean with note ────────────────────────────
  if (MSI_VERIFIED.has(nameLower)) {
    return { score: 0, flags: ['✅ Herramienta Hardware OEM MSI Verificada'], threatLevel: 'Clean', category: 'Hardware OEM' };
  }

  // ── 3. Known crypto miner — INSTANT CRITICAL ────────────────────────────
  if (MINER_EXACT.has(nameLower)) {
    return {
      score: 100,
      flags: ['🔴 MINERO DE CRIPTOMONEDAS DETECTADO — Finalizar de inmediato'],
      threatLevel: 'CRITICAL',
      category: 'Minería no autorizada',
    };
  }

  // ── 4. Known silent monetization daemon — INSTANT CRITICAL ───────────────
  if (MONETIZATION_EXACT.has(nameLower)) {
    return {
      score: 100,
      flags: ['⚠️ PUERTA TRASERA DE MONETIZACIÓN SILENCIOSA — Compartiendo ancho de banda o recursos sin consentimiento'],
      threatLevel: 'CRITICAL',
      category: 'Monetización oculta',
    };
  }

  const flags = [];
  let score   = 0;

  // ── 5. Keyword scan: miner in path/description ───────────────────────────
  const minerKw = containsKeyword(combined, MINER_KEYWORDS);
  if (minerKw) {
    score += WEIGHTS.MINER_KEYWORD_PATH;
    flags.push(`🔴 PALABRA CLAVE DE MINERÍA DETECTADA: "${minerKw}"`);
  }

  // ── 6. Keyword scan: silent monetization in path/description ─────────────
  const monetKw = containsKeyword(combined, MONETIZATION_KEYWORDS);
  if (monetKw) {
    score += WEIGHTS.SILENT_MONETIZATION;
    flags.push(`⚠️ PALABRA CLAVE DE MONETIZACIÓN SILENCIOSA: "${monetKw}"`);
  }

  // ── 7. Path anomaly checks ────────────────────────────────────────────────
  if (!proc.Path) {
    // NO_PATH: could be elevated-protected kernel module or hollow injection
    score += WEIGHTS.NO_PATH;
    flags.push('NO_PATH (módulo protegido de administrador o proceso oculto)');
  } else {
    if (isFromTemp(proc.Path)) {
      score += WEIGHTS.TEMP_PATH;
      flags.push('📂 EJECUCIÓN EN TEMP — Ejecutándose desde directorio temporal');
    }
    if (isFromAppDataRoaming(proc.Path)) {
      score += WEIGHTS.APPDATA_ROAMING;
      flags.push('📂 APPDATA ROAMING — Ubicación persistente no verificada');
    }
  }

  // ── 8. Name entropy check ─────────────────────────────────────────────────
  if (hasHighEntropy(proc.Name)) {
    score += WEIGHTS.ENTROPY_NAME;
    flags.push('🎲 NOMBRE ALTAMENTE ALEATORIO — Posible binario ofuscado');
  }

  // ── 9. Resource anomaly checks ────────────────────────────────────────────
  const cpu   = Number(proc.CPU)       || 0;
  const ramMB = Number(proc.WorkingSet) || 0;

  if (cpu > 25) {
    score += WEIGHTS.HIGH_CPU;
    flags.push(`🔥 ALTO CONSUMO DE CPU: ${cpu.toFixed(1)}% — Posible uso excesivo de cómputo`);
  }

  if (ramMB > 500 && !proc.Company) {
    score += WEIGHTS.HIGH_RAM_HIDDEN;
    flags.push(`💾 ALTO CONSUMO DE RAM SIN FIRMA: ${ramMB.toFixed(0)} MB — Proceso pesado no verificado`);
  }

  score = Math.min(score, 100);

  let threatLevel = 'Clean';
  let category    = 'Normal';
  if (score >= THREAT.CRITICAL)        { threatLevel = 'CRITICAL';   category = 'Amenaza Crítica'; }
  else if (score >= THREAT.SUSPICIOUS) { threatLevel = 'Suspicious'; category = 'Sospechoso / Revisar'; }
  else                                 { category = 'Limpio'; }

  return { score, flags, threatLevel, category };
}

// ─── Admin Privilege Check ────────────────────────────────────────────────────
async function checkIsAdmin() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => resolve(out.trim().toLowerCase() === 'true'));
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────
async function getProcessSnapshot() {
  const [raw, isAdmin] = await Promise.all([getRawProcesses(), checkIsAdmin()]);

  const scored = raw.map(proc => {
    const { score, flags, threatLevel, category } = scoreProcess(proc);
    return {
      name:        proc.Name,
      pid:         proc.Id,
      cpu:         proc.CPU        || 0,
      ramMB:       proc.WorkingSet || 0,
      path:        proc.Path       || null,
      description: proc.Description || '',
      company:     proc.Company     || '',
      score,
      flags,
      threatLevel,
      category,
    };
  });

  // Sort: critical → suspicious → clean, then by score desc, then CPU desc
  const LEVEL_ORDER = { CRITICAL: 0, Suspicious: 1, Clean: 2 };
  scored.sort((a, b) => {
    const ld = (LEVEL_ORDER[a.threatLevel] ?? 2) - (LEVEL_ORDER[b.threatLevel] ?? 2);
    if (ld !== 0) return ld;
    const sd = b.score - a.score;
    return sd !== 0 ? sd : b.cpu - a.cpu;
  });

  const summary = {
    total:      scored.length,
    critical:   scored.filter(p => p.threatLevel === 'CRITICAL').length,
    suspicious: scored.filter(p => p.threatLevel === 'Suspicious').length,
    clean:      scored.filter(p => p.threatLevel === 'Clean').length,
    isAdmin,
    scannedAt:  new Date().toISOString(),
  };

  return { processes: scored, summary };
}

module.exports = { getProcessSnapshot };
