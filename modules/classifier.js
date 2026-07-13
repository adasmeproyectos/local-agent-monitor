'use strict';

const { registerDynamicCategory } = require('./db');

// ─── Adaptive Domain Profiles (Zero-Bias Dynamic Clustering) ──────────────────
// Agnostic to user background: autonomously discovers whether user works in
// Construction, Finance, Software Dev, Academia, Legal, Design, or Operations.

const DYNAMIC_PROFILES = [
  {
    cluster: 'Construcción & Obra',
    description: 'Proyectos de construcción, arquitectura, cubicaciones, licitaciones y planos',
    keywords: [
      'cubicación', 'cubicacion', 'licitación', 'licitacion', 'presupuesto de obra',
      'remodelación', 'remodelacion', 'plano', 'autocad', 'edificación', 'edificacion',
      'hormigón', 'hormigon', 'proyecto estructural', 'bim', 'revit', 'obra civil',
      'arquitectura', 'especificaciones técnicas', 'cubicaciones',
    ],
    subTagRules: [
      { tag: 'Licitaciones & Propuestas', keywords: ['licitación', 'licitacion', 'propuesta', 'bases técnicas'] },
      { tag: 'Cubicaciones & Presupuestos', keywords: ['cubicación', 'cubicacion', 'presupuesto', 'partidas', 'unitario'] },
      { tag: 'Planos & Obra Civil', keywords: ['plano', 'autocad', 'dwg', 'estructural', 'hormigón', 'edificación'] },
    ],
  },
  {
    cluster: 'Finanzas & Contable',
    description: 'Presupuestos corporativos, balances, facturación, auditorías e impuestos',
    keywords: [
      'presupuesto', 'factura', 'balance', 'flujo de caja', 'tributario', 'iva',
      'liquidación', 'contable', 'auditoría', 'auditoria', 'inversión', 'inversion',
      'rentabilidad', 'impuestos', 'asiento contable', 'finanzas', 'cotización',
      'balance general', 'estado de resultados',
    ],
    subTagRules: [
      { tag: 'Presupuestos & Cotizaciones', keywords: ['presupuesto', 'cotización', 'cotizacion', 'proyección'] },
      { tag: 'Facturación & Tributario', keywords: ['factura', 'iva', 'tributario', 'impuestos', 'sii'] },
      { tag: 'Auditoría & Balances', keywords: ['balance', 'auditoría', 'auditoria', 'flujo de caja', 'estado financiero'] },
    ],
  },
  {
    cluster: 'Desarrollo & Software',
    description: 'Proyectos de código, APIs, servidores, bases de datos y arquitectura de software',
    keywords: [
      'github', 'api', 'node', 'javascript', 'python', 'algoritmo', 'base de datos',
      'deploy', 'git', 'código', 'servidor', 'arquitectura de software', 'endpoint',
      'docker', 'react', 'typescript', 'sql', 'backend', 'frontend',
    ],
    subTagRules: [
      { tag: 'Código & Proyectos', keywords: ['github', 'git', 'javascript', 'python', 'react', 'node'] },
      { tag: 'APIs & Arquitectura', keywords: ['api', 'endpoint', 'arquitectura', 'servidor', 'backend'] },
      { tag: 'Bases de Datos & SQL', keywords: ['base de datos', 'sql', 'postgres', 'sqlite', 'query'] },
    ],
  },
  {
    cluster: 'Académico & Estudio',
    description: 'Tesis, investigaciones universitarias, evaluaciones, estadística y cátedras',
    keywords: [
      'universidad', 'facultad', 'tesis', 'tesina', 'trabajo final', 'examen',
      'evaluación', 'evaluacion', 'cátedra', 'catedra', 'regresión', 'regresion',
      'estadística', 'estadistica', 'investigación', 'investigacion', 'microeconomía',
      'estrategia', 'bibliografía', 'apuntes', 'syllabus', 'paper',
    ],
    subTagRules: [
      { tag: 'Tesis & Investigación', keywords: ['tesis', 'investigación', 'paper', 'bibliografía', 'marco teórico'] },
      { tag: 'Estadística & Modelos', keywords: ['regresión', 'estadística', 'econometría', 'distribución normal', 'varianza'] },
      { tag: 'Evaluaciones & Apuntes', keywords: ['examen', 'evaluación', 'apuntes', 'cátedra', 'parcial', 'syllabus'] },
    ],
  },
  {
    cluster: 'Legal & Corporativo',
    description: 'Contratos jurídicos, acuerdos notariales, resoluciones y normativas',
    keywords: [
      'contrato', 'cláusula', 'clausula', 'notarial', 'acuerdo', 'demanda',
      'estatutos', 'poder notarial', 'reglamento', 'resolución', 'resolucion',
      'jurisprudencia', 'abogado', 'legal', 'arrendamiento',
    ],
    subTagRules: [
      { tag: 'Contratos & Acuerdos', keywords: ['contrato', 'acuerdo', 'cláusula', 'arrendamiento'] },
      { tag: 'Normativa & Resoluciones', keywords: ['reglamento', 'resolución', 'estatutos', 'normativa'] },
    ],
  },
  {
    cluster: 'Diseño & Creativo',
    description: 'Identidad visual, UI/UX, renders, mockups y recursos gráficos',
    keywords: [
      'mockup', 'figma', 'vector', 'identidad visual', 'render', 'storyboard',
      'tipografía', 'tipografia', 'paleta', 'photoshop', 'illustrator', 'ui/ux',
    ],
    subTagRules: [
      { tag: 'UI & Visual Design', keywords: ['mockup', 'figma', 'ui/ux', 'tipografía'] },
      { tag: 'Renders & Media', keywords: ['render', 'storyboard', 'vector'] },
    ],
  },
  {
    cluster: 'Gestión & Operaciones',
    description: 'KPIs ejecutivos, diagramas Gantt, minutas y logística operacional',
    keywords: [
      'gantt', 'kpi', 'okr', 'agile', 'scrum', 'informe ejecutivo', 'minuta',
      'logística', 'logistica', 'inventario', 'proveedor', 'cadena de suministro',
    ],
    subTagRules: [
      { tag: 'Proyectos & KPI', keywords: ['gantt', 'kpi', 'okr', 'agile', 'scrum'] },
      { tag: 'Informes & Minutas', keywords: ['informe ejecutivo', 'minuta', 'logística'] },
    ],
  },
];

