function invalid() { throw Object.assign(new Error('文本编码无效或包含二进制内容，未读取或保存文件'), { code: 'FILE_TEXT_ENCODING_INVALID' }); }
function textEncoding(bytes) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) invalid();
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', bom: true, prefix: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', bom: true, prefix: 2 };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', bom: true, prefix: 3 };
  return { encoding: 'utf-8', bom: false, prefix: 0 };
}
function decodeText(bytes, partial = false) {
  const { encoding, bom, prefix } = textEncoding(bytes);
  let content;
  try { content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(prefix), { stream: partial }); }
  catch { invalid(); }
  if (content.includes('\0')) invalid();
  return { content, encoding, bom };
}
function encodeText(content, format = { encoding: 'utf-8', bom: false }) {
  if (typeof content !== 'string' || content.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)) invalid();
  if (!['utf-8', 'utf-16le', 'utf-16be'].includes(format.encoding)) invalid();
  let bytes = Buffer.from(content, format.encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (format.encoding === 'utf-16be') bytes = bytes.swap16();
  if (format.bom) bytes = Buffer.concat([Buffer.from(format.encoding === 'utf-8' ? [0xef, 0xbb, 0xbf] : format.encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
  return bytes;
}
module.exports = { textEncoding, decodeText, encodeText };
