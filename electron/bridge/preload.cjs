const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('progress-event', (_event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('mindpaper-progress', { detail: payload || {} }));
  } catch {
    // ignore bridge event dispatch errors
  }
});

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
});

contextBridge.exposeInMainWorld('electronAPI', {
  translateText: (payload) => ipcRenderer.invoke('translate-text', payload),
  askAI: (payload) => ipcRenderer.invoke('ask-ai', payload),
  searchPaperOpenSource: (title) => ipcRenderer.invoke('search-paper-open-source', { title }),
  searchPaperReferences: (payload) => ipcRenderer.invoke('search-paper-references', payload),
  getEmbedding: (payload) => ipcRenderer.invoke('get-embedding', payload),
  logSummaryRewrite: (payload) => ipcRenderer.invoke('log-summary-rewrite', payload),
  logProgress: (payload) => ipcRenderer.invoke('log-progress', payload),
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (payload) => ipcRenderer.invoke('settings-set', payload),
  webdav: {
    test: (payload) => ipcRenderer.invoke('webdav-test', payload),
    save: (payload) => ipcRenderer.invoke('webdav-save', payload),
    syncUpload: () => ipcRenderer.invoke('webdav-sync-upload')
  },
  vector: {
    status: () => ipcRenderer.invoke('vector-get-status'),
    getPaperStatuses: (payload) => ipcRenderer.invoke('vector-get-paper-statuses', payload),
    debugQdrantStartup: () => ipcRenderer.invoke('vector-debug-qdrant-startup'),
    debugDumpQdrant: () => ipcRenderer.invoke('vector-debug-dump-qdrant'),
    searchPapers: (payload) => ipcRenderer.invoke('vector-search-papers', payload)
  },
  library: {
    getFolders: () => ipcRenderer.invoke('library-get-folders'),
    saveFolders: (payload) => ipcRenderer.invoke('library-save-folders', payload),
    getPapers: () => ipcRenderer.invoke('library-get-papers'),
    savePapers: (payload) => ipcRenderer.invoke('library-save-papers', payload),
    saveSnapshot: (payload) => ipcRenderer.invoke('library-save-snapshot', payload),
    savePdf: (payload) => ipcRenderer.invoke('library-save-pdf', payload),
    readPdf: (payload) => ipcRenderer.invoke('library-read-pdf', payload),
    getPaperState: (paperId) => ipcRenderer.invoke('library-get-paper-state', { paperId }),
    savePaperState: (paperId, state) =>
      ipcRenderer.invoke('library-save-paper-state', { paperId, state }),
    deletePaper: (payload) => ipcRenderer.invoke('library-delete-paper', payload),
    deletePapers: (payload) => ipcRenderer.invoke('library-delete-papers', payload),
    matchReferences: (payload) => ipcRenderer.invoke('library-match-references', payload)
  }
});
