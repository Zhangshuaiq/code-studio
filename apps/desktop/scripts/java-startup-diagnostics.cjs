const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
function summarizeClasspaths(projects, canonicalize = fs.realpathSync) {
  const spellings = new Set(), canonical = new Set(), resolved = new Map();
  let jarReferences = 0, duplicateEntriesWithinProjects = 0, unresolvedJarPaths = 0;
  for (const project of projects) {
    const seen = new Set();
    for (const file of [...(project.classpaths || []), ...(project.modulepaths || [])]) {
      if (typeof file !== 'string' || !/\.jar$/i.test(file)) continue;
      jarReferences++; spellings.add(file);
      if (!resolved.has(file)) { try { resolved.set(file, canonicalize(file)); } catch { resolved.set(file, file); unresolvedJarPaths++; } }
      const real = resolved.get(file); canonical.add(real);
      if (seen.has(real)) duplicateEntriesWithinProjects++;
      seen.add(real);
    }
  }
  return { projects: projects.length, jarReferences, distinctJarPaths: spellings.size, distinctCanonicalJars: canonical.size, unresolvedJarPaths, pathAliases: spellings.size - canonical.size, duplicateEntriesWithinProjects };
}
function parseGcStats(text) {
  const [header, values] = text.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
  if (!header || !values || header.length !== values.length) throw new Error('Invalid jstat output');
  const result = {};
  for (const key of ['YGC', 'YGCT', 'FGC', 'FGCT', 'CGC', 'CGCT', 'GCT']) {
    const value = Number(values[header.indexOf(key)]);
    if (Number.isFinite(value)) result[key] = value;
  }
  return result;
}
async function runtimeSnapshot(dataRoot, guardianPid) {
  const listed = (await exec('jcmd', ['-l'], { timeout: 4000, maxBuffer: 1024 * 1024 })).stdout;
  let pid = listed.split('\n').find(row => row.includes(dataRoot))?.match(/^(\d+) /)?.[1];
  // Some launchers rewrite sun.java.command, omitting the -data arguments.
  // Fall back only to the direct child of our own guardian, never a global JVM.
  if (!pid && process.platform !== 'win32' && Number.isSafeInteger(guardianPid) && guardianPid > 0) {
    const children = (await exec('pgrep', ['-P', String(guardianPid)], { timeout: 4000 })).stdout.trim().split(/\s+/);
    if (children.length === 1 && /^\d+$/.test(children[0])) pid = children[0];
  }
  if (!pid) return { available: false };
  const flags = (await exec('jcmd', [pid, 'VM.flags'], { timeout: 4000, maxBuffer: 1024 * 1024 })).stdout;
  const gc = parseGcStats((await exec('jstat', ['-gcutil', pid], { timeout: 4000 })).stdout);
  return { available: true, parallelGc: flags.includes('-XX:+UseParallelGC'), gc };
}
module.exports = { summarizeClasspaths, parseGcStats, runtimeSnapshot };
