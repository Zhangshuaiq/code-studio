const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const pty = require('node-pty');

class LocalTerminalRuntime {
  constructor() { this.sessions = new Map(); this.byProject = new Map(); }

  create(project, options = {}) {
    const existingId = this.byProject.get(project.id); const existing = existingId && this.sessions.get(existingId);
    if (existing && existing.status === 'running') return publicSession(existing);
    if (existing) this.sessions.delete(existing.id);
    const shell = defaultShell(); const cols = clamp(options.cols, 20, 400, 100); const rows = clamp(options.rows, 5, 200, 30);
    const id = crypto.randomBytes(12).toString('hex');
    const process = pty.spawn(shell.command, shell.args, { name: 'xterm-256color', cols, rows, cwd: project.path, env: { ...processEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    const session = { id, projectId: project.id, cwd: project.path, shell: shell.label, status: 'running', exitCode: null, sequence: 0, chunks: [], process };
    this.sessions.set(id, session); this.byProject.set(project.id, id);
    process.onData((data) => {
      session.chunks.push({ sequence: ++session.sequence, data });
      if (session.chunks.length > 2_000) session.chunks.splice(0, session.chunks.length - 2_000);
    });
    process.onExit(({ exitCode }) => { session.status = 'exited'; session.exitCode = exitCode; session.process = null; });
    return publicSession(session);
  }

  getForProject(projectId) { const id = this.byProject.get(projectId); return id ? this.sessions.get(id) : null; }
  get(id) { return this.sessions.get(id); }
  output(id, after = 0) { const session = this.sessions.get(id); if (!session) return null; return { ...publicSession(session), chunks: session.chunks.filter((item) => item.sequence > after) }; }
  write(id, data) { const session = this.sessions.get(id); if (!session?.process || session.status !== 'running') return false; session.process.write(data); return true; }
  resize(id, cols, rows) { const session = this.sessions.get(id); if (!session?.process || session.status !== 'running') return false; session.process.resize(clamp(cols, 20, 400, 100), clamp(rows, 5, 200, 30)); return true; }
  close(id) { const session = this.sessions.get(id); if (!session) return false; try { session.process?.kill(); } catch {} this.sessions.delete(id); if (this.byProject.get(session.projectId) === id) this.byProject.delete(session.projectId); return true; }
  async shutdown() { for (const id of [...this.sessions.keys()]) this.close(id); }
}

function defaultShell() {
  if (process.platform === 'win32') return { command: process.env.COMSPEC || 'powershell.exe', args: [], label: 'PowerShell' };
  const candidate = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return { command: candidate, args: ['-l'], label: candidate.split('/').pop() || 'shell' };
}
function processEnv() { const env = {}; for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value; return env; }
function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback; }
function publicSession(session) { return { id: session.id, projectId: session.projectId, cwd: session.cwd, shell: session.shell, status: session.status, exitCode: session.exitCode, sequence: session.sequence }; }

module.exports = { LocalTerminalRuntime };
