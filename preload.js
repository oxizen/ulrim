const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectSoundFiles: () => ipcRenderer.invoke('select-sound-files'),
  openInputDebug: () => ipcRenderer.invoke('open-input-debug'),
  onInputEvent: (callback) => ipcRenderer.on('input-event', (_event, data) => callback(data)),
  onHidStatus: (callback) => ipcRenderer.on('hid-status', (_event, status) => callback(status)),
  reconnectHid: () => ipcRenderer.invoke('reconnect-hid'),
  saveData: (filename, data) => ipcRenderer.invoke('save-data', filename, data),
  loadData: (filename) => ipcRenderer.invoke('load-data', filename),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_event, version) => callback(version)),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getHidDevices: () => ipcRenderer.invoke('get-hid-devices'),

  onWindowMaximizeChange: (callback) => {
    ipcRenderer.on('window-maximized', () => callback(true));
    ipcRenderer.on('window-unmaximized', () => callback(false));
  },
});
