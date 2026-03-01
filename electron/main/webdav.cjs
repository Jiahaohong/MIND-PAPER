const WEBDAV_KEYTAR_SERVICE = 'MindPaper-WebDAV';
const WEBDAV_LOCK_FILE = 'lock.json';

const registerWebDavIpc = ({
  ipcMain,
  enqueueWrite,
  testWebDavConnection,
  saveWebDavConfig,
  clearWebDavLock,
  getWebDavSyncState
}) => {
  ipcMain.handle('webdav-test', async (_event, payload = {}) => testWebDavConnection(payload));

  ipcMain.handle('webdav-save', async (_event, payload = {}) =>
    enqueueWrite(() => saveWebDavConfig(payload))
  );

  ipcMain.handle('webdav-get-sync-status', async () => getWebDavSyncState());

  ipcMain.handle('webdav-clear-lock', async () =>
    enqueueWrite(async () => {
      try {
        return await clearWebDavLock();
      } catch (error) {
        return {
          success: false,
          message: error?.message || '清除云端锁失败'
        };
      }
    })
  );
};

const createWebDavModule = (deps = {}) => {
  const {
    app,
    normalizeWebDavServer,
    normalizeWebDavRemotePath,
    loadSettings,
    saveSettings,
    lockTtlMs
  } = deps;

  let webdavDriverPromise = null;
  let keytarDriver = null;
  const webdavLockOwner = {
    sessionId: require('crypto').randomUUID(),
    device: `${require('os').hostname()}-${app.getName()}`,
    appVersion: app.getVersion()
  };
  let activeWebDavLock = null;

  const getWebDavDriver = async () => {
    if (webdavDriverPromise) return webdavDriverPromise;
    webdavDriverPromise = import('webdav')
      .then((module) => module)
      .catch((error) => {
        webdavDriverPromise = null;
        throw new Error(`缺少 webdav 依赖: ${error?.message || error}`);
      });
    return webdavDriverPromise;
  };

  const getKeytarDriver = () => {
    if (keytarDriver) return keytarDriver;
    try {
      keytarDriver = require('keytar');
      return keytarDriver;
    } catch (error) {
      throw new Error(`缺少 keytar 依赖: ${error?.message || error}`);
    }
  };

  const getWebDavCredentialAccount = (server, username) =>
    `${normalizeWebDavServer(server)}|${String(username || '').trim()}`;

  const saveWebDavCredential = async (server, username, password) => {
    const normalizedServer = normalizeWebDavServer(server);
    const normalizedUser = String(username || '').trim();
    const normalizedPassword = String(password || '');
    if (!normalizedServer || !normalizedUser) return false;
    if (!normalizedPassword) {
      return false;
    }
    const keytar = getKeytarDriver();
    await keytar.setPassword(
      WEBDAV_KEYTAR_SERVICE,
      getWebDavCredentialAccount(normalizedServer, normalizedUser),
      normalizedPassword
    );
    return true;
  };

  const getWebDavCredential = async (server, username) => {
    const normalizedServer = normalizeWebDavServer(server);
    const normalizedUser = String(username || '').trim();
    if (!normalizedServer || !normalizedUser) return '';
    try {
      const keytar = getKeytarDriver();
      return (
        (await keytar.getPassword(
          WEBDAV_KEYTAR_SERVICE,
          getWebDavCredentialAccount(normalizedServer, normalizedUser)
        )) || ''
      );
    } catch {
      return '';
    }
  };

  const hasWebDavCredential = async (server, username) => Boolean(await getWebDavCredential(server, username));

  const createWebDavClient = async (server, username, password) => {
    const driver = await getWebDavDriver();
    const createClient = driver?.createClient;
    if (typeof createClient !== 'function') {
      throw new Error('webdav createClient 不可用');
    }
    return createClient(normalizeWebDavServer(server), {
      username: String(username || '').trim(),
      password: String(password || '')
    });
  };

  const readRemoteJsonFile = async (client, remotePath) => {
    const exists = await client.exists(remotePath);
    if (!exists) return null;
    const content = await client.getFileContents(remotePath, { format: 'text' });
    try {
      return JSON.parse(String(content || ''));
    } catch {
      return null;
    }
  };

  const writeRemoteJsonFile = async (client, remotePath, payload) => {
    await client.putFileContents(remotePath, JSON.stringify(payload, null, 2), {
      overwrite: true
    });
  };

  const getWebDavConfigFromSettings = async () => {
    const settings = await loadSettings();
    const webdavServer = normalizeWebDavServer(settings.webdavServer);
    const webdavUsername = String(settings.webdavUsername || '').trim();
    const webdavRemotePath = normalizeWebDavRemotePath(settings.webdavRemotePath);
    let webdavHasPassword = false;
    try {
      webdavHasPassword = await hasWebDavCredential(webdavServer, webdavUsername);
    } catch {
      webdavHasPassword = false;
    }
    return {
      webdavServer,
      webdavUsername,
      webdavRemotePath,
      webdavHasPassword
    };
  };

  const resolveWebDavPassword = async (server, username, password) => {
    const direct = String(password || '');
    if (direct) return direct;
    return getWebDavCredential(server, username);
  };

  const testWebDavConnection = async (payload = {}) => {
    const server = normalizeWebDavServer(payload.server);
    const username = String(payload.username || '').trim();
    const remotePath = normalizeWebDavRemotePath(payload.remotePath);
    const password = await resolveWebDavPassword(server, username, payload.password);
    if (!server) {
      return { success: false, reachable: false, writable: false, validPath: false, message: '缺少服务器地址' };
    }
    if (!username) {
      return { success: false, reachable: false, writable: false, validPath: false, message: '缺少用户名' };
    }
    if (!password) {
      return { success: false, reachable: false, writable: false, validPath: false, message: '缺少密码或未保存凭据' };
    }
    let reachable = false;
    let validPath = false;
    let writable = false;
    try {
      const client = await createWebDavClient(server, username, password);
      await client.getDirectoryContents('/');
      reachable = true;
      const exists = await client.exists(remotePath);
      if (!exists) {
        await client.createDirectory(remotePath, { recursive: true });
      }
      validPath = true;
      const testFile = `${remotePath}/.mindpaper-webdav-test-${Date.now()}.tmp`;
      const payloadText = `mindpaper test ${new Date().toISOString()}`;
      await client.putFileContents(testFile, Buffer.from(payloadText, 'utf8'), { overwrite: true });
      writable = true;
      await client.deleteFile(testFile).catch(() => null);
      return { success: true, reachable, writable, validPath, message: '连接成功' };
    } catch (error) {
      return {
        success: false,
        reachable,
        writable,
        validPath,
        message: error?.message || 'WebDAV连接失败'
      };
    }
  };

  const saveWebDavConfig = async (payload = {}) => {
    const server = normalizeWebDavServer(payload.server);
    const username = String(payload.username || '').trim();
    const remotePath = normalizeWebDavRemotePath(payload.remotePath);
    const password = String(payload.password || '');
    await saveSettings({
      webdavServer: server,
      webdavUsername: username,
      webdavRemotePath: remotePath
    });
    const savedSecret = await saveWebDavCredential(server, username, password).catch((error) => {
      throw error;
    });
    return {
      success: true,
      webdavServer: server,
      webdavUsername: username,
      webdavRemotePath: remotePath,
      webdavHasPassword: savedSecret || Boolean(await hasWebDavCredential(server, username))
    };
  };

  const getRemoteWebDavLockPath = (remotePath) => `${remotePath}/${WEBDAV_LOCK_FILE}`;

  const buildWebDavLockPayload = () => {
    const now = Date.now();
    return {
      sessionId: webdavLockOwner.sessionId,
      device: webdavLockOwner.device,
      appVersion: webdavLockOwner.appVersion,
      acquiredAt: activeWebDavLock?.acquiredAt || now,
      refreshedAt: now,
      expiresAt: now + lockTtlMs
    };
  };

  const isWebDavLockAlive = (lock) =>
    Boolean(lock && Number(lock.expiresAt || 0) > Date.now() && String(lock.sessionId || '').trim());

  const isWebDavLockOwnedBySelf = (lock) =>
    String(lock?.sessionId || '').trim() === webdavLockOwner.sessionId;

  const isWebDavLockOwnedBySameDevice = (lock) =>
    String(lock?.device || '').trim() === String(webdavLockOwner.device || '').trim();

  const refreshWebDavLock = async (client, remotePath) => {
    const payload = buildWebDavLockPayload();
    await writeRemoteJsonFile(client, getRemoteWebDavLockPath(remotePath), payload);
    activeWebDavLock = payload;
  };

  const acquireWebDavLock = async (client, remotePath) => {
    const lockPath = getRemoteWebDavLockPath(remotePath);
    const existing = await readRemoteJsonFile(client, lockPath);
    if (
      isWebDavLockAlive(existing) &&
      !isWebDavLockOwnedBySelf(existing) &&
      !isWebDavLockOwnedBySameDevice(existing)
    ) {
      const owner = String(existing.device || 'unknown');
      throw new Error(`云端正在被其他设备使用: ${owner}`);
    }
    const payload = buildWebDavLockPayload();
    await writeRemoteJsonFile(client, lockPath, payload);
    activeWebDavLock = payload;
    if (isWebDavLockAlive(existing) && isWebDavLockOwnedBySameDevice(existing) && !isWebDavLockOwnedBySelf(existing)) {
      console.log(`[webdav-lock] took over stale same-device lock: device=${payload.device}, remote=${remotePath}`);
    }
    console.log(`[webdav-lock] acquired: device=${payload.device}, remote=${remotePath}`);
    return payload;
  };

  const ensureWebDavLock = async (client, remotePath) => {
    if (activeWebDavLock && isWebDavLockOwnedBySelf(activeWebDavLock) && isWebDavLockAlive(activeWebDavLock)) {
      await refreshWebDavLock(client, remotePath);
      return activeWebDavLock;
    }
    return acquireWebDavLock(client, remotePath);
  };

  const releaseWebDavLock = async () => {
    if (!activeWebDavLock) return;
    try {
      const config = await getWebDavConfigFromSettings();
      const password = await getWebDavCredential(config.webdavServer, config.webdavUsername);
      if (!config.webdavServer || !config.webdavUsername || !password) {
        activeWebDavLock = null;
        return;
      }
      const client = await createWebDavClient(config.webdavServer, config.webdavUsername, password);
      const lockPath = getRemoteWebDavLockPath(config.webdavRemotePath);
      const remoteLock = await readRemoteJsonFile(client, lockPath);
      if (isWebDavLockOwnedBySelf(remoteLock)) {
        await client.deleteFile(lockPath).catch(() => null);
        console.log(`[webdav-lock] released: remote=${config.webdavRemotePath}`);
      }
    } catch (error) {
      console.warn('[webdav-lock] release failed:', error?.message || error);
    } finally {
      activeWebDavLock = null;
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
    await client.getDirectoryContents('/');
    const lockPath = getRemoteWebDavLockPath(remotePath);
    const exists = await client.exists(lockPath);
    if (!exists) {
      return { success: true, cleared: false, message: '云端锁不存在' };
    }
    await client.deleteFile(lockPath).catch((error) => {
      throw new Error(error?.message || '删除云端锁失败');
    });
    activeWebDavLock = null;
    console.log(`[webdav-lock] force cleared: remote=${remotePath}`);
    return { success: true, cleared: true, message: '已清除云端锁' };
  };

  return {
    getWebDavDriver,
    getKeytarDriver,
    saveWebDavCredential,
    getWebDavCredential,
    hasWebDavCredential,
    createWebDavClient,
    getWebDavConfigFromSettings,
    resolveWebDavPassword,
    testWebDavConnection,
    saveWebDavConfig,
    ensureWebDavLock,
    releaseWebDavLock,
    clearWebDavLock,
    readRemoteJsonFile,
    writeRemoteJsonFile,
    webdavLockOwner
  };
};

module.exports = {
  createWebDavModule,
  registerWebDavIpc
};