// Extension sets (lowercase)
const EXT_MAP = {
  Instaladores: new Set(['.exe', '.msi', '.msix', '.msixbundle', '.appx', '.pkg', '.dmg', '.deb', '.rpm']),
  Multimedia:   new Set([
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.psd', '.ai', '.svg',
  ]),
  Comprimidos:  new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.lz4', '.zst', '.cab']),
};

const INSTALLER_PATTERNS = [
  /^setup[_\-\s]/i,
  /[_\-\s]setup$/i,
  /^install[_\-\s]/i,
  /[_\-\s]installer?$/i,
  /[_\-\s]x64$|[_\-\s]x86$|[_\-\s]win(dows)?[_\-\s]/i,
];

const DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.txt', '.md', '.csv']);

// ─── Core Adaptive Classifier ─────────────────────────────────────────────────

function classify(filename, ext, textSample = '') {
  const nameLower = (filename || '').toLowerCase();
  const textLower = (textSample || '').toLowerCase();
  const combined  = nameLower + ' ' + textLower;

  // 1. Comprimidos
  if (EXT_MAP.Comprimidos.has(ext)) {
    return { cluster: 'Comprimidos', subTag: null, confidence: 1.0, matchedKeywords: [] };
  }

  // 2. Multimedia
  if (EXT_MAP.Multimedia.has(ext)) {
    return { cluster: 'Multimedia', subTag: null, confidence: 1.0, matchedKeywords: [] };
  }

  // 3. Instaladores
  if (EXT_MAP.Instaladores.has(ext) || ext === '.exe' || INSTALLER_PATTERNS.some(p => p.test(nameLower))) {
    return { cluster: 'Instaladores', subTag: null, confidence: 1.0, matchedKeywords: [] };
  }

  // 4. Dynamic Domain Profiler (Zero-Bias Semantic Analysis)
  if (DOC_EXTS.has(ext) || ext === '') {
    let bestProfile    = null;
    let maxMatches     = 0;
    let matchedKws     = [];

    for (const profile of DYNAMIC_PROFILES) {
      const matches = profile.keywords.filter(kw => combined.includes(kw));
      if (matches.length > maxMatches) {
        maxMatches  = matches.length;
        bestProfile = profile;
        matchedKws  = matches;
      }
    }

    if (bestProfile && maxMatches > 0) {
      // Register this newly discovered cluster into SQLite dynamic categories
      registerDynamicCategory(bestProfile.cluster, bestProfile.description);

      // Determine sub-tag based on specific sub-topic rules
      let subTag = 'Documentación General';
      for (const rule of bestProfile.subTagRules) {
        if (rule.keywords.some(k => combined.includes(k))) {
          subTag = rule.tag;
          break;
        }
      }

      const confidence = Math.min(0.55 + (maxMatches * 0.12), 0.98);
      return {
        cluster: bestProfile.cluster,
        subTag,
        confidence: Number(confidence.toFixed(2)),
        matchedKeywords: matchedKws.slice(0, 8),
      };
    }
  }

  // 5. Fallback for unclassified general documents
  return {
    cluster: 'Documentos Generales',
    subTag: ext ? `Archivo ${ext.toUpperCase()}` : 'Varios',
    confidence: 0.5,
    matchedKeywords: [],
  };
}

module.exports = { classify, DYNAMIC_PROFILES };
