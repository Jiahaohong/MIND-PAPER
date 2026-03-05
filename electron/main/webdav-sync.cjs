const WEBDAV_PDF_MANIFEST_FILE = 'papers-manifest.json';
const WEBDAV_LOCK_FILE = 'lock.json';
const REMOTE_LOCK_WAIT_TIMEOUT_MS = 15000;
const REMOTE_LOCK_WAIT_POLL_MS = 1000;

const registerWebDavSyncIpc = ({
  ipcMain,
  enqueueWrite,
  syncLibraryToWebDav,
  syncLibraryFromWebDavToLocal
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
};

const createWebDavSyncModule = (deps = {}) => {
  const {
    BrowserWindow,
    path,
    fs,
    fsNative,
    crypto,
    ensureLibrary,
    ensureLibraryStoreReady,
    getLibraryDb,
    getLibraryPaths,
    getPaperArticleId,
    getWebDavConfigFromSettings,
    getWebDavCredential,
    createWebDavClient,
    webdavLockOwner,
    ensureWebDavLock,
    releaseWebDavLock,
    loadPaperStatesFromSqlite,
    loadLibraryDataFromSqliteFile,
    saveFoldersToSqlite,
    savePapersToSqlite,
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

  const cleanupRemoteSnapshot = async (snapshot = null) => {
    const tempPath = String(snapshot?.remoteTempSqlitePath || '').trim();
    if (!tempPath) return;
    await removeFileIfExists(tempPath);
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

  const shouldDownloadPdfFromRemote = (fileName, localManifest, remoteManifest) => {
    const localFiles =
      localManifest?.files && typeof localManifest.files === 'object' ? localManifest.files : {};
    const remoteFiles =
      remoteManifest?.files && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};
    const localMeta = localFiles[fileName];
    const remoteMeta = remoteFiles[fileName];
    if (!remoteMeta) return false;
    if (!localMeta) return true;

    const localSha1 = String(localMeta?.sha1 || '').trim();
    const remoteSha1 = String(remoteMeta?.sha1 || '').trim();
    if (localSha1 && remoteSha1) {
      return localSha1 !== remoteSha1;
    }
    return Number(localMeta?.size || 0) !== Number(remoteMeta?.size || 0);
  };

  const getRemotePdfManifestPath = (remotePath) => `${remotePath}/${WEBDAV_PDF_MANIFEST_FILE}`;
  const getRemoteLockPath = (remotePath) => `${remotePath}/${WEBDAV_LOCK_FILE}`;

  const isRemoteLockAlive = (lock) =>
    Boolean(lock && Number(lock.expiresAt || 0) > Date.now() && String(lock.sessionId || '').trim());

  const isRemoteLockOwnedBySelf = (lock) =>
    String(lock?.sessionId || '').trim() === String(webdavLockOwner?.sessionId || '').trim();

  const formatRemoteLockOwner = (lock) => {
    const device = String(lock?.device || '').trim();
    if (device) return device;
    const sessionId = String(lock?.sessionId || '').trim();
    return sessionId ? `session ${sessionId.slice(0, 8)}` : 'unknown';
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForRemoteLockRelease = async (
    client,
    remotePath,
    { timeoutMs = REMOTE_LOCK_WAIT_TIMEOUT_MS, pollMs = REMOTE_LOCK_WAIT_POLL_MS } = {}
  ) => {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    const lockPath = getRemoteLockPath(remotePath);
    while (true) {
      const lock = await readRemoteJsonFile(client, lockPath).catch(() => null);
      if (!isRemoteLockAlive(lock) || isRemoteLockOwnedBySelf(lock)) {
        return { ok: true, lock: lock || null };
      }
      if (Date.now() >= deadline) {
        return { ok: false, lock };
      }
      emitWebDavSyncState({
        active: true,
        direction: 'download',
        message: `云端正在同步中，等待 ${formatRemoteLockOwner(lock)} 释放锁`
      });
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
  };

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

  const buildStateMap = (states = []) =>
    new Map(
      (Array.isArray(states) ? states : [])
        .map((item) => [String(item?.paperId || '').trim(), item?.state || {}])
        .filter((entry) => entry[0])
    );

  const prepareRemoteWebDavSnapshot = async (client, remotePath, remoteSqlitePath) => {
    const paths = getLibraryPaths();
    const remoteTempSqlitePath = `${paths.sqlitePath}.remote-snapshot`;
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
    return {
      remotePath,
      remoteSqlitePath,
      remoteTempSqlitePath,
      remoteData,
      localManifest,
      remoteManifest
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

      const lockWaitResult = await waitForRemoteLockRelease(client, remotePath);
      if (!lockWaitResult.ok) {
        const owner = formatRemoteLockOwner(lockWaitResult.lock);
        const message = `云端正在由 ${owner} 同步，请稍后重试`;
        console.log(`[webdav-sync] startup download skipped: remote lock still active (${owner})`);
        emitWebDavSyncState({
          active: false,
          direction: 'download',
          message
        });
        return {
          success: false,
          skipped: true,
          locked: true,
          reason: 'remote lock active',
          owner,
          message
        };
      }

      const snapshot = await prepareRemoteWebDavSnapshot(client, remotePath, remoteSqlitePath);
      try {
        await ensureLibrary();
        const paths = getLibraryPaths();
        let downloadedPdfCount = 0;
        let downloadedPdfBytes = 0;
        const remoteFolders = Array.isArray(snapshot?.remoteData?.folders)
          ? snapshot.remoteData.folders
          : [];
        const remotePapers = (Array.isArray(snapshot?.remoteData?.papers) ? snapshot.remoteData.papers : []).sort(
          (a, b) => {
            const aTime = Number(a?.uploadedAt || 0);
            const bTime = Number(b?.uploadedAt || 0);
            if (aTime !== bTime) return bTime - aTime;
            return String(a?.title || '').localeCompare(String(b?.title || ''), 'zh-Hans-CN');
          }
        );
        const remoteStateMap = buildStateMap(snapshot?.remoteData?.states);
        const sqliteStat = await fs.stat(snapshot?.remoteTempSqlitePath).catch(() => null);
        const sqliteBytes = Number(sqliteStat?.size || 0);

        await ensureLibraryStoreReady();
        await saveFoldersToSqlite(remoteFolders);
        await savePapersToSqlite(remotePapers, paths, { preserveIncomingVersion: true });
        const retainedIds = new Set(remotePapers.map((paper) => String(paper?.id || '').trim()).filter(Boolean));
        const localStateIds = (await loadPaperStatesFromSqlite())
          .map((item) => String(item?.paperId || '').trim())
          .filter(Boolean);
        deletePaperStatesFromSqlite(localStateIds.filter((paperId) => !retainedIds.has(paperId)));
        for (const paperId of retainedIds) {
          // eslint-disable-next-line no-await-in-loop
          await savePaperStateToSqlite(paperId, remoteStateMap.get(paperId) || {});
        }

        const remotePapersPath = `${remotePath}/papers`;
        const expectedPdfFiles = new Set();
        for (const paper of remotePapers) {
          const paperId = String(paper?.id || '').trim();
          if (!paperId) continue;
          const fileName = `${getPaperArticleId(paperId)}.pdf`;
          expectedPdfFiles.add(fileName);
          if (!snapshot?.remoteManifest?.files?.[fileName]) continue;
          if (!shouldDownloadPdfFromRemote(fileName, snapshot.localManifest, snapshot.remoteManifest)) {
            continue;
          }
          const localPdfPath = path.join(paths.papersDir, fileName);
          // eslint-disable-next-line no-await-in-loop
          downloadedPdfBytes += await downloadFileFromWebDav(client, `${remotePapersPath}/${fileName}`, localPdfPath);
          downloadedPdfCount += 1;
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
        setSyncPending(false);
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
      } finally {
        await cleanupRemoteSnapshot(snapshot);
      }
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
        console.log('[webdav-sync] upload step mode: overwrite remote snapshot');
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
      setSyncPending(false);
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
    syncLibraryToWebDav
  };
};

module.exports = {
  createWebDavSyncModule,
  registerWebDavSyncIpc
};
