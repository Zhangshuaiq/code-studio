const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Diagnostic OSGi bundle only. No shipped JAR or installation is overwritten.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jdt-package-probe-'));
const source = path.join(__dirname, 'java-package-cache');
const plugins = path.resolve(__dirname, '../../../packages/code-intelligence/.cache/jdtls/1.61.0/plugins');
const classes = path.join(root, 'classes'); fs.mkdirSync(classes);
execFileSync('javac', ['--release', '21', '-cp', path.join(plugins, '*'), '-d', classes, path.join(source, 'PackageMetadataProbe.java')], { stdio: 'inherit' });
execFileSync('java', ['-cp', [classes, path.join(plugins, '*')].join(path.delimiter), 'codestudio.diagnostic.PackageMetadataProbe'], { stdio: 'inherit' });
const bundle = path.join(root, 'package-metadata-probe.jar');
execFileSync('jar', ['cfm', bundle, path.join(source, 'MANIFEST.MF'), '-C', classes, '.', '-C', source, 'plugin.xml'], { stdio: 'inherit' });
console.log(JSON.stringify({ bundle }));
