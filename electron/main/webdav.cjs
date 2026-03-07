const WEBDAV_KEYTAR_SERVICE = 'MindPaper-WebDAV';

const registerWebDavIpc = ({
  ipcMain,
  enqueueWrite,
  testWebDavConnection,
  saveWebDavConfig,
  clearWebDavLock
}) => {
  ipcMain.handle('webdav-test', async (_event, payload = {}) => testWebDavConnection(payload));

  ipcMain.handle('webdav-save', async (_event, payload = {}) =>
    enqueueWrite(() => saveWebDavConfig(payload))
  );

  ipcMain.handle('webdav-clear-lock', async () =>
    enqueueWrite(async () => {
      if (typeof clearWebDavLock !== 'function') {
        return {
          success: false,
          cleared: false,
          message: '当前未启用云同步锁'
        };
      }
      try {
        return await clearWebDavLock();
      } catch (error) {
        return {
          success: false,
          cleared: false,
          message: error?.message || '清除云端锁失败'
        };
      }
    })
  );
};

const createWebDavModule = (deps = {}) => {
  const {
    normalizeWebDavServer,
    normalizeWebDavRemotePath,
    loadSettings,
    saveSettings
  } = deps;

  let webdavDriverPromise = null;
  let keytarDriver = null;

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
    if (!normalizedPassword) return false;
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

  return {
    getWebDavCredential,
    createWebDavClient,
    getWebDavConfigFromSettings,
    testWebDavConnection,
    saveWebDavConfig
  };
};

module.exports = {
  createWebDavModule,
  registerWebDavIpc
};
