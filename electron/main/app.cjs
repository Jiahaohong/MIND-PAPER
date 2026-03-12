const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsNative = require('fs');
const crypto = require('crypto');
const os = require('os');
const { createMainWindow } = require('./window.cjs');
const createSqliteModule = require('./sqlite.cjs');
const { createWebDavModule, registerWebDavIpc } = require('./webdav.cjs');
const { createWebDavSyncModule, registerWebDavSyncIpc } = require('./webdav-sync.cjs');
const { registerLibraryIpc } = require('./library.cjs');

const isDev = !app.isPackaged;
const devServerURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3001';
const DEV_USER_DATA_PATH = path.join(app.getPath('appData'), `${app.getName()}-dev`);

if (isDev) {
  app.setPath('userData', DEV_USER_DATA_PATH);
}

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_LIBRARY_ROOT = path.join(app.getPath('userData'), 'Library');
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const PAPERS_VECTOR_NAME = 'summary';
const DEFAULT_SUMMARY_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_SUMMARY_VECTOR_DIM = 1024;
const SUMMARY_EMBED_MAX_TEXT_LEN = 6000;
const LIBRARY_SQLITE_VERSION = 1;
const TRANSLATE_SYSTEM_PROMPT =
  '你是翻译引擎。请将用户提供的文本翻译成中文，只输出翻译结果，不要添加解释。';
const CNKI_TOKEN_URL = 'https://dict.cnki.net/fyzs-front-api/getToken';
const CNKI_TRANSLATE_URL = 'https://dict.cnki.net/fyzs-front-api/translate/literaltranslation';
const CNKI_REGEX = /(查看名企职位.+?https:\/\/dict\.cnki\.net[a-zA-Z./]+.html?)/g;
const CNKI_AES_KEY = '4e87183cfd3a45fe';
const CNKI_TOKEN_TTL = 300 * 1000;
const CNKI_TRANSLATE_INTERVAL_MS = 1500;
const DEFAULT_WEBDAV_REMOTE_PATH = '/mindpaper';

let settingsLoaded = false;
let writeChain = Promise.resolve();
let pendingWrites = 0;
let isForceQuitting = false;
let forceQuitTimer = null;
let runtimeSettings = {
  translationEngine: 'cnki',
  apiKey: '',
  baseUrl: '',
  model: '',
  parsePdfWithAI: false,
  idleAutoSyncEnabled: false,
  idleAutoSyncMinutes: 10,
  libraryPath: '',
  webdavServer: '',
  webdavUsername: '',
  webdavRemotePath: DEFAULT_WEBDAV_REMOTE_PATH
};

let cnkiTokenCache = { token: '', t: 0 };
let cnkiLastTranslateRequestAt = 0;
let summaryVectorSyncChain = Promise.resolve();
const PROGRESS_STAGES = new Set([
  '开始解析基本信息',
  '完成解析基本信息',
  '开始重写摘要',
  '完成重写摘要',
  '开始向量化',
  '完成向量化',
  '开始入库',
  '完成入库',
  '开始翻译',
  '完成翻译'
]);

const logProgress = (stage, paperId = '') => {
  const normalized = String(stage || '').trim();
  if (!PROGRESS_STAGES.has(normalized)) return;
  const id = String(paperId || '').trim();
  const suffix = id ? ` paper=${id}` : '';
  console.log(`[progress] ${normalized}${suffix}`);
  const payload = { stage: normalized, paperId: id, at: Date.now() };
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      if (win?.isDestroyed?.()) return;
      if (win?.webContents?.isDestroyed?.()) return;
      win.webContents.send('progress-event', payload);
    } catch {
      // ignore window dispatch errors
    }
  });
};

const getConfiguredSummaryVectorDim = () => {
  const dim = Number(process.env.MINDPAPER_SUMMARY_VECTOR_DIM || DEFAULT_SUMMARY_VECTOR_DIM);
  return Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : DEFAULT_SUMMARY_VECTOR_DIM;
};

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  );

const toStablePointId = (value) => {
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

const forceExitSoon = (delayMs = 2000) => {
  if (forceQuitTimer) return;
  forceQuitTimer = setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      // ignore forced exit errors
    }
  }, delayMs);
};

const requestAppQuit = () => {
  if (isForceQuitting) return;
  isForceQuitting = true;
  try {
    closeLibraryDb();
  } catch {
    // ignore close db errors during quit
  }
  forceExitSoon();
  app.quit();
};

const resolveLibraryPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('~')) {
    return path.resolve(path.join(app.getPath('home'), raw.slice(1)));
  }
  return path.resolve(raw);
};

const normalizeWebDavServer = (value) => String(value || '').trim().replace(/\/+$/, '');

const normalizeWebDavRemotePath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_WEBDAV_REMOTE_PATH;
  const normalized = raw.replace(/\/+$/, '');
  return normalized.startsWith('/') ? normalized || DEFAULT_WEBDAV_REMOTE_PATH : `/${normalized}`;
};

const normalizeIdleAutoSyncMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  const integer = Math.floor(parsed);
  return Math.max(1, Math.min(1440, integer));
};

const sanitizeSettings = (payload = {}) => ({
  translationEngine: payload.translationEngine === 'openai' ? 'openai' : 'cnki',
  apiKey: String(payload.apiKey || '').trim(),
  baseUrl: String(payload.baseUrl || '').trim(),
  model: String(payload.model || '').trim(),
  parsePdfWithAI: Boolean(payload.parsePdfWithAI),
  idleAutoSyncEnabled: Boolean(payload.idleAutoSyncEnabled),
  idleAutoSyncMinutes: normalizeIdleAutoSyncMinutes(payload.idleAutoSyncMinutes),
  libraryPath: resolveLibraryPath(payload.libraryPath),
  webdavServer: normalizeWebDavServer(payload.webdavServer),
  webdavUsername: String(payload.webdavUsername || '').trim(),
  webdavRemotePath: normalizeWebDavRemotePath(payload.webdavRemotePath)
});

const getLibraryRoot = () => runtimeSettings.libraryPath || DEFAULT_LIBRARY_ROOT;
const getPaperArticleId = (paperId) => toStablePointId(String(paperId || '').trim());

