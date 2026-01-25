const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const isDev = !app.isPackaged;
const DEV_ICON_PATH = path.join(__dirname, '../assets/aipaper.png');
const PACKAGED_ICON_PATH = path.join(__dirname, '../assets/aipaper.icns');
const resolveIconPath = () => {
  const primary = isDev ? DEV_ICON_PATH : PACKAGED_ICON_PATH;
  if (fsSync.existsSync(primary)) return primary;
  const fallback = isDev ? PACKAGED_ICON_PATH : DEV_ICON_PATH;
  if (fsSync.existsSync(fallback)) return fallback;
  return null;
};
const ICON_PATH = resolveIconPath();
const DEFAULT_BASE_URL = 'https://api.chatanywhere.tech/v1';
const DEFAULT_MODEL = 'gpt-3.5-turbo';
const LOGIC_SYSTEM_PROMPT = `You are a strict academic-logic analysis engine.

Your task is NOT to summarize, explain, or paraphrase.
Your task is to locate a target sentence inside the author's
multi-dimensional reasoning structure, strictly based on the given text.

Rules:
- Output MUST be valid JSON.
- Output MUST be a JSON array.
- Do NOT include any explanation outside JSON.
- Do NOT use external academic knowledge.
- Every claim MUST be grounded in the provided text.`;

const LOGIC_REQUIRED_FIELDS = [
  'id',
  'dimension',
  'relation_type',
  'evidence_text',
  'confidence'
];

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
let settingsLoaded = false;
let runtimeSettings = {
  apiKey: '',
  baseUrl: ''
};

