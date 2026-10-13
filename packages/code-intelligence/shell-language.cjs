// Bash parser support is deliberately narrower than shell syntax highlighting.
// Zsh, Fish and PowerShell must not receive Bash diagnostics.
const { bashLanguage } = require('./file-types.json');
function supportsBashLanguage(file = '') {
  const name = String(file).replace(/\\/g, '/').split('/').pop().toLowerCase();
  return bashLanguage.extensions.some(extension => name.endsWith('.' + extension)) || bashLanguage.names.includes(name);
}
module.exports = { supportsBashLanguage };
