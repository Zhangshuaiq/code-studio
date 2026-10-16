function projectionDiagnostics() {
  let tail = '';
  const result = { used: false, hit: false, stats: null };
  return {
    result,
    accept(chunk) {
      tail = (tail + chunk.toString('utf8')).slice(-16384);
      if (tail.includes('CODE_STUDIO_PACKAGE_PROJECTION_USED')) result.used = true;
      if (tail.includes('CODE_STUDIO_PACKAGE_PROJECTION_HIT')) result.hit = true;
      const match = /CODE_STUDIO_PACKAGE_PROJECTION_STATS (\{[^\r\n]*\})/.exec(tail);
      if (match) {
        try {
          const values = JSON.parse(match[1]);
          const keys = ['calls', 'hits', 'misses', 'invalidations', 'evictions', 'entries', 'retainedNamesUpperBound', 'retainedCharsUpperBound'];
          if (keys.every(key => Number.isSafeInteger(values[key]) && values[key] >= 0)) result.stats = Object.fromEntries(keys.map(key => [key, values[key]]));
        } catch { /* Incomplete stderr fragments are retried on the next chunk. */ }
      }
    },
  };
}
module.exports = { projectionDiagnostics };