const getLibraryPaths = () => {
  const root = getLibraryRoot();
  return {
    root,
    papersDir: path.join(root, 'papers'),
    statesDir: path.join(root, 'states'),
    papersPath: path.join(root, 'papers.json'),
    foldersPath: path.join(root, 'folders.json'),
    indexPath: path.join(root, 'index.json'),
    sqlitePath: path.join(root, 'library.sqlite')
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
  const next = sanitizeSettings({ ...runtimeSettings, ...(payload || {}) });
  if (!next.libraryPath) {
    next.libraryPath = DEFAULT_LIBRARY_ROOT;
  }
  runtimeSettings = next;
  settingsLoaded = true;
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(runtimeSettings, null, 2), 'utf8');

  const nextLibraryRoot = getLibraryRoot();
  if (prevLibraryRoot !== nextLibraryRoot) {
    resetLibraryStore();
    await migrateLibrary(prevLibraryRoot, nextLibraryRoot);
  }

  return runtimeSettings;
};

const webDavModule = createWebDavModule({
  app,
  normalizeWebDavServer,
  normalizeWebDavRemotePath,
  loadSettings,
  saveSettings
});

const {
  getWebDavCredential,
  createWebDavClient,
  getWebDavConfigFromSettings,
  testWebDavConnection,
  saveWebDavConfig
} = webDavModule;

const buildOpenAIUrl = (baseUrl) => {
  const resolved = String(baseUrl || '').trim() || DEFAULT_BASE_URL;
  return resolved.endsWith('/chat/completions')
    ? resolved
    : `${resolved.replace(/\/$/, '')}/chat/completions`;
};

const buildOpenAIEmbeddingsUrl = (baseUrl) => {
  const resolved = String(baseUrl || '').trim() || DEFAULT_BASE_URL;
  if (resolved.endsWith('/embeddings')) return resolved;
  if (resolved.endsWith('/chat/completions')) {
    return `${resolved.slice(0, -'/chat/completions'.length)}/embeddings`;
  }
  return `${resolved.replace(/\/$/, '')}/embeddings`;
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

const openaiEmbeddings = async (
  input,
  settings,
  options = { model: 'text-embedding-3-small', dimensions: undefined }
) => {
  const apiKey = settings.apiKey;
  const baseUrl = settings.baseUrl || DEFAULT_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('请在设置中填写 API Key 和 Base URL');
  }
  const model = String(options.model || 'text-embedding-3-small').trim() || 'text-embedding-3-small';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const requestBody = { model, input };
    const dims = Number(options.dimensions);
    if (Number.isFinite(dims) && dims > 0) {
      requestBody.dimensions = Math.floor(dims);
    }
    const response = await fetch(buildOpenAIEmbeddingsUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || 'Embedding请求失败');
    }
    const rows = Array.isArray(data?.data) ? data.data : [];
    const vectors = rows
      .map((item) => (Array.isArray(item?.embedding) ? item.embedding : null))
      .filter((item) => Array.isArray(item));
    if (!vectors.length) {
      throw new Error('Embedding返回为空');
    }
    return vectors;
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
      await waitForCnkiTranslateSlot();
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

const waitForCnkiTranslateSlot = async () => {
  const now = Date.now();
  const elapsed = now - cnkiLastTranslateRequestAt;
  if (elapsed < CNKI_TRANSLATE_INTERVAL_MS) {
    await sleep(CNKI_TRANSLATE_INTERVAL_MS - elapsed);
  }
  cnkiLastTranslateRequestAt = Date.now();
};

const cnkiTranslateWithRetry = async (text, maxAttempts = 10) => {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const content = await cnkiTranslate(text);
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(CNKI_TRANSLATE_INTERVAL_MS);
      }
    }
  }
  throw lastError || new Error('CNKI翻译失败');
};

const deletePaperVectorPoints = async (paperIds = []) => {
  const ids = (Array.isArray(paperIds) ? paperIds : []).map((paperId) => String(paperId || '').trim()).filter(Boolean);
  if (!ids.length) return;
  try {
    deletePaperVectorsFromSqlite(ids);
  } catch (error) {
    console.warn('[vector-index] delete vector points failed:', error?.message || error);
  }
};

const normalizeSummaryForEmbedding = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_EMBED_MAX_TEXT_LEN);

const hashSummaryText = (value) =>
  crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');

