const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
});

contextBridge.exposeInMainWorld('electronAPI', {
  translateText: (payload) => ipcRenderer.invoke('translate-text', payload),
  askAI: (payload) => ipcRenderer.invoke('ask-ai', payload),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (payload) => ipcRenderer.invoke('settings-set', payload),
  library: {
    getFolders: () => ipcRenderer.invoke('library-get-folders'),
    saveFolders: (payload) => ipcRenderer.invoke('library-save-folders', payload),
    getPapers: () => ipcRenderer.invoke('library-get-papers'),
    savePapers: (payload) => ipcRenderer.invoke('library-save-papers', payload),
    savePdf: (payload) => ipcRenderer.invoke('library-save-pdf', payload),
    readPdf: (payload) => ipcRenderer.invoke('library-read-pdf', payload),
    getPaperState: (paperId) => ipcRenderer.invoke('library-get-paper-state', { paperId }),
    savePaperState: (paperId, state) =>
      ipcRenderer.invoke('library-save-paper-state', { paperId, state }),
    deletePaper: (payload) => ipcRenderer.invoke('library-delete-paper', payload),
    deletePapers: (payload) => ipcRenderer.invoke('library-delete-papers', payload)
  }
});
