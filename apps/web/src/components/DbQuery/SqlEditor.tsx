import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { sqlConfig } from '../../lib/sql-intelligence';
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
  const extensions = useMemo(
    () => [
      sql(sqlConfig({ dialect, tables, tableStructures, defaultSchema: dialect === 'postgresql' ? 'public' : undefined })),
      EditorView.lineWrapping,
    ],
    [dialect, tables, tableStructures],
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
