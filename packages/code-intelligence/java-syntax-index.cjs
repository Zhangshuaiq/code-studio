const { Parser, Language } = require('web-tree-sitter');
const path = require('node:path');
const PARSER_VERSION = 'web-tree-sitter@0.27.1/java@0.23.5/extractor@2/text-codec@1';
const TYPES = new Map([
  ['class_declaration', 'class'], ['interface_declaration', 'interface'],
  ['enum_declaration', 'enum'], ['record_declaration', 'record'],
  ['annotation_type_declaration', 'annotation'],
]);
let languagePromise;
function loadLanguage() {
  if (!languagePromise) languagePromise = (async () => {
    await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/web-tree-sitter.wasm') });
    return Language.load(require.resolve('tree-sitter-java/tree-sitter-java.wasm'));
  })().catch(error => { languagePromise = undefined; throw error; });
  return languagePromise;
}

class JavaSyntaxIndex {
  static async create() {
    const language = await loadLanguage();
    const parser = new Parser();
    try { parser.setLanguage(language); return new JavaSyntaxIndex(parser); }
    catch (error) { parser.delete(); throw error; }
  }
  constructor(parser) { this.parser = parser; this.closed = false; }
  close() { if (!this.closed) { this.closed = true; this.parser.delete(); } }
  parse(source, filePath, options = {}) {
    if (this.closed) throw new Error('Java syntax parser is closed');
    if (typeof source !== 'string' || typeof filePath !== 'string' || !filePath.endsWith('.java')) throw new TypeError('Java source and relative .java path are required');
    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) throw new TypeError('Only workspace-relative paths are supported');
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const maxNodes = options.maxNodes ?? 100000;
    const maxSymbols = options.maxSymbols ?? 10000;
    const budgetMs = options.budgetMs ?? 2000;
    for (const limit of [maxBytes, maxNodes, maxSymbols, budgetMs]) if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Parser budgets must be positive integers');
    if (Buffer.byteLength(source, 'utf8') > maxBytes) throw Object.assign(new Error('Java file exceeds syntax parsing byte budget'), { code: 'FAST_INDEX_FILE_TOO_LARGE' });
    const deadline = Date.now() + budgetMs;
    // The grammar terminates line comments at LF. Normalize lone CR using a
    // same-width character so Java line endings work without changing offsets.
    const tree = this.parser.parse(source.replace(/\r(?!\n)/g, '\n'), null, { progressCallback: () => Date.now() > deadline });
    if (!tree) { this.parser.reset(); throw Object.assign(new Error('Java syntax parsing exceeded time budget'), { code: 'FAST_INDEX_PARSE_TIMEOUT' }); }
    try {
      const lineStarts = [0];
      for (let i = 0; i < source.length; i++) {
        if (source.charCodeAt(i) === 10 || (source.charCodeAt(i) === 13 && source.charCodeAt(i + 1) !== 10)) lineStarts.push(i + 1);
      }
      const point = index => {
        let low = 0, high = lineStarts.length;
        while (low + 1 < high) { const mid = (low + high) >> 1; if (lineStarts[mid] <= index) low = mid; else high = mid; }
        return { line: low + 1, column: index - lineStarts[low] + 1 };
      };
      // The pinned JS/WASM binding exposes UTF-16 string offsets, not UTF-8
      // byte offsets. Validate slicing and derive coordinates from those offsets.
      const range = node => ({ start: point(node.startIndex), end: point(node.endIndex) });
      const root = tree.rootNode;
      const packageNode = root.namedChildren.find(node => node.type === 'package_declaration');
      const packageName = packageNode?.namedChildren.find(node => ['identifier', 'scoped_identifier'].includes(node.type))?.text || '';
      const imports = root.namedChildren.filter(node => node.type === 'import_declaration').map(node => ({ name: node.text.replace(/^import\s+(?:static\s+)?/, '').replace(/;\s*$/, '').trim(), static: /^import\s+static\s/.test(node.text), range: range(node) }));
      const symbols = [], inheritance = [];
      let visitedNodes = 0, truncated = false;
      const stack = [{ node: root, containers: [] }];
      while (stack.length) {
        if (++visitedNodes > maxNodes || symbols.length >= maxSymbols || Date.now() > deadline) { truncated = true; break; }
        const { node, containers } = stack.pop();
        let kind = TYPES.get(node.type);
        if (node.type === 'method_declaration' || node.type === 'annotation_type_element_declaration') kind = 'method';
        if (['constructor_declaration', 'compact_constructor_declaration'].includes(node.type)) kind = 'constructor';
        if (node.type === 'enum_constant') kind = 'enumMember';
        if (node.type === 'variable_declarator' && node.parent?.type === 'field_declaration') kind = 'field';
        if (node.type === 'formal_parameter' && node.parent?.parent?.type === 'record_declaration') kind = 'recordComponent';
        const name = kind ? node.childForFieldName('name') : null;
        let nextContainers = containers;
        if (name && !name.isMissing && name.text) {
          if (source.slice(name.startIndex, name.endIndex) !== name.text) throw new Error('Java parser coordinate contract mismatch');
          const selectionRange = range(name);
          symbols.push({ name: name.text, kind, path: filePath, packageName, container: containers.join('.'), line: selectionRange.start.line, column: selectionRange.start.column, range: range(node), selectionRange, incomplete: node.hasError });
          if (TYPES.has(node.type)) {
            nextContainers = [...containers, name.text];
            const clauses = node.namedChildren.filter(child => ['superclass', 'super_interfaces', 'extends_interfaces'].includes(child.type));
            for (const clause of clauses) inheritance.push({ owner: nextContainers.join('.'), clause: clause.text, range: range(clause), resolved: false });
          }
        }
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], containers: nextContainers });
      }
      return { parserVersion: PARSER_VERSION, semantic: false, path: filePath, packageName, imports, inheritance, symbols, hasErrors: root.hasError, truncated, visitedNodes };
    } finally { tree.delete(); }
  }
}
module.exports = { JavaSyntaxIndex, PARSER_VERSION };
