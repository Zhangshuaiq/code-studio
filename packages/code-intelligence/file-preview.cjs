const fs = require("node:fs");
const path = require("node:path");
const { fileLanguage, registry } = require('./file-type.cjs');
const { decodeText } = require('./file-text.cjs');
const IMAGE_MIME = new Map(Object.entries(registry.images).map(([extension, mime]) => ['.' + extension, mime]));

function describeFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (IMAGE_MIME.has(extension)) return { kind: 'image', mime: IMAGE_MIME.get(extension) };
  if (extension === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (extension === '.xlsx' || extension === '.csv') return { kind: 'spreadsheet', mime: extension === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (extension === '.xls') return { kind: 'unsupported', mime: 'application/vnd.ms-excel', reason: '旧版 .xls 暂不支持，请另存为 .xlsx 或 .csv' };
  if (Object.hasOwn(registry.binary, extension.slice(1))) return { kind: 'unsupported', mime: 'application/octet-stream', reason: `${registry.binary[extension.slice(1)]}暂不支持工作区内预览`, fileType: registry.binary[extension.slice(1)] };
  const sample = Buffer.alloc(8_192); let bytes = 0; const descriptor = fs.openSync(file, 'r');
  try { bytes = fs.readSync(descriptor, sample, 0, sample.length, 0); } finally { fs.closeSync(descriptor); }
  const content = sample.subarray(0, bytes);
  let decoded;
  try { decoded = decodeText(content, bytes === sample.length); }
  catch { return { kind: 'unsupported', mime: 'application/octet-stream', reason: '该二进制格式或文本编码暂不支持预览' }; }
  // Valid UTF-8 alone is not enough: binary data can contain ASCII control bytes.
  // Keep normal whitespace (including CRLF and form feed used by source files).
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(decoded.content))
    return { kind: 'unsupported', mime: 'application/octet-stream', reason: '该文件包含二进制控制字符，不能作为文本编辑' };
  let language = fileLanguage(file);
  if (language === 'plaintext') {
    const firstLine = decoded.content.split('\n', 1)[0];
    if (/^#!.*\b(?:bash|sh|zsh|ksh|fish)\b/.test(firstLine)) language = 'shell';
    else if (/^#!.*\bpython[\d.]*\b/.test(firstLine)) language = 'python';
    else if (/^#!.*\bnode\b/.test(firstLine)) language = 'javascript';
  }
  return { kind: 'text', mime: `${registry.mime[language] || 'text/plain'}; charset=${decoded.encoding}`, language, encoding: decoded.encoding, bom: decoded.bom, ...(language === 'markdown' ? { preview: 'markdown' } : {}) };
}

async function readSpreadsheet(file, workbook) {
  if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Spreadsheet exceeds input budget');
  if (path.extname(file).toLowerCase() === '.csv') await workbook.csv.readFile(file);
  else { await validateSpreadsheetArchive(file); await workbook.xlsx.readFile(file); }
  let truncated = workbook.worksheets.length > 20;
  let remainingBytes = 4 * 1024 * 1024;
  const sheets = workbook.worksheets.slice(0, 20).map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > 500 || remainingBytes <= 0) { truncated = true; return; }
      const values = [];
      for (let column = 1; column <= Math.min(row.cellCount, 100); column += 1) {
        const fullCell = spreadsheetCell(row.getCell(column).value);
        const cell = fullCell.slice(0, 10000);
        if (fullCell.length > cell.length) truncated = true;
        const bytes = Buffer.byteLength(JSON.stringify(cell), 'utf8') + 1;
        if (bytes > remainingBytes) { remainingBytes = 0; truncated = true; break; }
        remainingBytes -= bytes; values.push(cell);
      }
      if (row.cellCount > 100) truncated = true;
      rows.push(values);
    });
    return { name: sheet.name, rows };
  });
  return { sheets, truncated, limits: { sheets: 20, rows: 500, columns: 100, cellCharacters: 10000, displayBytes: 4 * 1024 * 1024 } };
}

// Check and stream every ZIP entry before ExcelJS allocates a workbook. This
// rejects compressed expansion bombs, forged entry sizes and encrypted input.
function validateSpreadsheetArchive(file) {
  return new Promise((resolve, reject) => {
    require('yauzl').open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let entries = 0, total = 0, settled = false;
      const fail = error => { if (!settled) { settled = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', entry => {
        if (++entries > 10000 || entry.uncompressedSize > 64 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) return fail(new Error('Spreadsheet ZIP budget exceeded'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          stream.on('error', fail);
          stream.on('data', chunk => { total += chunk.length; if (total > 64 * 1024 * 1024) { stream.destroy(); fail(new Error('Spreadsheet expansion budget exceeded')); } });
          stream.on('end', () => { if (!settled) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function spreadsheetCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) return spreadsheetCell(value.result);
    if ('text' in value) return String(value.text);
    if ('richText' in value) return value.richText.map((item) => item.text || '').join('');
    if ('hyperlink' in value) return String(value.text || value.hyperlink);
    return JSON.stringify(value);
  }
  return String(value);
}
module.exports = { describeFile, readSpreadsheet };
