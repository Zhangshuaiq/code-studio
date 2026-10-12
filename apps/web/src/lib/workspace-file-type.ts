import registry from '../../../../packages/code-intelligence/file-types.json';
export function workspaceFileLanguage(path = ''): string {
  const name = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const special = Object.prototype.hasOwnProperty.call(registry.names, name) ? (registry.names as Record<string, string>)[name] : undefined;
  if (special) return special;
  if (/^(dockerfile|containerfile)\./.test(name)) return 'dockerfile';
  if (name.startsWith('.env.')) return 'ini';
  const matches = Object.entries(registry.languages).flatMap(([language, extensions]) =>
    (extensions as string[]).filter(extension => name.endsWith('.' + extension)).map(extension => ({ language, extension })));
  return matches.sort((a, b) => b.extension.length - a.extension.length)[0]?.language || 'plaintext';
}
