const { TextDecoder } = require('node:util');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value));
function displayBuffer(value) {
  const buffer = bytes(value);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('binary');
    return { value: text, encoding: 'utf8', bytes: buffer.length };
  } catch { return { value: buffer.toString('base64'), encoding: 'base64', bytes: buffer.length }; }
}
module.exports = { bytes, displayBuffer };