const syncSummaryVectorsForPapers = async (papers = []) => {
  const source = Array.isArray(papers) ? papers : [];
  if (!source.length) return { ok: true, indexed: 0, skipped: 0 };
  const settings = await loadSettings();
  if (!settings?.parsePdfWithAI) {
    return { ok: false, skipped: source.length, error: 'ai_parse_disabled' };
  }
  if (!settings?.apiKey || !settings?.baseUrl) {
    return { ok: false, skipped: source.length, error: 'missing_openai_config' };
  }

  const candidates = source
    .map((paper) => {
      const paperId = String(paper?.id || '').trim();
      const summary = normalizeSummaryForEmbedding(paper?.summary);
      if (!paperId) return null;
      return {
        paperId,
        summary,
        summaryHash: hashSummaryText(summary)
      };
    })
    .filter(Boolean);
  if (!candidates.length) return { ok: true, indexed: 0, skipped: source.length };

  const nonEmpty = candidates.filter((item) => item.summary);
  const emptySummaryIds = candidates.filter((item) => !item.summary).map((item) => item.paperId);
  if (!nonEmpty.length) {
    if (emptySummaryIds.length) {
      await deletePaperVectorPoints(emptySummaryIds);
    }
    return { ok: true, indexed: 0, skipped: candidates.length };
  }

  const existing = loadPaperVectorsFromSqlite(nonEmpty.map((item) => item.paperId));
  const existingMetaMap = new Map(
    existing.map((row) => [
      String(row?.paperId || '').trim(),
      {
        summaryHash: String(row?.summaryHash || '').trim()
      }
    ])
  );
  const changed = nonEmpty.filter((item) => {
    const existingMeta = existingMetaMap.get(item.paperId);
    if (!existingMeta) return true;
    if (existingMeta.summaryHash !== item.summaryHash) return true;
    return false;
  });
  if (!changed.length) {
    if (emptySummaryIds.length) {
      await deletePaperVectorPoints(emptySummaryIds);
    }
    return { ok: true, indexed: 0, skipped: nonEmpty.length };
  }

  const model = String(process.env.MINDPAPER_SUMMARY_EMBED_MODEL || DEFAULT_SUMMARY_EMBEDDING_MODEL).trim();
  const vectorDim = getConfiguredSummaryVectorDim();
  const batchSize = 16;
  let indexed = 0;
  for (let i = 0; i < changed.length; i += batchSize) {
    const chunk = changed.slice(i, i + batchSize);
    chunk.forEach((item) => {
      logProgress('开始向量化', item.paperId);
    });
    // eslint-disable-next-line no-await-in-loop
    const vectors = await openaiEmbeddings(
      chunk.map((item) => item.summary),
      settings,
      { model, dimensions: vectorDim }
    );
    chunk.forEach((item) => {
      logProgress('完成向量化', item.paperId);
      logProgress('开始入库', item.paperId);
    });
    const vectorRows = chunk
      .map((item, idx) => {
        const vector = Array.isArray(vectors[idx]) ? vectors[idx] : null;
        if (!vector) return null;
        return {
          paperId: item.paperId,
          summaryHash: item.summaryHash,
          model,
          dim: vector.length,
          vector,
          updatedAt: Date.now()
        };
      })
      .filter(Boolean);
    if (!vectorRows.length) continue;
    const saveResult = savePaperVectorsToSqlite(vectorRows);
    indexed += Number(saveResult?.saved || 0);
    vectorRows.forEach((row) => {
      const paperId = String(row?.paperId || '').trim();
      if (!paperId) return;
      logProgress('完成入库', paperId);
    });
  }
  if (emptySummaryIds.length) {
    await deletePaperVectorPoints(emptySummaryIds);
  }
  return { ok: true, indexed, skipped: nonEmpty.length - changed.length };
};

