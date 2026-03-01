const WEBDAV_PDF_MANIFEST_FILE = 'papers-manifest.json';

const registerWebDavSyncIpc = ({
  ipcMain,
  enqueueWrite,
  syncLibraryToWebDav,
  syncLibraryFromWebDavToLocal,
  resolveWebDavConflicts
}) => {
  ipcMain.handle('webdav-sync-upload', async () =>
    enqueueWrite(async () => {
      try {
        return await syncLibraryToWebDav();
      } catch (error) {
        return {
          success: false,
          error: error?.message || 'WebDAV 上传失败'
        };
      }
    })
  );

  ipcMain.handle('webdav-sync-download', async () =>
    enqueueWrite(async () => {
      try {
        return await syncLibraryFromWebDavToLocal();
      } catch (error) {
        return {
          success: false,
          error: error?.message || 'WebDAV 下载失败'
        };
      }
    })
  );

  ipcMain.handle('webdav-resolve-conflicts', async (_event, payload = {}) =>
    enqueueWrite(async () => {
      try {
        return await resolveWebDavConflicts(payload);
      } catch (error) {
        return {
          success: false,
          error: error?.message || '处理云端冲突失败'
        };
      }
    })
  );
};

const createWebDavSyncModule = (deps = {}) => {
  const {
    BrowserWindow,
    path,
    fs,
    fsNative,
    crypto,
    formatLogTime,
    ensureLibrary,
    ensureLibraryStoreReady,
    getLibraryDb,
    getLibraryPaths,
    getPaperArticleId,
    normalizeWebDavServer,
    getWebDavConfigFromSettings,
    getWebDavCredential,
    createWebDavClient,
    ensureWebDavLock,
    releaseWebDavLock,
    loadFoldersFromSqlite,
    loadPapersFromSqlite,
    loadPaperStatesFromSqlite,
    loadLibraryDataFromSqliteFile,
    saveFoldersToSqlite,
    savePapersToSqlite,
    markAllPapersBaseVersionCurrent,
    savePaperStateToSqlite,
    deletePaperStatesFromSqlite,
    setSyncPending,
    getSyncPending,
    removeFileIfExists,
    readRemoteJsonFile,
    writeRemoteJsonFile
  } = deps;

  let webdavSyncState = {
    active: false,
    direction: 'idle',
    message: ''
  };
  let pendingWebDavConflict = null;

  const emitWebDavSyncState = (next = {}) => {
    webdavSyncState = {
      ...webdavSyncState,
      ...next
    };
    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        if (win?.isDestroyed?.()) return;
        if (win?.webContents?.isDestroyed?.()) return;
        win.webContents.send('webdav-sync-event', webdavSyncState);
      } catch {
        // ignore sync event dispatch errors
      }
    });
  };

  const emitWebDavConflict = (payload = {}) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      try {
        if (win?.isDestroyed?.()) return;
        if (win?.webContents?.isDestroyed?.()) return;
        win.webContents.send('webdav-conflict-event', payload);
      } catch {
        // ignore conflict event dispatch errors
      }
    });
  };

  const clearPendingWebDavConflict = async () => {
    const tempPath = String(pendingWebDavConflict?.remoteTempSqlitePath || '').trim();
    pendingWebDavConflict = null;
    if (tempPath) {
      await removeFileIfExists(tempPath);
    }
  };

  const createSqliteSyncSnapshot = async () => {
    await ensureLibraryStoreReady();
    const paths = getLibraryPaths();
    const db = getLibraryDb();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore checkpoint failures and still try snapshot copy
    }
    const snapshotPath = `${paths.sqlitePath}.sync`;
    await fs.copyFile(paths.sqlitePath, snapshotPath);
    return {
      snapshotPath,
      fileName: 'library.sqlite'
    };
  };

  const uploadFileToWebDav = async (client, remotePath, localPath) => {
    const data = await fs.readFile(localPath);
    await client.putFileContents(remotePath, data, { overwrite: true });
    return data.length;
  };

  const downloadFileFromWebDav = async (client, remotePath, localPath) => {
    const file = await client.getFileContents(remotePath, { format: 'binary' });
    const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return buffer.length;
  };

  const hashFileSha1 = async (filePath) =>
    new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = fsNative.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });

  const buildLocalPdfManifest = async (papersDir) => {
    const files = await fs.readdir(papersDir).catch(() => []);
    const entries = {};
    for (const file of files) {
      if (!String(file || '').toLowerCase().endsWith('.pdf')) continue;
      const fullPath = path.join(papersDir, file);
      let stat = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        stat = await fs.stat(fullPath);
      } catch {
        stat = null;
      }
      if (!stat?.isFile?.()) continue;
      // eslint-disable-next-line no-await-in-loop
      const sha1 = await hashFileSha1(fullPath);
      entries[file] = {
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
        sha1
      };
    }
    return {
      version: 1,
      updatedAt: Date.now(),
      files: entries
    };
  };

  const getRemotePdfManifestPath = (remotePath) => `${remotePath}/${WEBDAV_PDF_MANIFEST_FILE}`;

  const getChangedPdfFilesForUpload = (localManifest, remoteManifest) => {
    const localFiles =
      localManifest?.files && typeof localManifest.files === 'object' ? localManifest.files : {};
    const remoteFiles =
      remoteManifest?.files && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};
    return Object.entries(localFiles)
      .filter(([file, meta]) => {
        const remote = remoteFiles[file];
        if (!remote) return true;
        return String(meta?.sha1 || '') !== String(remote?.sha1 || '');
      })
      .map(([file]) => file);
  };

  const normalizePaperForConflictCompare = (paper = {}) => ({
    id: String(paper.id || '').trim(),
    version: Math.max(1, Number(paper.version || 1) || 1),
    baseVersion: Math.max(0, Number(paper.baseVersion ?? paper.base_version ?? 0) || 0),
    updatedAt: Number(paper.updatedAt || 0),
    title: String(paper.title || '').trim(),
    author: String(paper.author || '').trim(),
    date: String(paper.date || '').trim(),
    addedDate: String(paper.addedDate || '').trim(),
    uploadedAt: Number(paper.uploadedAt || 0),
    folderId: String(paper.folderId || '').trim(),
    previousFolderId: String(paper.previousFolderId || '').trim(),
    summary: String(paper.summary || '').trim(),
    abstract: String(paper.abstract || '').trim(),
    content: String(paper.content || '').trim(),
    keywords: Array.isArray(paper.keywords) ? [...paper.keywords] : [],
    publisher: String(paper.publisher || '').trim(),
    doi: String(paper.doi || '').trim(),
    references: Array.isArray(paper.references) ? paper.references : [],
    referenceStats: paper.referenceStats || null
  });

  const getPaperVersionInfo = (paper = {}) => {
    const normalized = normalizePaperForConflictCompare(paper);
    const version = Math.max(1, Number(normalized.version || 1) || 1);
    const baseVersion = Math.max(0, Number(normalized.baseVersion || 0) || 0);
    return {
      version,
      baseVersion,
      updatedAt: Number(normalized.updatedAt || 0),
      changedSinceBase: version > baseVersion
    };
  };

  const buildSyncedRemotePaper = (paper = {}) => {
    const version = Math.max(1, Number(paper?.version || 1) || 1);
    return {
      ...paper,
      version,
      baseVersion: version
    };
  };

  const buildPaperMap = (papers = []) =>
    new Map(
      (Array.isArray(papers) ? papers : [])
        .map((paper) => [String(paper?.id || '').trim(), paper])
        .filter((entry) => entry[0])
    );

  const buildStateMap = (states = []) =>
    new Map(
      (Array.isArray(states) ? states : [])
        .map((item) => [String(item?.paperId || '').trim(), item?.state || {}])
        .filter((entry) => entry[0])
    );

  const buildConflictPayload = ({ localData, remoteData, localManifest, remoteManifest, remoteInfo }) => {
    const localPapers = Array.isArray(localData?.papers) ? localData.papers : [];
    const remotePapers = Array.isArray(remoteData?.papers) ? remoteData.papers : [];
    const localPaperMap = buildPaperMap(localPapers);
    const remotePaperMap = buildPaperMap(remotePapers);
    const localFiles =
      localManifest?.files && typeof localManifest.files === 'object' ? localManifest.files : {};
    const remoteFiles =
      remoteManifest?.files && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};
    const allPaperIds = new Set([...localPaperMap.keys(), ...remotePaperMap.keys()]);
    const conflicts = [];

    Array.from(allPaperIds)
      .sort()
      .forEach((paperId) => {
        const localPaper = localPaperMap.get(paperId) || null;
        const remotePaper = remotePaperMap.get(paperId) || null;
        if (!localPaper || !remotePaper) return;
        const localNormalized = normalizePaperForConflictCompare(localPaper);
        const remoteNormalized = normalizePaperForConflictCompare(remotePaper);
        const pdfFile = `${getPaperArticleId(paperId)}.pdf`;
        const localPdf = localFiles[pdfFile] || null;
        const remotePdf = remoteFiles[pdfFile] || null;
        const localVersion = Math.max(1, Number(localNormalized.version || 1) || 1);
        const remoteVersion = Math.max(1, Number(remoteNormalized.version || 1) || 1);
        const localBaseVersion = Math.max(0, Number(localNormalized.baseVersion || 0) || 0);
        const localChanged = localVersion > localBaseVersion;
        const remoteChanged = remoteVersion > localBaseVersion;
        if (!(localChanged && remoteChanged)) return;
        conflicts.push({
          paperId,
          title: String(localPaper.title || remotePaper.title || paperId),
          local: {
            paper: localPaper,
            pdf: localPdf
          },
          remote: {
            paper: remotePaper,
            pdf: remotePdf
          },
          localVersion,
          remoteVersion,
          localBaseVersion,
          localUpdatedAt: Number(localNormalized.updatedAt || 0),
          remoteUpdatedAt: Number(remoteNormalized.updatedAt || 0),
          localBehindRemote: true
        });
      });

    if (conflicts.length) {
      console.log(
        `[webdav-conflict] detected ${conflicts.length} outdated local papers: ${conflicts
          .map(
            (item) =>
              `${item.paperId}(base=v${item.localBaseVersion},local=v${item.localVersion}@${formatLogTime(
                item.localUpdatedAt
              )},remote=v${item.remoteVersion}@${formatLogTime(item.remoteUpdatedAt)})`
          )
          .join(', ')}`
      );
    }

    return {
      ok: false,
      conflict: true,
      server: remoteInfo.server,
      remotePath: remoteInfo.remotePath,
      items: conflicts
    };
  };

  const prepareWebDavConflictIfNeeded = async (client, remotePath, remoteSqlitePath) => {
    const paths = getLibraryPaths();
    const localData = {
      folders: await loadFoldersFromSqlite(),
      papers: await loadPapersFromSqlite(),
      states: await loadPaperStatesFromSqlite()
    };
    const remoteTempSqlitePath = `${paths.sqlitePath}.remote-conflict`;
    await removeFileIfExists(remoteTempSqlitePath);
    await downloadFileFromWebDav(client, remoteSqlitePath, remoteTempSqlitePath);
    const remoteData = loadLibraryDataFromSqliteFile(remoteTempSqlitePath, {
      root: paths.root,
      papersDir: paths.papersDir
    });
    const localManifest = await buildLocalPdfManifest(paths.papersDir);
    const remoteManifest = (await readRemoteJsonFile(client, getRemotePdfManifestPath(remotePath))) || {
      version: 1,
      updatedAt: Date.now(),
      files: {}
    };
    const payload = buildConflictPayload({
      localData,
      remoteData,
      localManifest,
      remoteManifest,
      remoteInfo: {
        server: normalizeWebDavServer((await getWebDavConfigFromSettings()).webdavServer),
        remotePath
      }
    });
    await clearPendingWebDavConflict();
    pendingWebDavConflict = {
      remotePath,
      remoteSqlitePath,
      remoteTempSqlitePath,
      localData,
      remoteData,
      localManifest,
      remoteManifest,
      payload
    };
    return payload.items.length ? payload : null;
  };

  const mergeFoldersForConflictResolution = (localFolders = [], remoteFolders = []) => {
    const merged = new Map();
    [...(Array.isArray(localFolders) ? localFolders : []), ...(Array.isArray(remoteFolders) ? remoteFolders : [])].forEach(
      (folder) => {
        const id = String(folder?.id || '').trim();
        if (!id || merged.has(id)) return;
        merged.set(id, folder);
      }
    );
    return Array.from(merged.values());
  };

  const buildMergedLibraryState = ({ localData, remoteData }) => {
    const localPaperMap = buildPaperMap(localData?.papers);
    const remotePaperMap = buildPaperMap(remoteData?.papers);
    const localStateMap = buildStateMap(localData?.states);
    const remoteStateMap = buildStateMap(remoteData?.states);
    const finalPaperMap = new Map();
    const finalStateMap = new Map();
    const pdfSources = new Map();
    let hasLocalAheadChanges = false;
    const allPaperIds = new Set([...localPaperMap.keys(), ...remotePaperMap.keys()]);

    Array.from(allPaperIds).forEach((paperId) => {
      const localPaper = localPaperMap.get(paperId) || null;
      const remotePaper = remotePaperMap.get(paperId) || null;
      if (localPaper && remotePaper) {
        const { version: localVersion, baseVersion: localBaseVersion, changedSinceBase: localChanged } =
          getPaperVersionInfo(localPaper);
        const { version: remoteVersion } = getPaperVersionInfo(remotePaper);
        const remoteChanged = remoteVersion > localBaseVersion;
        if (!localChanged && remoteChanged) {
          finalPaperMap.set(paperId, buildSyncedRemotePaper(remotePaper));
          finalStateMap.set(paperId, remoteStateMap.get(paperId) || {});
          pdfSources.set(paperId, 'remote');
        } else if (localChanged && !remoteChanged) {
          finalPaperMap.set(paperId, localPaper);
          finalStateMap.set(paperId, localStateMap.get(paperId) || {});
          pdfSources.set(paperId, 'local');
          hasLocalAheadChanges = true;
        } else if (!localChanged && !remoteChanged) {
          const resolvedPaper = remoteVersion >= localVersion ? buildSyncedRemotePaper(remotePaper) : localPaper;
          finalPaperMap.set(paperId, resolvedPaper);
          finalStateMap.set(
            paperId,
            remoteVersion >= localVersion ? remoteStateMap.get(paperId) || {} : localStateMap.get(paperId) || {}
          );
          pdfSources.set(paperId, remoteVersion >= localVersion ? 'remote' : 'local');
        } else {
          finalPaperMap.set(paperId, localPaper);
          finalStateMap.set(paperId, localStateMap.get(paperId) || {});
          pdfSources.set(paperId, 'local');
          hasLocalAheadChanges = true;
        }
        return;
      }
      if (localPaper) {
        finalPaperMap.set(paperId, localPaper);
        finalStateMap.set(paperId, localStateMap.get(paperId) || {});
        pdfSources.set(paperId, 'local');
        hasLocalAheadChanges = true;
        return;
      }
      if (remotePaper) {
        finalPaperMap.set(paperId, buildSyncedRemotePaper(remotePaper));
        finalStateMap.set(paperId, remoteStateMap.get(paperId) || {});
        pdfSources.set(paperId, 'remote');
      }
    });

    return {
      folders: mergeFoldersForConflictResolution(localData?.folders, remoteData?.folders),
      papers: Array.from(finalPaperMap.values()).sort((a, b) => {
        const aTime = Number(a?.uploadedAt || 0);
        const bTime = Number(b?.uploadedAt || 0);
        if (aTime !== bTime) return bTime - aTime;
        return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-Hans-CN');
      }),
      stateMap: finalStateMap,
      pdfSources,
      hasLocalAheadChanges
    };
  };

  const resolveWebDavConflicts = async (payload = {}) => {
    if (!pendingWebDavConflict?.payload?.items?.length) {
      throw new Error('当前没有待处理的云端冲突');
    }
    const decisions = payload?.decisions && typeof payload.decisions === 'object' ? payload.decisions : {};
    const strategy = String(payload?.strategy || '').trim();
    const localPapers = Array.isArray(pendingWebDavConflict.localData?.papers)
      ? pendingWebDavConflict.localData.papers
      : [];
    const remotePapers = Array.isArray(pendingWebDavConflict.remoteData?.papers)
      ? pendingWebDavConflict.remoteData.papers
      : [];
    const localPaperMap = buildPaperMap(localPapers);
    const remotePaperMap = buildPaperMap(remotePapers);
    const localStateMap = buildStateMap(pendingWebDavConflict.localData?.states);
    const remoteStateMap = buildStateMap(pendingWebDavConflict.remoteData?.states);
    const conflictIds = new Set(
      pendingWebDavConflict.payload.items.map((item) => String(item.paperId || '').trim())
    );
    const finalPaperMap = new Map();
    const finalStateMap = new Map();
    const pdfSources = new Map();

    const chooseSource = (paperId) => {
      if (!conflictIds.has(paperId)) {
        if (localPaperMap.has(paperId) && remotePaperMap.has(paperId)) return 'local';
        return localPaperMap.has(paperId) ? 'local' : 'remote';
      }
      const explicit = String(decisions[paperId] || '').trim();
      if (explicit === 'local' || explicit === 'remote') return explicit;
      if (strategy === 'keep-local') return 'local';
      if (strategy === 'keep-remote') return 'remote';
      throw new Error(`缺少冲突项选择: ${paperId}`);
    };

    new Set([...localPaperMap.keys(), ...remotePaperMap.keys()]).forEach((paperId) => {
      const source = chooseSource(paperId);
      const paper = source === 'local' ? localPaperMap.get(paperId) : remotePaperMap.get(paperId);
      if (!paper) return;
      finalPaperMap.set(paperId, paper);
      finalStateMap.set(
        paperId,
        source === 'local' ? localStateMap.get(paperId) || {} : remoteStateMap.get(paperId) || {}
      );
      pdfSources.set(paperId, source);
    });

    const mergedFolders =
      strategy === 'keep-remote'
        ? mergeFoldersForConflictResolution(
            pendingWebDavConflict.remoteData?.folders,
            pendingWebDavConflict.localData?.folders
          )
        : mergeFoldersForConflictResolution(
            pendingWebDavConflict.localData?.folders,
            pendingWebDavConflict.remoteData?.folders
          );
    const finalPapers = Array.from(finalPaperMap.values()).sort((a, b) => {
      const aTime = Number(a?.uploadedAt || 0);
      const bTime = Number(b?.uploadedAt || 0);
      if (aTime !== bTime) return bTime - aTime;
      return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-Hans-CN');
    });

    await ensureLibrary();
    await ensureLibraryStoreReady();
    const paths = getLibraryPaths();
    await saveFoldersToSqlite(mergedFolders);
    await savePapersToSqlite(finalPapers, paths, { preserveIncomingVersion: true });
    const retainedIds = new Set(finalPapers.map((paper) => String(paper?.id || '').trim()).filter(Boolean));
    deletePaperStatesFromSqlite(
      Array.from(new Set([...localStateMap.keys(), ...remoteStateMap.keys()])).filter(
        (paperId) => !retainedIds.has(paperId)
      )
    );
    for (const paperId of retainedIds) {
      // eslint-disable-next-line no-await-in-loop
      await savePaperStateToSqlite(paperId, finalStateMap.get(paperId) || {});
    }

    const server = normalizeWebDavServer((await getWebDavConfigFromSettings()).webdavServer);
    const username = (await getWebDavConfigFromSettings()).webdavUsername;
    const password = await getWebDavCredential(server, username);
    if (!server || !username || !password) {
      throw new Error('请先在设置中完成 WebDAV 配置并保存凭据');
    }
    const client = await createWebDavClient(server, username, password);
    const remotePapersPath = `${pendingWebDavConflict.remotePath}/papers`;
    const expectedPdfFiles = new Set();
    for (const paper of finalPapers) {
      const paperId = String(paper?.id || '').trim();
      if (!paperId) continue;
      const fileName = `${getPaperArticleId(paperId)}.pdf`;
      expectedPdfFiles.add(fileName);
      const targetPath = path.join(paths.papersDir, fileName);
      const source = pdfSources.get(paperId) || 'local';
      if (source === 'remote') {
        if (pendingWebDavConflict.remoteManifest?.files?.[fileName]) {
          // eslint-disable-next-line no-await-in-loop
          await downloadFileFromWebDav(client, `${remotePapersPath}/${fileName}`, targetPath);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await removeFileIfExists(targetPath);
        }
      }
    }
    const localPdfFiles = await fs.readdir(paths.papersDir).catch(() => []);
    for (const file of localPdfFiles) {
      if (!String(file || '').toLowerCase().endsWith('.pdf')) continue;
      if (expectedPdfFiles.has(file)) continue;
      // eslint-disable-next-line no-await-in-loop
      await removeFileIfExists(path.join(paths.papersDir, file));
    }

    setSyncPending(true);
    const uploadResult = await syncLibraryToWebDav();
    await clearPendingWebDavConflict();
    emitWebDavConflict({ active: false });
    return {
      success: Boolean(uploadResult?.success),
      resolved: true,
      uploaded: uploadResult
    };
  };

  const syncLibraryFromWebDavToLocal = async () => {
    const config = await getWebDavConfigFromSettings();
    const server = config.webdavServer;
    const username = config.webdavUsername;
    const remotePath = config.webdavRemotePath;
    const password = await getWebDavCredential(server, username);
    if (!server || !username || !password) {
      console.log('[webdav-sync] startup download skipped: missing config or credential');
      return { success: false, skipped: true, reason: 'missing config or credential' };
    }

    emitWebDavSyncState({
      active: true,
      direction: 'download',
      message: '正在从云端同步'
    });

    try {
      const client = await createWebDavClient(server, username, password);
      await client.getDirectoryContents('/');
      if (!(await client.exists(remotePath))) {
        console.log(`[webdav-sync] startup download skipped: remote path not found (${server}${remotePath})`);
        emitWebDavSyncState({
          active: false,
          direction: 'download',
          message: '云端目录不存在'
        });
        return { success: false, skipped: true, reason: 'remote path not found' };
      }
      const remoteSqlitePath = `${remotePath}/library.sqlite`;
      if (!(await client.exists(remoteSqlitePath))) {
        console.log(
          `[webdav-sync] startup download skipped: remote sqlite not found (${server}${remoteSqlitePath})`
        );
        emitWebDavSyncState({
          active: false,
          direction: 'download',
          message: '云端数据库不存在'
        });
        return { success: false, skipped: true, reason: 'remote sqlite not found' };
      }

      const conflict = await prepareWebDavConflictIfNeeded(client, remotePath, remoteSqlitePath);
      if (conflict) {
        emitWebDavSyncState({
          active: false,
          direction: 'download',
          message: '检测到本地与云端冲突'
        });
        emitWebDavConflict({ active: true, mode: 'download', ...conflict });
        return conflict;
      }

      await ensureLibrary();
      const paths = getLibraryPaths();
      let downloadedPdfCount = 0;
      let downloadedPdfBytes = 0;
      const merged = buildMergedLibraryState({
        localData: pendingWebDavConflict?.localData || { folders: [], papers: [], states: [] },
        remoteData: pendingWebDavConflict?.remoteData || { folders: [], papers: [], states: [] }
      });
      const sqliteStat = await fs.stat(pendingWebDavConflict?.remoteTempSqlitePath).catch(() => null);
      const sqliteBytes = Number(sqliteStat?.size || 0);
      await ensureLibraryStoreReady();
      await saveFoldersToSqlite(merged.folders);
      await savePapersToSqlite(merged.papers, paths, { preserveIncomingVersion: true });
      const retainedIds = new Set(merged.papers.map((paper) => String(paper?.id || '').trim()).filter(Boolean));
      deletePaperStatesFromSqlite(
        Array.from(
          new Set([
            ...buildStateMap(pendingWebDavConflict?.localData?.states).keys(),
            ...buildStateMap(pendingWebDavConflict?.remoteData?.states).keys()
          ])
        ).filter((paperId) => !retainedIds.has(paperId))
      );
      for (const paperId of retainedIds) {
        // eslint-disable-next-line no-await-in-loop
        await savePaperStateToSqlite(paperId, merged.stateMap.get(paperId) || {});
      }

      const remotePapersPath = `${remotePath}/papers`;
      const expectedPdfFiles = new Set();
      for (const paper of merged.papers) {
        const paperId = String(paper?.id || '').trim();
        if (!paperId) continue;
        const fileName = `${getPaperArticleId(paperId)}.pdf`;
        expectedPdfFiles.add(fileName);
        if (merged.pdfSources.get(paperId) !== 'remote') continue;
        if (pendingWebDavConflict?.remoteManifest?.files?.[fileName]) {
          const localPdfPath = path.join(paths.papersDir, fileName);
          // eslint-disable-next-line no-await-in-loop
          downloadedPdfBytes += await downloadFileFromWebDav(
            client,
            `${remotePapersPath}/${fileName}`,
            localPdfPath
          );
          downloadedPdfCount += 1;
        }
      }
      const localPdfFiles = await fs.readdir(paths.papersDir).catch(() => []);
      for (const file of localPdfFiles) {
        if (!String(file || '').toLowerCase().endsWith('.pdf')) continue;
        if (expectedPdfFiles.has(file)) continue;
        // eslint-disable-next-line no-await-in-loop
        await removeFileIfExists(path.join(paths.papersDir, file));
      }

      console.log(
        `[webdav-sync] download complete: sqlite=${sqliteBytes}B, pdfs=${downloadedPdfCount}, pdfBytes=${downloadedPdfBytes}B, remote=${server}${remotePath}, syncPending=${getSyncPending()}`
      );
      setSyncPending(Boolean(merged.hasLocalAheadChanges));
      await clearPendingWebDavConflict();
      emitWebDavSyncState({
        active: false,
        direction: 'download',
        message: '云端同步完成'
      });
      return {
        success: true,
        sqliteBytes,
        downloadedPdfCount,
        downloadedPdfBytes,
        remotePath,
        server
      };
    } catch (error) {
      emitWebDavSyncState({
        active: false,
        direction: 'download',
        message: error?.message || '云端同步失败'
      });
      throw error;
    }
  };

  const syncLibraryToWebDav = async () => {
    const config = await getWebDavConfigFromSettings();
    const server = config.webdavServer;
    const username = config.webdavUsername;
    const remotePath = config.webdavRemotePath;
    const password = await getWebDavCredential(server, username);
    if (!server || !username || !password) {
      throw new Error('请先在设置中完成 WebDAV 配置并保存凭据');
    }

    emitWebDavSyncState({
      active: true,
      direction: 'upload',
      message: '正在上传到云端'
    });
    console.log(`[webdav-sync] upload start: remote=${server}${remotePath}`);

    try {
      console.log('[webdav-sync] upload step start: connect');
      const client = await createWebDavClient(server, username, password);
      await client.getDirectoryContents('/');
      console.log('[webdav-sync] upload step done: connect');
      if (!(await client.exists(remotePath))) {
        console.log(`[webdav-sync] upload step start: ensure remote dir ${remotePath}`);
        await client.createDirectory(remotePath, { recursive: true });
        console.log(`[webdav-sync] upload step done: ensure remote dir ${remotePath}`);
      }
      console.log('[webdav-sync] upload step start: acquire lock');
      await ensureWebDavLock(client, remotePath);
      console.log('[webdav-sync] upload step done: acquire lock');
      const remotePapersPath = `${remotePath}/papers`;
      if (!(await client.exists(remotePapersPath))) {
        console.log(`[webdav-sync] upload step start: ensure remote dir ${remotePapersPath}`);
        await client.createDirectory(remotePapersPath, { recursive: true });
        console.log(`[webdav-sync] upload step done: ensure remote dir ${remotePapersPath}`);
      }

      const paths = getLibraryPaths();
      const remoteSqlitePath = `${remotePath}/library.sqlite`;
      if (await client.exists(remoteSqlitePath)) {
        console.log('[webdav-sync] upload step start: detect conflict');
        const conflict = await prepareWebDavConflictIfNeeded(client, remotePath, remoteSqlitePath);
        if (conflict) {
          console.log(`[webdav-sync] upload step stop: conflict detected count=${conflict.items?.length || 0}`);
          emitWebDavSyncState({
            active: false,
            direction: 'upload',
            message: '检测到本地与云端冲突'
          });
          emitWebDavConflict({ active: true, mode: 'upload', ...conflict });
          return conflict;
        }
        console.log('[webdav-sync] upload step done: detect conflict');
        if (pendingWebDavConflict) {
          console.log('[webdav-sync] upload step start: merge remote changes into local cache');
          const merged = buildMergedLibraryState({
            localData: pendingWebDavConflict.localData,
            remoteData: pendingWebDavConflict.remoteData
          });
          await ensureLibraryStoreReady();
          await saveFoldersToSqlite(merged.folders);
          await savePapersToSqlite(merged.papers, paths, { preserveIncomingVersion: true });
          const retainedIds = new Set(
            merged.papers.map((paper) => String(paper?.id || '').trim()).filter(Boolean)
          );
          deletePaperStatesFromSqlite(
            Array.from(
              new Set([
                ...buildStateMap(pendingWebDavConflict.localData?.states).keys(),
                ...buildStateMap(pendingWebDavConflict.remoteData?.states).keys()
              ])
            ).filter((paperId) => !retainedIds.has(paperId))
          );
          for (const paperId of retainedIds) {
            // eslint-disable-next-line no-await-in-loop
            await savePaperStateToSqlite(paperId, merged.stateMap.get(paperId) || {});
          }
          for (const paper of merged.papers) {
            const paperId = String(paper?.id || '').trim();
            if (!paperId) continue;
            if (merged.pdfSources.get(paperId) !== 'remote') continue;
            const fileName = `${getPaperArticleId(paperId)}.pdf`;
            if (!pendingWebDavConflict.remoteManifest?.files?.[fileName]) continue;
            // eslint-disable-next-line no-await-in-loop
            await downloadFileFromWebDav(
              client,
              `${remotePapersPath}/${fileName}`,
              path.join(paths.papersDir, fileName)
            );
          }
          console.log('[webdav-sync] upload step done: merge remote changes into local cache');
        }
      }
      console.log('[webdav-sync] upload step start: create sqlite snapshot');
      const snapshot = await createSqliteSyncSnapshot();
      console.log(`[webdav-sync] upload step done: create sqlite snapshot path=${snapshot.snapshotPath}`);
      let uploadedPdfCount = 0;
      let uploadedPdfBytes = 0;
      let sqliteBytes = 0;

      try {
        console.log('[webdav-sync] upload step start: upload sqlite');
        sqliteBytes = await uploadFileToWebDav(client, `${remotePath}/${snapshot.fileName}`, snapshot.snapshotPath);
        console.log(`[webdav-sync] upload step done: upload sqlite bytes=${sqliteBytes}`);
        console.log('[webdav-sync] upload step start: build local pdf manifest');
        const localManifest = await buildLocalPdfManifest(paths.papersDir);
        console.log(
          `[webdav-sync] upload step done: build local pdf manifest files=${Object.keys(localManifest.files || {}).length}`
        );
        console.log('[webdav-sync] upload step start: read remote pdf manifest');
        const remoteManifest = await readRemoteJsonFile(client, getRemotePdfManifestPath(remotePath));
        console.log(
          `[webdav-sync] upload step done: read remote pdf manifest files=${Object.keys(remoteManifest?.files || {}).length}`
        );
        const filesToUpload = getChangedPdfFilesForUpload(localManifest, remoteManifest);
        console.log(`[webdav-sync] upload step start: upload changed pdfs count=${filesToUpload.length}`);
        const remoteFiles =
          remoteManifest?.files && typeof remoteManifest.files === 'object'
            ? Object.keys(remoteManifest.files)
            : [];
        for (const file of filesToUpload) {
          const localPath = path.join(paths.papersDir, file);
          uploadedPdfBytes += await uploadFileToWebDav(client, `${remotePapersPath}/${file}`, localPath);
          uploadedPdfCount += 1;
        }
        console.log(
          `[webdav-sync] upload step done: upload changed pdfs count=${uploadedPdfCount} bytes=${uploadedPdfBytes}`
        );
        console.log('[webdav-sync] upload step start: delete remote stale pdfs');
        for (const remoteFile of remoteFiles) {
          if (localManifest.files[remoteFile]) continue;
          await client.deleteFile(`${remotePapersPath}/${remoteFile}`).catch(() => null);
        }
        console.log('[webdav-sync] upload step done: delete remote stale pdfs');
        console.log('[webdav-sync] upload step start: write remote pdf manifest');
        await writeRemoteJsonFile(client, getRemotePdfManifestPath(remotePath), localManifest);
        console.log('[webdav-sync] upload step done: write remote pdf manifest');
      } finally {
        await removeFileIfExists(snapshot.snapshotPath);
      }

      console.log(
        `[webdav-sync] upload complete: sqlite=${sqliteBytes}B, pdfs=${uploadedPdfCount}, pdfBytes=${uploadedPdfBytes}B, remote=${server}${remotePath}, syncPending=${getSyncPending()}`
      );
      markAllPapersBaseVersionCurrent();
      setSyncPending(false);
      await clearPendingWebDavConflict();
      emitWebDavSyncState({
        active: false,
        direction: 'upload',
        message: '上传完成'
      });
      return {
        success: true,
        sqliteBytes,
        uploadedPdfCount,
        uploadedPdfBytes,
        remotePath,
        server
      };
    } catch (error) {
      console.warn(`[webdav-sync] upload failed: ${error?.message || error}`);
      emitWebDavSyncState({
        active: false,
        direction: 'upload',
        message: error?.message || '上传失败'
      });
      throw error;
    } finally {
      await releaseWebDavLock();
    }
  };

  return {
    getWebDavSyncState: () => webdavSyncState,
    syncLibraryFromWebDavToLocal,
    syncLibraryToWebDav,
    resolveWebDavConflicts
  };
};

module.exports = {
  createWebDavSyncModule,
  registerWebDavSyncIpc
};
