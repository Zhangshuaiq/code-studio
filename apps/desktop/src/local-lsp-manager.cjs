const path = require('node:path');
const { LocalLspManager: SharedLspManager } = require('@codegen/code-intelligence');

class LocalLspManager extends SharedLspManager {
  constructor(options = {}) {
    super({ ...options, resources: {
      jdtlsHome: process.env.CODE_STUDIO_JDTLS_HOME || path.resolve(__dirname, '../.cache/jdtls/1.61.0'),
      javaToolsRoot: path.resolve(__dirname, '../.cache/java-tools'),
      ...options.resources,
    } });
  }
}
module.exports = { LocalLspManager };
