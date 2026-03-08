const REMOTE_SYNC_DIR = 'sync';
const REMOTE_META_FILE = `${REMOTE_SYNC_DIR}/meta.json`;
const REMOTE_CHANGES_FILE = `${REMOTE_SYNC_DIR}/changes.json`;
const REMOTE_LOCK_FILE = `${REMOTE_SYNC_DIR}/lock.json`;
const REMOTE_SQLITE_FILE = 'library.sqlite';
const REMOTE_PAPERS_DIR = 'papers';
const REMOTE_PDF_MANIFEST_FILE = 'papers-manifest.json';

const LOCAL_SYNC_LAST_APPLIED_VERSION_KEY = '__sync_last_applied_version__';

const REMOTE_LOCK_TTL_MS = 10 * 60 * 1000;
const REMOTE_LOCK_WAIT_TIMEOUT_MS = 20 * 1000;
const REMOTE_LOCK_WAIT_POLL_MS = 1000;
const REMOTE_CHANGE_LOG_KEEP = 5000;

const registerWebDavSyncIpc = ({
  ipcMain,
  enqueueWrite,
  beforeSync,
  syncLibrary
}) => {
  ipcMain.handle('webdav-sync', async (_event, payload = {}) => {
    try {
      // Must run outside write queue to avoid waiting on self (deadlock).
      if (typeof beforeSync === 'function') {
        await beforeSync();
      }
      return await enqueueWrite(async () => {
        const mode = String(payload?.mode || 'auto').trim();
        return syncLibrary({ mode });
      });
    } catch (error) {
      return {
        success: false,
        error: error?.message || '云同步失败'
      };
    }
  });
};

