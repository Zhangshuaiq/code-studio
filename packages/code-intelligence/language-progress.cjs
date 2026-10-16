function updateLanguageProgress(session, status, progress, lifecycle) {
  if (!status || session.stopping || !progress || !['string', 'number'].includes(typeof progress.id) || !String(progress.id).length || String(progress.id).length > 256 || (typeof progress.id === 'number' && !Number.isFinite(progress.id)) || (progress.complete !== undefined && typeof progress.complete !== 'boolean')) return;
  session.progressTasks ||= new Map();
  session.progressTaskStarts ||= new Map();
  if (progress.complete === true) {
    const started = session.progressTaskStarts.get(progress.id);
    session.progressTasks.delete(progress.id); session.progressTaskStarts.delete(progress.id);
    if (started) lifecycle('background-task-complete', { stage: started.stage, durationMs: Math.round(performance.now() - started.time), activeTasks: session.progressTasks.size });
  } else {
    if (!session.progressTaskStarts.has(progress.id)) {
      const stage = session.serviceReady ? 'analysis' : 'import';
      session.progressTaskStarts.set(progress.id, { time: performance.now(), stage });
      lifecycle('background-task-start', { stage, activeTasks: session.progressTasks.size + 1 });
    }
    // Keep identity only; task descriptions can contain workspace paths and are
    // not needed to determine readiness or resource counts.
    session.progressTasks.set(progress.id, { id: progress.id });
  }
  if (session.progressTasks.size) Object.assign(status, session.provider === 'java' && !session.serviceReady
    ? { phase: 'importing', message: '正在导入 Java 项目' }
    : { phase: 'indexing', message: '正在更新项目索引' });
  else if (session.serviceReady) Object.assign(status, { phase: 'ready', message: '代码智能已就绪' });
}
function registerLanguageProgress(connection, handler) {
  connection.onNotification('language/progressReport', handler);
  connection.onNotification('language/progress', handler); // Compatibility with older/custom adapters.
}
module.exports = { updateLanguageProgress, registerLanguageProgress };
