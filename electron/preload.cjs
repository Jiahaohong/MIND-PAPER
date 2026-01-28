const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  readPdf: (filePath) => ipcRenderer.invoke('read-pdf', filePath),
  openaiChat: (payload) => ipcRenderer.invoke('openai-chat', payload),
  openaiLogic: (payload) => ipcRenderer.invoke('openai-logic', payload),
  translateText: (payload) => ipcRenderer.invoke('translate-text', payload),
  log: (payload) => ipcRenderer.send('app-log', payload),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (payload) => ipcRenderer.invoke('settings-set', payload)
});