const createWebDavSyncModule = (deps = {}) => {
  const {
    path,
    fs,
    fsNative,
    crypto,
    os,
    app,
    getLibraryPaths,
    ensureLibraryStoreReady,
    loadFoldersFromSqlite,
    loadPapersFromSqlite,
    loadPaperStatesFromSqlite,
    saveFoldersToSqlite,
    savePapersToSqlite,
    savePaperStateToSqlite,
    deletePaperStatesFromSqlite,
    loadLibraryDataFromSqliteFile,
    removeFileIfExists,
    getPaperArticleId,
    getWebDavConfigFromSettings,
    getWebDavCredential,
    createWebDavClient,
    loadSyncQueueEntries,
    clearSyncQueueEntries,
    getSyncQueueSize,
    withSyncQueueSuppressed,
    getLibraryKv,
    setLibraryKv
  } = deps;

  const lockOwner = {
    sessionId: crypto.randomUUID(),
    device: `${os.hostname()}-${app.getName()}`,
    appVersion: app.getVersion()
  };
  let activeLockPath = '';

  const now = () => Date.now();

  const getLocalAppliedVersion = () =>
    Math.max(0, Number(getLibraryKv(LOCAL_SYNC_LAST_APPLIED_VERSION_KEY, 0) || 0));

  const setLocalAppliedVersion = (version) => {
    setLibraryKv(LOCAL_SYNC_LAST_APPLIED_VERSION_KEY, Math.max(0, Number(version || 0)));
  };

  const ensureRemoteDirectory = async (client, remotePath) => {
    if (!(await client.exists(remotePath))) {
      await client.createDirectory(remotePath, { recursive: true });
    }
  };

  const readRemoteJsonFile = async (client, remoteFilePath, fallback = null) => {
    const exists = await client.exists(remoteFilePath);
    if (!exists) return fallback;
    const content = await client.getFileContents(remoteFilePath, { format: 'text' });
    try {
      return JSON.parse(String(content || ''));
    } catch {
      return fallback;
    }
  };

  const writeRemoteJsonFile = async (client, remoteFilePath, payload) => {
    await client.putFileContents(remoteFilePath, JSON.stringify(payload, null, 2), {
      overwrite: true
    });
  };

  const isRemoteLockAlive = (lock) =>
    Boolean(lock && Number(lock.expiresAt || 0) > now() && String(lock.sessionId || '').trim());

  const isRemoteLockOwnedBySelf = (lock) =>
    String(lock?.sessionId || '').trim() === String(lockOwner.sessionId || '').trim();

  const buildRemoteLockPayload = () => {
    const t = now();
    return {
      sessionId: lockOwner.sessionId,
      device: lockOwner.device,
      appVersion: lockOwner.appVersion,
      acquiredAt: t,
      refreshedAt: t,
      expiresAt: t + REMOTE_LOCK_TTL_MS
    };
  };

  const acquireRemoteLock = async (client, remotePath) => {
    const lockPath = `${remotePath}/${REMOTE_LOCK_FILE}`;
    const existing = await readRemoteJsonFile(client, lockPath, null);
    if (isRemoteLockAlive(existing) && !isRemoteLockOwnedBySelf(existing)) {
      throw new Error(`云端正在被其他设备同步: ${String(existing?.device || 'unknown')}`);
    }
    const payload = buildRemoteLockPayload();
    await writeRemoteJsonFile(client, lockPath, payload);
    activeLockPath = lockPath;
  };

  const releaseRemoteLock = async (client) => {
    if (!activeLockPath) return;
    try {
      const lock = await readRemoteJsonFile(client, activeLockPath, null);
      if (isRemoteLockOwnedBySelf(lock)) {
        await client.deleteFile(activeLockPath).catch(() => null);
      }
    } finally {
      activeLockPath = '';
    }
  };

  const clearWebDavLock = async () => {
    const config = await getWebDavConfigFromSettings();
    const server = config.webdavServer;
    const username = config.webdavUsername;
    const remotePath = config.webdavRemotePath;
    const password = await getWebDavCredential(server, username);
    if (!server || !username || !password) {
      throw new Error('请先在设置中完成 WebDAV 配置并保存凭据');
    }
    const client = await createWebDavClient(server, username, password);
    await ensureRemoteDirectory(client, remotePath);
    const lockPath = `${remotePath}/${REMOTE_LOCK_FILE}`;
    if (!(await client.exists(lockPath))) {
      return { success: true, cleared: false, message: '云端锁不存在' };
    }
    await client.deleteFile(lockPath);
    return { success: true, cleared: true, message: '已清除云端锁' };
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForRemoteLockRelease = async (client, remotePath) => {
    const deadline = now() + REMOTE_LOCK_WAIT_TIMEOUT_MS;
    const lockPath = `${remotePath}/${REMOTE_LOCK_FILE}`;
    while (true) {
      const lock = await readRemoteJsonFile(client, lockPath, null);
      if (!isRemoteLockAlive(lock) || isRemoteLockOwnedBySelf(lock)) {
        return { ok: true };
      }
      if (now() >= deadline) {
        return {
          ok: false,
          lock
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(REMOTE_LOCK_WAIT_POLL_MS);
    }
  };

  const normalizeRemoteChange = (item) => {
    const version = Number(item?.version || 0);
    const entityType = String(item?.entityType || '').trim();
    const entityId = String(item?.entityId || '').trim();
    const action = String(item?.action || '').trim();
    if (!Number.isFinite(version) || version <= 0) return null;
    if (!entityType || !entityId || !action) return null;
    return {
      version: Math.floor(version),
      opId: String(item?.opId || '').trim() || `v${version}-${entityType}-${entityId}`,
      entityType,
      entityId,
      action,
      payload: item?.payload && typeof item.payload === 'object' ? item.payload : {},
      updatedAt: Number(item?.updatedAt || now())
    };
  };

  const loadRemoteSyncState = async (client, remotePath) => {
    const metaPath = `${remotePath}/${REMOTE_META_FILE}`;
    const changesPath = `${remotePath}/${REMOTE_CHANGES_FILE}`;
    const metaRaw = await readRemoteJsonFile(client, metaPath, null);
    const changesRaw = await readRemoteJsonFile(client, changesPath, []);
    const changes = (Array.isArray(changesRaw) ? changesRaw : [])
      .map((item) => normalizeRemoteChange(item))
      .filter(Boolean)
      .sort((a, b) => a.version - b.version);
    const latestVersion = changes.length ? Number(changes[changes.length - 1].version || 0) : 0;
    const versionFromMeta = Number(metaRaw?.libraryVersion || 0);
    const libraryVersion = Math.max(
      0,
      Number.isFinite(versionFromMeta) ? Math.floor(versionFromMeta) : 0,
      latestVersion
    );
    return {
      meta: {
        libraryVersion,
        updatedAt: Number(metaRaw?.updatedAt || 0) || now()
      },
      changes
    };
  };

  const pruneRemoteChanges = (changes, latestVersion) => {
    if (!Array.isArray(changes) || !changes.length) return [];
    const minVersion = Math.max(1, Number(latestVersion || 0) - REMOTE_CHANGE_LOG_KEEP + 1);
    return changes.filter((item) => Number(item?.version || 0) >= minVersion);
  };

  const writeRemoteSyncState = async (client, remotePath, meta, changes) => {
    const changesPath = `${remotePath}/${REMOTE_CHANGES_FILE}`;
    const metaPath = `${remotePath}/${REMOTE_META_FILE}`;
    const nextChanges = pruneRemoteChanges(changes, meta.libraryVersion);
    await writeRemoteJsonFile(client, changesPath, nextChanges);
    await writeRemoteJsonFile(client, metaPath, {
      libraryVersion: Number(meta.libraryVersion || 0),
      updatedAt: now()
    });
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
        sha1,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0)
      };
    }
    return {
      version: 1,
      updatedAt: now(),
      files: entries
    };
  };

  const downloadBinaryFile = async (client, remoteFilePath, localFilePath) => {
    const file = await client.getFileContents(remoteFilePath, { format: 'binary' });
    const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
    await fs.mkdir(path.dirname(localFilePath), { recursive: true });
    await fs.writeFile(localFilePath, buffer);
    return buffer.length;
  };

  const uploadBinaryFile = async (client, remoteFilePath, localFilePath) => {
    const data = await fs.readFile(localFilePath);
    await client.putFileContents(remoteFilePath, data, { overwrite: true });
    return data.length;
  };

  const readRemotePdfManifest = async (client, remotePath) =>
    (await readRemoteJsonFile(client, `${remotePath}/${REMOTE_PDF_MANIFEST_FILE}`, null)) || {
      version: 1,
      updatedAt: 0,
      files: {}
    };

  const syncRemotePdfFilesFromLocal = async (client, remotePath, paths) => {
    const remotePapersPath = `${remotePath}/${REMOTE_PAPERS_DIR}`;
    if (!(await client.exists(remotePapersPath))) {
      await client.createDirectory(remotePapersPath, { recursive: true });
    }
    const localManifest = await buildLocalPdfManifest(paths.papersDir);
    const remoteManifest = await readRemotePdfManifest(client, remotePath);
    const localFiles = localManifest.files || {};
    const remoteFiles = remoteManifest.files && typeof remoteManifest.files === 'object' ? remoteManifest.files : {};

    let uploadedPdfCount = 0;
    let uploadedPdfBytes = 0;
    for (const [fileName, localMeta] of Object.entries(localFiles)) {
      const remoteMeta = remoteFiles[fileName];
      if (remoteMeta && String(remoteMeta.sha1 || '') === String(localMeta.sha1 || '')) {
        continue;
      }
      const localFilePath = path.join(paths.papersDir, fileName);
      // eslint-disable-next-line no-await-in-loop
      uploadedPdfBytes += await uploadBinaryFile(client, `${remotePapersPath}/${fileName}`, localFilePath);
      uploadedPdfCount += 1;
    }

    const staleRemoteFiles = Object.keys(remoteFiles).filter((fileName) => !localFiles[fileName]);
    for (const fileName of staleRemoteFiles) {
      // eslint-disable-next-line no-await-in-loop
      await client.deleteFile(`${remotePapersPath}/${fileName}`).catch(() => null);
    }

    await writeRemoteJsonFile(client, `${remotePath}/${REMOTE_PDF_MANIFEST_FILE}`, {
      ...localManifest,
      updatedAt: now()
    });

    return {
      uploadedPdfCount,
      uploadedPdfBytes
    };
  };

  const syncLocalPdfFilesFromRemote = async (client, remotePath, paths, papers) => {
    const remotePapersPath = `${remotePath}/${REMOTE_PAPERS_DIR}`;
    const remoteManifest = await readRemotePdfManifest(client, remotePath);
    const localManifest = await buildLocalPdfManifest(paths.papersDir);
    const expectedFiles = new Set(
      (Array.isArray(papers) ? papers : [])
        .map((paper) => String(paper?.id || '').trim())
        .filter(Boolean)
        .map((paperId) => `${getPaperArticleId(paperId)}.pdf`)
    );

    let downloadedPdfCount = 0;
    let downloadedPdfBytes = 0;
    for (const fileName of expectedFiles) {
      const remoteMeta = remoteManifest?.files?.[fileName];
      if (!remoteMeta) continue;
      const localMeta = localManifest?.files?.[fileName];
      if (localMeta && String(localMeta.sha1 || '') === String(remoteMeta.sha1 || '')) {
        continue;
      }
      const remoteFilePath = `${remotePapersPath}/${fileName}`;
      // eslint-disable-next-line no-await-in-loop
      if (!(await client.exists(remoteFilePath))) continue;
      // eslint-disable-next-line no-await-in-loop
      downloadedPdfBytes += await downloadBinaryFile(
        client,
        remoteFilePath,
        path.join(paths.papersDir, fileName)
      );
      downloadedPdfCount += 1;
    }

    const localFiles = await fs.readdir(paths.papersDir).catch(() => []);
    for (const fileName of localFiles) {
      if (!String(fileName || '').toLowerCase().endsWith('.pdf')) continue;
      if (expectedFiles.has(fileName)) continue;
      // eslint-disable-next-line no-await-in-loop
      await removeFileIfExists(path.join(paths.papersDir, fileName));
    }

    return {
      downloadedPdfCount,
      downloadedPdfBytes
    };
  };

  const createSqliteSnapshot = async () => {
    await ensureLibraryStoreReady();
    const paths = getLibraryPaths();
    const snapshotPath = `${paths.sqlitePath}.sync`;
    await removeFileIfExists(snapshotPath);
    await fs.copyFile(paths.sqlitePath, snapshotPath);
    return snapshotPath;
  };

  const uploadLocalSqliteSnapshot = async (client, remotePath) => {
    const paths = getLibraryPaths();
    const snapshotPath = await createSqliteSnapshot();
    try {
      return await uploadBinaryFile(client, `${remotePath}/${REMOTE_SQLITE_FILE}`, snapshotPath);
    } finally {
      await removeFileIfExists(snapshotPath);
    }
  };

  const applyRemoteChanges = async (client, remotePath, changes = []) => {
    const paths = getLibraryPaths();
    const list = (Array.isArray(changes) ? changes : [])
      .map((item) => normalizeRemoteChange(item))
      .filter(Boolean)
      .sort((a, b) => a.version - b.version);
    if (!list.length) {
      return {
        appliedCount: 0,
        downloadedPdfCount: 0,
        downloadedPdfBytes: 0
      };
    }

    let folders = await loadFoldersFromSqlite();
    let papers = await loadPapersFromSqlite();
    const stateMap = new Map(
      (await loadPaperStatesFromSqlite())
        .map((item) => [String(item?.paperId || '').trim(), item?.state || {}])
        .filter((entry) => entry[0])
    );
    const pdfChanges = [];

    list.forEach((change) => {
      if (change.entityType === 'folders' && change.action === 'upsert') {
        const nextFolders = Array.isArray(change?.payload?.folders) ? change.payload.folders : null;
        if (nextFolders) folders = nextFolders;
        return;
      }
      if (change.entityType === 'papers' && change.action === 'upsert') {
        const nextPapers = Array.isArray(change?.payload?.papers) ? change.payload.papers : null;
        if (nextPapers) papers = nextPapers;
        return;
      }
      if (change.entityType === 'paper_state') {
        const paperId = String(change?.payload?.paperId || change.entityId || '').trim();
        if (!paperId) return;
        if (change.action === 'delete') {
          stateMap.delete(paperId);
          return;
        }
        stateMap.set(paperId, change?.payload?.state || {});
        return;
      }
      if (change.entityType === 'pdf') {
        pdfChanges.push(change);
      }
    });

    const retainPaperIds = new Set(
      (Array.isArray(papers) ? papers : []).map((paper) => String(paper?.id || '').trim()).filter(Boolean)
    );

    const saveResult = await withSyncQueueSuppressed(async () => {
      await saveFoldersToSqlite(folders, { skipSyncQueue: true });
      await savePapersToSqlite(papers, paths, {
        preserveIncomingVersion: true,
        skipSyncQueue: true
      });

      const staleStateIds = Array.from(stateMap.keys()).filter((paperId) => !retainPaperIds.has(paperId));
      staleStateIds.forEach((paperId) => stateMap.delete(paperId));
      const localStateIds = (await loadPaperStatesFromSqlite())
        .map((item) => String(item?.paperId || '').trim())
        .filter(Boolean);
      deletePaperStatesFromSqlite(localStateIds.filter((paperId) => !stateMap.has(paperId)));
      for (const [paperId, state] of stateMap.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await savePaperStateToSqlite(paperId, state || {}, { skipSyncQueue: true });
      }
    });

    let downloadedPdfCount = 0;
    let downloadedPdfBytes = 0;
    const remotePapersPath = `${remotePath}/${REMOTE_PAPERS_DIR}`;
    for (const change of pdfChanges) {
      const paperId = String(change?.payload?.paperId || change.entityId || '').trim();
      if (!paperId) continue;
      const fileName = `${getPaperArticleId(paperId)}.pdf`;
      const localFilePath = path.join(paths.papersDir, fileName);
      if (change.action === 'delete') {
        // eslint-disable-next-line no-await-in-loop
        await removeFileIfExists(localFilePath);
        continue;
      }
      const remoteFilePath = `${remotePapersPath}/${fileName}`;
      // eslint-disable-next-line no-await-in-loop
      if (!(await client.exists(remoteFilePath))) continue;
      const remoteSha1 = String(change?.payload?.sha1 || '').trim();
      if (remoteSha1) {
        let localSha1 = '';
        try {
          // eslint-disable-next-line no-await-in-loop
          localSha1 = await hashFileSha1(localFilePath);
        } catch {
          localSha1 = '';
        }
        if (localSha1 && localSha1 === remoteSha1) continue;
      }
      // eslint-disable-next-line no-await-in-loop
      downloadedPdfBytes += await downloadBinaryFile(client, remoteFilePath, localFilePath);
      downloadedPdfCount += 1;
    }

    const manifestResult = await syncLocalPdfFilesFromRemote(client, remotePath, paths, papers);
    downloadedPdfCount += Number(manifestResult?.downloadedPdfCount || 0);
    downloadedPdfBytes += Number(manifestResult?.downloadedPdfBytes || 0);

    return {
      appliedCount: list.length,
      downloadedPdfCount,
      downloadedPdfBytes,
      saveResult
    };
  };

  const downloadFullRemoteSnapshot = async (client, remotePath, remoteVersion) => {
    const paths = getLibraryPaths();
    const remoteSqlitePath = `${remotePath}/${REMOTE_SQLITE_FILE}`;
    if (!(await client.exists(remoteSqlitePath))) {
      return {
        success: false,
        skipped: true,
        reason: 'remote sqlite not found'
      };
    }
    const tempPath = `${paths.sqlitePath}.remote-full`;
    await removeFileIfExists(tempPath);
    try {
      const sqliteBytes = await downloadBinaryFile(client, remoteSqlitePath, tempPath);
      const remoteData = loadLibraryDataFromSqliteFile(tempPath, {
        root: paths.root,
        papersDir: paths.papersDir
      });
      const folders = Array.isArray(remoteData?.folders) ? remoteData.folders : [];
      const papers = Array.isArray(remoteData?.papers) ? remoteData.papers : [];
      const states = Array.isArray(remoteData?.states) ? remoteData.states : [];
      const stateMap = new Map(
        states
          .map((item) => [String(item?.paperId || '').trim(), item?.state || {}])
          .filter((entry) => entry[0])
      );
      await withSyncQueueSuppressed(async () => {
        await saveFoldersToSqlite(folders, { skipSyncQueue: true });
        await savePapersToSqlite(papers, paths, {
          preserveIncomingVersion: true,
          skipSyncQueue: true
        });
        const retainIds = new Set(
          papers.map((paper) => String(paper?.id || '').trim()).filter(Boolean)
        );
        const localStateIds = (await loadPaperStatesFromSqlite())
          .map((item) => String(item?.paperId || '').trim())
          .filter(Boolean);
        deletePaperStatesFromSqlite(localStateIds.filter((paperId) => !retainIds.has(paperId)));
        for (const paperId of retainIds) {
          // eslint-disable-next-line no-await-in-loop
          await savePaperStateToSqlite(paperId, stateMap.get(paperId) || {}, { skipSyncQueue: true });
        }
      });
      const { downloadedPdfCount, downloadedPdfBytes } = await syncLocalPdfFilesFromRemote(
        client,
        remotePath,
        paths,
        papers
      );
      setLocalAppliedVersion(remoteVersion);
      return {
        success: true,
        mode: 'download',
        sqliteBytes,
        downloadedPdfCount,
        downloadedPdfBytes,
        remoteVersion
      };
    } finally {
      await removeFileIfExists(tempPath);
    }
  };

  const pullRemoteChanges = async (client, remotePath) => {
    await ensureRemoteDirectory(client, `${remotePath}/${REMOTE_SYNC_DIR}`);
    const lockResult = await waitForRemoteLockRelease(client, remotePath);
    if (!lockResult.ok) {
      return {
        success: false,
        skipped: true,
        locked: true,
        error: `云端正在由 ${String(lockResult.lock?.device || 'unknown')} 同步，请稍后重试`
      };
    }

    const remoteState = await loadRemoteSyncState(client, remotePath);
    const remoteVersion = Number(remoteState?.meta?.libraryVersion || 0);
    const localAppliedVersion = getLocalAppliedVersion();
    if (remoteVersion <= localAppliedVersion) {
      return {
        success: true,
        skipped: true,
        mode: 'download',
        remoteVersion
      };
    }

    const pendingRemote = remoteState.changes.filter(
      (item) => Number(item?.version || 0) > localAppliedVersion
    );
    if (!pendingRemote.length || Number(pendingRemote[0]?.version || 0) > localAppliedVersion + 1) {
      return downloadFullRemoteSnapshot(client, remotePath, remoteVersion);
    }

    const applyResult = await applyRemoteChanges(client, remotePath, pendingRemote);
    setLocalAppliedVersion(remoteVersion);
    return {
      success: true,
      mode: 'download',
      remoteVersion,
      appliedChangeCount: applyResult.appliedCount,
      downloadedPdfCount: applyResult.downloadedPdfCount,
      downloadedPdfBytes: applyResult.downloadedPdfBytes
    };
  };

  const normalizeLocalQueueEntry = (entry) => {
    const entityType = String(entry?.entityType || '').trim();
    const entityId = String(entry?.entityId || '').trim();
    const action = String(entry?.action || '').trim();
    if (!entityType || !entityId || !action) return null;
    return {
      entityType,
      entityId,
      action,
      payload: entry?.payload && typeof entry.payload === 'object' ? entry.payload : {},
      updatedAt: Number(entry?.updatedAt || now())
    };
  };

  const enrichPdfQueuePayload = async (entry, paths) => {
    if (entry.entityType !== 'pdf') return entry;
    const paperId = String(entry?.payload?.paperId || entry.entityId || '').trim();
    if (!paperId) return entry;
    const fileName = `${getPaperArticleId(paperId)}.pdf`;
    const filePath = path.join(paths.papersDir, fileName);
    if (entry.action === 'delete') {
      return {
        ...entry,
        payload: {
          paperId,
          fileName
        }
      };
    }
    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch {
      stat = null;
    }
    if (!stat?.isFile?.()) {
      return {
        ...entry,
        action: 'delete',
        payload: { paperId, fileName }
      };
    }
    const sha1 = await hashFileSha1(filePath);
    return {
      ...entry,
      payload: {
        paperId,
        fileName,
        sha1,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0)
      }
    };
  };

  const uploadLocalChanges = async (client, remotePath) => {
    const paths = getLibraryPaths();
    await ensureRemoteDirectory(client, remotePath);
    await ensureRemoteDirectory(client, `${remotePath}/${REMOTE_SYNC_DIR}`);
    await ensureRemoteDirectory(client, `${remotePath}/${REMOTE_PAPERS_DIR}`);

    await acquireRemoteLock(client, remotePath);
    try {
      const remoteState = await loadRemoteSyncState(client, remotePath);
      const remoteVersion = Number(remoteState?.meta?.libraryVersion || 0);
      const localAppliedVersion = getLocalAppliedVersion();

      let appliedChangeCount = 0;
      let downloadedPdfCount = 0;
      let downloadedPdfBytes = 0;
      let pulledRemote = false;
      if (remoteVersion > localAppliedVersion) {
        const pendingRemote = remoteState.changes.filter(
          (item) => Number(item?.version || 0) > localAppliedVersion
        );
        if (pendingRemote.length && Number(pendingRemote[0]?.version || 0) === localAppliedVersion + 1) {
          const applyResult = await applyRemoteChanges(client, remotePath, pendingRemote);
          appliedChangeCount = Number(applyResult.appliedCount || 0);
          downloadedPdfCount = Number(applyResult.downloadedPdfCount || 0);
          downloadedPdfBytes = Number(applyResult.downloadedPdfBytes || 0);
          setLocalAppliedVersion(remoteVersion);
          pulledRemote = true;
        } else {
          const fullDownloadResult = await downloadFullRemoteSnapshot(client, remotePath, remoteVersion);
          if (fullDownloadResult?.success) {
            appliedChangeCount = Number(fullDownloadResult?.appliedChangeCount || 0);
            downloadedPdfCount = Number(fullDownloadResult?.downloadedPdfCount || 0);
            downloadedPdfBytes = Number(fullDownloadResult?.downloadedPdfBytes || 0);
            pulledRemote = true;
          }
        }
      }

      const queueEntriesRaw = loadSyncQueueEntries();
      if (!queueEntriesRaw.length) {
        return {
          success: true,
          mode: appliedChangeCount || downloadedPdfCount ? 'download' : 'upload',
          skipped: true,
          remoteVersion: Number(remoteState?.meta?.libraryVersion || 0),
          appliedChangeCount,
          downloadedPdfCount,
          downloadedPdfBytes,
          pulledRemote
        };
      }

      const queueEntries = [];
      for (const item of queueEntriesRaw) {
        const normalized = normalizeLocalQueueEntry(item);
        if (!normalized) continue;
        // eslint-disable-next-line no-await-in-loop
        queueEntries.push(await enrichPdfQueuePayload(normalized, paths));
      }

      let uploadedPdfCount = 0;
      let uploadedPdfBytes = 0;
      for (const entry of queueEntries) {
        if (entry.entityType !== 'pdf') continue;
        const paperId = String(entry?.payload?.paperId || entry.entityId || '').trim();
        if (!paperId) continue;
        const fileName = String(entry?.payload?.fileName || `${getPaperArticleId(paperId)}.pdf`).trim();
        const remoteFilePath = `${remotePath}/${REMOTE_PAPERS_DIR}/${fileName}`;
        if (entry.action === 'delete') {
          // eslint-disable-next-line no-await-in-loop
          await client.deleteFile(remoteFilePath).catch(() => null);
          continue;
        }
        const localFilePath = path.join(paths.papersDir, fileName);
        // eslint-disable-next-line no-await-in-loop
        uploadedPdfBytes += await uploadBinaryFile(client, remoteFilePath, localFilePath);
        uploadedPdfCount += 1;
      }

      const sqliteBytes = await uploadLocalSqliteSnapshot(client, remotePath);
      const manifestResult = await syncRemotePdfFilesFromLocal(client, remotePath, paths);
      uploadedPdfCount += Number(manifestResult?.uploadedPdfCount || 0);
      uploadedPdfBytes += Number(manifestResult?.uploadedPdfBytes || 0);

      const nextChanges = [...remoteState.changes];
      let nextVersion = Number(remoteState?.meta?.libraryVersion || 0);
      queueEntries.forEach((entry) => {
        nextVersion += 1;
        nextChanges.push({
          version: nextVersion,
          opId: `${lockOwner.sessionId}:${nextVersion}:${entry.entityType}:${entry.entityId}`,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          payload: entry.payload,
          updatedAt: entry.updatedAt || now()
        });
      });
      await writeRemoteSyncState(
        client,
        remotePath,
        {
          libraryVersion: nextVersion,
          updatedAt: now()
        },
        nextChanges
      );

      clearSyncQueueEntries(queueEntriesRaw);
      setLocalAppliedVersion(nextVersion);
      return {
        success: true,
        mode: 'upload',
        remoteVersion: nextVersion,
        sqliteBytes,
        uploadedPdfCount,
        uploadedPdfBytes,
        appliedChangeCount,
        downloadedPdfCount,
        downloadedPdfBytes,
        pulledRemote
      };
    } finally {
      await releaseRemoteLock(client);
    }
  };

  const syncLibrary = async ({ mode = 'auto' } = {}) => {
    await ensureLibraryStoreReady();
    const config = await getWebDavConfigFromSettings();
    const server = config.webdavServer;
    const username = config.webdavUsername;
    const remotePath = config.webdavRemotePath;
    const password = await getWebDavCredential(server, username);
    if (!server || !username || !password) {
      return {
        success: false,
        skipped: true,
        reason: 'missing config or credential',
        error: '请先在设置中完成 WebDAV 配置并保存凭据'
      };
    }

    const client = await createWebDavClient(server, username, password);
    await client.getDirectoryContents('/');

    const normalizedMode = String(mode || 'auto').trim();
    if (normalizedMode === 'download') {
      const result = await pullRemoteChanges(client, remotePath);
      return {
        ...result,
        server,
        remotePath
      };
    }
    if (normalizedMode === 'upload') {
      const result = await uploadLocalChanges(client, remotePath);
      return {
        ...result,
        server,
        remotePath
      };
    }

    const pendingCount = Number(getSyncQueueSize() || 0);
    if (pendingCount > 0) {
      const result = await uploadLocalChanges(client, remotePath);
      return {
        ...result,
        server,
        remotePath
      };
    }
    const result = await pullRemoteChanges(client, remotePath);
    return {
      ...result,
      server,
      remotePath
    };
  };

  return {
    syncLibrary,
    clearWebDavLock
  };
};

module.exports = {
  createWebDavSyncModule,
  registerWebDavSyncIpc
};
