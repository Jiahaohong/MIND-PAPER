const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createMainWindow } = require('./window.cjs');

const isDev = !app.isPackaged;
const devServerURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3001';
const DEFAULT_QDRANT_URL = 'http://127.0.0.1:6333';
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEV_RESOURCES_ROOT = path.join(PROJECT_ROOT, 'resources');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_LIBRARY_ROOT = path.join(app.getPath('userData'), 'Library');
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const DEFAULT_LIBRARY_META_COLLECTION = 'library_meta';
const LIBRARY_META_VECTOR_NAME = 'meta';
const LIBRARY_META_VECTOR_DIM = 1;
const LIBRARY_META_VERSION = 1;
const LIBRARY_FOLDERS_POINT_KEY = '__folders__';
const LIBRARY_MIGRATION_POINT_KEY = '__migration__';
const TRANSLATE_SYSTEM_PROMPT =
  '你是翻译引擎。请将用户提供的文本翻译成中文，只输出翻译结果，不要添加解释。';
const CNKI_TOKEN_URL = 'https://dict.cnki.net/fyzs-front-api/getToken';
const CNKI_TRANSLATE_URL = 'https://dict.cnki.net/fyzs-front-api/translate/literaltranslation';
const CNKI_REGEX = /(查看名企职位.+?https:\/\/dict\.cnki\.net[a-zA-Z./]+.html?)/g;
const CNKI_AES_KEY = '4e87183cfd3a45fe';
const CNKI_TOKEN_TTL = 300 * 1000;

let settingsLoaded = false;
let writeChain = Promise.resolve();
let pendingWrites = 0;
let isForceQuitting = false;
let runtimeSettings = {
  translationEngine: 'cnki',
  apiKey: '',
  baseUrl: '',
  model: '',
  parsePdfWithAI: false,
  libraryPath: ''
};

let cnkiTokenCache = { token: '', t: 0 };
let qdrantBootPromise = null;
let qdrantProcess = null;
let qdrantStartedByApp = false;
let libraryMetaReadyPromise = null;

const getQdrantUrl = () => process.env.MINDPAPER_QDRANT_URL || DEFAULT_QDRANT_URL;
const getLibraryMetaCollection = () =>
  String(process.env.MINDPAPER_LIBRARY_META_COLLECTION || DEFAULT_LIBRARY_META_COLLECTION).trim() ||
  DEFAULT_LIBRARY_META_COLLECTION;

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );

const toQdrantPointId = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (isUuid(normalized)) return normalized.toLowerCase();
  const hex = crypto.createHash('sha1').update(`paper:${normalized}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(
    20,
    32
  )}`;
};

const enqueueWrite = (task) => {
  pendingWrites += 1;
  const run = writeChain.then(task);
  writeChain = run
    .catch((error) => {
      console.error('[write-queue] task failed:', error);
    })
    .finally(() => {
      pendingWrites -= 1;
    });
  return run;
};

const flushWrites = () => writeChain;

const resolveLibraryPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('~')) {
    return path.resolve(path.join(app.getPath('home'), raw.slice(1)));
  }
  return path.resolve(raw);
};

const sanitizeSettings = (payload = {}) => ({
  translationEngine: payload.translationEngine === 'openai' ? 'openai' : 'cnki',
  apiKey: String(payload.apiKey || '').trim(),
  baseUrl: String(payload.baseUrl || '').trim(),
  model: String(payload.model || '').trim(),
  parsePdfWithAI: Boolean(payload.parsePdfWithAI),
  libraryPath: resolveLibraryPath(payload.libraryPath)
});

const getLibraryRoot = () => runtimeSettings.libraryPath || DEFAULT_LIBRARY_ROOT;
const getQdrantStoragePath = () => path.join(getLibraryRoot(), 'qdrant-data');
const getLegacyQdrantStoragePath = () => path.join(app.getPath('userData'), 'qdrant-data');

const getLibraryPaths = () => {
  const root = getLibraryRoot();
  return {
    root,
    papersDir: path.join(root, 'papers'),
    statesDir: path.join(root, 'states'),
    papersPath: path.join(root, 'papers.json'),
    foldersPath: path.join(root, 'folders.json'),
    indexPath: path.join(root, 'index.json')
  };
};

const loadSettings = async () => {
  if (settingsLoaded) return runtimeSettings;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    runtimeSettings = { ...runtimeSettings, ...sanitizeSettings(parsed) };
  } catch (error) {
    // ignore missing/invalid settings
  }
  if (!runtimeSettings.libraryPath) {
    runtimeSettings.libraryPath = DEFAULT_LIBRARY_ROOT;
  }
  settingsLoaded = true;
  return runtimeSettings;
};

