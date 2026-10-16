const fs = require('node:fs');
const path = require('node:path');
function buildConcurrency(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new TypeError('Java build concurrency must be an integer from 1 to 8');
  return value;
}
function garbageCollectorArguments(value) {
  if (value === undefined || value === 'default') return [];
  if (value !== 'parallel') throw new TypeError('Java GC profile must be default or parallel');
  // Same heap budget; isolate the collector/throughput policy from heap sizing.
  return ['-XX:+UseParallelGC', '-XX:GCTimeRatio=4', '-XX:AdaptiveSizePolicyWeight=90'];
}
function sharedIndexArguments(home, root) {
  if (root === undefined) return [];
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\r\n\0]/.test(root)) throw new TypeError('Java shared index root must be an absolute trusted path');
  // Partition by the actual bundled core version, not the application version.
  const core = fs.readdirSync(path.join(home, 'plugins')).find(file => /^org\.eclipse\.jdt\.core_[\w.-]+\.jar$/.test(file));
  if (!core) return [];
  const directory = path.join(root, core.slice(0, -4));
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.accessSync(directory, fs.constants.W_OK);
    return [`-Djdt.core.sharedIndexLocation=${directory}`];
  } catch { return []; } // Optional cache failure must not prevent startup.
}
function flightRecordingArguments(filename) {
  if (filename === undefined) return [];
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /[,\r\n\0]/.test(filename)) throw new TypeError('Java flight recording requires an absolute trusted path without commas');
  return ['-Xlog:jfr*=off', '-XX:FlightRecorderOptions=stackdepth=64', `-XX:StartFlightRecording=filename=${filename},settings=profile,dumponexit=true,maxsize=64m`];
}
module.exports = { buildConcurrency, sharedIndexArguments, flightRecordingArguments, garbageCollectorArguments };
