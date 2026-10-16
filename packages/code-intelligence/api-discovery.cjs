// Static discovery only: never compile, execute project code or fetch remote refs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { JavaSyntaxIndex } = require('./java-syntax-index.cjs');
const { decodeText } = require('./file-text.cjs');
const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
const activeScans = new Map();
function annotations(node) {
  return (node?.namedChildren.find(n => n.type === 'modifiers')?.namedChildren || [])
    .filter(n => ['annotation', 'marker_annotation'].includes(n.type))
    .map(n => ({ name: n.childForFieldName('name')?.text.split('.').pop(), node: n }));
}
function literals(node) {
  if (!node) return null;
  if (node.type === 'string_literal') { try { return [JSON.parse(node.text)]; } catch { return null; } }
  if (node.type === 'element_value_array_initializer') {
    const values = node.namedChildren.map(literals);
    return values.length <= 32 && values.every(Boolean) ? values.flat() : null;
  }
  return null; // Constants/expressions are not guessed.
}
function attributes(annotation) {
  const args = annotation.node.namedChildren.find(n => n.type === 'annotation_argument_list');
  const result = {};
  for (const child of args?.namedChildren || []) {
    if (child.type === 'element_value_pair') result[child.childForFieldName('key')?.text] = child.childForFieldName('value');
    else result.value = child;
  }
  return result;
}
function mapping(node) {
  const item = annotations(node).find(a => /^(Request|Get|Post|Put|Patch|Delete)Mapping$/.test(a.name));
  if (!item) return null;
  const attrs = attributes(item);
  const rawPaths = attrs.path || attrs.value;
  const paths = rawPaths ? literals(rawPaths) : [''];
  const methods = item.name === 'RequestMapping'
    ? (attrs.method ? [...attrs.method.text.matchAll(/RequestMethod\.(\w+)/g)].map(m => m[1]).filter(v => verbs.includes(v)) : verbs)
    : [item.name.replace('Mapping', '').toUpperCase()];
  return { paths, methods, attrs };
}
function springEndpoints(parser, source, file) {
  // Skip non-Spring files before spending parser time (and avoid similarly named annotations).
  if (!/import\s+(?:static\s+)?org\.springframework\.web\.bind\.annotation\./.test(source)
      && !/@org\.springframework\.web\.bind\.annotation\./.test(source)) return { items: [], unresolved: 0 };
  const tree = parser.parse(source);
  if (!tree) return { items: [], unresolved: 1 };
  const items = []; let unresolved = tree.rootNode.hasError ? 1 : 0;
  try {
    const stack = [tree.rootNode];
    while (stack.length) {
      const node = stack.pop();
      if (['class_declaration', 'interface_declaration'].includes(node.type)) {
        const declared = annotations(node);
        if (declared.some(a => ['RestController', 'Controller'].includes(a.name))) {
          const base = mapping(node);
          for (const method of node.childForFieldName('body')?.namedChildren || []) {
            if (method.type !== 'method_declaration') continue;
            const route = mapping(method); if (!route) continue;
            if (!route.paths || (base && !base.paths) || !route.methods.length) { unresolved++; continue; }
            const parameters = []; let body = '';
            for (const parameter of method.childForFieldName('parameters')?.namedChildren || []) {
              const ann = annotations(parameter).find(a => ['RequestParam', 'PathVariable', 'RequestHeader', 'RequestBody'].includes(a.name));
              if (!ann) continue;
              const attrs = attributes(ann);
              const name = literals(attrs.name || attrs.value)?.[0] || parameter.childForFieldName('name')?.text;
              if (ann.name === 'RequestBody') { body = '{}'; continue; }
              if (name) parameters.push({ name, in: { RequestParam: 'query', PathVariable: 'path', RequestHeader: 'header' }[ann.name], value: literals(attrs.defaultValue)?.[0] || '', required: !attrs.defaultValue && attrs.required?.text !== 'false', type: parameter.childForFieldName('type')?.text });
            }
            const allowed = route.methods.filter(v => !base || base.methods.includes(v));
            for (const prefix of base?.paths || ['']) for (const suffix of route.paths) for (const verb of allowed) {
              const combined = suffix ? `${prefix.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}` : prefix;
              const routePath = '/' + combined.replace(/^\/+/, '');
              items.push({ method: verb, path: routePath, name: `${node.childForFieldName('name')?.text}.${method.childForFieldName('name')?.text}`, source: 'spring', file, line: method.startPosition.row + 1, parameters, body });
              if (items.length >= 5000) return { items, unresolved: unresolved + 1 };
            }
          }
        }
      }
      stack.push(...node.namedChildren);
    }
    return { items, unresolved };
  } finally { tree.delete(); }
}
function openApiEndpoints(doc, file) {
  if (!doc || (!doc.openapi && doc.swagger !== '2.0') || !doc.paths) return [];
  const ref = value => {
    if (!value?.$ref) return value;
    if (!value.$ref.startsWith('#/')) return null;
    return value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  };
  const items = [];
  for (const [routePath, entry] of Object.entries(doc.paths)) {
    const route = ref(entry); if (!route || !routePath.startsWith('/')) continue;
    for (const method of verbs) {
      const operation = route[method.toLowerCase()]; if (!operation) continue;
      const params = new Map();
      for (const raw of [...(route.parameters || []), ...(operation.parameters || [])]) {
        const p = ref(raw); if (p?.name && ['path', 'query', 'header'].includes(p.in)) params.set(`${p.in}:${p.name}`, { name: p.name, in: p.in, required: !!p.required, value: p.example ?? p.schema?.default ?? p.default ?? '' });
      }
      const request = ref(operation.requestBody);
      const example = request?.content?.['application/json']?.example;
      items.push({ method, path: routePath, name: operation.summary || operation.operationId || routePath, source: 'openapi', file, parameters: [...params.values()], body: example !== undefined ? JSON.stringify(example, null, 2) : request || operation.parameters?.some(p => p.in === 'body') ? '{}' : '' });
      if (items.length >= 5000) return items;
    }
  }
  return items;
}
async function scan(root) {
  root = await fs.realpath(root);
  const pending = [root], items = []; let entriesSeen = 0, bytes = 0, unresolved = 0, skipped = 0, truncated = false;
  const started = Date.now(); let syntax;
  try {
    while (pending.length && !truncated) {
      const directory = pending.pop();
      let entries; try {
        const realDirectory = await fs.realpath(directory);
        if (realDirectory !== root && !realDirectory.startsWith(root + path.sep)) { skipped++; continue; }
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch { skipped++; continue; }
      for (const entry of entries) {
        if (++entriesSeen > 100000 || Date.now() - started > 25000 || items.length >= 5000) { truncated = true; break; }
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (!ignored.has(entry.name)) pending.push(file); continue; }
        if (!entry.isFile() || !/\.java$|^(?:openapi|swagger).*\.json$/i.test(entry.name)) continue;
        let handle;
        try {
          const real = await fs.realpath(file); if (!real.startsWith(root + path.sep)) { skipped++; continue; }
          handle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
          const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) { skipped++; continue; }
          bytes += stat.size; if (bytes > 64 * 1024 * 1024) { truncated = true; break; }
          const buffer = Buffer.alloc(stat.size + 1); const read = await handle.read(buffer, 0, buffer.length, 0);
          if (read.bytesRead > stat.size) { skipped++; continue; }
          const content = decodeText(buffer.subarray(0, read.bytesRead)).content;
          const relative = path.relative(root, file).split(path.sep).join('/');
          if (entry.name.endsWith('.java')) {
            if (!syntax) syntax = await JavaSyntaxIndex.create();
            const result = springEndpoints(syntax.parser, content, relative); items.push(...result.items); unresolved += result.unresolved;
          } else items.push(...openApiEndpoints(JSON.parse(content), relative));
        } catch { skipped++; } finally { await handle?.close(); }
      }
    }
    return { items: items.slice(0, 5000).map((item, id) => ({ ...item, id: String(id) })), truncated: truncated || items.length >= 5000, unresolved, skipped, elapsedMs: Date.now() - started, frameworks: [...new Set(items.map(item => item.source))] };
  } finally { syntax?.close(); }
}
function discoverApis(root) {
  const key = path.resolve(root);
  if (activeScans.has(key)) return activeScans.get(key);
  if (activeScans.size >= 2) return Promise.reject(new Error('正在扫描其他项目接口，请稍后重试'));
  const pending = new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { root }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('接口扫描超时，请缩小项目范围后重试')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('接口扫描未完成')); });
  }).finally(() => activeScans.delete(key));
  activeScans.set(key, pending); return pending;
}
if (!isMainThread && workerData?.root) scan(workerData.root).then(result => parentPort.postMessage(result), () => parentPort.postMessage({ error: '无法扫描项目接口' }));
module.exports = { discoverApis, springEndpoints, openApiEndpoints };