const enqueueSummaryVectorSync = (papers = []) => {
  const snapshot = Array.isArray(papers) ? papers.map((item) => ({ ...item })) : [];
  summaryVectorSyncChain = summaryVectorSyncChain
    .then(async () => syncSummaryVectorsForPapers(snapshot))
    .catch((error) => {
      console.warn('[vector-index] summary vector sync failed:', error?.message || error);
    });
  return summaryVectorSyncChain;
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

const normalizePaperReference = (reference, index = 0) => {
  if (typeof reference === 'string') {
    const title = String(reference || '').trim();
    if (!title) return null;
    return {
      refId: `legacy-ref-${crypto.createHash('sha1').update(`${index}:${title}`).digest('hex').slice(0, 12)}`,
      title,
      source: 'local'
    };
  }
  if (!reference || typeof reference !== 'object') return null;
  const title = String(reference.title || reference.rawText || '').trim();
  if (!title) return null;
  return {
    refId:
      String(reference.refId || '').trim() ||
      `ref-${crypto.createHash('sha1').update(`${index}:${title}`).digest('hex').slice(0, 12)}`,
    title,
    order: Number.isFinite(Number(reference.order)) ? Number(reference.order) : undefined,
    source:
      reference.source === 'api' || reference.source === 'merged' || reference.source === 'local'
        ? reference.source
        : 'local',
    matchedPaperId: String(reference.matchedPaperId || '').trim() || undefined,
    matchedTitle: String(reference.matchedTitle || '').trim() || undefined,
    matchScore: Number.isFinite(Number(reference.matchScore)) ? Number(reference.matchScore) : undefined
  };
};

const tokenizeNormalizedTitle = (value) =>
  normalizeReferenceTitle(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

const computeTitleMatchScore = (left, right) => {
  const a = tokenizeNormalizedTitle(left);
  const b = tokenizeNormalizedTitle(right);
  if (!a.length || !b.length) return 0;
  const aJoined = a.join(' ');
  const bJoined = b.join(' ');
  if (aJoined === bJoined) return 1;
  if (aJoined.includes(bJoined) || bJoined.includes(aJoined)) return 0.96;
  const bSet = new Set(b);
  let common = 0;
  a.forEach((token) => {
    if (bSet.has(token)) common += 1;
  });
  return common / Math.max(a.length, b.length);
};

const matchReferencesToLocalPapers = async (paperId, references) => {
  const currentPaperId = String(paperId || '').trim();
  const input = Array.isArray(references) ? references : [];
  if (!input.length) return [];
  await ensureLibraryStoreReady();
  const localPapers = await loadPapersFromSqlite();
  const candidates = localPapers.filter((paper) => String(paper?.id || '').trim() !== currentPaperId);
  return input.map((reference, index) => {
    const normalized = normalizePaperReference(reference, index);
    if (!normalized) return null;
    const refTitle = String(normalized.title || '').trim();
    if (!refTitle) return normalized;
    let bestPaper = null;
    let bestScore = 0;
    candidates.forEach((paper) => {
      const score = computeTitleMatchScore(refTitle, paper?.title || '');
      if (score > bestScore) {
        bestScore = score;
        bestPaper = paper;
      }
    });
    if (bestPaper && bestScore >= 0.72) {
      normalized.matchedPaperId = String(bestPaper.id || '').trim() || undefined;
      normalized.matchedTitle = String(bestPaper.title || '').trim() || undefined;
      normalized.matchScore = Number(bestScore.toFixed(4));
    }
    return normalized;
  }).filter(Boolean);
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

const sanitizePaperForMeta = (paper, targetPdfPath) => {
  const source = paper && typeof paper === 'object' ? paper : {};
  const next = {
    id: String(source.id || '').trim(),
    title: String(source.title || '').trim(),
    author: String(source.author || '').trim(),
    date: String(source.date || '').trim(),
    addedDate: String(
      source.addedDate || source.uploadedAt || source.addedAt || source.createdAt || new Date().toISOString()
    ),
    uploadedAt: 0,
    folderId: String(source.folderId || '').trim(),
    previousFolderId: String(source.previousFolderId || '').trim(),
    summary: String(source.summary || '').trim(),
    abstract: String(source.abstract || '').trim(),
    content: String(source.content || ''),
    keywords: Array.isArray(source.keywords)
      ? source.keywords.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    publisher: String(source.publisher || '').trim(),
    doi: String(source.doi || '').trim(),
    version: Math.max(1, Number(source.version || 1) || 1),
    baseVersion: Math.max(0, Number(source.baseVersion ?? source.base_version ?? 0) || 0),
    updatedAt: Number(source.updatedAt || 0),
    references: Array.isArray(source.references)
      ? source.references
          .map((item, index) => normalizePaperReference(item, index))
          .filter(Boolean)
      : [],
    referenceStats:
      source.referenceStats && typeof source.referenceStats === 'object'
        ? {
            totalOpenAlex: Number(source.referenceStats.totalOpenAlex || 0),
            totalSemanticScholar: Number(source.referenceStats.totalSemanticScholar || 0),
            intersectionCount: Number(source.referenceStats.intersectionCount || 0),
            finalCount: Number(source.referenceStats.finalCount || 0),
            matchedCount: Number(source.referenceStats.matchedCount || 0)
          }
        : undefined,
    filePath: targetPdfPath
  };
  const uploadedAtMs = Number(source.uploadedAt || Date.parse(next.addedDate));
  next.uploadedAt = Number.isFinite(uploadedAtMs) && uploadedAtMs > 0 ? uploadedAtMs : Date.now();
  next.updatedAt = Number.isFinite(next.updatedAt) && next.updatedAt > 0 ? next.updatedAt : Date.now();
  if (!next.baseVersion && next.version > 1 && source.baseVersion != null) {
    next.baseVersion = Math.max(0, Number(source.baseVersion || 0) || 0);
  }
  return next;
};

const normalizePaperForStorage = async (paper, paths) => {
  const raw = paper && typeof paper === 'object' ? { ...paper } : {};
  const paperId = String(raw.id || '').trim();
  if (!paperId) return null;
  const paperPointId = getPaperArticleId(paperId);
  const targetPdfPath = path.join(paths.papersDir, `${paperPointId}.pdf`);
  const sourcePdfPath = String(raw.filePath || '').trim();
  if (sourcePdfPath && sourcePdfPath !== targetPdfPath) {
    await moveFileSafe(sourcePdfPath, targetPdfPath);
  }
  return sanitizePaperForMeta(raw, targetPdfPath);
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

const safeJsonParse = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const migrateExistingLibraryToSqlite = async (paths) => {
  const migratedVersion = Number(getLibraryKv('sqlite_migration_version', 0) || 0);
  const paperCountRow = getLibraryDb().prepare('SELECT COUNT(*) AS count FROM papers').get();
  const paperCount = Number(paperCountRow?.count || 0);
  if (migratedVersion >= LIBRARY_SQLITE_VERSION && paperCount >= 0) return;
  if (paperCount > 0) {
    setLibraryKv('sqlite_migration_version', LIBRARY_SQLITE_VERSION);
    return;
  }

  let folders = await readJsonFile(paths.foldersPath, []);
  let papers = await readJsonFile(paths.papersPath, []);
  let states = await loadLegacyStates(paths);
  const source = 'legacy-json';

  await saveFoldersToSqlite(folders);
  const paperSaveResult = await savePapersToSqlite(papers, paths, { preserveIncomingVersion: true });
  const normalizedPapers = Array.isArray(paperSaveResult?.papers) ? paperSaveResult.papers : [];
  for (const item of states) {
    // eslint-disable-next-line no-await-in-loop
    await savePaperStateToSqlite(item.paperId, item.state || {});
  }
  setLibraryKv('sqlite_migration_version', LIBRARY_SQLITE_VERSION);
  setLibraryKv('sqlite_migration_source', {
    source,
    migratedAt: Date.now(),
    paperCount: normalizedPapers.length
  });
  console.log(`[library-sqlite] migrated ${source}: papers=${normalizedPapers.length}`);
};

const sqliteModule = createSqliteModule({
  path,
  fs,
  fsNative,
  getLibraryPaths,
  loadSettings,
  sanitizePaperForMeta,
  normalizePaperForStorage,
  getPaperArticleId,
  enqueueSummaryVectorSync,
  migrateExistingLibraryToSqlite
});

const {
  getSqliteDriver,
  closeLibraryDb,
  resetLibraryStore,
  getLibraryDb,
  ensureLibrarySqliteSchema,
  getLibraryKv,
  setLibraryKv,
  recordSyncChange,
  loadSyncQueueEntries,
  clearSyncQueueEntries,
  getSyncQueueSize,
  withSyncQueueSuppressed,
  deletePaperStatesFromSqlite,
  deletePapersFromSqlite,
  mapSqlitePaperRow,
  loadFoldersFromSqlite,
  loadLibraryDataFromSqliteFile,
  saveFoldersToSqlite,
  loadPapersFromSqlite,
  savePapersToSqlite,
  savePaperStateToSqlite,
  loadPaperStateFromSqlite,
  loadPaperStatesFromSqlite,
  loadPaperVectorsFromSqlite,
  savePaperVectorsToSqlite,
  deletePaperVectorsFromSqlite,
  ensureLibraryStoreReady,
  ensureLibrary
} = sqliteModule;

const debugVectorBackendStartup = async () => {
  try {
    await ensureLibraryStoreReady();
    const vectors = loadPaperVectorsFromSqlite();
    const paths = getLibraryPaths();
    console.log(`[vector-index] sqlite-vector startup check ok: vectors=${vectors.length}`);
    return { ok: true, backend: 'sqlite-vector', vectorDbPath: paths.sqlitePath, count: vectors.length };
  } catch (error) {
    const message = error?.message || 'sqlite-vector startup check failed';
    console.warn(`[vector-index] sqlite-vector startup check error: ${message}`);
    return { ok: false, backend: 'sqlite-vector', error: message };
  }
};

const debugDumpVectorBackendInfo = async () => {
  try {
    await ensureLibraryStoreReady();
    const vectors = loadPaperVectorsFromSqlite();
    const summary = {
      collection: 'paper_summary_vectors',
      pointsCount: vectors.length,
      vectorNames: [PAPERS_VECTOR_NAME],
      samplePoints: vectors.slice(0, 3).map((item) => ({
        id: String(item?.paperId || ''),
        payloadKeys: ['paperId', 'summaryHash', 'model', 'dim']
      }))
    };
    console.log(`[vector-index] ===== sqlite-vector dump begin =====`);
    console.log(`[vector-index] rows=${vectors.length}`);
    console.log(`[vector-index] sample=${JSON.stringify(summary.samplePoints)}`);
    console.log(`[vector-index] ===== sqlite-vector dump end =====`);
    return { ok: true, backend: 'sqlite-vector', collections: [summary] };
  } catch (error) {
    const message = error?.message || 'sqlite-vector dump failed';
    console.warn(`[vector-index] sqlite-vector dump failed: ${message}`);
    return { ok: false, backend: 'sqlite-vector', error: message };
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

const normalizePaperTitle = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

const titleSimilarityScore = (query, target) => {
  const q = normalizePaperTitle(query);
  const t = normalizePaperTitle(target);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.includes(q) || q.includes(t)) return 0.95;
  const qTokens = new Set(q.split(/\s+/).filter(Boolean));
  const tTokens = new Set(t.split(/\s+/).filter(Boolean));
  if (!qTokens.size || !tTokens.size) return 0;
  let common = 0;
  qTokens.forEach((token) => {
    if (tTokens.has(token)) common += 1;
  });
  const denom = Math.max(qTokens.size, tTokens.size);
  return denom ? common / denom : 0;
};

const normalizeDoi = (doi) => {
  const raw = String(doi || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/i, '')
    .trim();
};

const extractArxivIdFromDoi = (doi) => {
  const normalized = normalizeDoi(doi);
  const match = normalized.match(/^10\.48550\/arxiv\.(.+)$/i);
  return match ? String(match[1] || '').trim() : '';
};

const fetchJsonWithTimeout = async (url, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
};

const searchOpenAlexByTitle = async (title) => {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5`;
  const data = await fetchJsonWithTimeout(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return null;
  let best = null;
  let bestScore = -1;
  for (const item of results) {
    const candidateTitle = String(item?.title || '').trim();
    const score = titleSimilarityScore(title, candidateTitle);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best) return null;
  const output = {
    source: 'OpenAlex',
    title: String(best?.title || '').trim(),
    authors: Array.isArray(best?.authorships)
      ? best.authorships
          .map((auth) => String(auth?.author?.display_name || '').trim())
          .filter(Boolean)
      : [],
    publication_date: String(best?.publication_date || '').trim(),
    venue:
      String(best?.primary_location?.source?.display_name || '').trim() ||
      String(best?.host_venue?.display_name || '').trim(),
    doi: String(best?.doi || '').trim() || null
  };
  console.log(
    `[open-source][openalex] query="${String(title || '').slice(0, 120)}" result=${JSON.stringify(
      output
    )}`
  );
  return output;
};

const getOpenAlexReferencesByDoi = async (doi) => {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const work = await fetchJsonWithTimeout(
    `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalized)}`
  ).catch(() => null);
  const referencedWorks = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
  const ids = referencedWorks
    .map((item) => String(item || '').split('/').pop())
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!ids.length) return [];
  const refItems = [];
  const fetchRefDetailsBatch = async (batchIds) => {
    const keys = ['openalex', 'openalex_id', 'ids.openalex'];
    for (const key of keys) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const detail = await fetchJsonWithTimeout(
          `https://api.openalex.org/works?filter=${key}:${encodeURIComponent(
            batchIds.join('|')
          )}&per-page=${batchIds.length}`
        );
        const results = Array.isArray(detail?.results) ? detail.results : [];
        if (results.length) return results;
      } catch {
        // try next key
      }
    }
    return [];
  };
  const chunkSize = 40;
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const results = await fetchRefDetailsBatch(chunk);
    refItems.push(
      ...results.map((item, resultIndex) => ({
        doi: normalizeDoi(item?.doi),
        title: String(item?.title || '').trim(),
        index: index + resultIndex
      }))
    );
  }
  const dedup = new Map();
  refItems.forEach((item, idx) => {
    const key = item.doi || normalizeReferenceTitle(item.title);
    if (!key || dedup.has(key)) return;
    const ref = buildApiReference(item.title || item.doi, idx, 'openalex');
    if (ref) dedup.set(key, ref);
  });
  return Array.from(dedup.values());
};

const getOpenAlexReferencesByTitle = async (title) => {
  const query = String(title || '').trim();
  if (!query) return [];
  const data = await fetchJsonWithTimeout(
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=1`
  ).catch(() => null);
  const top = Array.isArray(data?.results) ? data.results[0] : null;
  const referencedWorks = Array.isArray(top?.referenced_works) ? top.referenced_works : [];
  const ids = referencedWorks
    .map((item) => String(item || '').split('/').pop())
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!ids.length) return [];
  const batch = ids.slice(0, 80);
  const detail = await fetchJsonWithTimeout(
    `https://api.openalex.org/works?filter=ids.openalex:${encodeURIComponent(batch.join('|'))}&per-page=${batch.length}`
  ).catch(() => null);
  const results = Array.isArray(detail?.results) ? detail.results : [];
  const dedup = new Map();
  results.forEach((item, index) => {
    const doi = normalizeDoi(item?.doi);
    const title = String(item?.title || '').trim();
    const key = doi || normalizeReferenceTitle(title);
    if (!key || dedup.has(key)) return;
    const ref = buildApiReference(title || doi, index, 'openalex');
    if (ref) dedup.set(key, ref);
  });
  return Array.from(dedup.values());
};

