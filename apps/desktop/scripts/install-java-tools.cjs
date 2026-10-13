const path = require('node:path');
process.env.CODE_STUDIO_LANGUAGE_CACHE ||= path.resolve(__dirname, '../.cache');
require('@codegen/code-intelligence/scripts/install-java-tools.cjs').installJavaTools().catch(error => { console.error(error.message); process.exitCode = 1; });
