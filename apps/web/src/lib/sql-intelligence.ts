import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { MySQL, PostgreSQL, StandardSQL, keywordCompletionSource, schemaCompletionSource, sql, type SQLConfig, type SQLNamespace } from '@codemirror/lang-sql';
import type { WorkspaceSqlContext } from './workspace-sql-context';

export type SqlDialectName = 'mysql' | 'postgresql' | 'standard';
export interface SqlColumn { column_name?: string; Field?: string; data_type?: string; Type?: string }
export interface SqlMetadata { dialect?: SqlDialectName; tables?: string[]; tableStructures?: Record<string, SqlColumn[]>; defaultSchema?: string }
export const sqlDialect = (name?: SqlDialectName) => name === 'mysql' ? MySQL : name === 'postgresql' ? PostgreSQL : StandardSQL;

// Split qualification outside quoted identifiers, including escaped quotes.
// A quoted table named "order.items" is one name, not a schema and table.
export function sqlIdentifierParts(name: string, foldUnquoted = false): string[] {
  const parts: string[] = []; let value = ''; let quote = ''; let quoted = false; let closed = false;
  const append = () => { parts.push(quoted ? value : foldUnquoted ? value.trim().toLowerCase() : value.trim()); value = ''; quoted = false; closed = false; };
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (quote) {
      if (char === quote) { if (name[i + 1] === quote) { value += char; i++; } else { quote = ''; closed = true; } }
      else value += char;
    } else if (char === '"' || char === '`' || char === '[') { if (value.trim() || closed) return []; value = ''; quoted = true; quote = char === '[' ? ']' : char; }
    else if (char === '.') append();
    else if (closed) { if (char.trim()) return []; }
    else value += char;
  }
  append();
  return !quote && parts.every(Boolean) ? parts : [];
}

function addTable(schema: Record<string, SQLNamespace>, parts: string[], columns: SqlColumn[], dialect?: SqlDialectName) {
  if (!parts.length) return;
  let parent = schema;
  for (const part of parts.slice(0, -1)) {
    const name = part.replace(/\./g, '\\.');
    const existing = parent[name];
    if (!existing || Array.isArray(existing)) parent[name] = Object.create(null);
    parent = parent[name] as Record<string, SQLNamespace>;
  }
  parent[parts[parts.length - 1].replace(/\./g, '\\.')] = columns.flatMap(column => {
    const label = column.column_name || column.Field;
    const quote = dialect === 'mysql' ? '`' : '"';
    return label ? [{ label, type: 'property', detail: column.data_type || column.Type || 'column', apply: quote + label.split(quote).join(quote + quote) + quote }] : [];
  });
}

export function sqlConfig(metadata: SqlMetadata = {}): SQLConfig {
  const schema: Record<string, SQLNamespace> = Object.create(null);
  for (const table of new Set([...(metadata.tables || []), ...Object.keys(metadata.tableStructures || {})])) {
    addTable(schema, sqlIdentifierParts(table), metadata.tableStructures?.[table] || [], metadata.dialect);
  }
  return { dialect: sqlDialect(metadata.dialect), schema, upperCaseKeywords: true, defaultSchema: metadata.defaultSchema };
}

// Local CREATE TABLE declarations are a fallback when no DB is bound. Walk the
// SQL parser's statements (never comments/strings), not a regex over the file.
// ALTER, dynamic SQL and vendor-specific DDL are intentionally not inferred.
export function sqlDdlMetadata(content: string, dialect: SqlDialectName = 'standard'): SqlMetadata {
  const tables: string[] = []; const tableStructures: Record<string, SqlColumn[]> = Object.create(null);
  const tree = sqlDialect(dialect).language.parser.parse(content);
  for (let statement = tree.topNode.firstChild; statement; statement = statement.nextSibling) {
    if (statement.name !== 'Statement') continue;
    const nodes: (typeof tree.topNode)[] = []; for (let node = statement.firstChild; node; node = node.nextSibling) if (!/Comment/.test(node.name)) nodes.push(node);
    const text = (index: number) => nodes[index] ? content.slice(nodes[index].from, nodes[index].to).toUpperCase() : '';
    if (text(0) !== 'CREATE') continue;
    let index = text(1) === 'TEMP' || text(1) === 'TEMPORARY' ? 2 : 1;
    if (text(index++) !== 'TABLE') continue;
    if (text(index) === 'IF' && text(index + 1) === 'NOT' && text(index + 2) === 'EXISTS') index += 3;
    const name = nodes[index++]; const definitions = nodes[index];
    if (!name || !['Identifier', 'QuotedIdentifier', 'CompositeIdentifier'].includes(name.name) || definitions?.name !== 'Parens') continue;
    const table = content.slice(name.from, name.to);
    const columns: SqlColumn[] = []; let first = true;
    for (let node = definitions.firstChild; node; node = node.nextSibling) {
      const raw = content.slice(node.from, node.to);
      if (raw === '(' || raw === ',') { first = true; continue; }
      if (!first || /Comment/.test(node.name)) continue;
      first = false;
      if (!['Identifier', 'QuotedIdentifier', 'Keyword', 'Builtin'].includes(node.name) || ['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'EXCLUDE', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL'].includes(raw.toUpperCase())) continue;
      const parts = sqlIdentifierParts(raw); if (parts.length !== 1) continue;
      columns.push({ column_name: parts[0], data_type: node.nextSibling ? content.slice(node.nextSibling.from, node.nextSibling.to) : '' });
    }
    tables.push(table); tableStructures[table] = columns;
  }
  return { dialect, tables, tableStructures };
}

