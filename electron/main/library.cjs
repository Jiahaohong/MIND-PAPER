const registerLibraryIpc = ({
  ipcMain,
  enqueueWrite,
  ensureLibraryStoreReady,
  getLibraryPaths,
  loadFoldersFromSqlite,
  saveFoldersToSqlite,
  loadPapersFromSqlite,
  savePapersToSqlite,
  cleanupOrphanPaperStateFiles,
  writeJsonFile,
  getPaperArticleId,
  fs,
  fileExists,
  loadPaperStateFromSqlite,
  savePaperStateToSqlite,
  removeFileIfExists,
  deletePapersFromSqlite,
  recordSyncChange
}) => {
  ipcMain.handle('library-get-folders', async () => {
    await ensureLibraryStoreReady();
    const folders = await loadFoldersFromSqlite();
    return Array.isArray(folders) ? folders : [];
  });

  ipcMain.handle('library-save-folders', async (_event, payload = []) => {
    return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      await saveFoldersToSqlite(payload);
      return { ok: true };
    });
  });

  ipcMain.handle('library-get-papers', async () => {
    await ensureLibraryStoreReady();
    return loadPapersFromSqlite();
  });

  ipcMain.handle('library-save-papers', async (_event, payload = []) => {
    return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      const paths = getLibraryPaths();
      const result = await savePapersToSqlite(payload, paths);
      const papers = Array.isArray(result?.papers) ? result.papers : [];
      await cleanupOrphanPaperStateFiles(
        paths,
        papers.map((paper) => String(paper?.id || '').trim())
      );
      return { ok: true };
    });
  });

  ipcMain.handle('library-save-snapshot', async (_event, payload = {}) => {
      return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      const paths = getLibraryPaths();
      const foldersResult = await saveFoldersToSqlite(payload.folders);
      const papersResult = await savePapersToSqlite(payload.papers, paths);
      const papers = Array.isArray(papersResult?.papers) ? papersResult.papers : [];
      await cleanupOrphanPaperStateFiles(
        paths,
        papers.map((paper) => String(paper?.id || '').trim())
      );
      await writeJsonFile(paths.indexPath, { updatedAt: Date.now() });
      return { ok: true };
    });
  });

  ipcMain.handle('library-save-pdf', async (_event, payload = {}) => {
    return enqueueWrite(async () => {
      const paperId = String(payload.paperId || '').trim();
      if (!paperId) return { ok: false, error: '缺少paperId' };
      await ensureLibraryStoreReady();
      const paths = getLibraryPaths();
      const data = payload.data;
      if (!data) return { ok: false, error: '缺少PDF数据' };
      const buffer = Buffer.from(new Uint8Array(data));
      const paperPointId = getPaperArticleId(paperId);
      const filePath = require('path').join(paths.papersDir, `${paperPointId}.pdf`);
      await fs.writeFile(filePath, buffer);
      await writeJsonFile(paths.indexPath, { updatedAt: Date.now() });
      if (typeof recordSyncChange === 'function') {
        recordSyncChange({
          entityType: 'pdf',
          entityId: paperId,
          action: 'upsert',
          payload: { paperId }
        });
      }
      return { ok: true, filePath };
    });
  });

  ipcMain.handle('library-read-pdf', async (_event, payload = {}) => {
    await ensureLibraryStoreReady();
    const path = require('path');
    const paths = getLibraryPaths();
    const filePath = payload.filePath ? String(payload.filePath) : '';
    const paperId = payload.paperId ? String(payload.paperId) : '';
    let resolvedPath = filePath;
    if (resolvedPath && !(await fileExists(resolvedPath))) {
      resolvedPath = '';
    }
    if (!resolvedPath && paperId) {
      const expectedPath = path.join(paths.papersDir, `${getPaperArticleId(paperId)}.pdf`);
      if (await fileExists(expectedPath)) {
        resolvedPath = expectedPath;
      } else {
        const papers = await loadPapersFromSqlite();
        const entry = Array.isArray(papers) ? papers.find((item) => item.id === paperId) : null;
        resolvedPath = entry?.filePath || '';
      }
    }
    if (!resolvedPath) {
      return { ok: false, error: '未找到PDF路径' };
    }
    try {
      const buffer = await fs.readFile(resolvedPath);
      return { ok: true, data: buffer };
    } catch (error) {
      return { ok: false, error: error?.message || '读取PDF失败' };
    }
  });

  ipcMain.handle('library-get-paper-state', async (_event, payload = {}) => {
    await ensureLibraryStoreReady();
    const paperId = String(payload.paperId || '').trim();
    if (!paperId) return null;
    return loadPaperStateFromSqlite(paperId);
  });

  ipcMain.handle('library-save-paper-state', async (_event, payload = {}) => {
    return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      const paperId = String(payload.paperId || '').trim();
      if (!paperId) return { ok: false, error: '缺少paperId' };
      const result = await savePaperStateToSqlite(paperId, payload.state || {});
      return result;
    });
  });

  ipcMain.handle('library-delete-paper', async (_event, payload = {}) => {
    return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      const path = require('path');
      const paths = getLibraryPaths();
      const paperId = String(payload.paperId || '').trim();
      if (!paperId) return { ok: false, error: '缺少paperId' };
      let resolvedPath = payload.filePath ? String(payload.filePath) : '';
      if (!resolvedPath) {
        resolvedPath = path.join(paths.papersDir, `${getPaperArticleId(paperId)}.pdf`);
      }
      await removeFileIfExists(resolvedPath);
      await removeFileIfExists(path.join(paths.papersDir, `${getPaperArticleId(paperId)}.pdf`));
      await removeFileIfExists(path.join(paths.statesDir, `${paperId}.json`));
      deletePapersFromSqlite([paperId]);
      const papers = await loadPapersFromSqlite();
      const remainIds = Array.isArray(papers)
        ? papers
            .map((paper) => String(paper?.id || '').trim())
            .filter((id) => id && id !== paperId)
        : [];
      await cleanupOrphanPaperStateFiles(paths, remainIds);
      return { ok: true };
    });
  });

  ipcMain.handle('library-delete-papers', async (_event, payload = {}) => {
    return enqueueWrite(async () => {
      await ensureLibraryStoreReady();
      const path = require('path');
      const paths = getLibraryPaths();
      const items = Array.isArray(payload.items) ? payload.items : [];
      const ids = items
        .map((item) => String(item?.id || '').trim())
        .filter(Boolean);
      if (!ids.length) return { ok: true };
      for (const item of items) {
        const paperId = String(item?.id || '').trim();
        if (!paperId) continue;
        let resolvedPath = item?.filePath ? String(item.filePath) : '';
        await removeFileIfExists(resolvedPath);
        await removeFileIfExists(path.join(paths.papersDir, `${getPaperArticleId(paperId)}.pdf`));
        await removeFileIfExists(path.join(paths.statesDir, `${paperId}.json`));
      }
      deletePapersFromSqlite(ids);
      const papers = await loadPapersFromSqlite();
      const idSet = new Set(ids);
      const remainIds = Array.isArray(papers)
        ? papers
            .map((paper) => String(paper?.id || '').trim())
            .filter((id) => id && !idSet.has(id))
        : [];
      await cleanupOrphanPaperStateFiles(paths, remainIds);
      return { ok: true };
    });
  });
};

module.exports = {
  registerLibraryIpc
};
