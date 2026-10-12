const { JavaRunConfigurationStore } = require('./java-run-configuration.cjs');

class JavaBreakpointConfigurationStore extends JavaRunConfigurationStore {
  key(project) { return `java.breakpoints.${project.id}`; }
  remove(project) { this.store?.deleteSetting(this.key(project)); }
  read(project) {
    const ciphertext = this.store?.getSetting(this.key(project));
    if (!ciphertext) return {};
    this.available();
    try { return validateBreakpoints(JSON.parse(this.codec.decrypt(ciphertext))); }
    catch { throw Object.assign(new Error('无法恢复断点，请重新设置或清除保存的断点'), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' }); }
  }
  save(project, input) {
    const points = validateBreakpoints(input);
    this.available();
    this.store.setSetting(this.key(project), this.codec.encrypt(JSON.stringify(points)));
    return points;
  }
}

function validateBreakpoints(input) {
  const invalid = () => { throw Object.assign(new Error('断点配置无效'), { code: 'LOCAL_JAVA_BREAKPOINTS_INVALID' }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 200) invalid();
  const result = {}; let count = 0;
  for (const [file, lines] of Object.entries(input)) {
    if (!file || file.length > 1000 || !file.endsWith('.java') || file.includes('\\') || /[\0\r\n]/.test(file) || file.startsWith('@java-source/') || file.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(file)) invalid();
    if (!Array.isArray(lines) || lines.length > 1000 || (count += lines.length) > 5000) invalid();
    const points = new Map();
    for (const point of lines) {
      const object = point && typeof point === 'object' && !Array.isArray(point);
      const line = object ? point.line : point;
      if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000) invalid();
      for (const field of ['condition', 'hitCondition', 'logMessage']) if (object && point[field] !== undefined && (typeof point[field] !== 'string' || point[field].length > 2000 || point[field].includes('\0'))) invalid();
      const condition = object ? point.condition?.trim() : '';
      const hitCondition = object ? point.hitCondition?.trim() : '';
      if (hitCondition && (!/^[1-9]\d{0,9}$/.test(hitCondition) || Number(hitCondition) > 2147483647)) invalid();
      const logMessage = object && point.logMessage?.trim() ? point.logMessage : '';
      points.set(line, condition || hitCondition || logMessage ? { line, ...(condition ? { condition } : {}), ...(hitCondition ? { hitCondition } : {}), ...(logMessage ? { logMessage } : {}) } : line);
    }
    if (points.size) result[file] = [...points.values()].sort((a, b) => (typeof a === 'number' ? a : a.line) - (typeof b === 'number' ? b : b.line));
  }
  return result;
}

function relocateBreakpointPaths(input, from, to) {
  const result = {};
  for (const [file, points] of Object.entries(validateBreakpoints(input))) {
    const target = file === from ? to : file.startsWith(`${from}/`) ? to + file.slice(from.length) : file;
    if (!target.endsWith('.java')) {
      throw Object.assign(new Error('带有 Java 断点的文件不能改为非 Java 文件'), { code: 'WORKSPACE_PATH_INVALID' });
    }
    if (result[target]) throw Object.assign(new Error('目标文件已有断点，不能覆盖'), { code: 'WORKSPACE_PATH_INVALID' });
    result[target] = points;
  }
  return validateBreakpoints(result);
}

module.exports = { JavaBreakpointConfigurationStore, validateBreakpoints, relocateBreakpointPaths };
