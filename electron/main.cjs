const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const isDev = !app.isPackaged;
const devServerURL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3001';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const TRANSLATE_SYSTEM_PROMPT =
  '你是翻译引擎。请将用户提供的文本翻译成中文，只输出翻译结果，不要添加解释。';
const CNKI_TOKEN_URL = 'https://dict.cnki.net/fyzs-front-api/getToken';
const CNKI_TRANSLATE_URL = 'https://dict.cnki.net/fyzs-front-api/translate/literaltranslation';
const CNKI_REGEX = /(查看名企职位.+?https:\/\/dict\.cnki\.net[a-zA-Z./]+.html?)/g;
const CNKI_AES_KEY = '4e87183cfd3a45fe';
const CNKI_TOKEN_TTL = 300 * 1000;

let settingsLoaded = false;
let runtimeSettings = {
  translationEngine: 'cnki',
  apiKey: '',
  baseUrl: '',
  model: '',
  parsePdfWithAI: false
};

let cnkiTokenCache = { token: '', t: 0 };

const sanitizeSettings = (payload = {}) => ({
  translationEngine: payload.translationEngine === 'openai' ? 'openai' : 'cnki',
  apiKey: String(payload.apiKey || '').trim(),
  baseUrl: String(payload.baseUrl || '').trim(),
  model: String(payload.model || '').trim(),
  parsePdfWithAI: Boolean(payload.parsePdfWithAI)
});

const loadSettings = async () => {
  if (settingsLoaded) return runtimeSettings;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    runtimeSettings = { ...runtimeSettings, ...sanitizeSettings(parsed) };
  } catch (error) {
    // ignore missing/invalid settings
  }
  settingsLoaded = true;
  return runtimeSettings;
};

const saveSettings = async (payload = {}) => {
  const next = { ...runtimeSettings, ...sanitizeSettings(payload) };
  runtimeSettings = next;
  settingsLoaded = true;
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(runtimeSettings, null, 2), 'utf8');
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

const LIBRARY_ROOT = path.join(app.getPath('userData'), 'Library');
const LIBRARY_PAPERS_DIR = path.join(LIBRARY_ROOT, 'papers');
const LIBRARY_STATES_DIR = path.join(LIBRARY_ROOT, 'states');
const LIBRARY_PAPERS_PATH = path.join(LIBRARY_ROOT, 'papers.json');
const LIBRARY_FOLDERS_PATH = path.join(LIBRARY_ROOT, 'folders.json');
const LIBRARY_INDEX_PATH = path.join(LIBRARY_ROOT, 'index.json');

const ensureLibrary = async () => {
  await fs.mkdir(LIBRARY_ROOT, { recursive: true });
  await fs.mkdir(LIBRARY_PAPERS_DIR, { recursive: true });
  await fs.mkdir(LIBRARY_STATES_DIR, { recursive: true });
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

ipcMain.handle('settings-get', async () => loadSettings());
ipcMain.handle('settings-set', async (_event, payload = {}) => saveSettings(payload));

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
  await ensureLibrary();
  return readJsonFile(LIBRARY_FOLDERS_PATH, null);
});

ipcMain.handle('library-save-folders', async (_event, payload = []) => {
  await ensureLibrary();
  await writeJsonFile(LIBRARY_FOLDERS_PATH, Array.isArray(payload) ? payload : []);
  return { ok: true };
});

ipcMain.handle('library-get-papers', async () => {
  await ensureLibrary();
  return readJsonFile(LIBRARY_PAPERS_PATH, null);
});

ipcMain.handle('library-save-papers', async (_event, payload = []) => {
  await ensureLibrary();
  await writeJsonFile(LIBRARY_PAPERS_PATH, Array.isArray(payload) ? payload : []);
  return { ok: true };
});

ipcMain.handle('library-save-pdf', async (_event, payload = {}) => {
  const paperId = String(payload.paperId || '').trim();
  if (!paperId) return { ok: false, error: '缺少paperId' };
  await ensureLibrary();
  const data = payload.data;
  if (!data) return { ok: false, error: '缺少PDF数据' };
  const buffer = Buffer.from(new Uint8Array(data));
  const filePath = path.join(LIBRARY_PAPERS_DIR, `${paperId}.pdf`);
  await fs.writeFile(filePath, buffer);
  await writeJsonFile(LIBRARY_INDEX_PATH, { updatedAt: Date.now() });
  return { ok: true, filePath };
});

ipcMain.handle('library-read-pdf', async (_event, payload = {}) => {
  await ensureLibrary();
  const filePath = payload.filePath ? String(payload.filePath) : '';
  const paperId = payload.paperId ? String(payload.paperId) : '';
  let resolvedPath = filePath;
  if (!resolvedPath && paperId) {
    const papers = await readJsonFile(LIBRARY_PAPERS_PATH, []);
    const entry = Array.isArray(papers) ? papers.find((item) => item.id === paperId) : null;
    resolvedPath = entry?.filePath || '';
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
  await ensureLibrary();
  const paperId = String(payload.paperId || '').trim();
  if (!paperId) return null;
  const statePath = path.join(LIBRARY_STATES_DIR, `${paperId}.json`);
  return readJsonFile(statePath, null);
});

ipcMain.handle('library-save-paper-state', async (_event, payload = {}) => {
  await ensureLibrary();
  const paperId = String(payload.paperId || '').trim();
  if (!paperId) return { ok: false, error: '缺少paperId' };
  const statePath = path.join(LIBRARY_STATES_DIR, `${paperId}.json`);
  await writeJsonFile(statePath, payload.state || {});
  return { ok: true };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(devServerURL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