export function sqlCompletionSources(config: SQLConfig): CompletionSource[] {
  return [schemaCompletionSource(config), keywordCompletionSource(config.dialect || StandardSQL, true)];
}

// Parse table references without reading identifiers from comments or strings.
// This is bounded metadata discovery, not a SQL execution/validation engine.
export function sqlReferencedTables(content: string, dialect: SqlDialectName = 'standard'): string[] {
  if (content.length > 1_000_000) return [];
  const references = new Set<string>();
  const tree = sqlDialect(dialect).language.parser.parse(content);
  for (let statement = tree.topNode.firstChild; statement; statement = statement.nextSibling) {
    const canonical = (raw: string) => JSON.stringify(sqlIdentifierParts(raw, dialect === 'postgresql'));
    const walk = (parent: typeof statement, inherited = new Set<string>()) => {
      if (!parent) return;
      const ctes = new Set(inherited);
      const nodes: NonNullable<typeof statement>[] = [];
      for (let node = parent.firstChild; node; node = node.nextSibling) if (!/Comment/.test(node.name)) nodes.push(node);
      const raw = (index: number) => nodes[index] ? content.slice(nodes[index].from, nodes[index].to) : '';
      const identifier = (index: number) => ['Identifier', 'QuotedIdentifier', 'CompositeIdentifier'].includes(nodes[index]?.name);
      let inWith = false; let from = false; let expect = false;
      for (let i = 0; i < nodes.length; i++) {
        const word = raw(i).toUpperCase();
        if (nodes[i].name === 'Keyword' && word === 'WITH') inWith = true;
        if (inWith && identifier(i)) {
          const as = nodes[i + 1]?.name === 'Parens' ? i + 2 : i + 1;
          if (raw(as).toUpperCase() === 'AS' && nodes[as + 1]?.name === 'Parens') ctes.add(canonical(raw(i)));
        }
        if (nodes[i].name === 'Keyword' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(word)) inWith = false;
        if (nodes[i].name === 'Keyword' && ['FROM', 'JOIN', 'UPDATE', 'INTO'].includes(word)) { expect = true; if (word === 'FROM' || word === 'JOIN') from = true; continue; }
        if (nodes[i].name === 'Keyword' && ['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'RETURNING', 'SET', 'VALUES'].includes(word)) { from = false; expect = false; }
        if (from && raw(i) === ',') { expect = true; continue; }
        if (expect) {
          if (nodes[i].name === 'Keyword' && ['ONLY', 'LATERAL'].includes(word)) continue;
          if (references.size < 129 && identifier(i) && nodes[i + 1]?.name !== 'Parens' && !ctes.has(canonical(raw(i)))) references.add(raw(i));
          expect = false;
        }
        if (nodes[i].name === 'Parens') walk(nodes[i], ctes);
      }
    };
    walk(statement);
  }
  return [...references];
}

export async function completeSql(content: string, offset: number, metadata: SqlMetadata = {}, explicit = true) {
  const config = sqlConfig(metadata);
  const state = EditorState.create({ doc: content, extensions: [sql(config)] });
  const context = new CompletionContext(state, Math.max(0, Math.min(content.length, offset)), explicit);
  const results = await Promise.all(sqlCompletionSources(config).map(source => source(context)));
  return results.filter(result => result !== null);
}

export function createSqlWorkspaceCompletionProvider(monaco: any, projectId: string, external?: () => WorkspaceSqlContext | undefined) {
  let disposed = false;
  const currentContext = () => { const context = external?.(); return context && context.expiresAt > Date.now() ? context : undefined; };
  const declarations = new WeakMap<object, { version: number; dialect: SqlDialectName; metadata: SqlMetadata }>();
  const provider = {
    triggerCharacters: ['.', '"', '`'],
    provideCompletionItems: async (model: any, position: any, _context: any, token: any) => {
      if (disposed || model.isDisposed() || model.uri.scheme !== 'codegen' || model.uri.authority !== projectId) return { suggestions: [] };
      const version = model.getVersionId();
      const metadata: SqlMetadata = { tables: [], tableStructures: Object.create(null) };
      const bound = currentContext();
      const sourceVersions: Array<{ model: any; version: number }> = [];
      let total = 0; let coverageLimited = false;
      for (const candidate of monaco.editor.getModels()) {
        if (candidate.isDisposed() || candidate.uri.scheme !== 'codegen' || candidate.uri.authority !== projectId || candidate.getLanguageId() !== 'sql') continue;
        const content = candidate.getValue(); total += content.length;
        if (content.length > 1_000_000 || total > 4_000_000) { coverageLimited = true; continue; }
        sourceVersions.push({ model: candidate, version: candidate.getVersionId() });
        let cached = declarations.get(candidate);
        const dialect = bound?.metadata.dialect || 'standard';
        if (!cached || cached.version !== candidate.getVersionId() || cached.dialect !== dialect) {
          cached = { version: candidate.getVersionId(), dialect, metadata: sqlDdlMetadata(content, dialect) }; declarations.set(candidate, cached);
        }
        metadata.tables!.push(...cached.metadata.tables!);
        Object.assign(metadata.tableStructures!, cached.metadata.tableStructures);
      }
      const content = model.getValue();
      // Bound, authorized DB structure wins over local DDL guesses for the
      // same table, while unrelated opened declarations remain available.
      if (bound) {
        metadata.dialect = bound.metadata.dialect; metadata.defaultSchema = bound.metadata.defaultSchema;
        for (const [table, columns] of Object.entries(bound.metadata.tableStructures || {})) {
          const parts = sqlIdentifierParts(table);
          if (parts.length === 2 && parts[0] === bound.metadata.defaultSchema) {
            for (const localTable of Object.keys(metadata.tableStructures || {})) {
              const localParts = sqlIdentifierParts(localTable);
              if (localParts.length === 1 && localParts[0] === parts[1]) metadata.tableStructures![localTable] = columns;
            }
          }
        }
        metadata.tables!.push(...(bound.metadata.tables || [])); Object.assign(metadata.tableStructures!, bound.metadata.tableStructures || {});
      }
      if (content.length > 1_000_000) return { suggestions: [], incomplete: true };
      const results = await completeSql(content, model.getOffsetAt(position), metadata);
      if (disposed || token?.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version || sourceVersions.some(source => source.model.isDisposed() || source.model.getVersionId() !== source.version) || currentContext()?.revision !== bound?.revision) return { suggestions: [] };
      const suggestions = results.flatMap(result => {
        const start = model.getPositionAt(result.from); const end = model.getPositionAt(result.to ?? model.getOffsetAt(position));
        return result.options.filter(item => !item.apply || typeof item.apply === 'string').map(item => ({
          label: item.label, insertText: typeof item.apply === 'string' ? item.apply : item.label,
          kind: monaco.languages.CompletionItemKind[item.type === 'keyword' ? 'Keyword' : item.type === 'property' ? 'Field' : item.type === 'type' ? 'Class' : 'Text'],
          detail: [item.detail, coverageLimited ? '已打开 DDL 部分解析' : ''].filter(Boolean).join(' · ') || undefined, sortText: item.type === 'keyword' ? `2-${item.label}` : `1-${item.label}`,
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        }));
      });
      return { suggestions: [...new Map(suggestions.map(item => [item.label + ':' + item.kind, item])).values()], incomplete: coverageLimited };
    },
  };
  return { ...provider, dispose() { disposed = true; } };
}

export function installSqlWorkspaceCompletions(monaco: any, projectId: string) {
  const provider = createSqlWorkspaceCompletionProvider(monaco, projectId);
  const registration = monaco.languages.registerCompletionItemProvider('sql', provider);
  return { dispose() { provider.dispose(); registration.dispose(); } };
}
