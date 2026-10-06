const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalApi } = require('./local-api.cjs');

const DEFAULT_SERVER_URL = process.env.CODEGEN_SERVER_URL || '';
let mainWindow;
let settingsWindow;
let localApi;

function augmentDesktopPath() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [...new Set([...candidates, ...current])].join(path.delimiter);
}

function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function normalizeServerUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务器地址只支持 http:// 或 https://');
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { serverUrl: normalizeServerUrl(parsed.serverUrl) };
  } catch {
    return null;
  }
}

function writeConfig(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return normalized;
}

function isAllowedNavigation(target, serverUrl) {
  try { return new URL(target).origin === new URL(serverUrl).origin; } catch { return false; }
}

function openExternalUrl(target) {
  try {
    const url = new URL(target);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) shell.openExternal(url.toString()).catch(() => {});
  } catch {}
}

function createMainWindow(serverUrl) {
  const window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 700, show: false,
    title: 'Code Studio', backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url, serverUrl)) return { action: 'allow' };
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, serverUrl)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  window.loadURL(serverUrl).catch(() => {
    if (!window.isDestroyed()) showSettings(false);
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
}

function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow.focus();
  settingsWindow = new BrowserWindow({
    width: 520, height: 390, resizable: false, minimizable: false, maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: Boolean(mainWindow && !mainWindow.isDestroyed()), title: '服务器设置',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '客户端', submenu: [
      { label: '连接服务设置…', click: () => showSettings() },
      { type: 'separator' },
      { role: 'reload', label: '重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      ...(process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }]),
    ] },
    { role: 'editMenu' }, { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('settings:get-server-url', () => readConfig()?.serverUrl || DEFAULT_SERVER_URL);
ipcMain.handle('settings:save-server-url', (_event, value) => {
  try {
    writeConfig(value);
    settingsWindow?.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '服务器地址无效' };
  }
});
ipcMain.on('settings:cancel', () => settingsWindow?.close());
ipcMain.handle('runtime:configure-control-server', () => { showSettings(); });
ipcMain.handle('runtime:export-license-challenge', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !localApi) return { ok: false, message: '本地运行时不可用' };
  try {
    const challenge = localApi.createOfflineLicenseChallenge();
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出离线许可证申请', defaultPath: `code-studio-${challenge.deviceId.slice(0, 8)}.license-request.json`, filters: [{ name: 'Code Studio License Request', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, `${JSON.stringify(challenge, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '无法导出离线许可证申请' }; }
});
ipcMain.handle('runtime:import-license-file', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !localApi) return { ok: false, message: '本地运行时不可用' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, { title: '导入离线许可证', properties: ['openFile'], filters: [{ name: 'Code Studio License', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const status = localApi.installOfflineLicenseFile(fs.readFileSync(result.filePaths[0], 'utf8')); return { ok: true, status };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '无法导入离线许可证' }; }
});
ipcMain.handle('runtime:approve-agent-write', async (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !localApi || !request || typeof request.projectId !== 'string' || typeof request.modelConfigId !== 'string' || typeof request.prompt !== 'string') return { ok: false };
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > 200_000) return { ok: false, message: '任务内容无效，请重新输入' };
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['取消', '允许本次修改'], defaultId: 0, cancelId: 0, noLink: true,
    title: '允许智能助手修改文件',
    message: '允许智能助手修改当前项目中的文件吗？',
    detail: `本次任务：${prompt.slice(0, 180)}${prompt.length > 180 ? '…' : ''}\n\n授权只适用于该项目、该模型和这段任务内容，有效期 60 秒且只能使用一次。`,
  });
  if (result.response !== 1) return { ok: false };
  const approvalToken = localApi.issueAgentWriteApproval(request);
  return approvalToken ? { ok: true, approvalToken } : { ok: false, message: '项目已关闭，请重新打开后再试' };
});
ipcMain.handle('runtime:open-directory', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !localApi) {
    return { ok: false, message: '本地运行时不可用' };
  }
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  return { ok: true, project: localApi.registerWorkspace(result.filePaths[0]) };
});

app.whenReady().then(async () => {
  augmentDesktopPath();
  localApi = await createLocalApi({
    staticDir: path.join(__dirname, '..', 'renderer'),
    storePath: path.join(app.getPath('userData'), 'code-studio.sqlite3'),
    lspDataRoot: path.join(app.getPath('userData'), 'language-data'),
    credentialCodec: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    },
    controlServerUrl: () => readConfig()?.serverUrl || DEFAULT_SERVER_URL || null,
    licensePublicKey: process.env.CODE_STUDIO_LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    policyPublicKey: process.env.CODE_STUDIO_POLICY_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    appVersion: app.getVersion(),
  });
  installMenu();
  createMainWindow(localApi.origin);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(localApi.origin);
  });
});

app.on('before-quit', () => {
  void localApi?.close().catch(() => {});
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
