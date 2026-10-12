const fs = require('node:fs');
const path = require('node:path');
const packagePath = require.resolve('pdfjs-dist/package.json');
const { version } = require(packagePath);
const root = path.dirname(packagePath);
const output = path.resolve(__dirname, '../public/pdfjs', version);
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  fs.mkdirSync(path.join(output, name), { recursive: true });
  fs.cpSync(path.join(root, name), path.join(output, name), { recursive: true });
}
console.log(`Prepared local PDF assets ${version}`);