const saveSettings = async (payload = {}) => {
  const prevLibraryRoot = getLibraryRoot();
  const next = { ...runtimeSettings, ...sanitizeSettings(payload) };
  if (!next.libraryPath) {
    next.libraryPath = DEFAULT_LIBRARY_ROOT;
  }
  runtimeSettings = next;
  settingsLoaded = true;
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(runtimeSettings, null, 2), 'utf8');

  const nextLibraryRoot = getLibraryRoot();
  if (prevLibraryRoot !== nextLibraryRoot) {
    await migrateLibrary(prevLibraryRoot, nextLibraryRoot);
  }

  return runtimeSettings;
};

const buildOpenAIUrl = (baseUrl) => {
  const resolved = String(baseUrl || '').trim() || DEFAULT_BASE_URL;
  return resolved.endsWith('/chat/completions')
    ? resolved
    : `${resolved.replace(/\/$/, '')}/chat/completions`;
};

const openaiChatCompletion = async (
  messages,
  settings,
  options = { temperature: 0.3, maxTokens: 1200 }
) => {
  const apiKey = settings.apiKey;
  const baseUrl = settings.baseUrl || DEFAULT_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('请在设置中填写 API Key 和 Base URL');
  }
  const model = settings.model || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(buildOpenAIUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens
      }),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || 'AI请求失败');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI返回内容为空');
    }
    return String(content).trim();
  } finally {
    clearTimeout(timeout);
  }
};

const getCnkiToken = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && cnkiTokenCache.token && now - cnkiTokenCache.t < CNKI_TOKEN_TTL) {
    return cnkiTokenCache.token;
  }
  const response = await fetch(CNKI_TOKEN_URL, { method: 'GET' });
  const data = await response.json();
  if (!response.ok || (typeof data?.code === 'number' && data.code !== 200)) {
    throw new Error(data?.message || data?.msg || 'CNKI获取Token失败');
  }
  const token =
    data?.data?.token ||
    data?.data ||
    data?.token ||
    data?.result?.token ||
    data?.result ||
    '';
  if (!token) {
    throw new Error('CNKI返回Token为空');
  }
  cnkiTokenCache = { token, t: now };
  return token;
};

const getCnkiWord = (text) => {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(CNKI_AES_KEY, 'utf8'), null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return encrypted.toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
};

const splitCnkiText = (text, maxLen = 800) => {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const sentences = clean
    .split(/[.?!]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!sentences.length) return [clean.slice(0, maxLen)];
  const chunks = [];
  let current = '';
  sentences.forEach((sentence) => {
    const sentenceWithDot = `${sentence}. `;
    if (current.length + sentenceWithDot.length > maxLen) {
      if (current) chunks.push(current.trim());
      current = sentenceWithDot;
    } else {
      current += sentenceWithDot;
    }
  });
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [clean.slice(0, maxLen)];
};

const cnkiTranslate = async (text) => {
  const chunks = splitCnkiText(text, 800);
  let translated = '';
  for (const chunk of chunks) {
    let token = await getCnkiToken();
    let data;
    let response;
    const request = async () => {
      response = await fetch(CNKI_TRANSLATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Token: token
        },
        body: JSON.stringify({
          words: getCnkiWord(chunk),
          translateType: null
        })
      });
      data = await response.json();
    };

    await request();
    const code = typeof data?.code === 'number' ? data.code : null;
    const mResult = data?.data?.mResult || data?.mResult || '';

    if (!response.ok || (code !== null && code !== 200) || !mResult) {
      token = await getCnkiToken(true);
      await request();
    }

    if (!response.ok) {
      throw new Error(data?.message || data?.msg || 'CNKI翻译失败');
    }
    if (typeof data?.code === 'number' && data.code !== 200) {
      throw new Error(data?.message || data?.msg || 'CNKI翻译失败');
    }
    if (data?.data?.isInputVerificationCode) {
      throw new Error('CNKI翻译需要人工验证，请稍后重试');
    }
    const raw = data?.data?.mResult || data?.mResult || '';
    if (!raw) {
      throw new Error('CNKI返回翻译为空');
    }
    const cleaned = String(raw).replace(CNKI_REGEX, '').trim();
    translated += `${cleaned} `;
  }
  return translated.trim();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cnkiTranslateWithRetry = async (text, maxAttempts = 10) => {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const content = await cnkiTranslate(text);
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(1000);
      }
    }
  }
  throw lastError || new Error('CNKI翻译失败');
};

