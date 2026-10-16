const path = require('node:path');
function validChange(change) {
  return change && typeof change.path === 'string' && change.path.length <= 1024 && !/[\\\0]/.test(change.path) && !path.isAbsolute(change.path) && !/^[A-Za-z]:/.test(change.path) && !change.path.split('/').some(part => !part || part === '.' || part === '..') && [1, 2, 3].includes(change.type);
}
function javaRelevant(change) {
  return /\.(java|jar|class)$/i.test(change.path) || /(?:^|\/)(?:pom\.xml|\.classpath|\.project|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/.test(change.path) || /(?:^|\/)\.settings\/[^/]+\.prefs$/.test(change.path);
}
function indexChangeScope(changes) {
  // Unknown changes (e.g. a directory rename) require conservative invalidation.
  if (!Array.isArray(changes)) return { java: true, relations: true };
  return { java: changes.some(change => /\.java$/i.test(change.path || '')), relations: changes.some(change => /\.(java|xml)$/i.test(change.path || '')) };
}
module.exports = { validChange, javaRelevant, indexChangeScope };
