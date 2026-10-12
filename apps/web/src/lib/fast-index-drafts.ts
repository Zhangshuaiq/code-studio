export function collectJavaDrafts(files: Array<{ path: string; content: string; baseline: string; readOnly?: boolean }>) {
  const documents = files.filter(file => !file.readOnly && file.path.endsWith('.java') && !file.path.startsWith('@java-source/') && file.content !== file.baseline).map(file => ({ path: file.path, content: file.content }));
  if (documents.length > 20 || documents.some(document => document.content.length > 500_000) || new TextEncoder().encode(JSON.stringify(documents)).byteLength > 900_000) {
    throw new Error('未保存的 Java 代码过多，请先保存部分文件后再搜索');
  }
  return documents;
}
