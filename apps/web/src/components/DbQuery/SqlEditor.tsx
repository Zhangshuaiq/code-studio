import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  tables?: string[];
  tableStructures?: Record<string, Array<{ column_name?: string; Field?: string }>>;
  dialect?: 'mysql' | 'postgresql';
  placeholder?: string;
}

export function SqlEditor({
  value,
  onChange,
  tables = [],
  tableStructures = {},
  dialect = 'postgresql',
  placeholder = 'SELECT * FROM table_name LIMIT 10;',
}: SqlEditorProps) {
  // SQL 关键词
  const sqlKeywords = [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
    'ALTER', 'TABLE', 'INDEX', 'VIEW', 'DISTINCT', 'ORDER BY', 'GROUP BY',
    'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'FULL JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE',
    'IS NULL', 'IS NOT NULL', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN',
    'UNION', 'INTERSECT', 'EXCEPT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  ];

  // 自动补全函数
  const sqlCompletion = useMemo(
    () =>
      autocompletion({
        override: [
          (context: CompletionContext) => {
            const word = context.matchBefore(/\w*/);
            if (!word || (word.from === word.to && !context.explicit)) {
              return null;
            }

            const options = [];

            // 添加关键词
            for (const keyword of sqlKeywords) {
              options.push({
                label: keyword,
                type: 'keyword',
                boost: 1,
              });
            }

            // 添加表名
            for (const table of tables) {
              options.push({
                label: table,
                type: 'type',
                detail: 'table',
                boost: 2,
              });
            }

            // 添加字段名（从表结构中提取）
            for (const [table, columns] of Object.entries(tableStructures)) {
              for (const col of columns) {
                const columnName = col.column_name || col.Field;
                if (columnName) {
                  options.push({
                    label: columnName,
                    type: 'property',
                    detail: `from ${table}`,
                    info: `${table}.${columnName}`,
                    boost: 3,
                  });
                }
              }
            }

            return {
              from: word.from,
              options,
              validFor: /^\w*$/,
            };
          },
        ],
      }),
    [tables, tableStructures, sqlKeywords],
  );

  // SQL 方言配置
  const sqlDialect = dialect === 'mysql' ? MySQL : PostgreSQL;

  const extensions = useMemo(
    () => [
      sql({ dialect: sqlDialect }),
      sqlCompletion,
      EditorView.lineWrapping,
    ],
    [sqlDialect, sqlCompletion],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      height="120px"
      theme="light"
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: true,
        dropCursor: true,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
      }}
      className="sql-editor"
    />
  );
}
