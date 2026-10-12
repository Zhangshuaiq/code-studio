const registry = require('./file-types.json');
function fileLanguage(file) {
  const name = String(file).replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (Object.hasOwn(registry.names, name)) return registry.names[name];
  if (/^(dockerfile|containerfile)\./.test(name)) return 'dockerfile';
  if (name.startsWith('.env.')) return 'ini';
  // Longest suffix wins (for example .svg.xml), independent of project type.
  const matches = Object.entries(registry.languages).flatMap(([language, extensions]) =>
    extensions.filter(extension => name.endsWith('.' + extension)).map(extension => ({ language, extension })));
  return matches.sort((a, b) => b.extension.length - a.extension.length)[0]?.language || 'plaintext';
}
module.exports = { fileLanguage, registry };
