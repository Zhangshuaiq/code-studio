const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { JavaSyntaxIndex } = require('./java-syntax-index.cjs');
const { decodeText } = require('./file-text.cjs');
const crypto = require('node:crypto');
const declarationCache = require('./relations-cache.cjs');
const ignored = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.gradle', '.idea']);
const managers = new Map();
function safePath(value) { return typeof value === 'string' && value.length <= 1024 && !/[\\\0]/.test(value) && !path.isAbsolute(value) && !value.split('/').includes('..') && /\.(java|xml)$/.test(value); }
function splitTypes(text) {
  const result = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) { if (text[i] === '<') depth++; else if (text[i] === '>') depth--; else if (text[i] === ',' && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; } }
  if (text.slice(start).trim()) result.push(text.slice(start).trim()); return result;
}
const typeParameters = node => (node.childForFieldName('type_parameters')?.namedChildren || []).map(p => p.namedChildren.find(n => n.type === 'type_identifier')?.text).filter(Boolean);
function javaDeclarations(syntax, content, file) {
  const tree = syntax.parser.parse(content); if (!tree) return [];
  try {
    const root = tree.rootNode;
    const pkg = root.namedChildren.find(n => n.type === 'package_declaration')?.text.replace(/^package\s+|;$/g, '').trim() || '';
    const imports = root.namedChildren.filter(n => n.type === 'import_declaration' && !/^import\s+static/.test(n.text)).map(n => n.text.replace(/^import\s+|;$/g, '').trim());
    // Traverse in native tree-sitter rather than materializing every expression
    // node in JavaScript. This still includes nested and method-local types.
    const result = [];
    for (const node of root.descendantsOfType(['class_declaration', 'interface_declaration'])) {
      if (['class_declaration', 'interface_declaration'].includes(node.type)) {
        const name = node.childForFieldName('name'); if (!name) continue;
        const parents = []; let ancestor = node.parent;
        while (ancestor) { if (['class_declaration', 'interface_declaration'].includes(ancestor.type)) parents.unshift(ancestor.childForFieldName('name')?.text); ancestor = ancestor.parent; }
        const fullName = [pkg, ...parents, name.text].filter(Boolean).join('.');
        const supers = [], superArguments = {};
        for (const clause of node.namedChildren.filter(n => ['superclass', 'super_interfaces', 'extends_interfaces'].includes(n.type))) {
          for (const raw of splitTypes(clause.text.replace(/^(extends|implements)\s+/, ''))) {
            const type = raw.replace(/<.*>$/, '').trim(); if (!/^[\w.$]+$/.test(type)) continue;
            supers.push(type); superArguments[type] = raw.includes('<') ? splitTypes(raw.slice(raw.indexOf('<') + 1, raw.lastIndexOf('>'))) : [];
          }
        }
        const methods = (node.childForFieldName('body')?.namedChildren || []).filter(n => n.type === 'method_declaration').map(method => {
          const methodName = method.childForFieldName('name');
          const parameters = method.childForFieldName('parameters')?.namedChildren.filter(n => ['formal_parameter', 'spread_parameter'].includes(n.type)).map(n => {
            const type = n.childForFieldName('type') || n.namedChildren.find(c => /^(?:type_identifier|scoped_type_identifier|generic_type|array_type|integral_type|floating_point_type|boolean_type|annotated_type)$/.test(c.type));
            return (type?.text.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, '').trim() || '?') + (n.childForFieldName('dimensions')?.text.replace(/\s/g, '') || '') + (n.type === 'spread_parameter' ? '[]' : '');
          }) || [];
          const modifiers = method.namedChildren.find(n => n.type === 'modifiers')?.text || '';
          return { name: methodName?.text, line: methodName?.startPosition.row + 1, column: methodName?.startPosition.column + 1, parameters, typeParameters: typeParameters(method), inheritable: !/\b(private|static)\b/.test(modifiers) };
        }).filter(m => m.name);
        result.push({ fullName, name: name.text, pkg, imports, supers, superArguments, typeParameters: typeParameters(node), isInterface: node.type === 'interface_declaration', methods, path: file, line: name.startPosition.row + 1, column: name.startPosition.column + 1 });
      }
    }
    return result;
  } finally { tree.delete(); }
}
function xmlDeclarations(content, file) {
  const result = []; let namespace, depth = 0;
  // Tokenize comments/CDATA first. No entity expansion, DTD loading or XML execution.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of content.matchAll(tokens)) {
    const text = match[0]; if (text.startsWith('<!')) continue;
    if (text.startsWith('</')) { depth--; continue; }
    const tag = /^<([\w:.-]+)/.exec(text)?.[1];
    const attrs = Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1], m[3]]));
    if (depth === 0 && tag === 'mapper' && /^[\w.$]+$/.test(attrs.namespace || '')) namespace = attrs.namespace;
    if (namespace && depth === 1 && ['select', 'insert', 'update', 'delete'].includes(tag) && /^[\w$]+$/.test(attrs.id || '')) {
      const index = match.index + text.indexOf(attrs.id, text.indexOf('id'));
      const prefix = content.slice(0, index); result.push({ namespace, name: attrs.id, path: file, line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') });
    }
    if (!text.endsWith('/>')) depth++;
  }
  return result;
}
const typeKey = type => JSON.stringify([type.path, type.fullName]);
function assembleRelationIndex(partitions, dependencies, incomplete, mode, recomputedTypes) {
  const byPath = new Map(), seen = new Set();
  for (const edges of partitions.values()) for (const edge of edges) {
    const key = JSON.stringify([edge.path, edge.line, edge.column, edge.link.path, edge.link.line, edge.link.column, edge.link.direction]);
    if (seen.has(key)) continue;
    if (seen.size >= 100000) { incomplete = true; continue; }
    seen.add(key);
    const list = byPath.get(edge.path) || []; list.push(edge); byPath.set(edge.path, list);
  }
  return { byPath, partitions, dependencies, incomplete, edgeCount: seen.size, mode, recomputedTypes };
}
function buildRelationIndex(files, selectedChildren) {
  const types = [...files.values()].flatMap(f => f.java || []), xml = [...files.values()].flatMap(f => f.xml || []);
  const byName = new Map(); for (const type of types) { const list = byName.get(type.fullName) || []; list.push(type); byName.set(type.fullName, list); }
  const resolve = (type, name) => {
    const explicit = type.imports.find(i => i.endsWith('.' + name));
    const candidates = [...new Set([name, ...(explicit ? [explicit] : []), [type.pkg, name].filter(Boolean).join('.'), ...type.imports.filter(i => i.endsWith('.*')).map(i => i.slice(0, -1) + name), ...[...byName.keys()].filter(key => key.startsWith(type.pkg + '.') && key.endsWith('.' + name) && type.fullName.startsWith(key.slice(0, -name.length)))])];
    const found = candidates.flatMap(n => byName.get(n) || []); return found.length === 1 ? found[0] : null;
  };
  const partitions = new Map(), dependencies = new Map(), childOccurrences = new Map();
  let partition, seenEdges, retainedEdges = 0;
  let incomplete = false;
  const add = (origin, target, direction, label) => {
    if (!target.line) return;
    const key = JSON.stringify([origin.path, origin.line, origin.column, target.path, target.line, target.column, direction]);
    if (seenEdges.has(key)) return;
    if (retainedEdges >= 100000) { incomplete = true; return; }
    seenEdges.add(key);
    retainedEdges++;
    partition.push({ path: origin.path, line: origin.line, column: origin.column, name: origin.name, link: { path: target.path, line: target.line, column: target.column, direction, label } });
  };
  const canonical = (owner, value, bindings = {}, methodParameters = []) => value.replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g, name => {
    if (methodParameters.includes(name)) return `#METHOD:${methodParameters.indexOf(name)}`;
    if (Object.hasOwn(bindings, name)) return bindings[name];
    if (name.includes('.') || /^(boolean|byte|char|short|int|long|float|double|void|extends|super)$/.test(name)) return name;
    const explicit = owner.imports.find(i => i.endsWith('.' + name)); if (explicit) return explicit;
    if (/^(String|Object|Boolean|Byte|Character|Short|Integer|Long|Float|Double|Number|Class|Throwable|Exception|RuntimeException)$/.test(name)) return 'java.lang.' + name;
    const local = [owner.pkg, name].filter(Boolean).join('.');
    if (byName.has(local)) return local;
    const wildcards = owner.imports.filter(i => i.endsWith('.*')).sort();
    const importedTypes = wildcards.map(i => i.slice(0, -1) + name).filter(fullName => byName.has(fullName));
    if (importedTypes.length === 1) return importedTypes[0];
    if (wildcards.length === 1) return wildcards[0].slice(0, -1) + name;
    if (wildcards.includes('java.util.*') && /^(List|Map|Set|Collection|Optional|Iterator|Iterable|ArrayList|HashMap|HashSet|Comparator|Date|UUID)$/.test(name)) return 'java.util.' + name;
    return wildcards.length ? `${wildcards.join('|')}:${name}` : local;
  }).replace(/\s+/g, '');
  const compatible = (a, b, child, parent) => a.inheritable && b.inheritable && a.name === b.name && a.parameters.length === b.parameters.length && a.parameters.every((p, i) => canonical(child.owner, p, child.bindings, a.typeParameters) === canonical(parent.owner, b.parameters[i], parent.bindings, b.typeParameters));
  for (const child of types) {
    const baseKey = typeKey(child), occurrence = childOccurrences.get(baseKey) || 0;
    childOccurrences.set(baseKey, occurrence + 1);
    // Separate same-named local classes in different methods. Such snapshots
    // conservatively use full rebuilds, but must not overwrite partitions.
    const childKey = occurrence ? `${baseKey}#${occurrence}` : baseKey;
    if (selectedChildren && !selectedChildren.has(childKey)) continue;
    partition = []; seenEdges = new Set(); partitions.set(childKey, partition);
    const contexts = [], seenContexts = new Set();
    const visit = (owner, bindings, trail = new Set()) => {
      if (trail.has(owner.fullName) || trail.size >= 32) return;
      const key = `${owner.fullName}:${JSON.stringify(bindings)}`; if (seenContexts.has(key)) return; seenContexts.add(key);
      contexts.push({ owner, bindings }); const next = new Set(trail).add(owner.fullName);
      for (const name of owner.supers) {
        const parent = resolve(owner, name); if (!parent) continue;
        const args = owner.superArguments?.[name] || [];
        const mapped = Object.fromEntries((parent.typeParameters || []).map((parameter, index) => [parameter, args[index] ? canonical(owner, args[index], bindings) : 'java.lang.Object']));
        visit(parent, mapped, next);
      }
    };
    visit(child, Object.fromEntries((child.typeParameters || []).map(name => [name, `${child.fullName}:${name}`])));
    dependencies.set(childKey, new Set(contexts.map(context => typeKey(context.owner))));
    const implementations = contexts.filter(c => c.owner === child || !c.owner.isInterface).flatMap(context => context.owner.methods.map(method => ({ method, context })));
    for (const parent of contexts.slice(1)) {
      add(child, parent.owner, 'up', `父类型 ${parent.owner.fullName}`); add(parent.owner, child, 'down', `实现/子类 ${child.fullName}`);
      for (const original of parent.owner.methods) {
        const found = implementations.find(({ method, context }) => compatible(method, original, context, parent));
        if (!found || found.context.owner === parent.owner) continue;
        const { method, context } = found;
        add({ ...method, path: context.owner.path }, { ...original, path: parent.owner.path }, 'up', `${parent.owner.fullName}.${original.name}`);
        add({ ...original, path: parent.owner.path }, { ...method, path: context.owner.path }, 'down', `${context.owner.fullName}.${method.name}`);
      }
    }
  }
  partition = []; seenEdges = new Set(); partitions.set('@mapper', partition);
  for (const statement of xml) for (const type of byName.get(statement.namespace) || []) {
    const methods = type.methods.filter(m => m.name === statement.name);
    for (const method of methods) {
      add({ ...method, path: type.path }, statement, 'down', `Mapper XML ${statement.path} · ${statement.name}`);
      add(statement, { ...method, path: type.path }, 'up', `Mapper ${type.fullName}.${method.name}`);
    }
  }
  return assembleRelationIndex(partitions, dependencies, incomplete, 'full', dependencies.size);
}
function updateRelationIndex(previous, before, after) {
  if (!previous || previous.incomplete) return buildRelationIndex(after);
  const oldTypes = [...before.values()].flatMap(file => file.java || []), newTypes = [...after.values()].flatMap(file => file.java || []);
  const topology = types => types.map(({ methods, line, column, ...type }) => [typeKey(type), type]).sort((a, b) => a[0].localeCompare(b[0]));
  // Type set/import/supertype changes can alter formerly unresolved names in
  // unrelated files. Never trust the old dependency graph in that case.
  if (new Set(newTypes.map(typeKey)).size !== newTypes.length || JSON.stringify(topology(oldTypes)) !== JSON.stringify(topology(newTypes))) return buildRelationIndex(after);
  const oldByKey = new Map(oldTypes.map(type => [typeKey(type), type]));
  const changed = new Set(newTypes.filter(type => JSON.stringify(type) !== JSON.stringify(oldByKey.get(typeKey(type)))).map(typeKey));
  const xmlChanged = JSON.stringify([...before].filter(([, file]) => file.xml).map(([file, data]) => [file, data.xml])) !== JSON.stringify([...after].filter(([, file]) => file.xml).map(([file, data]) => [file, data.xml]));
  if (!changed.size && !xmlChanged) return { ...previous, mode: 'reused', recomputedTypes: 0 };
  const affected = new Set([...previous.dependencies].filter(([, ancestors]) => [...changed].some(key => ancestors.has(key))).map(([key]) => key));
  const patch = buildRelationIndex(after, affected);
  if (patch.incomplete) return buildRelationIndex(after);
  const partitions = new Map(previous.partitions), dependencies = new Map(previous.dependencies);
  for (const [key, value] of patch.partitions) partitions.set(key, value);
  for (const [key, value] of patch.dependencies) dependencies.set(key, value);
  return assembleRelationIndex(partitions, dependencies, false, 'incremental', affected.size);
}
function queryRelationIndex(index, activePath, position) {
  const rows = new Map();
  for (const edge of index.byPath.get(activePath) || []) {
    // Filter before grouping: same-line overloads must remain independent.
    if (position && (edge.line !== position.line || position.column < edge.column || position.column >= edge.column + edge.name.length || edge.link.direction !== 'down' || edge.link.label.startsWith('Mapper XML '))) continue;
    const row = rows.get(edge.line) || { line: edge.line, column: edge.column, links: [] };
    if (!row.links.some(link => link.path === edge.link.path && link.line === edge.link.line && link.column === edge.link.column && link.direction === edge.link.direction)) row.links.push(edge.link);
    rows.set(edge.line, row);
  }
  return [...rows.values()].sort((a, b) => a.line - b.line);
}
function relate(files, activePath, position) {
  return queryRelationIndex(buildRelationIndex(files), activePath, position);
}
async function runWorker() {
  const root = await fs.realpath(workerData.root), syntax = await JavaSyntaxIndex.create();
  const files = await declarationCache.load(workerData.cacheDirectory, root);
  let lastScan = 0, revision = 0, incomplete = false;
  let parsedFiles = 0, reusedFiles = 0;
  let baseIndex, overlayIndex, graphBuilds = 0;
  const rowCache = new Map();
  async function refresh() {
    if (Date.now() - lastScan < 30000) return;
    rowCache.clear();
    const before = new Map(files);
    overlayIndex = undefined;
    const scanningRevision = revision;
    parsedFiles = 0; reusedFiles = 0;
    const pending = [root], seen = new Set(); let bytes = 0, entriesSeen = 0; incomplete = false;
    const deadline = Date.now() + 25000;
    while (pending.length && !incomplete) {
      const directory = pending.pop();
      let entries; try { const real = await fs.realpath(directory); if (real !== root && !real.startsWith(root + path.sep)) continue; entries = await fs.readdir(directory, { withFileTypes: true }); } catch { incomplete = true; break; }
      for (const entry of entries) {
        if (++entriesSeen > 100000 || Date.now() > deadline || seen.size >= 10000) { incomplete = true; break; }
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (!ignored.has(entry.name)) pending.push(absolute); continue; }
        if (!entry.isFile() || !/\.(java|xml)$/.test(entry.name)) continue;
        const file = path.relative(root, absolute).split(path.sep).join('/'); seen.add(file);
        let handle;
        try {
          // Warm validation only needs a no-follow metadata check. Do not open
          // thousands of unchanged source files (or resolve every parent again).
          const metadata = await fs.lstat(absolute);
          if (!metadata.isFile() || metadata.size > 1024 * 1024) { files.delete(file); incomplete = true; continue; }
          const previous = files.get(file);
          if (previous?.stamp === `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`) {
            bytes += metadata.size;
            if (bytes > 64 * 1024 * 1024) { incomplete = true; break; }
            reusedFiles++; continue;
          }
          const real = await fs.realpath(absolute); if (!real.startsWith(root + path.sep)) { files.delete(file); continue; }
          handle = await fs.open(absolute, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
          const stat = await handle.stat(), stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
          if (!stat.isFile() || stat.size > 1024 * 1024) { files.delete(file); incomplete = true; continue; }
          bytes += stat.size; if (bytes > 64 * 1024 * 1024) { incomplete = true; break; }
          if (files.get(file)?.stamp === stamp) { reusedFiles++; continue; }
          const buffer = Buffer.alloc(stat.size + 1), read = await handle.read(buffer, 0, buffer.length, 0);
          if (read.bytesRead > stat.size) { files.delete(file); incomplete = true; continue; }
          const content = decodeText(buffer.subarray(0, read.bytesRead)).content;
          files.set(file, { stamp, ...(file.endsWith('.java') ? { java: javaDeclarations(syntax, content, file) } : { xml: xmlDeclarations(content, file) }) });
          parsedFiles++;
        } catch { files.delete(file); incomplete = true; } finally { await handle?.close(); }
      }
    }
    if (!incomplete) for (const key of files.keys()) if (!seen.has(key)) files.delete(key);
    lastScan = revision === scanningRevision ? Date.now() : 0;
    if (baseIndex) {
      baseIndex = incomplete ? undefined : updateRelationIndex(baseIndex, before, files);
      if (baseIndex && baseIndex.mode !== 'reused') graphBuilds++;
    }
    if (!incomplete && lastScan) await declarationCache.save(workerData.cacheDirectory, root, files);
  }
  let tail = Promise.resolve();
  parentPort.on('message', message => {
    if (message.invalidate) { revision++; lastScan = 0; rowCache.clear(); return; }
    tail = tail.catch(() => {}).then(async () => {
      try {
        await refresh();
        // Include all unsaved buffers in the key; never persist those buffers.
        const cacheKey = message.path + ':' + JSON.stringify(message.position || null) + ':' + crypto.createHash('sha256').update(JSON.stringify(message.documents || [])).digest('hex');
        const cached = rowCache.get(cacheKey);
        let rows, graphIncomplete, graphMode, recomputedTypes;
        if (!cached) {
          let graph;
          const overlays = new Map(files);
          const changes = [];
          for (const document of message.documents || []) {
            const field = document.path.endsWith('.java') ? 'java' : 'xml';
            const declarations = field === 'java' ? javaDeclarations(syntax, document.content, document.path) : xmlDeclarations(document.content, document.path);
            // Body-only edits and opening a clean file do not change the graph.
            if (JSON.stringify(files.get(document.path)?.[field] || []) === JSON.stringify(declarations)) continue;
            overlays.set(document.path, { [field]: declarations }); changes.push([document.path, declarations]);
          }
          changes.sort((a, b) => a[0].localeCompare(b[0]));
          if (!changes.length) {
            if (!baseIndex) { baseIndex = buildRelationIndex(files); graphBuilds++; }
            graph = baseIndex;
          } else {
            const signature = crypto.createHash('sha256').update(JSON.stringify(changes)).digest('hex');
            if (overlayIndex?.signature !== signature) { overlayIndex = { signature, graph: updateRelationIndex(baseIndex, files, overlays) }; graphBuilds++; }
            graph = overlayIndex.graph;
          }
          rows = queryRelationIndex(graph, message.path, message.position);
          graphIncomplete = graph.incomplete;
          graphMode = graph.mode; recomputedTypes = graph.recomputedTypes;
          if (rowCache.size >= 32) rowCache.delete(rowCache.keys().next().value);
          rowCache.set(cacheKey, { rows, incomplete: graph.incomplete, graphMode, recomputedTypes });
        } else { rows = cached.rows; graphIncomplete = cached.incomplete; graphMode = cached.graphMode; recomputedTypes = cached.recomputedTypes; }
        parentPort.postMessage({ id: message.id, result: { rows, incomplete: incomplete || graphIncomplete, source: 'project-declarations', scope: 'project', semanticComplete: false, validation: { parsedFiles, reusedFiles, graphBuilds, graphMode, recomputedTypes } } });
      } catch { parentPort.postMessage({ id: message.id, error: '文件关联索引暂不可用' }); }
    });
  });
}
function relatedLocations(root, input, options = {}) {
  if (input && (input.line !== undefined || input.column !== undefined) && (!Number.isSafeInteger(input.line) || !Number.isSafeInteger(input.column) || input.line < 1 || input.column < 1 || typeof input.path !== 'string' || !input.path.endsWith('.java'))) return Promise.reject(new Error('项目实现查询位置无效'));
  if (!input || !safePath(input.path) || (input.content !== undefined && typeof input.content !== 'string') || (input.documents !== undefined && !Array.isArray(input.documents))) return Promise.reject(new Error('文件关联路径或内容无效'));
  if (input.documents?.some(d => !d || !safePath(d.path) || typeof d.content !== 'string')) return Promise.reject(new Error('文件关联编辑内容无效'));
  const documents = [...(input.documents || []).filter(d => d.path !== input.path), ...(input.content !== undefined ? [{ path: input.path, content: input.content }] : [])];
  if (documents.length > 21 || documents.some(d => !safePath(d.path) || typeof d.content !== 'string') || Buffer.byteLength(JSON.stringify(documents)) > 1024 * 1024) return Promise.reject(new Error('文件关联编辑内容过大或无效'));
  const key = path.resolve(root); let manager = managers.get(key);
  if (!manager) {
    if (managers.size >= 2) {
      const available = [...managers.entries()].filter(([, entry]) => entry.requests.size === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!available) return Promise.reject(new Error('正在处理其他项目关联，请稍后重试'));
      managers.delete(available[0]); clearTimeout(available[1].idle); void available[1].worker.terminate();
    }
    const worker = new Worker(__filename, { workerData: { root: key, cacheDirectory: options.cacheDirectory }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    manager = { worker, requests: new Map(), sequence: 0, lastUsed: Date.now() }; managers.set(key, manager);
    const failed = () => { clearTimeout(manager.idle); if (managers.get(key) === manager) managers.delete(key); for (const pending of manager.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('文件关联索引暂不可用')); } manager.requests.clear(); };
    worker.on('error', failed); worker.on('exit', failed);
    worker.on('message', message => { const pending = manager.requests.get(message.id); if (!pending) return; clearTimeout(pending.timer); manager.requests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); });
  }
  manager.lastUsed = Date.now();
  clearTimeout(manager.idle);
  manager.idle = setTimeout(() => { void manager.worker.terminate(); }, 120000); manager.idle.unref?.();
  if (manager.requests.size >= 8) return Promise.reject(new Error('文件关联查询繁忙'));
  return new Promise((resolve, reject) => {
    const id = ++manager.sequence;
    const timer = setTimeout(() => { manager.requests.delete(id); reject(new Error('文件关联查询超时')); void manager.worker.terminate(); }, 35000);
    manager.requests.set(id, { resolve, reject, timer }); manager.worker.postMessage({ id, path: input.path, documents, position: input.line === undefined ? undefined : { line: input.line, column: input.column } });
  });
}
function closeRelations() { return Promise.all([...managers.values()].map(m => m.worker.terminate())); }
function invalidateRelations(root) { managers.get(path.resolve(root))?.worker.postMessage({ invalidate: true }); }
if (!isMainThread && workerData?.root) runWorker().catch(() => process.exit(1));
module.exports = { relatedLocations, closeRelations, invalidateRelations, javaDeclarations, xmlDeclarations, relate, buildRelationIndex, queryRelationIndex, updateRelationIndex };
