'use strict';

const fs       = require('fs');
const fsp      = require('fs').promises;
const path     = require('path');
const pdfParse = require('pdf-parse');
const unzipper = require('unzipper');

const ARCHIVE_EXTS    = new Set(['.zip', '.jar', '.docx', '.xlsx', '.pptx', '.odt', '.epub']);
const PDF_SLICE_BYTES = 8192;   // 8 KB — zero-cost token budget
const PDF_MAX_PAGES   = 8;      // generous ceiling for title/abstract capture
const MAX_PDF_SIZE    = 150 * 1024 * 1024; // skip PDFs > 150 MB (likely corrupted binaries)

// ─── PDF Extraction ───────────────────────────────────────────────────────────
/**
 * Extract the first PDF_SLICE_BYTES of text via direct fs.readFile().
 * Uses a custom pagerender callback that halts after the text budget is spent
 * so large documents don't block the crawler pipeline.
 */
async function extractPdf(filePath) {
  try {
    // Stat before reading to avoid loading huge files
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || stat.size > MAX_PDF_SIZE) {
      return { textSample: '', info: {} };
    }

    // Direct Buffer read — bypasses any CORS / browser restriction
    const buffer = await fsp.readFile(filePath);

    let accumulated = '';
    const options = {
      // Bail-out pagerender: stop processing pages once budget consumed
      pagerender(pageData) {
        if (accumulated.length >= PDF_SLICE_BYTES) return Promise.resolve('');
        return pageData.getTextContent().then(tc => {
          const pageText = tc.items.map(i => i.str).join(' ');
          accumulated += pageText + ' ';
          return pageText;
        });
      },
      max: PDF_MAX_PAGES,
      // Suppress pdfjs internal warnings (broken xref, encoding mismatches)
      verbosity: 0,
    };

    const data = await pdfParse(buffer, options);

    // Prefer pdfParse full text (it reassembles across pages), fallback to accumulated
    const rawText = data.text || accumulated;

    return {
      textSample: rawText.slice(0, PDF_SLICE_BYTES).trim(),
      info: {
        title:    data.info?.Title    || '',
        author:   data.info?.Author   || '',
        subject:  data.info?.Subject  || '',
        keywords: data.info?.Keywords || '',
        creator:  data.info?.Creator  || '',
        pages:    data.numpages       || 0,
      },
    };
  } catch (err) {
    // Swallow all errors (encrypted, corrupt, password-protected PDFs)
    // so one bad file never stalls the crawler pipeline
    return { textSample: '', info: {} };
  }
}

// ─── Archive Manifest Extraction ──────────────────────────────────────────────
/**
 * Read ZIP central-directory entries without decompressing any content.
 */
async function extractZipManifest(filePath) {
  try {
    const dir = await unzipper.Open.file(filePath);
    const entries = (dir.files || []).slice(0, 60).map(e => e.path);
    return {
      textSample: entries.join(' '),
      info: { entryCount: (dir.files || []).length },
    };
  } catch {
    return { textSample: '', info: {} };
  }
}

// ─── Main Extractor ───────────────────────────────────────────────────────────
/**
 * Extract metadata from any supported file type.
 *
 * @param {string} filePath  - Absolute path to file
 * @param {string} ext       - Lowercase extension (e.g. ".pdf")
 * @returns {{ textSample, info, size, mtime }}
 */
async function extractMetadata(filePath, ext) {
  let textSample = '';
  let info       = {};
  let size       = 0;
  let mtime      = new Date().toISOString();

  try {
    const stat = await fsp.stat(filePath);
    size  = stat.size;
    mtime = stat.mtime.toISOString();
  } catch {
    return { textSample, info, size, mtime };
  }

  if (size > 4 * 1024 * 1024 * 1024) {
    return { textSample, info, size, mtime };
  }

  try {
    if (ext === '.pdf') {
      ({ textSample, info } = await extractPdf(filePath));
    } else if (ARCHIVE_EXTS.has(ext)) {
      ({ textSample, info } = await extractZipManifest(filePath));
    }
  } catch {
    // Intentionally swallowed — pipeline must not crash on a single file
  }

  return { textSample, info, size, mtime };
}

module.exports = { extractMetadata };