const searchSemanticScholarByTitle = async (title) => {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    title
  )}&limit=5&fields=title,authors,venue,year,publicationDate,externalIds,abstract`;
  const data = await fetchJsonWithTimeout(url);
  const results = Array.isArray(data?.data) ? data.data : [];
  if (!results.length) return null;
  let best = null;
  let bestScore = -1;
  for (const item of results) {
    const candidateTitle = String(item?.title || '').trim();
    const score = titleSimilarityScore(title, candidateTitle);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best) return null;
  const output = {
    source: 'Semantic Scholar',
    title: String(best?.title || '').trim(),
    authors: Array.isArray(best?.authors)
      ? best.authors.map((auth) => String(auth?.name || '').trim()).filter(Boolean)
      : [],
    publication_date: String(best?.publicationDate || best?.year || '').trim(),
    venue: String(best?.venue || '').trim(),
    doi: String(best?.externalIds?.DOI || '').trim() || null
  };
  console.log(
    `[open-source][semanticscholar] query="${String(title || '').slice(
      0,
      120
    )}" result=${JSON.stringify(output)}`
  );
  return output;
};

const normalizeReferenceTitle = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

const buildApiReference = (title, index, source) => {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) return null;
  return {
    refId: `${source}-ref-${index + 1}`,
    title: normalizedTitle,
    source: 'api'
  };
};