const isQdrantReachable = async (url, timeoutMs = 1000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/collections`, {
      method: 'GET',
      signal: controller.signal
    });
    return Boolean(response.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const parseLocalQdrantTarget = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    const isLocalHost =
      host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLocalHost) return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      host: host === '::1' ? '127.0.0.1' : host,
      port
    };
  } catch {
    return null;
  }
};

const waitForQdrantReady = async (url, timeoutMs = 15000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isQdrantReachable(url, 1200);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(400);
  }
  return false;
};

const getQdrantBinaryName = () => {
  if (process.platform === 'darwin') return 'qdrant-macos';
  if (process.platform === 'win32') return 'qdrant-win.exe';
  return 'qdrant-linux';
};

const resolveQdrantCandidates = (localTarget, storagePath) => {
  const candidates = [];
  const devLocalPath = path.join(PROJECT_ROOT, 'resources', 'qdrant', 'qdrant-macos');
  const envOverrides = {
    QDRANT__SERVICE__HOST: '127.0.0.1',
    QDRANT__SERVICE__HTTP_PORT: String(localTarget.port),
    QDRANT__STORAGE__STORAGE_PATH: storagePath
  };

  const appendCandidates = (command, isPath = false) => {
    if (!command) return;
    if (candidates.some((item) => item.command === command && !item.args.length)) return;
    candidates.push({ command, args: [], envOverrides, isPath });
  };

  appendCandidates(devLocalPath, true);
  return candidates;
};

const ensureQdrantReady = async () => {
  if (process.platform !== 'darwin') return true;
  const qdrantUrl = getQdrantUrl();
  if (await isQdrantReachable(qdrantUrl, 1200)) return true;
  if (qdrantBootPromise) return qdrantBootPromise;

  qdrantBootPromise = (async () => {
    await loadSettings();
    const localTarget = parseLocalQdrantTarget(qdrantUrl);
    if (!localTarget) {
      console.warn(`[vector-index] qdrant not reachable: ${qdrantUrl}`);
      return false;
    }
    const storagePath = getQdrantStoragePath();
    const legacyStoragePath = getLegacyQdrantStoragePath();
    if (storagePath !== legacyStoragePath) {
      let targetExists = false;
      try {
        await fs.access(storagePath);
        targetExists = true;
      } catch {
        targetExists = false;
      }
      if (!targetExists) {
        try {
          await fs.access(legacyStoragePath);
          await fs.mkdir(path.dirname(storagePath), { recursive: true });
          try {
            await fs.rename(legacyStoragePath, storagePath);
          } catch {
            await fs.cp(legacyStoragePath, storagePath, { recursive: true });
          }
          console.log(
            `[vector-index] qdrant storage migrated: ${legacyStoragePath} -> ${storagePath}`
          );
        } catch {
          // legacy storage does not exist
        }
      }
    }
    await fs.mkdir(storagePath, { recursive: true });
    console.log(`[vector-index] qdrant storage path: ${storagePath}`);
    const candidates = resolveQdrantCandidates(localTarget, storagePath);

    for (const candidate of candidates) {
      let proc = null;
      try {
        if (candidate.isPath) {
          try {
            await fs.access(candidate.command);
            await fs.chmod(candidate.command, 0o755);
          } catch {
            continue;
          }
        }
        proc = spawn(candidate.command, candidate.args, {
          cwd: storagePath,
          env: {
            ...process.env,
            ...(candidate.envOverrides || {})
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        proc.stdout?.on('data', () => {
          // keep quiet unless startup fails
        });
        proc.stderr?.on('data', (chunk) => {
          const line = String(chunk || '').trim();
          if (line) {
            console.warn(`[vector-index] qdrant: ${line}`);
          }
        });

        const earlyExit = new Promise((resolve) => {
          proc.once('error', () => resolve(false));
          proc.once('exit', () => resolve(false));
        });
        const ready = await Promise.race([waitForQdrantReady(qdrantUrl, 15000), earlyExit]);
        if (ready) {
          qdrantProcess = proc;
          qdrantStartedByApp = true;
          proc.on('exit', (code, signal) => {
            if (qdrantProcess === proc) {
              qdrantProcess = null;
              qdrantStartedByApp = false;
            }
            console.warn(
              `[vector-index] qdrant exited (code=${String(code)}, signal=${String(signal)})`
            );
          });
          console.log(`[vector-index] qdrant started by app on ${qdrantUrl}`);
          return true;
        }

        proc.kill('SIGTERM');
      } catch (error) {
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }
    }

    console.warn(
      `[vector-index] failed to auto-start qdrant. Set MINDPAPER_QDRANT_BIN or start qdrant manually (${qdrantUrl}).`
    );
    return false;
  })().finally(() => {
    qdrantBootPromise = null;
  });

  return qdrantBootPromise;
};

const stopManagedQdrant = async () => {
  if (!qdrantStartedByApp || !qdrantProcess || qdrantProcess.killed) return;
  const proc = qdrantProcess;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      done();
    }, 3000);
  });
  qdrantProcess = null;
  qdrantStartedByApp = false;
};

const buildQdrantUrl = (pathname) => `${getQdrantUrl().replace(/\/$/, '')}${pathname}`;

const qdrantRequest = async (pathname, options = {}) => {
  const response = await fetch(buildQdrantUrl(pathname), {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || data?.status === 'error') {
    const reason = data?.status?.error || data?.error || response.statusText || 'qdrant request failed';
    throw new Error(String(reason));
  }
  return data;
};

const getLibraryFoldersPointId = () => toQdrantPointId(`library:${LIBRARY_FOLDERS_POINT_KEY}`);
const getLibraryMigrationPointId = () => toQdrantPointId(`library:${LIBRARY_MIGRATION_POINT_KEY}`);
const getLibraryStatePointId = (paperId) => toQdrantPointId(`library:state:${String(paperId || '').trim()}`);
const getPaperArticleId = (paperId) => toQdrantPointId(String(paperId || '').trim());

const buildMetaVector = () => ({ [LIBRARY_META_VECTOR_NAME]: [1] });

const ensureLibraryMetaCollection = async () => {
  const collection = getLibraryMetaCollection();
  try {
    await qdrantRequest(`/collections/${collection}`);
    return;
  } catch {
    // create if missing
  }
  await qdrantRequest(`/collections/${collection}`, {
    method: 'PUT',
    body: {
      vectors: {
        [LIBRARY_META_VECTOR_NAME]: {
          size: LIBRARY_META_VECTOR_DIM,
          distance: 'Cosine'
        }
      }
    }
  });
};

const upsertLibraryMetaPoints = async (points = []) => {
  if (!points.length) return;
  const collection = getLibraryMetaCollection();
  await qdrantRequest(`/collections/${collection}/points`, {
    method: 'PUT',
    body: { points, wait: true }
  });
};

const deleteLibraryMetaPoints = async (ids = []) => {
  const list = (Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!list.length) return;
  const collection = getLibraryMetaCollection();
  await qdrantRequest(`/collections/${collection}/points/delete`, {
    method: 'POST',
    body: { points: list, wait: true }
  });
};

const getLibraryMetaPoint = async (id) => {
  const pointId = String(id || '').trim();
  if (!pointId) return null;
  const collection = getLibraryMetaCollection();
  const data = await qdrantRequest(`/collections/${collection}/points`, {
    method: 'POST',
    body: {
      ids: [pointId],
      with_payload: true,
      with_vector: false
    }
  });
  const points = Array.isArray(data?.result) ? data.result : [];
  return points[0] || null;
};

const scrollLibraryMetaPoints = async (filter = null) => {
  const collection = getLibraryMetaCollection();
  const points = [];
  let offset = null;
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const data = await qdrantRequest(`/collections/${collection}/points/scroll`, {
      method: 'POST',
      body: {
        limit: 256,
        offset: offset || undefined,
        filter: filter || undefined,
        with_payload: true,
        with_vector: false
      }
    });
    const batch = Array.isArray(data?.result?.points) ? data.result.points : [];
    points.push(...batch);
    offset = data?.result?.next_page_offset || null;
    if (!offset) break;
  }
  return points;
};

const fileExists = async (filePath) => {
  const target = String(filePath || '').trim();
  if (!target) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const moveFileSafe = async (fromPath, toPath) => {
  const from = String(fromPath || '').trim();
  const to = String(toPath || '').trim();
  if (!from || !to || from === to) return;
  if (!(await fileExists(from))) return;
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (await fileExists(to)) return;
  try {
    await fs.rename(from, to);
  } catch {
    await fs.copyFile(from, to);
    await removeFileIfExists(from);
  }
};

const normalizePaperForMeta = async (paper, order, paths) => {
  const next = paper && typeof paper === 'object' ? { ...paper } : {};
  const paperId = String(next.id || '').trim();
  if (!paperId) return null;
  const paperPointId = getPaperArticleId(paperId);
  const targetPdfPath = path.join(paths.papersDir, `${paperPointId}.pdf`);
  const sourcePdfPath = String(next.filePath || '').trim();
  if (sourcePdfPath && sourcePdfPath !== targetPdfPath) {
    await moveFileSafe(sourcePdfPath, targetPdfPath);
  }
  next.id = paperId;
  if (Object.prototype.hasOwnProperty.call(next, 'articleId')) {
    delete next.articleId;
  }
  next.addedDate = String(
    next.addedDate || next.uploadedAt || next.addedAt || next.createdAt || new Date().toISOString()
  );
  const uploadedAtMs = Number(next.uploadedAt || Date.parse(next.addedDate));
  next.uploadedAt = Number.isFinite(uploadedAtMs) && uploadedAtMs > 0 ? uploadedAtMs : Date.now();
  next.filePath = targetPdfPath;
  return {
    point: {
      id: paperPointId,
      vector: buildMetaVector(),
      payload: {
        type: 'paper',
        order,
        updatedAt: Date.now(),
        paper: next
      }
    },
    paper: next
  };
};

const saveFoldersToMeta = async (folders) => {
  const payload = Array.isArray(folders) ? folders : [];
  await upsertLibraryMetaPoints([
    {
      id: getLibraryFoldersPointId(),
      vector: buildMetaVector(),
      payload: {
        type: 'folders',
        folders: payload,
        updatedAt: Date.now()
      }
    }
  ]);
  return payload;
};

const loadFoldersFromMeta = async () => {
  const point = await getLibraryMetaPoint(getLibraryFoldersPointId());
  return Array.isArray(point?.payload?.folders) ? point.payload.folders : null;
};

const loadPapersFromMeta = async () => {
  const paths = getLibraryPaths();
  const points = await scrollLibraryMetaPoints({
    must: [{ key: 'type', match: { value: 'paper' } }]
  });
  return points
    .map((point) => ({
      order: Number(point?.payload?.order ?? Number.MAX_SAFE_INTEGER),
      paper: point?.payload?.paper || null
    }))
    .filter((item) => item.paper && typeof item.paper === 'object')
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const next = { ...item.paper };
      if (Object.prototype.hasOwnProperty.call(next, 'articleId')) {
        delete next.articleId;
      }
      const paperId = String(next.id || '').trim();
      const paperPointId = getPaperArticleId(paperId);
      next.addedDate = String(
        next.addedDate || next.uploadedAt || next.addedAt || next.createdAt || new Date().toISOString()
      );
      const uploadedAtMs = Number(next.uploadedAt || Date.parse(next.addedDate));
      next.uploadedAt = Number.isFinite(uploadedAtMs) && uploadedAtMs > 0 ? uploadedAtMs : Date.now();
      next.filePath = path.join(paths.papersDir, `${paperPointId}.pdf`);
      return next;
    });
};

const savePapersToMeta = async (papers, paths) => {
  const source = Array.isArray(papers) ? papers : [];
  const normalizedPapers = [];
  const paperPoints = [];
  for (let index = 0; index < source.length; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const normalized = await normalizePaperForMeta(source[index], index, paths);
    if (!normalized) continue;
    normalizedPapers.push(normalized.paper);
    paperPoints.push(normalized.point);
  }
  const existingPaperPoints = await scrollLibraryMetaPoints({
    must: [{ key: 'type', match: { value: 'paper' } }]
  });
  const existingPaperIds = new Set(
    existingPaperPoints.map((point) => String(point?.id || '').trim()).filter(Boolean)
  );
  const nextPaperIds = new Set(
    paperPoints.map((point) => String(point?.id || '').trim()).filter(Boolean)
  );
  const removedPaperIds = Array.from(existingPaperIds).filter((id) => !nextPaperIds.has(id));
  const removedStateIds = existingPaperPoints
    .filter((point) => removedPaperIds.includes(String(point?.id || '').trim()))
    .map((point) => getLibraryStatePointId(point?.payload?.paper?.id))
    .filter(Boolean);
  if (paperPoints.length) {
    await upsertLibraryMetaPoints(paperPoints);
  }
  if (removedPaperIds.length) {
    await deleteLibraryMetaPoints(removedPaperIds);
    await deleteLibraryMetaPoints(removedStateIds);
  }
  return normalizedPapers;
};

const savePaperStateToMeta = async (paperId, state) => {
  const normalizedPaperId = String(paperId || '').trim();
  if (!normalizedPaperId) return { ok: false, error: '缺少paperId' };
  const statePointId = getLibraryStatePointId(normalizedPaperId);
  await upsertLibraryMetaPoints([
    {
      id: statePointId,
      vector: buildMetaVector(),
      payload: {
        type: 'state',
        paperId: normalizedPaperId,
        state: state || {},
        updatedAt: Date.now()
      }
    }
  ]);
  return { ok: true };
};

const loadPaperStateFromMeta = async (paperId) => {
  const normalizedPaperId = String(paperId || '').trim();
  if (!normalizedPaperId) return null;
  const statePoint = await getLibraryMetaPoint(getLibraryStatePointId(normalizedPaperId));
  return statePoint?.payload?.state || null;
};

const loadLegacyStates = async (paths) => {
  const result = [];
  let files = [];
  try {
    files = await fs.readdir(paths.statesDir);
  } catch {
    return result;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const paperId = String(file.slice(0, -5) || '').trim();
    if (!paperId) continue;
    // eslint-disable-next-line no-await-in-loop
    const state = await readJsonFile(path.join(paths.statesDir, file), null);
    if (!state) continue;
    result.push({ paperId, state });
  }
  return result;
};

const migrateLegacyLibraryToQdrant = async (paths) => {
  const migrationPoint = await getLibraryMetaPoint(getLibraryMigrationPointId()).catch(() => null);
  if (Number(migrationPoint?.payload?.version || 0) >= LIBRARY_META_VERSION) return;
  const folders = await readJsonFile(paths.foldersPath, []);
  const papers = await readJsonFile(paths.papersPath, []);
  const normalizedPapers = await savePapersToMeta(papers, paths);
  await saveFoldersToMeta(folders);
  const legacyStates = await loadLegacyStates(paths);
  if (legacyStates.length) {
    const statePoints = legacyStates.map((item) => ({
      id: getLibraryStatePointId(item.paperId),
      vector: buildMetaVector(),
      payload: {
        type: 'state',
        paperId: item.paperId,
        state: item.state || {},
        updatedAt: Date.now()
      }
    }));
    await upsertLibraryMetaPoints(statePoints);
  }
  await upsertLibraryMetaPoints([
    {
      id: getLibraryMigrationPointId(),
      vector: buildMetaVector(),
      payload: {
        type: 'migration',
        version: LIBRARY_META_VERSION,
        migratedAt: Date.now(),
        paperCount: normalizedPapers.length
      }
    }
  ]);
  console.log(`[library-meta] migrated legacy json to qdrant: papers=${normalizedPapers.length}`);
};

const ensureLibraryMetaReady = async () => {
  if (libraryMetaReadyPromise) return libraryMetaReadyPromise;
  libraryMetaReadyPromise = (async () => {
    await ensureLibrary();
    const ready = await ensureQdrantReady();
    if (!ready) throw new Error('qdrant not ready');
    await ensureLibraryMetaCollection();
    const paths = getLibraryPaths();
    await migrateLegacyLibraryToQdrant(paths);
    return true;
  })().catch((error) => {
    libraryMetaReadyPromise = null;
    throw error;
  });
  return libraryMetaReadyPromise;
};

const ensureLibrary = async () => {
  await loadSettings();
  const paths = getLibraryPaths();
  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.papersDir, { recursive: true });
  await fs.mkdir(paths.statesDir, { recursive: true });
};

const debugQdrantStartup = async () => {
  const qdrantUrl = getQdrantUrl();
  const ready = await ensureQdrantReady();
  if (!ready) {
    console.warn(`[vector-index] qdrant startup check failed: ${qdrantUrl}`);
    return { ok: false, error: 'qdrant not ready', qdrantUrl };
  }
  try {
    const response = await fetch(`${qdrantUrl}/collections`, { method: 'GET' });
    const data = await response.json();
    const collections = Array.isArray(data?.result?.collections)
      ? data.result.collections.map((item) => String(item?.name || '')).filter(Boolean)
      : [];
    console.log(
      `[vector-index] qdrant startup check ok: url=${qdrantUrl}, collections=${collections.length}`
    );
    return { ok: true, qdrantUrl, collections };
  } catch (error) {
    const message = error?.message || 'qdrant startup check failed';
    console.warn(`[vector-index] qdrant startup check error: ${message}`);
    return { ok: false, qdrantUrl, error: message };
  }
};

const debugDumpQdrantInfo = async () => {
  const qdrantUrl = getQdrantUrl().replace(/\/$/, '');
  try {
    const ready = await ensureQdrantReady();
    if (!ready) {
      return { ok: false, error: 'qdrant not ready', qdrantUrl };
    }
    const requestJson = async (path, options = {}) => {
      const response = await fetch(`${qdrantUrl}${path}`, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        const detail = data?.status?.error || data?.result?.error || text || response.statusText;
        throw new Error(`Qdrant ${options.method || 'GET'} ${path} failed: ${detail}`);
      }
      return data;
    };

    const collectionsResp = await requestJson('/collections');
    const collections = Array.isArray(collectionsResp?.result?.collections)
      ? collectionsResp.result.collections
          .map((item) => String(item?.name || '').trim())
          .filter(Boolean)
      : [];

    console.log(`[vector-index] ===== qdrant dump begin =====`);
    console.log(`[vector-index] url=${qdrantUrl}`);
    console.log(`[vector-index] collections=${collections.length} -> ${collections.join(', ') || '(none)'}`);

    const details = [];
    for (const name of collections) {
      // eslint-disable-next-line no-await-in-loop
      const info = await requestJson(`/collections/${name}`);
      // eslint-disable-next-line no-await-in-loop
      const countResp = await requestJson(`/collections/${name}/points/count`, {
        method: 'POST',
        body: { exact: true }
      });
      const pointsCount = Number(countResp?.result?.count || 0);
      // eslint-disable-next-line no-await-in-loop
      const scrollResp = await requestJson(`/collections/${name}/points/scroll`, {
        method: 'POST',
        body: { limit: 3, with_payload: true, with_vector: false }
      });
      const samplePoints = Array.isArray(scrollResp?.result?.points)
        ? scrollResp.result.points.map((point) => ({
            id: String(point?.id || ''),
            payloadKeys: Object.keys(point?.payload || {})
          }))
        : [];
      console.log(
        `[vector-index] collection=${name} points=${pointsCount} vectors=${Object.keys(
          info?.result?.config?.params?.vectors || {}
        ).join(', ')}`
      );
      console.log(`[vector-index] sample=${JSON.stringify(samplePoints)}`);
      details.push({
        name,
        pointsCount,
        vectorNames: Object.keys(info?.result?.config?.params?.vectors || {}),
        samplePoints
      });
    }
    console.log(`[vector-index] ===== qdrant dump end =====`);
    return { ok: true, qdrantUrl, collections: details };
  } catch (error) {
    const message = error?.message || 'qdrant dump failed';
    console.warn(`[vector-index] qdrant dump failed: ${message}`);
    return { ok: false, qdrantUrl, error: message };
  }
};

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
};

const writeJsonFile = async (filePath, data) => {
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, filePath);
};

const removeFileIfExists = async (filePath) => {
  const target = String(filePath || '').trim();
  if (!target) return;
  try {
    await fs.rm(target, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
};

const cleanupOrphanPaperStateFiles = async (paths, activePaperIds = []) => {
  const dir = String(paths?.statesDir || '').trim();
  if (!dir) return { removed: 0 };
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { removed: 0 };
  }
  const active = new Set(
    (Array.isArray(activePaperIds) ? activePaperIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const paperId = file.slice(0, -5);
    if (!paperId) continue;
    if (active.has(paperId)) continue;
    const fullPath = path.join(dir, file);
    // eslint-disable-next-line no-await-in-loop
    await removeFileIfExists(fullPath);
    removed += 1;
  }
  return { removed };
};

const updatePaperPaths = (papers, fromRoot, toRoot) => {
  if (!Array.isArray(papers)) return [];
  return papers.map((paper) => {
    if (!paper || typeof paper !== 'object') return paper;
    const filePath = String(paper.filePath || '');
    if (filePath && filePath.startsWith(fromRoot)) {
      const relative = path.relative(fromRoot, filePath);
      return { ...paper, filePath: path.join(toRoot, relative) };
    }
    return paper;
  });
};

const migrateLibrary = async (fromRoot, toRoot) => {
  const source = String(fromRoot || '').trim();
  const target = String(toRoot || '').trim();
  if (!source || !target || source === target) return;

  try {
    await fs.access(source);
  } catch {
    await fs.mkdir(target, { recursive: true });
    return;
  }

  await fs.mkdir(target, { recursive: true });

  try {
    await fs.rename(source, target);
  } catch {
    try {
      await fs.cp(source, target, { recursive: true });
    } catch (error) {
      throw new Error(`迁移数据失败: ${error?.message || error}`);
    }
  }

  const newPapersPath = path.join(target, 'papers.json');
  const papers = await readJsonFile(newPapersPath, null);
  if (papers) {
    const updated = updatePaperPaths(papers, source, target);
    await writeJsonFile(newPapersPath, updated);
  }
};

const openaiTranslate = async (text, settings) => {
  return openaiChatCompletion(
    [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    settings,
    { temperature: 0.2, maxTokens: 800 }
  );
};

ipcMain.handle('settings-get', async () => {
  const settings = await loadSettings();
  return { ...settings, libraryPath: getLibraryRoot() };
});
ipcMain.handle('settings-set', async (_event, payload = {}) =>
  enqueueWrite(() => saveSettings(payload))
);

ipcMain.handle('translate-text', async (_event, payload = {}) => {
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, error: '缺少文本' };

  try {
    const settings = await loadSettings();
    const engine = settings.translationEngine || 'cnki';
    if (engine === 'openai') {
      const content = await openaiTranslate(text, settings);
      return { ok: true, content, engine: 'openai' };
    }
    const content = await cnkiTranslateWithRetry(text);
    return { ok: true, content, engine: 'cnki' };
  } catch (error) {
    return { ok: false, error: error?.message || '翻译失败' };
  }
});

ipcMain.handle('ask-ai', async (_event, payload = {}) => {
  const prompt = String(payload.prompt || '').trim();
  const incomingMessages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!prompt) return { ok: false, error: '缺少问题内容' };
  try {
    const settings = await loadSettings();
    const history = incomingMessages
      .filter((item) => item && typeof item.text === 'string' && item.text.trim())
      .map((item) => ({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: String(item.text || '').trim()
      }));
    const messages = [
      {
        role: 'system',
        content:
          '你是一个学术论文阅读助手。回答要准确、简洁、有条理。若信息不足，请明确指出。'
      },
      ...history,
      { role: 'user', content: prompt }
    ];
    const content = await openaiChatCompletion(messages, settings, {
      temperature: 0.3,
      maxTokens: 2000
    });
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: error?.message || 'AI请求失败' };
  }
});

ipcMain.handle('library-get-folders', async () => {
  await ensureLibraryMetaReady();
  const folders = await loadFoldersFromMeta();
  return Array.isArray(folders) ? folders : [];
});

ipcMain.handle('library-save-folders', async (_event, payload = []) => {
  return enqueueWrite(async () => {
    await ensureLibraryMetaReady();
    await saveFoldersToMeta(payload);
    return { ok: true };
  });
});

ipcMain.handle('library-get-papers', async () => {
  await ensureLibraryMetaReady();
  return loadPapersFromMeta();
});

ipcMain.handle('library-save-papers', async (_event, payload = []) => {
  return enqueueWrite(async () => {
    await ensureLibraryMetaReady();
    const paths = getLibraryPaths();
    const papers = await savePapersToMeta(payload, paths);
    await cleanupOrphanPaperStateFiles(
      paths,
      papers.map((paper) => String(paper?.id || '').trim())
    );
    return { ok: true };
  });
});

ipcMain.handle('library-save-snapshot', async (_event, payload = {}) => {
  return enqueueWrite(async () => {
    await ensureLibraryMetaReady();
    const paths = getLibraryPaths();
    const folders = await saveFoldersToMeta(payload.folders);
    const papers = await savePapersToMeta(payload.papers, paths);
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
    await ensureLibraryMetaReady();
    const paths = getLibraryPaths();
    const data = payload.data;
    if (!data) return { ok: false, error: '缺少PDF数据' };
    const buffer = Buffer.from(new Uint8Array(data));
    const paperPointId = getPaperArticleId(paperId);
    const filePath = path.join(paths.papersDir, `${paperPointId}.pdf`);
    await fs.writeFile(filePath, buffer);
    await writeJsonFile(paths.indexPath, { updatedAt: Date.now() });
    return { ok: true, filePath };
  });
});

ipcMain.handle('library-read-pdf', async (_event, payload = {}) => {
  await ensureLibraryMetaReady();
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
      const papers = await loadPapersFromMeta();
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
  await ensureLibraryMetaReady();
  const paperId = String(payload.paperId || '').trim();
  if (!paperId) return null;
  return loadPaperStateFromMeta(paperId);
});

ipcMain.handle('library-save-paper-state', async (_event, payload = {}) => {
  return enqueueWrite(async () => {
    await ensureLibraryMetaReady();
    const paperId = String(payload.paperId || '').trim();
    if (!paperId) return { ok: false, error: '缺少paperId' };
    return savePaperStateToMeta(paperId, payload.state || {});
  });
});

ipcMain.handle('library-delete-paper', async (_event, payload = {}) => {
  return enqueueWrite(async () => {
    await ensureLibraryMetaReady();
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
    await deleteLibraryMetaPoints([getPaperArticleId(paperId), getLibraryStatePointId(paperId)]);
    const papers = await loadPapersFromMeta();
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
    await ensureLibraryMetaReady();
    const paths = getLibraryPaths();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const ids = items
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean);
    if (!ids.length) return { ok: true };
    const pointIdsToDelete = [];
    const stateIdsToDelete = [];
    for (const item of items) {
      const paperId = String(item?.id || '').trim();
      if (!paperId) continue;
      let resolvedPath = item?.filePath ? String(item.filePath) : '';
      await removeFileIfExists(resolvedPath);
      await removeFileIfExists(path.join(paths.papersDir, `${getPaperArticleId(paperId)}.pdf`));
      await removeFileIfExists(path.join(paths.statesDir, `${paperId}.json`));
      pointIdsToDelete.push(getPaperArticleId(paperId));
      stateIdsToDelete.push(getLibraryStatePointId(paperId));
    }
    await deleteLibraryMetaPoints([...pointIdsToDelete, ...stateIdsToDelete]);
    const papers = await loadPapersFromMeta();
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

ipcMain.handle('vector-get-status', async () => {
  const startup = await debugQdrantStartup();
  const ready = Boolean(startup?.ok);
  const collectionName = getLibraryMetaCollection();
  let pointCount = -1;
  if (ready) {
    try {
      const qdrantUrl = getQdrantUrl().replace(/\/$/, '');
      const response = await fetch(`${qdrantUrl}/collections/${collectionName}/points/count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exact: true })
      });
      if (response.ok) {
        const data = await response.json();
        pointCount = Number(data?.result?.count || 0);
      }
    } catch {
      pointCount = -1;
    }
  }
  return {
    ok: ready,
    collection: collectionName,
    vectorFields: ['meta'],
    vectorDim: LIBRARY_META_VECTOR_DIM,
    pointCount,
    qdrantUrl: getQdrantUrl(),
    qdrantStoragePath: getQdrantStoragePath(),
    qdrantManagedByApp: qdrantStartedByApp,
    error: ready ? undefined : startup?.error || 'qdrant not ready'
  };
});

ipcMain.handle('vector-debug-qdrant-startup', async () => {
  return debugQdrantStartup();
});

ipcMain.handle('vector-debug-dump-qdrant', async () => {
  return debugDumpQdrantInfo();
});

app.whenReady().then(() => {
  createMainWindow({
    isDev,
    devServerURL,
    preloadPath: path.join(__dirname, '..', 'bridge', 'preload.cjs'),
    indexHtmlPath: path.join(__dirname, '..', '..', 'dist', 'index.html')
  });

  void (async () => {
    try {
      await ensureLibraryMetaReady();
      await debugQdrantStartup();
    } catch (error) {
      console.warn('[vector-index] init failed:', error?.message || error);
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({
        isDev,
        devServerURL,
        preloadPath: path.join(__dirname, '..', 'bridge', 'preload.cjs'),
        indexHtmlPath: path.join(__dirname, '..', '..', 'dist', 'index.html')
      });
    }
  });
});

app.on('before-quit', (event) => {
  if (isForceQuitting) return;
  event.preventDefault();
  isForceQuitting = true;
  Promise.allSettled([flushWrites()])
    .then(async () => {
      try {
        await stopManagedQdrant();
      } catch {
        // ignore
      }
    })
    .finally(() => {
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
