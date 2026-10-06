const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopSettings', {
  getServerUrl: () => ipcRenderer.invoke('settings:get-server-url'),
  saveServerUrl: (url) => ipcRenderer.invoke('settings:save-server-url', url),
  cancel: () => ipcRenderer.send('settings:cancel'),
});

contextBridge.exposeInMainWorld('desktopRuntime', {
  openDirectory: () => ipcRenderer.invoke('runtime:open-directory'),
  configureControlServer: () => ipcRenderer.invoke('runtime:configure-control-server'),
  approveAgentWrite: (request) => ipcRenderer.invoke('runtime:approve-agent-write', request),
  exportLicenseChallenge: () => ipcRenderer.invoke('runtime:export-license-challenge'),
  importLicenseFile: () => ipcRenderer.invoke('runtime:import-license-file'),
});