const getSemanticScholarReferencesByDoi = async (doi) => {
  const normalized = normalizeDoi(doi);
  if (!normalized) return [];
  const data = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(
      normalized
    )}?fields=references.title,references.externalIds`
  ).catch(() => null);
  const references = Array.isArray(data?.references) ? data.references : [];
  let refItems = references.map((item, index) => ({
    doi: normalizeDoi(item?.externalIds?.DOI),
    title: String(item?.title || '').trim(),
    index
  }));
  if (!refItems.some((item) => item.doi || item.title)) {
    const arxivId = extractArxivIdFromDoi(normalized);
    if (arxivId) {
      const arxivData = await fetchJsonWithTimeout(
        `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${encodeURIComponent(
          arxivId
        )}?fields=references.title,references.externalIds`
      ).catch(() => null);
      const arxivRefs = Array.isArray(arxivData?.references) ? arxivData.references : [];
      refItems = arxivRefs.map((item, index) => ({
        doi: normalizeDoi(item?.externalIds?.DOI),
        title: String(item?.title || '').trim(),
        index
      }));
    }
  }
  const dedup = new Map();
  refItems.forEach((item, idx) => {
    const key = item.doi || normalizeReferenceTitle(item.title);
    if (!key || dedup.has(key)) return;
    const ref = buildApiReference(item.title || item.doi, idx, 'semanticscholar');
    if (ref) dedup.set(key, ref);
  });
  return Array.from(dedup.values());
};

const getSemanticScholarReferencesByTitle = async (title) => {
  const query = String(title || '').trim();
  if (!query) return [];
  const search = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
      query
    )}&limit=1&fields=paperId,title`
  ).catch(() => null);
  const paperId = String(search?.data?.[0]?.paperId || '').trim();
  if (!paperId) return [];
  const detail = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      paperId
    )}?fields=references.title,references.externalIds`
  ).catch(() => null);
  const references = Array.isArray(detail?.references) ? detail.references : [];
  const dedup = new Map();
  references.forEach((item, index) => {
    const doi = normalizeDoi(item?.externalIds?.DOI);
    const title = String(item?.title || '').trim();
    const key = doi || normalizeReferenceTitle(title);
    if (!key || dedup.has(key)) return;
    const ref = buildApiReference(title || doi, index, 'semanticscholar');
    if (ref) dedup.set(key, ref);
  });
  return Array.from(dedup.values());
};

const getReferenceIntersectionByDoi = async (doi, title = '') => {
  const normalized = normalizeDoi(doi);
  if (!normalized) {
    return {
      doi: '',
      total_openalex: 0,
      total_semanticscholar: 0,
      intersection_count: 0,
      references: []
    };
  }
  let [openAlexRefs, semanticScholarRefs] = await Promise.all([
    getOpenAlexReferencesByDoi(normalized),
    getSemanticScholarReferencesByDoi(normalized)
  ]);
  if (!openAlexRefs.length && !semanticScholarRefs.length && String(title || '').trim()) {
    [openAlexRefs, semanticScholarRefs] = await Promise.all([
      getOpenAlexReferencesByTitle(title),
      getSemanticScholarReferencesByTitle(title)
    ]);
  }
  const unionMap = new Map();
  [...openAlexRefs, ...semanticScholarRefs].forEach((item) => {
    const key = normalizeReferenceTitle(item?.title) || String(item?.refId || '');
    if (!key || unionMap.has(key)) return;
    unionMap.set(key, item);
  });
  const union = Array.from(unionMap.values());
  console.log(
    `[references] doi=${normalized} openalex=${openAlexRefs.length} semanticscholar=${semanticScholarRefs.length} union=${union.length}`
  );
  return {
    doi: normalized,
    total_openalex: openAlexRefs.length,
    total_semanticscholar: semanticScholarRefs.length,
    intersection_count: union.length,
    union_count: union.length,
    references: union
  };
};

const searchPaperOpenSource = async (title) => {
  const query = String(title || '').trim();
  if (!query) return null;
  let primary = null;
  const semantic = await searchSemanticScholarByTitle(query).catch(() => null);
  if (semantic) {
    primary = {
      source: 'Semantic Scholar',
      title: String(semantic?.title || '').trim(),
      authors: Array.isArray(semantic?.authors) ? semantic.authors.filter(Boolean) : [],
      publication_date: String(semantic?.publication_date || '').trim(),
      venue: String(semantic?.venue || '').trim(),
      doi: String(semantic?.doi || '').trim() || null
    };
  } else {
    const openAlex = await searchOpenAlexByTitle(query).catch(() => null);
    if (!openAlex) return null;
    primary = {
      source: 'OpenAlex',
      title: String(openAlex?.title || '').trim(),
      authors: Array.isArray(openAlex?.authors) ? openAlex.authors.filter(Boolean) : [],
      publication_date: String(openAlex?.publication_date || '').trim(),
      venue: String(openAlex?.venue || '').trim(),
      doi: String(openAlex?.doi || '').trim() || null
    };
  }
  console.log(
    `[open-source][merged] query="${String(query || '').slice(0, 120)}" result=${JSON.stringify(
      primary
    )}`
  );
  return primary;
};

const webDavSyncModule = createWebDavSyncModule({
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
  loadPaperVectorsFromSqlite,
  saveFoldersToSqlite,
  savePapersToSqlite,
  savePaperStateToSqlite,
  savePaperVectorsToSqlite,
  deletePaperStatesFromSqlite,
  deletePaperVectorsFromSqlite,
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
});

const { syncLibrary, clearWebDavLock } = webDavSyncModule;

ipcMain.handle('settings-get', async () => {
  const settings = await loadSettings();
  const webdav = await getWebDavConfigFromSettings();
  return { ...settings, libraryPath: getLibraryRoot(), ...webdav };
});
ipcMain.handle('settings-set', async (_event, payload = {}) =>
  enqueueWrite(async () => {
    const settings = await saveSettings(payload);
    const webdav = await getWebDavConfigFromSettings();
    return { ...settings, libraryPath: getLibraryRoot(), ...webdav };
  })
);

registerWebDavIpc({
  ipcMain,
  enqueueWrite,
  testWebDavConnection,
  saveWebDavConfig,
  clearWebDavLock
});

registerWebDavSyncIpc({
  ipcMain,
  enqueueWrite,
  beforeSync: flushWrites,
  syncLibrary
});

registerLibraryIpc({
  ipcMain,
  enqueueWrite,
  ensureLibraryStoreReady: sqliteModule.ensureLibraryStoreReady,
  getLibraryPaths,
  loadFoldersFromSqlite: sqliteModule.loadFoldersFromSqlite,
  saveFoldersToSqlite: sqliteModule.saveFoldersToSqlite,
  loadPapersFromSqlite: sqliteModule.loadPapersFromSqlite,
  savePapersToSqlite: sqliteModule.savePapersToSqlite,
  cleanupOrphanPaperStateFiles,
  writeJsonFile,
  getPaperArticleId,
  fs,
  fileExists,
  loadPaperStateFromSqlite: sqliteModule.loadPaperStateFromSqlite,
  savePaperStateToSqlite: sqliteModule.savePaperStateToSqlite,
  removeFileIfExists,
  deletePapersFromSqlite: sqliteModule.deletePapersFromSqlite,
  recordSyncChange
});

ipcMain.handle('translate-text', async (_event, payload = {}) => {
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, error: '缺少文本' };

  try {
    logProgress('开始翻译');
    const settings = await loadSettings();
    const engine = settings.translationEngine || 'cnki';
    if (engine === 'openai') {
      const content = await openaiTranslate(text, settings);
      logProgress('完成翻译');
      return { ok: true, content, engine: 'openai' };
    }
    const content = await cnkiTranslateWithRetry(text);
    logProgress('完成翻译');
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

ipcMain.handle('search-paper-open-source', async (_event, payload = {}) => {
  try {
    const title = String(payload?.title || '').trim();
    if (!title) return null;
    return await searchPaperOpenSource(title);
  } catch (error) {
    console.warn('[metadata] open-source search failed:', error?.message || error);
    return null;
  }
});

ipcMain.handle('search-paper-references', async (_event, payload = {}) => {
  try {
    const doi = String(payload?.doi || '').trim();
    const title = String(payload?.title || '').trim();
    if (!doi) {
      return {
        ok: false,
        error: '缺少 DOI',
        doi: '',
        total_openalex: 0,
        total_semanticscholar: 0,
        intersection_count: 0,
        references: []
      };
    }
    const result = await getReferenceIntersectionByDoi(doi, title);
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || '参考文献解析失败',
      doi: normalizeDoi(payload?.doi),
      total_openalex: 0,
      total_semanticscholar: 0,
      intersection_count: 0,
      references: []
    };
  }
});

ipcMain.handle('log-summary-rewrite', async (_event, payload = {}) => {
  const paperId = String(payload?.paperId || '').trim();
  if (paperId) {
    logProgress('完成重写摘要', paperId);
  } else {
    logProgress('完成重写摘要');
  }
  return { ok: true };
});

ipcMain.handle('log-progress', async (_event, payload = {}) => {
  const stage = String(payload?.stage || '').trim();
  const paperId = String(payload?.paperId || '').trim();
  logProgress(stage, paperId);
  return { ok: true };
});

ipcMain.handle('debug-log', async (_event, payload = {}) => {
  const tag = String(payload?.tag || 'debug').trim() || 'debug';
  const message = String(payload?.message || '').trim();
  const event = String(payload?.event || '').trim();
  const paperId = String(payload?.paperId || '').trim();
  const data = payload?.payload;
  const base = message || event || '(empty)';
  const suffix = paperId ? ` paper=${paperId}` : '';
  if (data && typeof data === 'object') {
    try {
      console.log(`[${tag}] ${base}${suffix} ${JSON.stringify(data)}`);
    } catch {
      console.log(`[${tag}] ${base}${suffix}`);
    }
  } else {
    console.log(`[${tag}] ${base}${suffix}`);
  }
  return { ok: true };
});

ipcMain.handle('get-embedding', async (_event, payload = {}) => {
  try {
    const settings = await loadSettings();
    const rawInput =
      typeof payload === 'string'
        ? payload
        : payload?.input ?? payload?.text ?? '';
    const inputList = Array.isArray(rawInput)
      ? rawInput
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [String(rawInput || '').trim()].filter(Boolean);
    if (!inputList.length) {
      return { success: false, error: '缺少文本输入' };
    }
    const model =
      typeof payload === 'object' && payload?.model
        ? String(payload.model).trim()
        : 'text-embedding-3-small';
    const dimensions = (() => {
      if (typeof payload === 'object' && payload?.dimensions !== undefined) {
        return Number(payload.dimensions);
      }
      return getConfiguredSummaryVectorDim();
    })();
    const vectors = await openaiEmbeddings(inputList.length === 1 ? inputList[0] : inputList, settings, {
      model,
      dimensions
    });
    if (inputList.length === 1) {
      return {
        success: true,
        model,
        dimensions: Array.isArray(vectors[0]) ? vectors[0].length : 0,
        embedding: vectors[0]
      };
    }
    return {
      success: true,
      model,
      dimensions: Array.isArray(vectors[0]) ? vectors[0].length : 0,
      embeddings: vectors
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Embedding请求失败'
    };
  }
});


ipcMain.handle('library-match-references', async (_event, payload = {}) => {
  try {
    const paperId = String(payload?.paperId || '').trim();
    const references = Array.isArray(payload?.references) ? payload.references : [];
    const matched = await matchReferencesToLocalPapers(paperId, references);
    return { ok: true, references: matched };
  } catch (error) {
    return { ok: false, error: error?.message || 'reference match failed', references: [] };
  }
});

const cosineSimilarity = (left = [], right = []) => {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < len; index += 1) {
    const av = Number(a[index]);
    const bv = Number(b[index]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    dot += av * bv;
    leftNorm += av * av;
    rightNorm += bv * bv;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

ipcMain.handle('vector-search-papers', async (_event, payload = {}) => {
  try {
    const query = String(payload?.query || '').trim();
    if (!query) return { ok: false, error: '缺少query' };
    const limit = Math.max(1, Math.min(100, Number(payload?.limit || 30)));
    const settings = await loadSettings();
    if (!settings?.parsePdfWithAI) {
      return { ok: false, error: 'AI解析已关闭，相似度搜索不可用' };
    }
    if (!settings?.apiKey || !settings?.baseUrl) {
      return { ok: false, error: '请先在设置中配置 API Key 和 Base URL' };
    }
    await ensureLibraryStoreReady();
    const vectorRows = loadPaperVectorsFromSqlite();
    if (!vectorRows.length) return { ok: true, results: [] };
    const model = String(payload?.model || process.env.MINDPAPER_SUMMARY_EMBED_MODEL || DEFAULT_SUMMARY_EMBEDDING_MODEL).trim();
    const vectorDim = Math.max(1, Number(vectorRows[0]?.dim || vectorRows[0]?.vector?.length || getConfiguredSummaryVectorDim()));
    const vectors = await openaiEmbeddings(query, settings, { model, dimensions: vectorDim });
    const vector = Array.isArray(vectors[0]) ? vectors[0] : null;
    if (!vector) return { ok: false, error: 'query embedding failed' };
    const results = vectorRows
      .map((item) => {
        const paperId = String(item?.paperId || '').trim();
        const score = cosineSimilarity(vector, item?.vector || []);
        if (!paperId || !Number.isFinite(score)) return null;
        return {
          id: getPaperArticleId(paperId),
          paperId,
          score,
          payload: {
            paperId,
            summaryHash: String(item?.summaryHash || '').trim(),
            model: String(item?.model || '').trim(),
            dim: Number(item?.dim || 0)
          }
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
      .slice(0, limit)
      .filter((item) => item.paperId);
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: error?.message || 'vector search failed' };
  }
});

ipcMain.handle('vector-get-paper-statuses', async (_event, payload = {}) => {
  try {
    const paperIds = Array.isArray(payload?.paperIds)
      ? payload.paperIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (!paperIds.length) return { ok: true, vectorizedPaperIds: [] };
    await ensureLibraryStoreReady();
    const vectorizedPaperIds = loadPaperVectorsFromSqlite(paperIds)
      .map((row) => String(row?.paperId || '').trim())
      .filter(Boolean);
    return { ok: true, vectorizedPaperIds: Array.from(new Set(vectorizedPaperIds)) };
  } catch (error) {
    return { ok: false, error: error?.message || 'vector status failed', vectorizedPaperIds: [] };
  }
});

ipcMain.handle('vector-get-status', async () => {
  await ensureLibraryStoreReady();
  const startup = await debugVectorBackendStartup();
  const ready = Boolean(startup?.ok);
  const paths = getLibraryPaths();
  let pointCount = -1;
  let summaryVectorCount = -1;
  let vectorDim = getConfiguredSummaryVectorDim();
  try {
    const db = getLibraryDb();
    const row = db.prepare('SELECT COUNT(*) AS count FROM papers').get();
    pointCount = Number(row?.count || 0);
  } catch {
    pointCount = -1;
  }
  const vectors = loadPaperVectorsFromSqlite();
  summaryVectorCount = vectors.length;
  if (vectors.length) {
    vectorDim = Math.max(1, Number(vectors[0]?.dim || vectors[0]?.vector?.length || vectorDim));
  }
  return {
    ok: ready,
    collection: 'sqlite-vector',
    vectorFields: [PAPERS_VECTOR_NAME],
    vectorDim,
    pointCount,
    summaryVectorCollection: 'paper_summary_vectors',
    summaryVectorCount,
    metadataDbPath: paths.sqlitePath,
    error: ready ? undefined : startup?.error || 'sqlite-vector not ready'
  };
});

ipcMain.handle('vector-debug-qdrant-startup', async () => {
  return debugVectorBackendStartup();
});

ipcMain.handle('vector-debug-dump-qdrant', async () => {
  return debugDumpVectorBackendInfo();
});

app.whenReady().then(() => {
  const bindCtrlQQuitShortcut = (win) => {
    if (!win?.webContents) return;
    win.webContents.on('before-input-event', (event, input = {}) => {
      const key = String(input?.key || '').toLowerCase();
      if (
        input?.type === 'keyDown' &&
        input?.control &&
        !input?.meta &&
        !input?.alt &&
        !input?.shift &&
        key === 'q'
      ) {
        event.preventDefault();
        requestAppQuit();
      }
    });
  };

  const createWindow = () => {
    const win = createMainWindow({
      isDev,
      devServerURL,
      preloadPath: path.join(__dirname, '..', 'bridge', 'preload.cjs'),
      indexHtmlPath: path.join(__dirname, '..', '..', 'dist', 'index.html')
    });
    bindCtrlQQuitShortcut(win);
    return win;
  };

  createWindow();

  void (async () => {
    try {
      await ensureLibraryStoreReady();
      const papers = await loadPapersFromSqlite();
      if (Array.isArray(papers) && papers.length) {
        void enqueueSummaryVectorSync(papers);
      }
    } catch (error) {
      console.warn('[vector-index] init failed:', error?.message || error);
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  isForceQuitting = true;
  try {
    closeLibraryDb();
  } catch {
    // ignore close db errors on quit
  }
});

app.on('will-quit', () => {
  if (forceQuitTimer) {
    clearTimeout(forceQuitTimer);
    forceQuitTimer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