const sanitizeSettings = (payload = {}) => ({
  apiKey: String(payload.apiKey || '').trim(),
  baseUrl: String(payload.baseUrl || '').trim()
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
  const resolved = String(baseUrl || '').trim();
  return resolved.endsWith('/chat/completions')
    ? resolved
    : `${resolved.replace(/\/$/, '')}/chat/completions`;
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f4f1ea',
    ...(ICON_PATH ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
};

ipcMain.handle('read-pdf', async (_event, filePath) => {
  if (!filePath) return null;
  return fs.readFile(filePath);
});

ipcMain.handle('settings-get', async () => {
  const settings = await loadSettings();
  return settings;
});

ipcMain.handle('settings-set', async (_event, payload = {}) => {
  try {
    const settings = await saveSettings(payload);
    return { ok: true, settings };
  } catch (error) {
    return { ok: false, error: error?.message || '保存设置失败' };
  }
});

ipcMain.handle('openai-chat', async (_event, payload = {}) => {
  const settings = await loadSettings();
  const apiKey = settings.apiKey;
  const baseUrl = settings.baseUrl;
  if (!apiKey) {
    return { ok: false, error: '缺少OPENAI_API_KEY' };
  }
  if (!baseUrl) {
    return { ok: false, error: '缺少OPENAI_BASE_URL' };
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) {
    return { ok: false, error: 'messages不能为空' };
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.3;
  const maxTokens = Number.isFinite(payload.maxTokens) ? payload.maxTokens : 600;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

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
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, error: data?.error?.message || 'OpenAI请求失败' };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return { ok: false, error: 'OpenAI返回内容为空' };
    }

    return { ok: true, content: content.trim(), usage: data?.usage || null };
  } catch (error) {
    const baseMessage =
      error?.name === 'AbortError' ? 'OpenAI请求超时' : error?.message || 'OpenAI请求失败';
    const cause = error?.cause;
    const detail = cause?.code || cause?.message || '';
    const message = detail ? `${baseMessage} (${detail})` : baseMessage;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle('openai-logic', async (_event, payload = {}) => {
  const settings = await loadSettings();
  const apiKey = settings.apiKey;
  const baseUrl = settings.baseUrl;
  if (!apiKey) {
    return { ok: false, error: '缺少OPENAI_API_KEY' };
  }
  if (!baseUrl) {
    return { ok: false, error: '缺少OPENAI_BASE_URL' };
  }

  const fullText = String(payload.fullText || '').trim();
  const targetSentence = String(payload.targetSentence || '').trim();
  const pageNumber = Number.isFinite(payload.pageNumber) ? payload.pageNumber : null;
  const sectionHint = String(payload.sectionHint || '').trim();

  if (!fullText || !targetSentence) {
    return { ok: false, error: '缺少全文或选中文本' };
  }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;
  const maxTokens = Number.isFinite(payload.maxTokens) ? payload.maxTokens : 900;

  const userPrompt = `# Task
Given the full text of an academic paper and a target sentence,
reconstruct the sentence's position in the author's high-dimensional reasoning space.

# Target Sentence
"${targetSentence}"

# Page Number
${pageNumber ? `p${pageNumber}` : 'unknown'}

# Section Hint
${sectionHint || 'unknown'}

# Full Paper Text
${fullText}

# Required Output
Return a JSON array.
Each element MUST represent one high-dimensional linkage related to the target sentence.

Each JSON object MUST contain the following fields:

- id: string
- dimension: one of ["dependency_up", "dependency_down", "structural_role", "in_text_contrast", "implicit_assumption"]
- relation_type: string
- evidence_text: string
- confidence: one of ["explicit", "inferred"]

Output JSON ONLY.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
    const response = await fetch(buildOpenAIUrl(baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: LOGIC_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, error: data?.error?.message || 'OpenAI请求失败' };
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return { ok: false, error: 'OpenAI返回内容为空' };
    }

    const cleaned = content
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'OpenAI返回不是JSON数组' };
    }
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        return { ok: false, error: 'OpenAI返回结构不完整' };
      }
      for (const key of LOGIC_REQUIRED_FIELDS) {
        if (!(key in item)) {
          return { ok: false, error: `缺少字段: ${key}` };
        }
      }
    }

    return { ok: true, items: parsed, usage: data?.usage || null };
  } catch (error) {
    const baseMessage =
      error?.name === 'AbortError' ? 'OpenAI请求超时' : error?.message || 'OpenAI请求失败';
    const cause = error?.cause;
    const detail = cause?.code || cause?.message || '';
    const message = detail ? `${baseMessage} (${detail})` : baseMessage;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.on('app-log', (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type || 'log';
  if (type === 'selection') {
    console.log(`[AIPAPER] 选中文本: ${payload.text || ''}`);
    return;
  }
  if (type === 'related') {
    console.log(`[AIPAPER] 相关段落 (基于: ${payload.selection || ''})`);
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    segments.forEach((segment, index) => {
      const page = Number.isFinite(segment.pageIndex) ? segment.pageIndex + 1 : '?';
      console.log(`  ${index + 1}. [p${page}] ${segment.text || ''}`);
    });
    return;
  }
  if (type === 'related-jump') {
    const page = Number.isFinite(payload.pageIndex) ? payload.pageIndex + 1 : '?';
    console.log(
      `[AIPAPER] 跳转相关段落 ${payload.index || '?'} / ${payload.total || '?'} -> p${page}`
    );
    if (payload.text) {
      console.log(`  ${payload.text}`);
    }
    return;
  }
  if (type === 'related-match') {
    const page = Number.isFinite(payload.pageIndex) ? payload.pageIndex + 1 : '?';
    console.log(
      `[AIPAPER] 匹配结果 ${payload.index || '?'} / ${payload.total || '?'} -> p${page} (${payload.status || 'unknown'})`
    );
    if (payload.matchedText) {
      console.log(`  PDF: ${payload.matchedText}`);
    }
    return;
  }
  if (type === 'related-logic') {
    console.log(`[AIPAPER] 高维关联结果 (${payload.count || 0})`);
    const items = Array.isArray(payload.items) ? payload.items : [];
    items.forEach((item, index) => {
      console.log(
        `  ${index + 1}. [${item.dimension || '?'}] ${item.relation_type || ''}`
      );
      if (item.evidence_text) {
        console.log(`     ${item.evidence_text}`);
      }
    });
    return;
  }
  console.log('[AIPAPER]', payload);
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && ICON_PATH) {
    try {
      const result = app.dock.setIcon(ICON_PATH);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn('[AIPAPER] Dock icon load failed:', error?.message || error);
        });
      }
    } catch (error) {
      console.warn('[AIPAPER] Dock icon load failed:', error?.message || error);
    }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
