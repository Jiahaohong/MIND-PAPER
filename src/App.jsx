import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString();

const STORAGE_KEY = 'aipaper-history-v1';
const HIGHLIGHT_CACHE_KEY = 'aipaper-highlight-cache-v1';
const FOLDER_STORAGE_KEY = 'aipaper-folders-v1';
const VIEW_ALL = 'all';
const VIEW_TRASH = 'trash';
const MAX_QUESTIONS = 5;
const MIN_QUESTIONS = 3;
const MAX_PROMPT_CHARS = 12000;
const MAX_CONTEXT_SEGMENTS = 6;
const MAX_CONTEXT_CHARS = 420;
const MAX_RELATED_SEGMENTS = 6;
const MIN_SELECTION_CHARS = 2;
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.4;
const MIN_MINDMAP_SCALE = 0.5;
const MAX_MINDMAP_SCALE = 2.2;
const MINDMAP_GAP_X = 90;
const MINDMAP_GAP_Y = 18;
const MINDMAP_MARGIN = 60;
const MINDMAP_MAX_WIDTH = 240;
const MINDMAP_NOTE_MAX_WIDTH = 200;
const MINDMAP_NOTE_MAX_LINES = 2;
const MINDMAP_NOTE_TRANSLATION_MAX_LINES = 2;
const MINDMAP_PADDING_X = 12;
const MINDMAP_PADDING_Y = 8;
const MINDMAP_NOTE_PADDING_X = 10;
const MINDMAP_NOTE_PADDING_Y = 6;
const MINDMAP_FONT_SIZE = 13;
const MINDMAP_ROOT_FONT_SIZE = 14;
const MINDMAP_NOTE_FONT_SIZE = 11;
const MINDMAP_NOTE_TEXT_REM = 0.7;
const MINDMAP_NOTE_TRANSLATION_REM = 0.68;
const MINDMAP_LINE_HEIGHT = 16;
const MINDMAP_NOTE_LINE_HEIGHT = 14;
const MINDMAP_NOTE_TRANSLATION_GAP = 4;
const LEFT_PANEL_MIN = 200;
const LEFT_PANEL_MAX = 420;
const PUNCTUATION_REGEX = /[\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F'"“”‘’.,;:!?，。？！、；：·—…\-–—()\[\]{}<>《》【】]/g;
const HIGHLIGHT_COLORS = [
  { id: 'sun', swatch: '#facc15', fill: 'rgba(250, 204, 21, 0.45)' },
  { id: 'peach', swatch: '#fb923c', fill: 'rgba(251, 146, 60, 0.4)' },
  { id: 'mint', swatch: '#34d399', fill: 'rgba(52, 211, 153, 0.35)' },
  { id: 'sky', swatch: '#60a5fa', fill: 'rgba(96, 165, 250, 0.35)' },
  { id: 'rose', swatch: '#f87171', fill: 'rgba(248, 113, 113, 0.35)' }
];

const QUESTION_SYSTEM_PROMPT =
  '你是研究阅读助手。请根据用户提供的PDF全文内容，生成3-5个“带着问题阅读”的问题，问题应具体、可引导阅读。' +
  '仅返回JSON数组字符串，数组元素为中文问题句子，不要添加任何额外说明。';

const CHAT_SYSTEM_PROMPT =
  '你是AIPAPER阅读助手。请基于提供的文档片段回答用户问题，避免编造。' +
  '如果片段不足以回答，请明确说明并建议用户提供更具体的关键词或页码。';

const TRANSLATE_SYSTEM_PROMPT =
  '你是翻译引擎。请将用户提供的文本翻译成中文，只输出翻译结果，不要添加解释。';

const RELATED_SYSTEM_PROMPT =
  '你是PDF阅读助手。请从候选片段中挑选与选中文本逻辑相关的3-6个片段编号。' +
  '仅返回JSON数组，例如：[1,3,5]，不要添加解释。';

const STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'into',
  'using',
  'used',
  'use',
  'paper',
  'study',
  'results',
  'method',
  'methods',
  'analysis',
  'model',
  'data',
  'based',
  'were',
  'their',
  'have',
  'has',
  'for',
  'are',
  'was',
  'not',
  'but',
  'can',
  'may',
  'also',
  'such',
  'these',
  'those',
  'between',
  'within'
]);

const STOPWORDS_ZH = new Set([
  '我们',
  '本文',
  '研究',
  '结果',
  '方法',
  '通过',
  '进行',
  '提出',
  '分析',
  '数据',
  '模型',
  '可以',
  '因此',
  '其中',
  '一个',
  '以及',
  '同时',
  '对于',
  '相关',
  '不同',
  '重要',
  '主要',
  '进一步'
]);

const loadHistory = () => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      ...entry,
      chat: Array.isArray(entry.chat) ? entry.chat : [],
      questions: Array.isArray(entry.questions) ? entry.questions : [],
      highlights: Array.isArray(entry.highlights) ? entry.highlights : [],
      customChapters: Array.isArray(entry.customChapters) ? entry.customChapters : [],
      relatedHistory: Array.isArray(entry.relatedHistory) ? entry.relatedHistory : [],
      folderId: entry.folderId || null,
      trashedAt: entry.trashedAt || null
    }));
  } catch {
    return [];
  }
};

const saveHistory = (history) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
};

const getHighlightCache = () => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(HIGHLIGHT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const saveHighlightCache = (cache) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HIGHLIGHT_CACHE_KEY, JSON.stringify(cache));
};

const upsertHighlightCache = (key, highlights) => {
  if (!key) return;
  const cache = getHighlightCache();
  cache[key] = highlights;
  saveHighlightCache(cache);
};

const removeHighlightCache = (key) => {
  if (!key) return;
  const cache = getHighlightCache();
  if (!(key in cache)) return;
  delete cache[key];
  saveHighlightCache(cache);
};

const loadFolders = () => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FOLDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((folder) => ({
        id: folder.id,
        name: String(folder.name || '').trim(),
        parentId: folder.parentId || null,
        createdAt: folder.createdAt || new Date().toISOString()
      }))
      .filter((folder) => folder.id && folder.name);
  } catch {
    return [];
  }
};

const saveFolders = (folders) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));
};

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

const toUint8Array = (data) => {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
};

const clonePdfData = (data) => {
  if (!data) return null;
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return new Uint8Array(buffer);
  }
  return new Uint8Array(data);
};

const tokenizeEnglish = (text) => text.toLowerCase().match(/[a-z]{4,}/g) || [];

const tokenizeChinese = (text) => text.match(/[\u4e00-\u9fa5]{2,6}/g) || [];

const extractKeywords = (text, limit = 3) => {
  const freq = new Map();
  const addToken = (token, isZh) => {
    const cleaned = token.trim();
    if (!cleaned) return;
    if (isZh) {
      if (STOPWORDS_ZH.has(cleaned)) return;
    } else if (STOPWORDS.has(cleaned)) {
      return;
    }
    freq.set(cleaned, (freq.get(cleaned) || 0) + 1);
  };

  tokenizeEnglish(text).forEach((token) => addToken(token, false));
  tokenizeChinese(text).forEach((token) => addToken(token, true));

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
};

const segmentText = (pages = []) => {
  const segments = [];

  pages.forEach((pageText, pageIndex) => {
    const lines = String(pageText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 40);

    lines.forEach((line) => {
      if (line.length > 360) {
        const parts = line
          .split(/[。！？.!?]\s+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 25);
        parts.forEach((part) => segments.push({ text: part, pageIndex }));
      } else {
        segments.push({ text: line, pageIndex });
      }
    });
  });

  return segments;
};

const scoreSegment = (segment, keywords) => {
  if (!keywords.length) return 0;
  const lower = segment.toLowerCase();
  let score = 0;
  keywords.forEach((kw) => {
    if (!kw) return;
    if (lower.includes(kw.toLowerCase())) score += 1;
  });
  return score / keywords.length;
};

const trimSnippet = (text, max = 320) => (text.length > max ? `${text.slice(0, max)}…` : text);

const clampScale = (value) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
const clampMindmapScale = (value) =>
  Math.min(MAX_MINDMAP_SCALE, Math.max(MIN_MINDMAP_SCALE, value));

const wrapTextLines = (text, maxWidth, ctx) => {
  const safeText = String(text || '').trim();
  if (!safeText) return [''];
  const measure = (value) => {
    if (!ctx) return value.length * 8;
    return ctx.measureText(value).width;
  };
  const lines = [];
  let line = '';
  for (const char of safeText) {
    if (!line && char === ' ') continue;
    const nextLine = line + char;
    if (measure(nextLine) > maxWidth && line) {
      lines.push(line);
      line = char.trim() ? char : '';
    } else {
      line = nextLine;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const clampTextLines = (lines, maxLines) => {
  if (!maxLines || lines.length <= maxLines) return lines;
  const next = lines.slice(0, maxLines);
  const lastIndex = maxLines - 1;
  const last = next[lastIndex] || '';
  const trimmed =
    last.length > 3 ? `${last.slice(0, Math.max(0, last.length - 3))}...` : `${last}...`;
  next[lastIndex] = trimmed;
  return next;
};

const removeLineBreaks = (text) =>
  String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stripPunctuation = (text) => String(text || '').replace(PUNCTUATION_REGEX, '');

const normalizeForIndex = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/\u00ad/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .toLowerCase()
    .replace(/\s+/g, '');
};

const normalizeNoPunct = (text) => stripPunctuation(normalizeForIndex(text));

const sortTextItems = (items) =>
  [...items].sort((a, b) => {
    const yDiff = Math.abs(a.transform[5] - b.transform[5]);
    if (yDiff > 2) {
      return b.transform[5] - a.transform[5];
    }
    return a.transform[4] - b.transform[4];
  });

const getItemRect = (item, viewport) => {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
    item.transform[4],
    item.transform[5],
    item.transform[4] + item.width,
    item.transform[5] + item.height
  ]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left,
    top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
};

const buildPageIndex = (items, viewport) => {
  const normalizedChars = [];
  const normalizedNoPunctChars = [];
  const charToItem = [];
  const charToOffset = [];
  const charToItemNoPunct = [];
  const charToOffsetNoPunct = [];
  const itemCharCounts = items.map(() => 0);
  const itemCharCountsNoPunct = items.map(() => 0);
  const itemRects = items.map((item) => getItemRect(item, viewport));

  items.forEach((item, itemIndex) => {
    const normalized = normalizeForIndex(item.str || '');
    itemCharCounts[itemIndex] = normalized.length;
    for (let i = 0; i < normalized.length; i += 1) {
      normalizedChars.push(normalized[i]);
      charToItem.push(itemIndex);
      charToOffset.push(i);
    }

    const normalizedNoPunct = normalizeNoPunct(item.str || '');
    itemCharCountsNoPunct[itemIndex] = normalizedNoPunct.length;
    for (let i = 0; i < normalizedNoPunct.length; i += 1) {
      normalizedNoPunctChars.push(normalizedNoPunct[i]);
      charToItemNoPunct.push(itemIndex);
      charToOffsetNoPunct.push(i);
    }
  });

  return {
    items,
    itemRects,
    normalizedText: normalizedChars.join(''),
    normalizedNoPunct: normalizedNoPunctChars.join(''),
    charToItem,
    charToOffset,
    charToItemNoPunct,
    charToOffsetNoPunct,
    itemCharCounts,
    itemCharCountsNoPunct
  };
};

const findMatchRange = (haystack, needle) => {
  if (!needle) return null;
  const start = haystack.indexOf(needle);
  if (start < 0) return null;
  return { start, length: needle.length };
};

const getItemIndicesForRange = (map, start, length) => {
  const indices = [];
  const seen = new Set();
  const end = Math.min(start + length, map.length);
  for (let i = Math.max(0, start); i < end; i += 1) {
    const index = map[i];
    if (index == null || seen.has(index)) continue;
    seen.add(index);
    indices.push(index);
  }
  return indices;
};

const buildMatchRects = (pageIndex, map, offsetMap, itemCharCounts, range) => {
  const itemIndices = getItemIndicesForRange(map, range.start, range.length);
  const rects = [];
  const startIdx = range.start;
  const endIdx = Math.min(map.length - 1, range.start + range.length - 1);
  const startItem = map[startIdx];
  const endItem = map[endIdx];

  itemIndices.forEach((idx) => {
    const rect = pageIndex.itemRects[idx];
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const itemLen = itemCharCounts[idx] || 0;
    if (!itemLen || startItem == null || endItem == null) {
      rects.push(rect);
      return;
    }

    let left = rect.left;
    let width = rect.width;
    if (idx === startItem || idx === endItem) {
      const startOffset = idx === startItem ? offsetMap[startIdx] ?? 0 : 0;
      const endOffset =
        idx === endItem ? offsetMap[endIdx] ?? itemLen - 1 : itemLen - 1;
      const startRatio = Math.max(0, Math.min(1, startOffset / itemLen));
      const endRatio = Math.max(0, Math.min(1, (endOffset + 1) / itemLen));
      left = rect.left + rect.width * startRatio;
      width = rect.width * Math.max(0, endRatio - startRatio);
      if (width <= 0) {
        width = rect.width;
        left = rect.left;
      }
    }

    rects.push({ ...rect, left, width });
  });

  const matchedText = itemIndices
    .map((idx) => pageIndex.items[idx]?.str)
    .filter(Boolean)
    .join(' ');
  return { rects, matchedText };
};

const matchSegmentInPage = (pageIndex, segmentText) => {
  const normalized = normalizeForIndex(segmentText);
  if (!normalized) return null;
  const normalizedNoPunct = normalizeNoPunct(segmentText);

  let range = findMatchRange(pageIndex.normalizedText, normalized);
  let map = pageIndex.charToItem;
  let offsetMap = pageIndex.charToOffset;
  let itemCharCounts = pageIndex.itemCharCounts;

  if (!range && normalizedNoPunct.length > 2) {
    range = findMatchRange(pageIndex.normalizedNoPunct, normalizedNoPunct);
    map = pageIndex.charToItemNoPunct;
    offsetMap = pageIndex.charToOffsetNoPunct;
    itemCharCounts = pageIndex.itemCharCountsNoPunct;
  }

  if (!range) return null;
  return buildMatchRects(pageIndex, map, offsetMap, itemCharCounts, range);
};

const matchSegmentAcrossPages = (segmentText, pageIndexData) => {
  for (let pageIndex = 0; pageIndex < pageIndexData.length; pageIndex += 1) {
    const pageIndexInfo = pageIndexData[pageIndex];
    const match = matchSegmentInPage(pageIndexInfo, segmentText);
    if (match) {
      return { ...match, pageIndex };
    }
  }
  return { rects: [], matchedText: '', pageIndex: null };
};

const HEADING_NUMBER_REGEX = /^(\d+(?:\.\d+)*)\s+\S+/;
const HEADING_ZH_REGEX = /^第[一二三四五六七八九十百]+(章|节|部分)\s*\S+/;

const getMedian = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const groupItemsIntoLines = (items) => {
  const lines = [];
  let current = null;
  items.forEach((item) => {
    const y = item?.transform?.[5] ?? 0;
    if (!current || Math.abs(current.y - y) > 2) {
      current = { y, items: [] };
      lines.push(current);
    }
    current.items.push(item);
  });

  return lines
    .map((line) => {
      const text = line.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
      const height = line.items.reduce((acc, item) => Math.max(acc, item.height || 0), 0);
      return { text, height, y: line.y };
    })
    .filter((line) => line.text);
};

const getHeadingLevel = (text) => {
  const zhMatch = text.match(HEADING_ZH_REGEX);
  if (zhMatch) {
    return zhMatch[1] === '节' ? 2 : 1;
  }
  const numMatch = text.match(HEADING_NUMBER_REGEX);
  if (numMatch) {
    return Math.min(4, numMatch[1].split('.').length);
  }
  return null;
};

const buildOutlineTreeFromHeadings = (headings) => {
  const root = [];
  const stack = [];
  let lastKey = '';

  headings.forEach((heading, index) => {
    const key = `${heading.pageIndex}-${heading.title}`;
    if (key === lastKey) return;
    lastKey = key;
    const node = {
      id: `h-${heading.pageIndex}-${index}`,
      title: heading.title,
      pageIndex: heading.pageIndex,
      top: heading.top ?? null,
      topRatio: heading.topRatio ?? null,
      items: [],
      level: heading.level
    };
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    if (!stack.length) {
      root.push(node);
    } else {
      stack[stack.length - 1].items.push(node);
    }
    stack.push(node);
  });

  const stripLevels = (nodes) =>
    nodes.map((node) => ({
      id: node.id,
      title: node.title,
      pageIndex: node.pageIndex,
      top: node.top ?? null,
      topRatio: node.topRatio ?? null,
      items: stripLevels(node.items || [])
    }));

  return stripLevels(root);
};

const normalizeHeadingKey = (text) =>
  stripPunctuation(String(text || '').toLowerCase())
    .replace(/\d+/g, '')
    .replace(/\s+/g, '');

const buildFallbackOutline = (pageInfos) => {
  if (!pageInfos.length) return [];
  const linesByPage = pageInfos.map((info) => groupItemsIntoLines(info.items));
  const heights = [];
  linesByPage.forEach((lines) => {
    lines.forEach((line) => {
      if (line.height) heights.push(line.height);
    });
  });
  const medianHeight = getMedian(heights);
  const headings = [];
  const headerCounts = new Map();
  const totalPages = pageInfos.length;

  linesByPage.forEach((lines, pageIndex) => {
    const pageHeight = pageInfos[pageIndex]?.viewport?.height || 0;
    const viewport = pageInfos[pageIndex]?.viewport;
    lines.forEach((line) => {
      if (line.text.length < 4 || line.text.length > 120) return;
      if (pageHeight) {
        const inFooter = line.y <= pageHeight * 0.08;
        if (inFooter) return;
      }
      const level = getHeadingLevel(line.text);
      const isLarge = medianHeight && line.height >= medianHeight * 1.25;
      if (!level && !isLarge) return;
      const inHeader = pageHeight ? line.y >= pageHeight * 0.9 : false;
      const key = normalizeHeadingKey(line.text);
      if (inHeader && key) {
        headerCounts.set(key, (headerCounts.get(key) || 0) + 1);
      }
      const top = viewport
        ? Math.max(0, viewport.convertToViewportPoint(0, line.y)[1] - line.height)
        : null;
      const topRatio =
        viewport && top != null && viewport.height
          ? Math.max(0, Math.min(1, top / viewport.height))
          : null;
      headings.push({
        title: line.text,
        pageIndex,
        level: level || 1,
        top,
        topRatio,
        inHeader,
        key
      });
    });
  });

  const headerThreshold = Math.max(3, Math.ceil(totalPages * 0.4));
  const filtered = headings.filter((heading) => {
    if (!heading.inHeader || !heading.key) return true;
    return (headerCounts.get(heading.key) || 0) < headerThreshold;
  });

  return buildOutlineTreeFromHeadings(filtered);
};

const resolveOutlineDestination = async (doc, dest, pageViewports) => {
  if (!dest) return { pageIndex: null, top: null, topRatio: null };
  let destArray = dest;
  if (typeof dest === 'string') {
    destArray = await doc.getDestination(dest);
  }
  if (!Array.isArray(destArray) || !destArray.length)
    return { pageIndex: null, top: null, topRatio: null };
  const pageRef = destArray[0];
  let pageIndex = null;
  if (typeof pageRef === 'number') {
    pageIndex = pageRef;
  } else {
    try {
      pageIndex = await doc.getPageIndex(pageRef);
    } catch {
      pageIndex = null;
    }
  }
  if (pageIndex == null) return { pageIndex: null, top: null, topRatio: null };
  const destType = destArray[1]?.name || destArray[1]?.toString?.() || '';
  let top = null;
  if (destType === 'XYZ') {
    top = typeof destArray[3] === 'number' ? destArray[3] : null;
  } else if (destType === 'FitH' || destType === 'FitBH') {
    top = typeof destArray[2] === 'number' ? destArray[2] : null;
  }
  if (top == null) return { pageIndex, top: null, topRatio: null };
  let viewport = pageViewports.get(pageIndex);
  if (!viewport) {
    const page = await doc.getPage(pageIndex + 1);
    viewport = page.getViewport({ scale: 1 });
    pageViewports.set(pageIndex, viewport);
  }
  const [, y] = viewport.convertToViewportPoint(0, top);
  const topPx = Math.max(0, y);
  const topRatio = viewport.height ? Math.max(0, Math.min(1, topPx / viewport.height)) : null;
  return { pageIndex, top: topPx, topRatio };
};

const buildOutlineTree = async (doc, items, parentId = '', pageViewports = new Map()) => {
  const nodes = await Promise.all(
    (items || []).map(async (item, index) => {
      const id = `${parentId}${parentId ? '.' : ''}${index}`;
      const destInfo = await resolveOutlineDestination(doc, item?.dest, pageViewports);
      const children = item?.items?.length
        ? await buildOutlineTree(doc, item.items, id, pageViewports)
        : [];
      const rawTitle = String(item?.title || '').trim();
      const title = rawTitle || (children.length ? '未命名章节' : '');
      return {
        id,
        title,
        pageIndex: destInfo.pageIndex,
        top: destInfo.top,
        topRatio: destInfo.topRatio,
        items: children
      };
    })
  );

  return nodes.filter((node) => node.title || node.items.length);
};

const extractOutline = async (doc, pageInfos) => {
  const pageViewports = new Map(
    pageInfos.map((info, index) => [index, info.viewport]).filter((item) => item[1])
  );
  try {
    const outline = await doc.getOutline();
    if (outline?.length) {
      const tree = await buildOutlineTree(doc, outline, '', pageViewports);
      if (tree.length) return tree;
    }
  } catch {
    // ignore outline errors
  }
  return buildFallbackOutline(pageInfos);
};

const collectOutlineIds = (nodes, acc = {}) => {
  nodes.forEach((node) => {
    acc[node.id] = true;
    if (node.items?.length) collectOutlineIds(node.items, acc);
  });
  return acc;
};

const flattenOutline = (nodes, depth = 0, acc = []) => {
  nodes.forEach((node) => {
    acc.push({ ...node, depth });
    if (node.items?.length) {
      flattenOutline(node.items, depth + 1, acc);
    }
  });
  return acc;
};

const normalizeHighlightRect = (rect) => {
  if (!rect || typeof rect !== 'object') return null;
  if (
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.w === 'number' &&
    typeof rect.h === 'number'
  ) {
    return { ...rect, legacy: false };
  }
  if (
    typeof rect.left === 'number' &&
    typeof rect.top === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  ) {
    return { ...rect, legacy: true };
  }
  return null;
};

const normalizeHighlights = (list) =>
  (Array.isArray(list) ? list : [])
    .map((item) => {
      const rects = (item?.rects || [])
        .map((rect) => normalizeHighlightRect(rect))
        .filter((rect) => rect && rect.pageIndex != null && rect.pageIndex >= 0);
      return {
        ...item,
        rects
      };
    })
    .filter((item) => item?.rects?.length);

const normalizeQuestions = (list) =>
  (Array.isArray(list) ? list : [])
    .map((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return null;
        return { id: `q-${makeId()}`, text };
      }
      if (item && typeof item === 'object') {
        const text = String(item.text || item.content || '').trim();
        if (!text) return null;
        return { ...item, id: item.id || `q-${makeId()}`, text };
      }
      return null;
    })
    .filter(Boolean);

const sortOutlineByPosition = (nodes) =>
  nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aNode = a.node;
      const bNode = b.node;
      const aPage = aNode?.isRoot ? -1 : aNode?.pageIndex ?? Number.POSITIVE_INFINITY;
      const bPage = bNode?.isRoot ? -1 : bNode?.pageIndex ?? Number.POSITIVE_INFINITY;
      if (aPage !== bPage) return aPage - bPage;
      const aRatio = typeof aNode?.topRatio === 'number' ? aNode.topRatio : 0;
      const bRatio = typeof bNode?.topRatio === 'number' ? bNode.topRatio : 0;
      if (aRatio !== bRatio) return aRatio - bRatio;
      return a.index - b.index;
    })
    .map((item) => item.node);

const mergeOutlineWithCustom = (outline, customNodes, baseFlatOutline, rootId) => {
  const custom = Array.isArray(customNodes) ? customNodes : [];
  const source = Array.isArray(outline) ? outline : [];
  if (!custom.length) return source;
  const cloneNodes = (nodes) =>
    (nodes || []).map((node) => ({
      ...node,
      items: cloneNodes(node.items || [])
    }));
  const rootItems = cloneNodes(source);
  const baseIds = new Set((baseFlatOutline || []).map((node) => node.id));

  const insertIntoParent = (nodes, parentId, child) => {
    for (const node of nodes) {
      if (node.id === parentId) {
        node.items = Array.isArray(node.items) ? [...node.items, child] : [child];
        return true;
      }
      if (node.items?.length && insertIntoParent(node.items, parentId, child)) return true;
    }
    return false;
  };

  custom.forEach((node) => {
    if (!node) return;
    const normalized = {
      ...node,
      items: Array.isArray(node.items) ? node.items : [],
      isCustom: true
    };
    let parentId = node.parentId;
    if (!parentId || !baseIds.has(parentId)) {
      const candidate = findChapterForPosition(
        baseFlatOutline || [],
        node.pageIndex,
        node.topRatio ?? 0
      );
      parentId = candidate?.id || null;
    }
    if (parentId && parentId !== rootId && insertIntoParent(rootItems, parentId, normalized)) {
      return;
    }
    rootItems.push(normalized);
  });

  const sortChildren = (nodes) => {
    if (!nodes.length) return;
    const sorted = sortOutlineByPosition(nodes);
    nodes.splice(0, nodes.length, ...sorted);
    nodes.forEach((node) => {
      if (node.items?.length) sortChildren(node.items);
    });
  };

  sortChildren(rootItems);
  return rootItems;
};

const CHAPTER_START_TOLERANCE = 0.03;

const findChapterForPosition = (flatOutline, pageIndex, topRatio) => {
  if (!flatOutline.length || pageIndex == null) return null;
  const ratio = typeof topRatio === 'number' ? topRatio : 0;
  let candidate = null;
  flatOutline.forEach((node) => {
    if (node.pageIndex == null) return;
    const nodeRatio = typeof node.topRatio === 'number' ? node.topRatio : 0;
    const isBefore =
      node.pageIndex < pageIndex ||
      (node.pageIndex === pageIndex && nodeRatio <= ratio);
    if (isBefore) {
      candidate = node;
    }
  });
  if (candidate?.isRoot) {
    const samePageHeadings = flatOutline
      .filter(
        (node) =>
          !node.isRoot &&
          node.pageIndex === pageIndex &&
          typeof node.topRatio === 'number'
      )
      .sort((a, b) => (a.topRatio ?? 0) - (b.topRatio ?? 0));
    if (samePageHeadings.length) {
      const firstHeading = samePageHeadings[0];
      if (ratio + CHAPTER_START_TOLERANCE >= (firstHeading.topRatio ?? 0)) {
        return firstHeading;
      }
    }
  }
  return candidate;
};

const getHighlightKey = (entry) => entry?.path || entry?.name || null;

const preparePromptText = (text, maxChars = MAX_PROMPT_CHARS) => {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n...\n${tail}`;
};

const parseQuestionList = (raw) => {
  if (!raw) return [];
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // fall through to line parsing
  }

  return raw
    .split(/\n+/)
    .map((line) => line.replace(/^[\s\-\d\.\)\u2022]+/, '').trim())
    .filter((line) => line.length > 6)
    .slice(0, MAX_QUESTIONS);
};

const parseIndexList = (raw, max) => {
  if (!raw) return [];
  const cleaned = raw.trim().replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= max);
    }
  } catch {
    // fall through to regex parsing
  }

  const matches = cleaned.match(/\d+/g) || [];
  return matches
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= max);
};

const selectContextSegments = (question, segments, limit = MAX_CONTEXT_SEGMENTS) => {
  if (!segments.length) return [];
  const keywords = extractKeywords(question, 4);
  const scored = segments.map((segment) => ({
    segment: segment.text,
    score: scoreSegment(segment.text, keywords)
  }));

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((item) => item.score > 0).slice(0, limit);
  const fallback = scored.slice(0, limit);

  return (picked.length ? picked : fallback).map((item) =>
    trimSnippet(item.segment, MAX_CONTEXT_CHARS)
  );
};

const buildAnswer = (question, segments) => {
  if (!segments.length) {
    return '文档已读取，但没有可检索的文本。请检查PDF是否为扫描件或图片。';
  }

  const keywords = extractKeywords(question, 4);
  const scored = segments.map((segment) => ({
    segment: segment.text,
    score: scoreSegment(segment.text, keywords)
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((item) => item.score > 0).slice(0, 2);

  if (!top.length) {
    return '我没有找到直接相关的段落。可以尝试更具体的术语、关键词或页码。';
  }

  const snippet = top
    .map((item, index) => `片段${index + 1}：${trimSnippet(item.segment)}`)
    .join('\n\n');

  return `文档中可能相关的内容：\n${snippet}\n\n如果你想深入某个公式或段落，请告诉我页码。`;
};

const generateQuestions = (text) => {
  const [k1, k2, k3] = extractKeywords(text, 3);
  const list = [
    '这篇文档试图解决的核心问题是什么？',
    k1 ? `作者提出的主要方法与“${k1}”之间有什么关键联系？` : '作者提出的主要方法或模型是什么？',
    k2 ? `文中关键概念（如“${k2}”）是如何定义与使用的？` : '文中关键概念或假设是如何定义的？',
    k3 ? `实验或证明如何支持关于“${k3}”的结论？` : '实验或论证如何支撑核心结论？',
    '有哪些局限性或未来方向值得继续探索？'
  ];

  const targetCount = Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, list.length));
  return list.slice(0, targetCount);
};

const canUseOpenAI = () =>
  typeof window !== 'undefined' &&
  window.electronAPI &&
  typeof window.electronAPI.openaiChat === 'function';

const canUseOpenAILogic = () =>
  typeof window !== 'undefined' &&
  window.electronAPI &&
  typeof window.electronAPI.openaiLogic === 'function';

const canUseLogger = () =>
  typeof window !== 'undefined' &&
  window.electronAPI &&
  typeof window.electronAPI.log === 'function';

const canUseSettings = () =>
  typeof window !== 'undefined' &&
  window.electronAPI &&
  typeof window.electronAPI.settingsGet === 'function';


const logToMain = (payload) => {
  if (canUseLogger()) {
    window.electronAPI.log(payload);
  } else {
    console.log('[AIPAPER]', payload);
  }
};

const requestOpenAI = async ({ messages, temperature = 0.3, maxTokens = 600 }) => {
  if (!canUseOpenAI()) {
    throw new Error('OpenAI不可用');
  }
  const response = await window.electronAPI.openaiChat({ messages, temperature, maxTokens });
  if (!response?.ok) {
    throw new Error(response?.error || 'OpenAI请求失败');
  }
  return response.content || '';
};

const requestOpenAILogic = async ({
  fullText,
  targetSentence,
  pageNumber,
  sectionHint,
  temperature = 0.2,
  maxTokens = 900
}) => {
  if (!canUseOpenAILogic()) {
    throw new Error('OpenAI不可用');
  }
  const response = await window.electronAPI.openaiLogic({
    fullText,
    targetSentence,
    pageNumber,
    sectionHint,
    temperature,
    maxTokens
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'OpenAI请求失败');
  }
  return Array.isArray(response.items) ? response.items : [];
};

const generateQuestionsWithOpenAI = async (text) => {
  const promptText = preparePromptText(text);
  const content = await requestOpenAI({
    messages: [
      { role: 'system', content: QUESTION_SYSTEM_PROMPT },
      { role: 'user', content: `PDF内容如下：\n${promptText}` }
    ],
    temperature: 0.4,
    maxTokens: 400
  });

  const list = parseQuestionList(content);
  if (list.length >= MIN_QUESTIONS) {
    return list.slice(0, MAX_QUESTIONS);
  }
  return generateQuestions(text);
};

const answerWithOpenAI = async (question, segments, history) => {
  const contextSegments = selectContextSegments(question, segments);
  const contextText = contextSegments.length
    ? contextSegments.map((segment, index) => `片段${index + 1}：${segment}`).join('\n')
    : '（未检索到相关片段）';
  const historyMessages = Array.isArray(history)
    ? history.slice(-4).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content
      }))
    : [];

  const content = await requestOpenAI({
    messages: [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      ...historyMessages,
      { role: 'user', content: `问题：${question}\n\n文档片段：\n${contextText}` }
    ],
    temperature: 0.2,
    maxTokens: 700
  });

  return content.trim();
};

const findRelatedSegmentsLocal = (selectionText, segments) => {
  if (!segments.length) return [];
  const tokens = extractKeywords(selectionText, 4);
  const keywords = tokens.length ? tokens : [selectionText.trim()];
  const scored = segments.map((segment) => ({
    ...segment,
    score: scoreSegment(segment.text, keywords)
  }));
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter((item) => item.score > 0).slice(0, MAX_RELATED_SEGMENTS);
  return picked.length ? picked : scored.slice(0, MAX_RELATED_SEGMENTS);
};

const matchRelatedSegmentsToPdf = (segments, pageIndexData) => {
  if (!segments.length || !pageIndexData.length) return segments;

  return segments.map((segment) => {
    const normalizedText = removeLineBreaks(segment.text).trim();
    if (!normalizedText) return segment;
    const match = matchSegmentAcrossPages(normalizedText, pageIndexData);
    return {
      ...segment,
      text: normalizedText,
      pageIndex: match.pageIndex ?? segment.pageIndex,
      rects: match.rects || [],
      matchedText: match.matchedText || ''
    };
  });
};

const refineRelatedSegmentsWithOpenAI = async (selectionText, candidates) => {
  if (!candidates.length) return [];
  const list = candidates
    .map((segment, index) => `${index + 1}. ${trimSnippet(segment.text, 220)}`)
    .join('\n');

  const content = await requestOpenAI({
    messages: [
      { role: 'system', content: RELATED_SYSTEM_PROMPT },
      { role: 'user', content: `选中文本：${selectionText}\n候选片段：\n${list}` }
    ],
    temperature: 0.2,
    maxTokens: 200
  });

  const indices = parseIndexList(content, candidates.length);
  if (!indices.length) return [];
  const selected = indices.map((index) => candidates[index - 1]).filter(Boolean);
  return selected.slice(0, MAX_RELATED_SEGMENTS);
};

const extractPdfText = async (pdfData) => {
  const doc = await pdfjs.getDocument({ data: pdfData }).promise;
  const pages = [];
  const pageIndexData = [];
  const pageInfos = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = sortTextItems(content.items || []);
    const strings = items.map((item) => item.str);
    pages.push(strings.join(' '));
    pageIndexData.push(buildPageIndex(items, viewport));
    pageInfos.push({ items, viewport });
  }

  const outline = await extractOutline(doc, pageInfos);

  return { fullText: pages.join('\n'), pages, pageIndexData, outline };
};

const formatDate = (value) => {
  if (!value) return '未知日期';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知日期';
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};

const getChatCount = (messages) => Math.floor((messages || []).length / 2);

const getPdfName = (currentPdf) => currentPdf?.name || '未选择PDF';

const getPdfPath = (file) => (file && 'path' in file ? file.path : null);

const canUseElectron = () =>
  typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.readPdf === 'function';

export default function App() {
  const [history, setHistory] = useState(loadHistory);
  const [folders, setFolders] = useState(loadFolders);
  const [activeView, setActiveView] = useState(VIEW_ALL);
  const [folderDialog, setFolderDialog] = useState({
    open: false,
    mode: 'create',
    targetId: null,
    name: '',
    parentId: null,
    returnView: null
  });
  const [folderError, setFolderError] = useState('');
  const [contextMenu, setContextMenu] = useState({
    open: false,
    x: 0,
    y: 0,
    kind: null,
    entry: null,
    folder: null,
    parentId: null
  });
  const [dragOverFolderId, setDragOverFolderId] = useState(null);
  const [dragOverSidebar, setDragOverSidebar] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [openTabs, setOpenTabs] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [currentPdf, setCurrentPdf] = useState(null);
  const [numPagesByTab, setNumPagesByTab] = useState({});
  const [scaleByTab, setScaleByTab] = useState({});
  const [centerViewByTab, setCenterViewByTab] = useState({});
  const [rightPanelTabByTab, setRightPanelTabByTab] = useState({});
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [questions, setQuestions] = useState([]);
  const [editingQuestionId, setEditingQuestionId] = useState(null);
  const [questionDraft, setQuestionDraft] = useState('');
  const [expandedQuestions, setExpandedQuestions] = useState({});
  const [questionMenu, setQuestionMenu] = useState({
    open: false,
    x: 0,
    y: 0,
    question: null
  });
  const [fullText, setFullText] = useState('');
  const [relatedLogicItems, setRelatedLogicItems] = useState([]);
  const [relatedLogicStatus, setRelatedLogicStatus] = useState('');
  const [relatedHistoryByTab, setRelatedHistoryByTab] = useState({});
  const [relatedHistoryViewByTab, setRelatedHistoryViewByTab] = useState({});
  const [customChaptersByTab, setCustomChaptersByTab] = useState({});
  const [segments, setSegments] = useState([]);
  const [status, setStatus] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [chatStatus, setChatStatus] = useState('');
  const [autoScaleByTab, setAutoScaleByTab] = useState({});
  const [mindmapScale, setMindmapScale] = useState(1);
  const [mindmapOffset, setMindmapOffset] = useState({ x: 0, y: 0 });
  const [isMindmapPanning, setIsMindmapPanning] = useState(false);
  const [selectionText, setSelectionText] = useState('');
  const [selectionRect, setSelectionRect] = useState(null);
  const [selectionHighlights, setSelectionHighlights] = useState([]);
  const [anchorSelectionText, setAnchorSelectionText] = useState('');
  const [anchorSelectionInfo, setAnchorSelectionInfo] = useState(null);
  const [pageIndexData, setPageIndexData] = useState([]);
  const [outline, setOutline] = useState([]);
  const [expandedOutline, setExpandedOutline] = useState({});
  const [expandedMindmap, setExpandedMindmap] = useState({});
  const [highlights, setHighlights] = useState([]);
  const [activeHighlightId, setActiveHighlightId] = useState(null);
  const [selectionInfo, setSelectionInfo] = useState(null);
  const [relatedSegments, setRelatedSegments] = useState([]);
  const [relatedIndex, setRelatedIndex] = useState(0);
  const [isFindingRelated, setIsFindingRelated] = useState(false);
  const [translationResult, setTranslationResult] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [leftWidth, setLeftWidth] = useState(260);
  const [isResizing, setIsResizing] = useState(false);
  const [draggingNoteId, setDraggingNoteId] = useState(null);
  const [dragOverOutlineId, setDragOverOutlineId] = useState(null);
  const [dragOverMindmapId, setDragOverMindmapId] = useState(null);
  const [dragGhost, setDragGhost] = useState(null);
  const [questionPicker, setQuestionPicker] = useState({
    open: false,
    highlightId: null,
    selectionInfo: null,
    selectionText: ''
  });
  const [expandedHighlightIds, setExpandedHighlightIds] = useState(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ apiKey: '', baseUrl: '' });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const tabListRef = useRef(null);
  const [questionPickerStyle, setQuestionPickerStyle] = useState(null);

  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const viewerScrollRef = useRef(null);
  const pageRefsMap = useRef(new Map());
  const scrollTopByTabRef = useRef(new Map());
  const shellRef = useRef(null);
  const selectionToolbarRef = useRef(null);
  const relatedQuestionButtonRef = useRef(null);
  const resizeStartRef = useRef({ x: 0, width: 0 });
  const scrollEndRef = useRef(null);
  const isPdfScrollingRef = useRef(false);
  const mindmapPanRef = useRef(null);
  const mindmapMeasureRef = useRef(null);
  const mindmapAnchorRef = useRef(null);
  const translateRequestRef = useRef(0);
  const lastTranslateTextRef = useRef('');
  const pendingTranslationRef = useRef(new Map());
  const translationCacheRef = useRef(new Map());
  const latestTranslationByTextRef = useRef(new Map());
  const questionEditRef = useRef({ id: null, originalText: '', isNew: false });
  const questionInputRef = useRef(null);
  const dragNoteTimerRef = useRef(null);
  const dragNoteRef = useRef(null);
  const dragNoteTriggeredRef = useRef(false);
  const dragOverOutlineIdRef = useRef(null);
  const dragOverMindmapRef = useRef({ id: null, kind: null });
  const flatOutlineRef = useRef([]);
  const analysisCacheRef = useRef(new Map());
  const pdfUrlMapRef = useRef(new Map());
  const analysisStateRef = useRef(new Map());
  const getPageRefsForId = (id) => {
    if (!id) return [];
    const map = pageRefsMap.current;
    if (!map.has(id)) map.set(id, []);
    return map.get(id);
  };

  const getActivePageRefs = () => getPageRefsForId(currentId);

  const setNumPagesForTab = (tabId, total) => {
    if (!tabId) return;
    setNumPagesByTab((prev) => ({ ...prev, [tabId]: total }));
  };

  const getCenterViewForTab = (tabId) =>
    tabId && centerViewByTab[tabId] ? centerViewByTab[tabId] : 'pdf';

  const setCenterViewForTab = (tabId, view) => {
    if (!tabId) return;
    setCenterViewByTab((prev) => (prev[tabId] === view ? prev : { ...prev, [tabId]: view }));
  };

  const getRightPanelTabForTab = (tabId) =>
    tabId && rightPanelTabByTab[tabId] ? rightPanelTabByTab[tabId] : 'questions';

  const setRightPanelTabForTab = (tabId, tab) => {
    if (!tabId) return;
    setRightPanelTabByTab((prev) => (prev[tabId] === tab ? prev : { ...prev, [tabId]: tab }));
  };

  const getRelatedHistoryViewForTab = (tabId) =>
    tabId && relatedHistoryViewByTab[tabId] ? relatedHistoryViewByTab[tabId] : 'history';

  const setRelatedHistoryViewForTab = (tabId, view) => {
    if (!tabId) return;
    setRelatedHistoryViewByTab((prev) =>
      prev[tabId] === view ? prev : { ...prev, [tabId]: view }
    );
  };

  const getRelatedHistoryForTab = (tabId) =>
    tabId && relatedHistoryByTab[tabId] ? relatedHistoryByTab[tabId] : [];

  const getScaleForTab = (tabId) => (tabId && scaleByTab[tabId] ? scaleByTab[tabId] : 1.05);

  const setScaleForTab = (tabId, nextScale) => {
    if (!tabId) return;
    setScaleByTab((prev) => ({ ...prev, [tabId]: nextScale }));
  };

  const markAutoScale = (tabId) => {
    if (!tabId) return;
    setAutoScaleByTab((prev) => ({ ...prev, [tabId]: true }));
  };

  const isAutoScaled = (tabId) => Boolean(tabId && autoScaleByTab[tabId]);

  const isHomeView = !currentId;
  const activeScale = getScaleForTab(currentId || currentPdf?.id);
  const activeCenterView = getCenterViewForTab(currentId || currentPdf?.id);
  const activeRightTab = getRightPanelTabForTab(currentId || currentPdf?.id);
  const relatedHistoryView = getRelatedHistoryViewForTab(currentId || currentPdf?.id);
  const relatedHistoryList = getRelatedHistoryForTab(currentId || currentPdf?.id);
  const relatedDone = Boolean(relatedLogicItems.length || relatedLogicStatus);
  const outlineRootId = currentId ? `root-${currentId}` : 'outline-root';
  const customChapters = currentId ? customChaptersByTab[currentId] || [] : [];

  const resetTranslation = () => {
    translateRequestRef.current += 1;
    lastTranslateTextRef.current = '';
    setTranslationResult('');
    setIsTranslating(false);
  };

  const normalizeTranslationText = (value) => (value || '').trim();

  const cacheTranslation = (text, translation) => {
    const key = normalizeTranslationText(text);
    if (!key || !translation) return;
    translationCacheRef.current.set(key, translation);
  };

  const syncTranslationForHighlight = (highlightId, text) => {
    if (!highlightId) return;
    const key = normalizeTranslationText(text);
    if (!key) return;
    const cached = translationCacheRef.current.get(key);
    if (cached) {
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === highlightId && item.translation !== cached
            ? { ...item, translation: cached }
            : item
        )
      );
      return;
    }
    const pendingId = latestTranslationByTextRef.current.get(key);
    if (!pendingId) return;
    const pending = pendingTranslationRef.current.get(pendingId);
    if (pending && !pending.highlightId) {
      pending.highlightId = highlightId;
      pendingTranslationRef.current.set(pendingId, pending);
    }
  };

  const attachTranslationToDraft = (highlight) => {
    if (!highlight) return highlight;
    const key = normalizeTranslationText(highlight.text);
    if (!key) return highlight;
    const cached = translationCacheRef.current.get(key);
    if (cached && !highlight.translation) {
      return { ...highlight, translation: cached };
    }
    const pendingId = latestTranslationByTextRef.current.get(key);
    if (!pendingId) return highlight;
    const pending = pendingTranslationRef.current.get(pendingId);
    if (pending && !pending.highlightId) {
      pending.highlightId = highlight.id;
      pendingTranslationRef.current.set(pendingId, pending);
    }
    return highlight;
  };

  const ensurePdfUrl = (tabId) => {
    if (!tabId) return null;
    const map = pdfUrlMapRef.current;
    const existing = map.get(tabId);
    if (existing?.url && existing?.source) return existing.url;
    const source = getAnalysisSource(tabId);
    if (!source) return existing?.url || null;
    if (existing?.source === source && existing?.url) return existing.url;
    if (existing?.url) URL.revokeObjectURL(existing.url);
    const blob = new Blob([source], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    map.set(tabId, { url, source });
    return url;
  };

  const getAnalysisSource = (tabId, data) => {
    if (!tabId) return null;
    const cached = analysisCacheRef.current.get(tabId);
    if (cached?.byteLength) return cached;
    if (data?.byteLength) {
      const source = clonePdfData(data);
      analysisCacheRef.current.set(tabId, source);
      return source;
    }
    return null;
  };

  const captureAnalysisState = (tabId) => {
    if (!tabId) return;
    analysisStateRef.current.set(tabId, {
      outline,
      pageIndexData,
      segments,
      fullText,
      questions,
      expandedOutline,
      expandedMindmap,
      customChapters: customChaptersByTab[tabId] || [],
      relatedLogicItems,
      relatedLogicStatus,
      anchorSelectionText,
      anchorSelectionInfo,
      relatedHistoryView: getRelatedHistoryViewForTab(tabId)
    });
  };

  const applyCachedAnalysisState = (tabId) => {
    const cached = tabId ? analysisStateRef.current.get(tabId) : null;
    if (!cached) return false;
    setOutline(cached.outline || []);
    setPageIndexData(cached.pageIndexData || []);
    setSegments(cached.segments || []);
    setFullText(cached.fullText || '');
    setQuestions(normalizeQuestions(cached.questions || []));
    setExpandedOutline(cached.expandedOutline || {});
    setExpandedMindmap(cached.expandedMindmap || {});
    setCustomChaptersByTab((prev) => ({
      ...prev,
      [tabId]: cached.customChapters || prev[tabId] || []
    }));
    setRelatedLogicItems(cached.relatedLogicItems || []);
    setRelatedLogicStatus(cached.relatedLogicStatus || '');
    setAnchorSelectionText(cached.anchorSelectionText || '');
    setAnchorSelectionInfo(cached.anchorSelectionInfo || null);
    if (tabId && cached.relatedHistoryView) {
      setRelatedHistoryViewForTab(tabId, cached.relatedHistoryView);
    }
    setIsAnalyzing(false);
    setStatus('');
    return true;
  };

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    saveFolders(folders);
  }, [folders]);

  useEffect(() => {
    if (activeView === VIEW_ALL || activeView === VIEW_TRASH) return;
    const exists = folders.some((folder) => folder.id === activeView);
    if (!exists) setActiveView(VIEW_ALL);
  }, [folders, activeView]);

  useEffect(() => {
    if (!contextMenu.open) return undefined;
    const handleMouseDown = (event) => {
      if (event.button !== 0) return;
      setContextMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setContextMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu.open]);

  useEffect(() => {
    if (!questionMenu.open) return undefined;
    const handleMouseDown = (event) => {
      if (event.button !== 0) return;
      setQuestionMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setQuestionMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [questionMenu.open]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (!isResizing) return undefined;
    const handleMove = (event) => {
      const shell = shellRef.current;
      if (!shell) return;
      const delta = event.clientX - resizeStartRef.current.x;
      const nextWidth = Math.min(
        LEFT_PANEL_MAX,
        Math.max(LEFT_PANEL_MIN, resizeStartRef.current.width + delta)
      );
      setLeftWidth(nextWidth);
    };
    const handleUp = () => setIsResizing(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  useEffect(() => {
    dragOverOutlineIdRef.current = dragOverOutlineId;
  }, [dragOverOutlineId]);

  const updateHistoryChat = (id, chat) => {
    setHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, chat } : entry))
    );
  };

  const updateHistoryQuestions = (id, questions) => {
    setHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, questions } : entry))
    );
  };

  const startQuestionEdit = (question, isNew = false) => {
    if (!question) return;
    questionEditRef.current = {
      id: question.id,
      originalText: question.text || '',
      isNew
    };
    setEditingQuestionId(question.id);
    setQuestionDraft(question.text || '');
  };

  const handleAddQuestion = () => {
    const next = { id: `q-${makeId()}`, text: '' };
    setQuestions((prev) => [...normalizeQuestions(prev), next]);
    startQuestionEdit(next, true);
  };

  const handleEditQuestion = (question) => {
    startQuestionEdit(question, false);
  };

  const handleDeleteQuestion = (questionId) => {
    if (!questionId) return;
    setQuestions((prev) => prev.filter((item) => item.id !== questionId));
    setHighlights((prev) =>
      prev.map((item) =>
        item.questionId === questionId ? { ...item, questionId: null } : item
      )
    );
    setExpandedQuestions((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    if (editingQuestionId === questionId) {
      setEditingQuestionId(null);
      setQuestionDraft('');
    }
  };

  const finalizeQuestionEdit = (questionId) => {
    if (!questionId) return;
    const trimmed = questionDraft.trim();
    const { originalText, isNew } = questionEditRef.current || {};
    if (!trimmed) {
      if (isNew) {
        setQuestions((prev) => prev.filter((item) => item.id !== questionId));
      } else if (originalText) {
        setQuestions((prev) =>
          prev.map((item) =>
            item.id === questionId ? { ...item, text: originalText } : item
          )
        );
      }
      setEditingQuestionId(null);
      setQuestionDraft('');
      questionEditRef.current = { id: null, originalText: '', isNew: false };
      return;
    }
    setQuestions((prev) =>
      prev.map((item) => (item.id === questionId ? { ...item, text: trimmed } : item))
    );
    setHighlights((prev) =>
      prev.map((item) =>
        item.questionId === questionId ? { ...item, questionText: trimmed } : item
      )
    );
    setEditingQuestionId(null);
    setQuestionDraft('');
    questionEditRef.current = { id: null, originalText: '', isNew: false };
  };

  const toggleQuestionExpand = (questionId) => {
    if (!questionId) return;
    setExpandedQuestions((prev) => ({
      ...prev,
      [questionId]: !prev[questionId]
    }));
  };

  const openQuestionMenu = (event, question) => {
    if (!question) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 140;
    const menuHeight = 90;
    const maxLeft = window.innerWidth - menuWidth - 12;
    const maxTop = window.innerHeight - menuHeight - 12;
    const left = Math.max(12, Math.min(event.clientX, maxLeft));
    const top = Math.max(12, Math.min(event.clientY, maxTop));
    setQuestionMenu({ open: true, x: left, y: top, question });
  };

  const openQuestionPicker = () => {
    if (!selectionInfo || !selectionText) return;
    if (!currentId) return;
    setQuestionPicker({
      open: true,
      highlightId: activeHighlightId,
      selectionInfo,
      selectionText
    });
  };

  const attachHighlightToQuestion = (question) => {
    if (!question) return;
    const questionId = question.id;
    const questionText = question.text;
    if (questionPicker.highlightId) {
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === questionPicker.highlightId
            ? { ...item, questionId, questionText }
            : item
        )
      );
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
      return;
    }
    const defaultColor = HIGHLIGHT_COLORS[0]?.fill || 'rgba(250, 204, 21, 0.45)';
    const nextHighlight = buildHighlightFromSelectionData(
      defaultColor,
      questionPicker.selectionInfo,
      questionPicker.selectionText
    );
    if (!nextHighlight) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
      return;
    }
    const highlightWithQuestion = {
      ...nextHighlight,
      questionId,
      questionText
    };
    setHighlights((prev) => [...prev, highlightWithQuestion]);
    setActiveHighlightId(highlightWithQuestion.id);
    setSelectionHighlights([]);
    setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
  };

  const loadSettings = async () => {
    if (!canUseSettings()) return;
    const data = await window.electronAPI.settingsGet();
    setSettingsForm({
      apiKey: data?.apiKey || '',
      baseUrl: data?.baseUrl || ''
    });
  };

  const handleSettingsClick = async () => {
    setSettingsOpen(true);
    setSettingsError('');
    try {
      await loadSettings();
    } catch (error) {
      setSettingsError(error?.message || '读取设置失败');
    }
  };

  const closeSettingsDialog = () => {
    setSettingsOpen(false);
    setSettingsError('');
    setSettingsSaving(false);
  };

  const saveSettings = async () => {
    if (!canUseSettings()) return;
    setSettingsSaving(true);
    setSettingsError('');
    try {
      const response = await window.electronAPI.settingsSet({
        apiKey: settingsForm.apiKey,
        baseUrl: settingsForm.baseUrl
      });
      if (!response?.ok) {
        throw new Error(response?.error || '保存失败');
      }
      setSettingsOpen(false);
    } catch (error) {
      setSettingsError(error?.message || '保存失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleTabListWheel = (event) => {
    const list = tabListRef.current;
    if (!list) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    list.scrollLeft += event.deltaY;
  };

  const updateHistoryHighlights = (id, highlights) => {
    setHistory((prev) =>
      prev.map((entry) => (entry.id === id ? { ...entry, highlights } : entry))
    );
  };

  const updateHistoryRelatedHistory = (id, relatedHistory) => {
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, relatedHistory: relatedHistory || [] } : entry
      )
    );
  };

  const updateHistoryCustomChapters = (id, customChapters) => {
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, customChapters: customChapters || [] } : entry
      )
    );
  };

  const upsertOpenTab = (entry) => {
    if (!entry?.id) return;
    setOpenTabs((prev) => {
      const nextTab = {
        id: entry.id,
        name: entry.name,
        path: entry.path || null
      };
      const exists = prev.some((tab) => tab.id === entry.id);
      if (!exists) return [...prev, nextTab];
      return prev.map((tab) =>
        tab.id === entry.id ? { ...tab, ...nextTab } : tab
      );
    });
  };

  const applyEntryState = (entry, mergedHighlights) => {
    setCurrentId(entry.id);
    setMessages(entry.chat || []);
    setQuestions(normalizeQuestions(entry.questions || []));
    setEditingQuestionId(null);
    setQuestionDraft('');
    setExpandedQuestions({});
    setSegments([]);
    setStatus('');
    setChatStatus('');
    setIsChatting(false);
    setSelectionText('');
    setSelectionRect(null);
    setSelectionHighlights([]);
    setHighlights(mergedHighlights || []);
    setActiveHighlightId(null);
    setSelectionInfo(null);
    setPageIndexData([]);
    setOutline([]);
    setExpandedOutline({});
    setFullText('');
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setRelatedLogicItems([]);
    setRelatedLogicStatus('');
    setRelatedHistoryByTab((prev) => ({
      ...prev,
      [entry.id]: entry.relatedHistory || prev[entry.id] || []
    }));
    setCustomChaptersByTab((prev) => ({
      ...prev,
      [entry.id]: entry.customChapters || prev[entry.id] || []
    }));
    if (!relatedHistoryViewByTab[entry.id]) {
      setRelatedHistoryViewForTab(entry.id, 'history');
    }
  };

  const goHome = () => {
    if (currentId) {
      captureAnalysisState(currentId);
      updateHistoryHighlights(currentId, highlights);
      updateHistoryCustomChapters(currentId, customChapters);
      const cacheKey = getHighlightKey(currentPdf);
      if (cacheKey) {
        upsertHighlightCache(cacheKey, highlights);
      }
    }
    setCurrentPdf(null);
    setCurrentId(null);
    setMessages([]);
    setDraft('');
    setQuestions([]);
    setEditingQuestionId(null);
    setQuestionDraft('');
    setExpandedQuestions({});
    setSegments([]);
    setStatus('');
    setChatStatus('');
    setIsAnalyzing(false);
    setIsChatting(false);
    setSelectionText('');
    setSelectionRect(null);
    setSelectionHighlights([]);
    setPageIndexData([]);
    setOutline([]);
    setExpandedOutline({});
    setHighlights([]);
    setActiveHighlightId(null);
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setDragActive(false);
  };

  const openCreateFolder = (parentId = null, returnView = activeView) => {
    setFolderError('');
    setFolderDialog({
      open: true,
      mode: 'create',
      targetId: null,
      name: '',
      parentId,
      returnView
    });
  };

  const openRenameFolder = (folder) => {
    if (!folder) return;
    setFolderError('');
    setFolderDialog({ open: true, mode: 'rename', targetId: folder.id, name: folder.name });
  };

  const closeFolderDialog = () => {
    setFolderError('');
    setFolderDialog({
      open: false,
      mode: 'create',
      targetId: null,
      name: '',
      parentId: null,
      returnView: null
    });
  };

  const submitFolderDialog = () => {
    const rawName = folderDialog.name || '';
    const name = rawName.trim();
    if (!name) {
      setFolderError('请输入文件夹名称。');
      return;
    }
    if (folderDialog.mode === 'create') {
      const next = {
        id: `folder-${makeId()}`,
        name,
        parentId: folderDialog.parentId || null,
        createdAt: new Date().toISOString()
      };
      setFolders((prev) => [...prev, next]);
      setExpandedFolders((prev) => ({
        ...prev,
        [next.id]: true,
        ...(next.parentId ? { [next.parentId]: true } : {})
      }));
      const nextView =
        folderDialog.returnView != null ? folderDialog.returnView : next.parentId || next.id;
      setActiveView(nextView);
    } else {
      setFolders((prev) =>
        prev.map((folder) =>
          folder.id === folderDialog.targetId ? { ...folder, name } : folder
        )
      );
    }
    closeFolderDialog();
  };

  const getDescendantFolderIds = (rootId) => {
    const result = [];
    const stack = [rootId];
    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;
      result.push(current);
      folders.forEach((item) => {
        if (item.parentId === current) stack.push(item.id);
      });
    }
    return result;
  };

  const deleteFolder = (folder) => {
    if (!folder) return;
    const targetIds = new Set(getDescendantFolderIds(folder.id));
    const hasItems = history.some(
      (entry) => !entry.trashedAt && entry.folderId && targetIds.has(entry.folderId)
    );
    const confirmMessage = hasItems
      ? '删除文件夹会把其中的PDF移动到回收站，确认继续吗？'
      : '确认删除这个文件夹吗？';
    if (!window.confirm(confirmMessage)) return;
    const deletedAt = new Date().toISOString();
    setHistory((prev) =>
      prev.map((entry) =>
        entry.folderId && targetIds.has(entry.folderId) && !entry.trashedAt
          ? { ...entry, trashedAt: deletedAt }
          : entry
      )
    );
    setFolders((prev) => prev.filter((item) => !targetIds.has(item.id)));
    if (activeView && targetIds.has(activeView)) {
      setActiveView(VIEW_ALL);
    }
  };

  const moveEntryToFolder = (entryId, folderId) => {
    const nextFolderId = folderId || null;
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === entryId ? { ...entry, folderId: nextFolderId } : entry
      )
    );
  };

  const moveEntryToTrash = (entryId) => {
    if (!window.confirm('将该PDF移动到回收站吗？')) return;
    const deletedAt = new Date().toISOString();
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === entryId ? { ...entry, trashedAt: deletedAt } : entry
      )
    );
  };

  const restoreEntry = (entryId) => {
    setHistory((prev) =>
      prev.map((entry) => {
        if (entry.id !== entryId) return entry;
        const folderExists = entry.folderId
          ? folders.some((folder) => folder.id === entry.folderId)
          : true;
        return {
          ...entry,
          trashedAt: null,
          folderId: folderExists ? entry.folderId : null
        };
      })
    );
  };

  const permanentlyDeleteEntry = (entry) => {
    if (!entry) return;
    if (!window.confirm('确认彻底删除该PDF及其本地记录吗？')) return;
    const cacheKey = getHighlightKey(entry);
    setHistory((prev) => prev.filter((item) => item.id !== entry.id));
    if (cacheKey) removeHighlightCache(cacheKey);
  };

  const emptyTrash = () => {
    if (!trashCount) return;
    if (!window.confirm('确认清空回收站吗？此操作不可恢复。')) return;
    const trashedEntries = history.filter((entry) => entry.trashedAt);
    trashedEntries.forEach((entry) => {
      const cacheKey = getHighlightKey(entry);
      if (cacheKey) removeHighlightCache(cacheKey);
    });
    setHistory((prev) => prev.filter((entry) => !entry.trashedAt));
  };

  const openContextMenu = (event, payload) => {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 220;
    const menuHeight =
      payload?.kind === 'entry' && !payload?.entry?.trashedAt
        ? 260
        : payload?.kind === 'canvas'
        ? 120
        : 200;
    const maxLeft = window.innerWidth - menuWidth - 12;
    const maxTop = window.innerHeight - menuHeight - 12;
    const left = Math.max(12, Math.min(event.clientX, maxLeft));
    const top = Math.max(12, Math.min(event.clientY, maxTop));
    setContextMenu({ open: true, x: left, y: top, ...payload });
  };

  const closeContextMenu = () => {
    setContextMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
  };

  const openEntryContextMenu = (event, entry) => {
    if (!entry) return;
    openContextMenu(event, { kind: 'entry', entry });
  };

  const openFolderContextMenu = (event, folder) => {
    if (!folder) return;
    openContextMenu(event, { kind: 'folder', folder });
  };

  const openCanvasContextMenu = (event) => {
    if (activeView === VIEW_TRASH) return;
    const target = event.target;
    if (target?.closest?.('.icon-button-tile, .icon-add, .file-row, .context-menu')) {
      return;
    }
    if (target?.closest?.('.manager-toolbar, .manager-actions, .manager-title')) {
      return;
    }
    const parentId =
      activeView !== VIEW_ALL && activeView !== VIEW_TRASH ? activeView : null;
    openContextMenu(event, { kind: 'canvas', parentId });
  };

  const handleEntryDragStart = (event, entry) => {
    if (!entry) return;
    event.dataTransfer.setData('text/plain', entry.id);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleEntryDragEnd = () => {
    setDragOverFolderId(null);
    setDragOverSidebar(null);
  };

  const handleFolderDragOver = (event, folder) => {
    if (!folder) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverFolderId(folder.id);
  };

  const handleFolderDragLeave = (event, folder) => {
    if (!folder) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragOverFolderId(null);
  };

  const handleFolderDrop = (event, folder) => {
    if (!folder) return;
    event.preventDefault();
    const entryId = event.dataTransfer.getData('text/plain');
    if (!entryId) return;
    moveEntryToFolder(entryId, folder.id);
    setDragOverFolderId(null);
  };

  const handleSidebarDragOver = (event, target) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverSidebar(target);
  };

  const handleSidebarDragLeave = (event, target) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragOverSidebar((prev) => (prev === target ? null : prev));
  };

  const handleSidebarDrop = (event, target) => {
    event.preventDefault();
    const entryId = event.dataTransfer.getData('text/plain');
    if (!entryId) return;
    if (target === VIEW_TRASH) {
      moveEntryToTrash(entryId);
    } else if (target === VIEW_ALL) {
      moveEntryToFolder(entryId, '');
    }
    setDragOverSidebar(null);
    setDragOverFolderId(null);
  };

  const handleTabSelect = async (tabId) => {
    if (!tabId || tabId === currentId) return;
    if (currentId && viewerScrollRef.current) {
      scrollTopByTabRef.current.set(currentId, viewerScrollRef.current.scrollTop);
    }
    if (currentId) {
      captureAnalysisState(currentId);
    }
    const entry = history.find((item) => item.id === tabId);
    if (!entry) return;
    if (!centerViewByTab[entry.id]) {
      setCenterViewForTab(entry.id, 'pdf');
    }
    if (!rightPanelTabByTab[entry.id]) {
      setRightPanelTabForTab(entry.id, 'questions');
    }
    const cachedHighlights = getHighlightCache()[getHighlightKey(entry)] || [];
    const mergedHighlights = normalizeHighlights(
      (entry.highlights || []).length ? entry.highlights : cachedHighlights
    );
    if (!(entry.highlights || []).length && mergedHighlights.length) {
      updateHistoryHighlights(entry.id, mergedHighlights);
    }
    applyEntryState(entry, mergedHighlights);
    const analysisSource = getAnalysisSource(entry.id);
    if (analysisSource) {
      setCurrentPdf({ ...entry });
      if (applyCachedAnalysisState(entry.id)) {
        return;
      }
      const analysisData = clonePdfData(analysisSource);
      if (!analysisData) {
        setStatus('解析PDF失败，请重新上传该PDF。');
        return;
      }
      await analyzePdf(analysisData, {
        entryId: entry.id,
        existingQuestions: entry.questions
      });
      return;
    }
    if (!entry.path) {
      setCurrentPdf(null);
      setStatus('没有找到本地路径，请重新上传该PDF。');
      return;
    }
    if (!canUseElectron()) {
      setStatus('当前环境无法读取本地文件，请在Electron中运行。');
      return;
    }
    try {
      const raw = await window.electronAPI.readPdf(entry.path);
      const data = toUint8Array(raw);
      if (!data) throw new Error('Empty data');
      analysisCacheRef.current.set(entry.id, data);
      setCurrentPdf({ ...entry });
      upsertOpenTab(entry);
      await analyzePdf(clonePdfData(data), {
        entryId: entry.id,
        existingQuestions: entry.questions
      });
    } catch (error) {
      setCurrentPdf(null);
      setStatus('读取PDF失败，请确认文件仍在原路径。');
    }
  };

  useEffect(() => {
    if (!currentId) return;
    updateHistoryHighlights(currentId, highlights);
    const cacheKey = getHighlightKey(currentPdf);
    if (cacheKey) {
      upsertHighlightCache(cacheKey, highlights);
    }
  }, [highlights, currentId]);

  useEffect(() => {
    if (!currentId) return;
    updateHistoryQuestions(currentId, questions);
  }, [questions, currentId]);

  useEffect(() => {
    if (!currentId) return;
    setExpandedHighlightIds(new Set());
  }, [currentId]);

  useEffect(() => {
    if (!editingQuestionId) return;
    requestAnimationFrame(() => {
      questionInputRef.current?.focus?.();
      questionInputRef.current?.select?.();
    });
  }, [editingQuestionId]);

  useEffect(() => {
    if (!editingQuestionId) return undefined;
    const handleMouseDown = (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target?.closest?.('.question-item.editing')) return;
      finalizeQuestionEdit(editingQuestionId);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [editingQuestionId, questionDraft]);


  useEffect(() => {
    if (!questionPicker.open) return;
    if (!selectionInfo || !selectionText) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
    }
  }, [questionPicker.open, selectionInfo, selectionText]);

  useEffect(() => {
    if (!editingQuestionId) return;
    return () => {
      questionEditRef.current = { id: null, originalText: '', isNew: false };
    };
  }, [editingQuestionId]);

  useEffect(() => {
    if (!currentId) return;
    updateHistoryCustomChapters(currentId, customChapters);
  }, [customChapters, currentId]);

  useEffect(() => {
    if (activeCenterView !== 'pdf') {
      resetTranslation();
    }
  }, [activeCenterView]);

  useEffect(() => {
    if (!selectionText || !selectionRect) {
      resetTranslation();
      return;
    }
    if (activeCenterView !== 'pdf') return;
    const source = normalizeTranslationText(selectionText);
    if (source.length < MIN_SELECTION_CHARS) {
      resetTranslation();
      return;
    }
    const highlightId = activeHighlightId;
    const activeHighlight = highlightId
      ? highlights.find((item) => item.id === activeHighlightId)
      : null;
    if (activeHighlight?.translation) {
      cacheTranslation(source, activeHighlight.translation);
      lastTranslateTextRef.current = source;
      setTranslationResult(activeHighlight.translation);
      setIsTranslating(false);
      return;
    }
    const cachedTranslation = translationCacheRef.current.get(source);
    if (cachedTranslation) {
      if (highlightId) {
        syncTranslationForHighlight(highlightId, source);
      }
      lastTranslateTextRef.current = source;
      setTranslationResult(cachedTranslation);
      setIsTranslating(false);
      return;
    }

    const pendingId = latestTranslationByTextRef.current.get(source);
    if (pendingId) {
      const pending = pendingTranslationRef.current.get(pendingId);
      if (pending && highlightId && pending.highlightId !== highlightId) {
        pending.highlightId = highlightId;
        pendingTranslationRef.current.set(pendingId, pending);
      }
      if (lastTranslateTextRef.current === source) return;
    }
    if (lastTranslateTextRef.current === source) return;
    lastTranslateTextRef.current = source;

    const requestId = translateRequestRef.current + 1;
    translateRequestRef.current = requestId;
    pendingTranslationRef.current.set(requestId, {
      text: source,
      highlightId: highlightId || null
    });
    latestTranslationByTextRef.current.set(source, requestId);
    setIsTranslating(true);
    setTranslationResult('正在翻译...');

    const run = async () => {
      try {
        const content = await requestOpenAI({
          messages: [
            { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
            { role: 'user', content: source }
          ],
          temperature: 0.2,
          maxTokens: 800
        });
        const result = String(content || '').trim();
        const finalText = result || '未返回翻译结果';
        const pending = pendingTranslationRef.current.get(requestId);
        cacheTranslation(pending?.text || source, finalText);
        if (pending?.highlightId) {
          setHighlights((prev) =>
            prev.map((item) =>
              item.id === pending.highlightId ? { ...item, translation: finalText } : item
            )
          );
        }
        if (translateRequestRef.current === requestId) {
          setTranslationResult(finalText);
        }
      } catch (error) {
        if (translateRequestRef.current === requestId) {
          setTranslationResult('翻译失败');
        }
      } finally {
        pendingTranslationRef.current.delete(requestId);
        if (translateRequestRef.current === requestId) {
          setIsTranslating(false);
        }
      }
    };
    run();
  }, [selectionText, selectionRect, activeCenterView, activeHighlightId, highlights]);

  useEffect(() => {
    if (!isMindmapPanning) return;
    const handleMove = (event) => {
      const start = mindmapPanRef.current;
      if (!start) return;
      const nextX = start.offsetX + event.clientX - start.x;
      const nextY = start.offsetY + event.clientY - start.y;
      setMindmapOffset({ x: nextX, y: nextY });
    };
    const handleUp = () => {
      setIsMindmapPanning(false);
      mindmapPanRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isMindmapPanning]);

  useEffect(() => {
    if (activeCenterView !== 'mindmap') {
      setIsMindmapPanning(false);
      mindmapPanRef.current = null;
      return;
    }
    clearSelection();
  }, [activeCenterView]);

  useEffect(() => {
    clearSelection();
  }, [currentId]);

  useEffect(() => {
    const handleMouseUp = () => {
      if (draggingNoteId) return;
      cancelNoteDrag();
      dragNoteTriggeredRef.current = false;
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingNoteId]);

  useEffect(() => {
    if (!draggingNoteId) return undefined;
    if (dragNoteTimerRef.current) {
      window.clearTimeout(dragNoteTimerRef.current);
      dragNoteTimerRef.current = null;
    }
    const handleMove = (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const row = target?.closest?.('[data-outline-id]');
      const nextId = row?.dataset?.outlineId || null;
      if (dragOverOutlineIdRef.current !== nextId) {
        setDragOverOutlineId(nextId);
      }
      const mindmapNode = target?.closest?.('[data-mindmap-id]');
      let mindmapId = mindmapNode?.dataset?.mindmapId || null;
      let mindmapKind = mindmapNode?.dataset?.mindmapKind || null;
      if (mindmapKind === 'note') {
        mindmapId = null;
        mindmapKind = null;
      }
      if (dragOverMindmapRef.current.id !== mindmapId) {
        setDragOverMindmapId(mindmapId);
      }
      dragOverMindmapRef.current = { id: mindmapId, kind: mindmapKind };
      const dragInfo = dragNoteRef.current;
      if (dragInfo) {
        setDragGhost((prev) => ({
          ...(prev || {}),
          id: dragInfo.id,
          text: dragInfo.text || prev?.text || '',
          translation: dragInfo.translation || prev?.translation || '',
          color: dragInfo.color || prev?.color,
          isChapterTitle: dragInfo.isChapterTitle ?? prev?.isChapterTitle ?? false,
          width: dragInfo.width || prev?.width || 0,
          height: dragInfo.height || prev?.height || 0,
          lines: dragInfo.lines || prev?.lines || null,
          translationLines: dragInfo.translationLines || prev?.translationLines || null,
          translationGap: dragInfo.translationGap ?? prev?.translationGap ?? 0,
          fontSize: dragInfo.fontSize || prev?.fontSize || null,
          translationFontSize:
            dragInfo.translationFontSize || prev?.translationFontSize || null,
          lineHeight: dragInfo.lineHeight || prev?.lineHeight || null,
          kind: dragInfo.source || prev?.kind || 'outline',
          nodeKind: dragInfo.nodeKind || prev?.nodeKind || 'note',
          x: event.clientX - (dragInfo.offsetX || 0),
          y: event.clientY - (dragInfo.offsetY || 0)
        }));
      }
    };
    const handleUp = () => {
      const targetId = dragOverOutlineIdRef.current;
      const mindmapTarget = dragOverMindmapRef.current;
      const dragInfo = dragNoteRef.current;
      const resolvedTargetId =
        mindmapTarget?.id && mindmapTarget?.kind !== 'note'
          ? mindmapTarget.id
          : targetId;
      if (dragInfo && resolvedTargetId && resolvedTargetId !== dragInfo.chapterId) {
        const targetNode = flatOutlineRef.current.find(
          (node) => node.id === resolvedTargetId
        );
        if (targetNode) {
          setHighlights((prev) =>
            prev.map((item) =>
              item.id === dragInfo.id
                ? {
                    ...item,
                    chapterId: targetNode.id,
                    chapterTitle: targetNode.title
                  }
                : item
            )
          );
        }
      }
      setDraggingNoteId(null);
      setDragOverOutlineId(null);
      setDragOverMindmapId(null);
      setDragGhost(null);
      dragNoteTriggeredRef.current = false;
      dragOverMindmapRef.current = { id: null, kind: null };
      dragNoteRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [draggingNoteId]);

  useEffect(() => {
    if (!currentId || activeCenterView !== 'pdf') return;
    const saved = scrollTopByTabRef.current.get(currentId);
    if (saved == null) return;
    requestAnimationFrame(() => {
      if (viewerScrollRef.current) {
        viewerScrollRef.current.scrollTop = saved;
      }
    });
  }, [currentId, activeCenterView]);

  const analyzePdf = async (pdfData, options = {}) => {
    const existingQuestions = Array.isArray(options.existingQuestions)
      ? options.existingQuestions
      : [];
    const hasSavedQuestions = existingQuestions.length > 0;
    const loadingStatus =
      hasSavedQuestions
        ? '正在解析PDF...'
        : canUseOpenAI()
          ? 'AI正在通读全文，生成阅读问题...'
          : '正在解析PDF...';
    setIsAnalyzing(true);
    setStatus(loadingStatus);
    try {
      const { fullText, pages, pageIndexData: nextPageIndexData, outline: nextOutline } =
        await extractPdfText(pdfData);
      const nextSegments = segmentText(pages);
      const initialExpanded = collectOutlineIds(nextOutline, {});
      setPageIndexData(nextPageIndexData);
      setOutline(nextOutline);
      setFullText(fullText);
      setExpandedOutline(initialExpanded);
      setExpandedMindmap(initialExpanded);
      setSegments(nextSegments);
      let nextQuestions = [];
      if (hasSavedQuestions) {
        nextQuestions = existingQuestions.slice(0, MAX_QUESTIONS);
      } else if (canUseOpenAI()) {
        try {
          nextQuestions = await generateQuestionsWithOpenAI(fullText);
        } catch {
          nextQuestions = [];
        }
      }
      const normalizedQuestions = normalizeQuestions(nextQuestions).slice(0, MAX_QUESTIONS);
      setQuestions(normalizedQuestions);
      if (options.entryId) {
        updateHistoryQuestions(options.entryId, normalizedQuestions);
      }
      const cacheId = options.entryId || currentId || currentPdf?.id;
      if (cacheId) {
        analysisStateRef.current.set(cacheId, {
          outline: nextOutline,
          pageIndexData: nextPageIndexData,
          segments: nextSegments,
          fullText,
          questions: normalizedQuestions,
          expandedOutline: initialExpanded,
          expandedMindmap: initialExpanded,
          customChapters: customChaptersByTab[cacheId] || []
        });
      }
      setStatus('');
      return normalizedQuestions;
    } catch (error) {
      setSegments([]);
      setPageIndexData([]);
      setFullText('');
      setHighlights([]);
      setActiveHighlightId(null);
      setSelectionInfo(null);
      setOutline([]);
      setExpandedOutline({});
      if (!existingQuestions.length) {
        setQuestions([]);
      }
      setStatus('解析PDF失败，请确认文件可复制文本。');
      return [];
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setStatus('请上传PDF格式文件。');
      return;
    }
    setDragActive(false);
    setStatus('');
    setChatStatus('');
    setIsChatting(false);

    const buffer = await file.arrayBuffer();
    const source = new Uint8Array(buffer);
    const assignedFolderId =
      activeView !== VIEW_ALL && activeView !== VIEW_TRASH ? activeView : null;
    const entry = {
      id: makeId(),
      name: file.name,
      path: getPdfPath(file),
      addedAt: new Date().toISOString(),
      chat: [],
      questions: [],
      highlights: [],
      customChapters: [],
      folderId: assignedFolderId,
      trashedAt: null
    };
    const cachedHighlights = normalizeHighlights(
      getHighlightCache()[getHighlightKey(entry)] || []
    );
    if (cachedHighlights.length) {
      entry.highlights = cachedHighlights;
    }

    setHistory((prev) => [entry, ...prev]);
    setCenterViewForTab(entry.id, 'pdf');
    setRightPanelTabForTab(entry.id, 'questions');
    upsertOpenTab(entry);
    setCurrentPdf({ ...entry });
    applyEntryState(entry, entry.highlights || []);
    analysisCacheRef.current.set(entry.id, source);

    await analyzePdf(clonePdfData(source), { entryId: entry.id });
  };

  const handleHistorySelect = async (entry) => {
    if (!entry) return;
    if (currentId) {
      captureAnalysisState(currentId);
    }
    if (!centerViewByTab[entry.id]) {
      setCenterViewForTab(entry.id, 'pdf');
    }
    if (!rightPanelTabByTab[entry.id]) {
      setRightPanelTabForTab(entry.id, 'questions');
    }
    const cachedHighlights = getHighlightCache()[getHighlightKey(entry)] || [];
    const mergedHighlights = normalizeHighlights(
      (entry.highlights || []).length ? entry.highlights : cachedHighlights
    );
    if (!(entry.highlights || []).length && mergedHighlights.length) {
      updateHistoryHighlights(entry.id, mergedHighlights);
    }
    applyEntryState(entry, mergedHighlights);

    const cachedSource = getAnalysisSource(entry.id);
    if (cachedSource) {
      setCurrentPdf({ ...entry });
      if (applyCachedAnalysisState(entry.id)) {
        return;
      }
      const analysisData = clonePdfData(cachedSource);
      if (!analysisData) {
        setStatus('解析PDF失败，请重新上传该PDF。');
        return;
      }
      await analyzePdf(analysisData, {
        entryId: entry.id,
        existingQuestions: entry.questions
      });
      return;
    }

    if (!entry.path) {
      setCurrentPdf(null);
      setStatus('没有找到本地路径，请重新上传该PDF。');
      return;
    }

    if (!canUseElectron()) {
      setStatus('当前环境无法读取本地文件，请在Electron中运行。');
      return;
    }

    try {
      const raw = await window.electronAPI.readPdf(entry.path);
      const data = toUint8Array(raw);
      if (!data) throw new Error('Empty data');
      analysisCacheRef.current.set(entry.id, data);
      setCurrentPdf({ ...entry });
      upsertOpenTab(entry);
      await analyzePdf(clonePdfData(data), {
        entryId: entry.id,
        existingQuestions: entry.questions
      });
    } catch (error) {
      setCurrentPdf(null);
      setStatus('读取PDF失败，请确认文件仍在原路径。');
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (!isHomeView) return;
    const file = event.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    if (!isHomeView) {
      if (dragActive) setDragActive(false);
      return;
    }
    const hasFiles = event.dataTransfer?.types?.includes('Files');
    if (!hasFiles) return;
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setDragActive(false);
  };

  const handleSend = async () => {
    const content = draft.trim();
    if (!content || isChatting) return;
    if (!currentId) {
      setStatus('请先上传PDF。');
      return;
    }
    if (isAnalyzing) {
      setStatus('AI正在通读全文，请稍等片刻再提问。');
      return;
    }

    const userMessage = { id: makeId(), role: 'user', content, ts: Date.now() };
    const updated = [...messages, userMessage];
    setMessages(updated);
    updateHistoryChat(currentId, updated);
    setDraft('');
    setChatStatus('');
    setIsChatting(true);

    let reply = '';
    try {
      if (canUseOpenAI()) {
        reply = await answerWithOpenAI(content, segments, messages);
      } else {
        reply = buildAnswer(content, segments);
        setChatStatus('OpenAI未配置，已使用本地回答。');
      }
    } catch (error) {
      reply = buildAnswer(content, segments);
      const detail = error?.message ? `（${error.message}）` : '';
      setChatStatus(`OpenAI请求失败${detail}，已使用本地回答。`);
    } finally {
      setIsChatting(false);
    }

    if (!reply) {
      reply = buildAnswer(content, segments);
    }

    const assistantMessage = { id: makeId(), role: 'assistant', content: reply, ts: Date.now() };
    const finalMessages = [...updated, assistantMessage];
    setMessages(finalMessages);
    updateHistoryChat(currentId, finalMessages);
    setStatus('');
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const triggerUpload = () => {
    if (inputRef.current) inputRef.current.click();
  };

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.id === activeView) || null,
    [folders, activeView]
  );
  const folderChildrenMap = useMemo(() => {
    const map = new Map();
    folders.forEach((folder) => {
      const key = folder.parentId || null;
      const list = map.get(key) || [];
      list.push(folder);
      map.set(key, list);
    });
    return map;
  }, [folders]);
  const getFolderChildren = (parentId) => folderChildrenMap.get(parentId || null) || [];
  const flatFolders = useMemo(() => {
    const result = [];
    const walk = (parentId, depth) => {
      const children = getFolderChildren(parentId);
      children.forEach((folder) => {
        result.push({ ...folder, depth });
        walk(folder.id, depth + 1);
      });
    };
    walk(null, 0);
    return result;
  }, [folderChildrenMap]);
  const visibleFolders = useMemo(() => {
    if (activeView === VIEW_ALL) return getFolderChildren(null);
    if (activeView === VIEW_TRASH) return [];
    return getFolderChildren(activeView);
  }, [activeView, folderChildrenMap]);
  const activeEntries = useMemo(() => {
    if (activeView === VIEW_TRASH) {
      return history.filter((entry) => entry.trashedAt);
    }
    const filtered = history.filter((entry) => !entry.trashedAt);
    if (activeView === VIEW_ALL) {
      return filtered.filter((entry) => !entry.folderId);
    }
    return filtered.filter((entry) => entry.folderId === activeView);
  }, [history, activeView]);
  const folderNameMap = useMemo(() => {
    const map = new Map();
    folders.forEach((folder) => map.set(folder.id, folder.name));
    return map;
  }, [folders]);
  const activeCount = useMemo(
    () => history.filter((entry) => !entry.trashedAt && !entry.folderId).length,
    [history]
  );
  const trashCount = useMemo(
    () => history.filter((entry) => entry.trashedAt).length,
    [history]
  );
  const relatedRectsByPage = useMemo(() => {
    const map = new Map();
    relatedSegments.forEach((segment, idx) => {
      if (segment.pageIndex == null || !segment.rects?.length) return;
      const list = map.get(segment.pageIndex) || [];
      segment.rects.forEach((rect) => {
        if (!rect) return;
        list.push({ rect, isCurrent: idx === relatedIndex });
      });
      map.set(segment.pageIndex, list);
    });
    return map;
  }, [relatedSegments, relatedIndex]);
  const baseOutlineDisplayNodes = useMemo(() => {
    if (!currentPdf) return [];
    return [
      {
        id: outlineRootId,
        title: getPdfName(currentPdf),
        pageIndex: 0,
        top: 0,
        topRatio: 0,
        isRoot: true,
        items: outline
      }
    ];
  }, [currentPdf, outlineRootId, outline]);
  const baseFlatOutline = useMemo(
    () => flattenOutline(baseOutlineDisplayNodes),
    [baseOutlineDisplayNodes]
  );
  const baseFlatOutlineByPosition = useMemo(
    () => sortOutlineByPosition(baseFlatOutline),
    [baseFlatOutline]
  );
  const mergedOutline = useMemo(
    () =>
      mergeOutlineWithCustom(
        outline,
        customChapters,
        baseFlatOutlineByPosition,
        outlineRootId
      ),
    [outline, customChapters, baseFlatOutlineByPosition, outlineRootId]
  );
  const outlineDisplayNodes = useMemo(() => {
    if (!currentPdf) return [];
    return [
      {
        id: outlineRootId,
        title: getPdfName(currentPdf),
        pageIndex: 0,
        top: 0,
        topRatio: 0,
        isRoot: true,
        items: mergedOutline
      }
    ];
  }, [currentPdf, outlineRootId, mergedOutline]);
  const flatOutline = useMemo(
    () => flattenOutline(outlineDisplayNodes),
    [outlineDisplayNodes]
  );
  useEffect(() => {
    flatOutlineRef.current = flatOutline;
  }, [flatOutline]);
  const flatOutlineByPosition = useMemo(
    () => sortOutlineByPosition(flatOutline),
    [flatOutline]
  );
  const getHighlightSortKey = (highlight) => {
    if (!highlight) return { pageIndex: 0, top: 0 };
    const rects = highlight.rects || [];
    const topRatio = rects.length
      ? Math.min(...rects.map((rect) => rect.y ?? 0))
      : 0;
    const pageIndex =
      highlight.pageIndex != null
        ? highlight.pageIndex
        : rects[0]?.pageIndex ?? 0;
    return { pageIndex, top: topRatio };
  };
  const highlightsByChapter = useMemo(() => {
    const map = new Map();
    highlights.forEach((item) => {
      if (!item?.chapterId || item.isChapterTitle) return;
      const list = map.get(item.chapterId) || [];
      list.push(item);
      map.set(item.chapterId, list);
    });
    for (const list of map.values()) {
      list.sort((a, b) => {
        const aKey = getHighlightSortKey(a);
        const bKey = getHighlightSortKey(b);
        if (aKey.pageIndex !== bKey.pageIndex) return aKey.pageIndex - bKey.pageIndex;
        if (aKey.top !== bKey.top) return aKey.top - bKey.top;
        return 0;
      });
    }
    return map;
  }, [highlights]);
  const selectionRectsByPage = useMemo(() => {
    const map = new Map();
    selectionHighlights.forEach((rect) => {
      if (!rect || rect.pageIndex == null) return;
      const list = map.get(rect.pageIndex) || [];
      list.push(rect);
      map.set(rect.pageIndex, list);
    });
    return map;
  }, [selectionHighlights]);

  const highlightRectsByPage = useMemo(() => {
    const map = new Map();
    highlights.forEach((highlight) => {
      highlight.rects?.forEach((rect) => {
        if (!rect || rect.pageIndex == null) return;
        const list = map.get(rect.pageIndex) || [];
        list.push({
          rect,
          color: highlight.color,
          isActive: highlight.id === activeHighlightId
        });
        map.set(rect.pageIndex, list);
      });
    });
    return map;
  }, [highlights, activeHighlightId]);

  const highlightsByQuestion = useMemo(() => {
    const map = new Map();
    highlights.forEach((item) => {
      if (!item?.questionId) return;
      const list = map.get(item.questionId) || [];
      list.push(item);
      map.set(item.questionId, list);
    });
    for (const list of map.values()) {
      list.sort((a, b) => {
        const aKey = getHighlightSortKey(a);
        const bKey = getHighlightSortKey(b);
        if (aKey.pageIndex !== bKey.pageIndex) return aKey.pageIndex - bKey.pageIndex;
        if (aKey.top !== bKey.top) return aKey.top - bKey.top;
        return 0;
      });
    }
    return map;
  }, [highlights]);

  const articleInfo = useMemo(() => {
    const meta = currentPdf?.meta || {};
    return [
      { label: '文章标题', value: getPdfName(currentPdf) },
      {
        label: '发布时间',
        value: meta.publishedAt ? formatDate(meta.publishedAt) : '未知'
      },
      { label: '第一作者', value: meta.firstAuthor || '未知' },
      { label: '通讯作者', value: meta.correspondingAuthor || '未知' }
    ];
  }, [currentPdf]);
  const activeHighlightColor = useMemo(() => {
    const match = highlights.find((item) => item.id === activeHighlightId);
    return match?.color || null;
  }, [highlights, activeHighlightId]);

  const mindmapResult = useMemo(() => {
    let stage = 'init';
    try {
      if (activeCenterView !== 'mindmap') return { layout: null, error: '', detail: '' };
      if (!currentPdf || !mergedOutline.length)
        return { layout: null, error: '', detail: '' };
      if (typeof document === 'undefined' || !document.body) {
        return { layout: null, error: '', detail: '' };
      }
      stage = 'measure-init';
      if (!mindmapMeasureRef.current) {
        const canvas = document.createElement('canvas');
        mindmapMeasureRef.current = canvas.getContext('2d');
      }
      const ctx = mindmapMeasureRef.current;

      stage = 'metrics';
        const getMetrics = (node) => {
          const text = node.text || '';
          const translation = node.translation || '';
          const kind = node.kind;
          const isNote = kind === 'note';
          const isRoot = kind === 'root';
          const isNoteExpanded =
            isNote && node.note?.id ? expandedHighlightIds.has(node.note.id) : false;
        const baseFontSize = parseFloat(getComputedStyle(document.body)?.fontSize);
        const noteFontSize = Number.isFinite(baseFontSize)
          ? baseFontSize * MINDMAP_NOTE_TEXT_REM
          : MINDMAP_NOTE_FONT_SIZE;
        const translationFontSize = Number.isFinite(baseFontSize)
          ? baseFontSize * MINDMAP_NOTE_TRANSLATION_REM
          : MINDMAP_NOTE_FONT_SIZE * (MINDMAP_NOTE_TRANSLATION_REM / MINDMAP_NOTE_TEXT_REM);
        const fontSize = isNote
          ? noteFontSize
          : isRoot
            ? MINDMAP_ROOT_FONT_SIZE
            : MINDMAP_FONT_SIZE;
        const resolvedTranslationFontSize = isNote ? translationFontSize : fontSize;
        const lineHeight = isNote ? MINDMAP_NOTE_LINE_HEIGHT : MINDMAP_LINE_HEIGHT;
        const maxWidth = isNote ? MINDMAP_NOTE_MAX_WIDTH : MINDMAP_MAX_WIDTH;
        const paddingX = isNote ? MINDMAP_NOTE_PADDING_X : MINDMAP_PADDING_X;
        const paddingY = isNote ? MINDMAP_NOTE_PADDING_Y : MINDMAP_PADDING_Y;
        const fontWeight = isRoot ? '600' : '500';
        const fontFamily =
          getComputedStyle(document.body)?.fontFamily || 'sans-serif';
        if (ctx) {
          ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        }
        let lines = wrapTextLines(text, maxWidth - paddingX * 2, ctx);
        let translationLines = [];
        if (translation) {
          if (ctx) {
            ctx.font = `${fontWeight} ${resolvedTranslationFontSize}px ${fontFamily}`;
          }
          translationLines = wrapTextLines(translation, maxWidth - paddingX * 2, ctx);
        }
        if (isNote && !isNoteExpanded) {
          lines = clampTextLines(lines, MINDMAP_NOTE_MAX_LINES);
          translationLines = clampTextLines(
            translationLines,
            MINDMAP_NOTE_TRANSLATION_MAX_LINES
          );
        }
        const lineWidths = [];
        if (lines.length) {
          if (ctx) {
            ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
          }
          lines.forEach((line) => {
            lineWidths.push(ctx ? ctx.measureText(line).width : line.length * fontSize * 0.6);
          });
        }
        if (translationLines.length) {
          if (ctx) {
            ctx.font = `${fontWeight} ${resolvedTranslationFontSize}px ${fontFamily}`;
          }
          translationLines.forEach((line) => {
            lineWidths.push(
              ctx
                ? ctx.measureText(line).width
                : line.length * resolvedTranslationFontSize * 0.6
            );
          });
        }
        const contentWidth = Math.min(
          maxWidth,
          Math.max(...lineWidths, fontSize * 0.8)
        );
        const width = Math.ceil(contentWidth + paddingX * 2);
        const translationHeight = translationLines.length
          ? translationLines.length * lineHeight + MINDMAP_NOTE_TRANSLATION_GAP
          : 0;
        const height = Math.ceil(
          lines.length * lineHeight + translationHeight + paddingY * 2
        );
        return {
          width,
          height,
          lines,
          translationLines,
          translationGap: translationLines.length ? MINDMAP_NOTE_TRANSLATION_GAP : 0,
          fontSize,
          translationFontSize: resolvedTranslationFontSize,
          lineHeight
        };
      };

      stage = 'build-tree';
      const buildTree = (nodes) =>
        nodes.map((node) => {
          const notes = highlightsByChapter.get(node.id) || [];
          const childNodes = node.items?.length ? buildTree(node.items) : [];
          const noteNodes = notes.map((note) => ({
            id: `note-${note.id}`,
            text: note.text,
            translation: note.isChapterTitle ? '' : note.translation || '',
            kind: 'note',
            note
          }));
          const children = [...childNodes, ...noteNodes];
          return {
            id: node.id,
            text: node.title,
            kind: 'chapter',
            pageIndex: node.pageIndex,
            top: node.top,
            topRatio: node.topRatio,
            children,
            collapsed: !isMindmapExpanded(node.id, true)
          };
        });

      const rootNotes = highlightsByChapter.get(outlineRootId) || [];
      const rootNoteNodes = rootNotes.map((note) => ({
        id: `note-${note.id}`,
        text: note.text,
        translation: note.isChapterTitle ? '' : note.translation || '',
        kind: 'note',
        note
      }));
      const chapterNodes = buildTree(mergedOutline);
      const getRootNoteOrder = (note, fallback) => {
        const rects = Array.isArray(note.rects) ? note.rects : [];
        const pageIndex =
          typeof note.pageIndex === 'number'
            ? note.pageIndex
            : rects[0]?.pageIndex;
        const ratio = rects.length
          ? Math.min(
              ...rects.map((rect) => {
                if (typeof rect.y === 'number') return rect.y;
                if (typeof rect.top === 'number') return rect.top > 1 ? 1 : rect.top;
                return 0;
              })
            )
          : 0;
        return {
          pageIndex: typeof pageIndex === 'number' ? pageIndex : Number.POSITIVE_INFINITY,
          ratio,
          index: fallback
        };
      };
      const getChapterOrder = (node, fallback) => ({
        pageIndex:
          typeof node.pageIndex === 'number' ? node.pageIndex : Number.POSITIVE_INFINITY,
        ratio: typeof node.topRatio === 'number' ? node.topRatio : 0,
        index: fallback
      });
      const rootChildren = [
        ...chapterNodes.map((node, index) => ({
          node,
          order: getChapterOrder(node, index)
        })),
        ...rootNoteNodes.map((node, index) => ({
          node,
          order: getRootNoteOrder(node.note || {}, chapterNodes.length + index)
        }))
      ]
        .sort((a, b) => {
          if (a.order.pageIndex !== b.order.pageIndex) {
            return a.order.pageIndex - b.order.pageIndex;
          }
          if (a.order.ratio !== b.order.ratio) {
            return a.order.ratio - b.order.ratio;
          }
          return a.order.index - b.order.index;
        })
        .map((item) => item.node);
      const root = {
        id: outlineRootId,
        text: getPdfName(currentPdf),
        kind: 'root',
        children: rootChildren,
        collapsed: !isMindmapExpanded(outlineRootId, true)
      };

      stage = 'apply-metrics';
      const applyMetrics = (node) => {
        const metrics = getMetrics(node);
        node.width = metrics.width;
        node.height = metrics.height;
        node.lines = metrics.lines;
        node.translationLines = metrics.translationLines;
        node.translationGap = metrics.translationGap;
        node.fontSize = metrics.fontSize;
        node.translationFontSize = metrics.translationFontSize;
        node.lineHeight = metrics.lineHeight;
        if (!node.children?.length || node.collapsed) return;
        node.children.forEach((child) => applyMetrics(child));
      };

      stage = 'calc-height';
      const calcHeight = (node) => {
        if (!node.children?.length || node.collapsed) {
          node.subtreeHeight = node.height;
          return node.subtreeHeight;
        }
        let total = 0;
        node.children.forEach((child, index) => {
          total += calcHeight(child);
          if (index < node.children.length - 1) total += MINDMAP_GAP_Y;
        });
        node.subtreeHeight = Math.max(node.height, total);
        return node.subtreeHeight;
      };

      stage = 'position-tree';
      const positionTree = (node, x, yTop) => {
        const subtreeHeight = node.subtreeHeight || node.height;
        node.x = x;
        node.y = yTop + (subtreeHeight - node.height) / 2;
        if (!node.children?.length || node.collapsed) return;
        let cursor = yTop;
        node.children.forEach((child) => {
          positionTree(child, x + node.width + MINDMAP_GAP_X, cursor);
          cursor += (child.subtreeHeight || child.height) + MINDMAP_GAP_Y;
        });
      };

      stage = 'layout';
      applyMetrics(root);
      calcHeight(root);
      positionTree(root, 0, 0);

      stage = 'collect';
      const nodes = [];
      const edges = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      const walk = (node) => {
        nodes.push(node);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
        if (!node.children?.length || node.collapsed) return;
        node.children.forEach((child) => {
          edges.push({ from: node, to: child });
          walk(child);
        });
      };

      walk(root);

      stage = 'finalize';
      const offset = {
        x: MINDMAP_MARGIN - minX,
        y: MINDMAP_MARGIN - minY
      };

      return {
        layout: {
          nodes,
          edges,
          offset,
          width: maxX - minX + MINDMAP_MARGIN * 2,
          height: maxY - minY + MINDMAP_MARGIN * 2
        },
        error: '',
        detail: ''
      };
    } catch (error) {
      const detail = `${stage}: ${error?.message || error}`;
      console.error('[AIPAPER] Mindmap layout failed', stage, error);
      return { layout: null, error: '思维导图渲染失败', detail };
    }
  }, [
    activeCenterView,
    currentPdf,
    mergedOutline,
    highlightsByChapter,
    expandedMindmap,
    outlineRootId,
    expandedHighlightIds
  ]);

  const mindmapDisplayOffset = useMemo(() => {
    const layout = mindmapResult.layout;
    const anchor = mindmapAnchorRef.current;
    if (!layout || !anchor) return mindmapOffset;
    const node = layout.nodes.find((item) => item.id === anchor.id);
    if (!node) return mindmapOffset;
    const scale = mindmapScale;
    return {
      x: anchor.x - (node.x + node.width / 2 + layout.offset.x) * scale,
      y: anchor.y - (node.y + node.height / 2 + layout.offset.y) * scale
    };
  }, [mindmapResult.layout, mindmapOffset, mindmapScale]);

  useEffect(() => {
    const layout = mindmapResult.layout;
    const anchor = mindmapAnchorRef.current;
    if (!layout || !anchor) return;
    mindmapAnchorRef.current = null;
    setMindmapOffset(mindmapDisplayOffset);
  }, [mindmapResult.layout]);

  useEffect(() => {
    if (!flatOutlineByPosition.length) return;
    const hasChapters = flatOutlineByPosition.some((node) => !node.isRoot);
    if (!hasChapters) return;
    const outlineIds = new Set(flatOutlineByPosition.map((node) => node.id));
    setHighlights((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (!item || item.pageIndex == null) return item;
        const needsChapter =
          !item.chapterId || !outlineIds.has(item.chapterId) || item.chapterId === outlineRootId;
        if (!needsChapter) return item;
        const rects = item.rects || [];
        const topRatio = rects.length
          ? Math.min(...rects.map((rect) => rect.y ?? 0))
          : 0;
        const chapter = findChapterForPosition(flatOutlineByPosition, item.pageIndex, topRatio);
        if (!chapter) return item;
        changed = true;
        return { ...item, chapterId: chapter.id, chapterTitle: chapter.title };
      });
      return changed ? next : prev;
    });
  }, [flatOutlineByPosition, outlineRootId]);

  const toolbarStyle = useMemo(() => {
    if (!selectionRect || typeof window === 'undefined') return null;
    const colorWidth = (HIGHLIGHT_COLORS.length + 2) * 26 + 46;
    const actionWidth = 130;
    const estimatedWidth = Math.max(colorWidth + actionWidth, 280);
    const maxLeft = window.innerWidth - estimatedWidth - 12;
    const left = Math.max(12, Math.min(selectionRect.left, maxLeft));
    const top = selectionRect.bottom + 8;
    return { top, left };
  }, [selectionRect, relatedSegments.length]);

  useEffect(() => {
    if (!questionPicker.open) {
      setQuestionPickerStyle(null);
      return;
    }
    if (typeof window === 'undefined') return;
    const pickerWidth = 220;
    const gap = 4;
    const updatePosition = () => {
      const target = relatedQuestionButtonRef.current || selectionToolbarRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      let left = rect.right + gap;
      if (left + pickerWidth > window.innerWidth - 12) {
        left = rect.left - pickerWidth - gap;
      }
      const top = rect.top;
      setQuestionPickerStyle({
        top: Math.max(12, top),
        left: Math.max(12, left),
        width: pickerWidth
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [questionPicker.open, selectionRect, selectionText]);

  const clearSelection = () => {
    setSelectionText('');
    setSelectionRect(null);
    setSelectionHighlights([]);
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setActiveHighlightId(null);
    setSelectionInfo(null);
    setAnchorSelectionText('');
    setAnchorSelectionInfo(null);
    resetTranslation();
    if (typeof window !== 'undefined') {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    }
  };

  const clearSelectionHighlightOnly = () => {
    setSelectionText('');
    setSelectionRect(null);
    setSelectionHighlights([]);
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setActiveHighlightId(null);
    setSelectionInfo(null);
    resetTranslation();
    if (typeof window !== 'undefined') {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
    }
  };

  const getViewerMetrics = () => {
    if (!viewerScrollRef.current) return null;
    const rect = viewerScrollRef.current.getBoundingClientRect();
    return {
      rect,
      scrollLeft: viewerScrollRef.current.scrollLeft,
      scrollTop: viewerScrollRef.current.scrollTop
    };
  };

  const getViewerPoint = (event) => {
    const metrics = getViewerMetrics();
    if (!metrics) return null;
    return {
      x: event.clientX - metrics.rect.left + metrics.scrollLeft,
      y: event.clientY - metrics.rect.top + metrics.scrollTop
    };
  };

  const isPointInHighlights = (event) => {
    if (!selectionHighlights.length) return false;
    const point = getViewerPoint(event);
    if (!point) return false;
    return selectionHighlights.some((rect) => {
      if (!rect || rect.pageIndex == null) return false;
    const page = getActivePageRefs()[rect.pageIndex];
      if (!page) return false;
      const pageWidth = page.offsetWidth || 1;
      const pageHeight = page.offsetHeight || 1;
      const left = page.offsetLeft + rect.x * pageWidth;
      const top = page.offsetTop + rect.y * pageHeight;
      const width = rect.w * pageWidth;
      const height = rect.h * pageHeight;
      return (
        point.x >= left &&
        point.x <= left + width &&
        point.y >= top &&
        point.y <= top + height
      );
    });
  };

  const isPointInRelatedHighlights = (event) => {
    const point = getViewerPoint(event);
    if (!point) return false;
    return relatedSegments.some((segment) => {
      if (!segment.rects?.length || segment.pageIndex == null) return false;
    const page = getActivePageRefs()[segment.pageIndex];
      if (!page) return false;
      const offsetTop = page.offsetTop;
      const offsetLeft = page.offsetLeft;
      return segment.rects.some((rect) => {
        const left = offsetLeft + rect.left * activeScale;
        const top = offsetTop + rect.top * activeScale;
        const width = rect.width * activeScale;
        const height = rect.height * activeScale;
        return (
          point.x >= left &&
          point.x <= left + width &&
          point.y >= top &&
          point.y <= top + height
        );
      });
    });
  };

  const handleViewerMouseDown = (event) => {
    const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
    const findHighlightAtPoint = () => {
      const point = getViewerPoint(event);
      if (!point) return null;
      for (const highlight of highlights) {
        const rects = highlight.rects || [];
        for (const rect of rects) {
          const page = getActivePageRefs()[rect.pageIndex];
          if (!page) continue;
          const pageWidth = page.offsetWidth || 1;
          const pageHeight = page.offsetHeight || 1;
          const isLegacy = rect.legacy || typeof rect.x !== 'number';
          const left = page.offsetLeft + (isLegacy ? rect.left * activeScale : rect.x * pageWidth);
          const top = page.offsetTop + (isLegacy ? rect.top * activeScale : rect.y * pageHeight);
          const width = isLegacy ? rect.width * activeScale : rect.w * pageWidth;
          const height = isLegacy ? rect.height * activeScale : rect.h * pageHeight;
          if (
            point.x >= left &&
            point.x <= left + width &&
            point.y >= top &&
            point.y <= top + height
          ) {
            return highlight;
          }
        }
      }
      return null;
    };

    const hitHighlight = findHighlightAtPoint();
    if (hitHighlight) {
      const rects = hitHighlight.rects || [];
      const container = viewerScrollRef.current;
      if (container && rects.length) {
        const viewerRects = rects
          .map((rect) => {
            const page = getActivePageRefs()[rect.pageIndex];
            if (!page) return null;
            const pageWidth = page.offsetWidth || 1;
            const pageHeight = page.offsetHeight || 1;
            const isLegacy = rect.legacy || typeof rect.x !== 'number';
            const left = page.offsetLeft + (isLegacy ? rect.left * activeScale : rect.x * pageWidth);
            const top = page.offsetTop + (isLegacy ? rect.top * activeScale : rect.y * pageHeight);
            const width = isLegacy ? rect.width * activeScale : rect.w * pageWidth;
            const height = isLegacy ? rect.height * activeScale : rect.h * pageHeight;
            return { left, top, width, height };
          })
          .filter(Boolean);
        if (viewerRects.length) {
            const left = Math.min(...viewerRects.map((rect) => rect.left));
            const top = Math.min(...viewerRects.map((rect) => rect.top));
            const right = Math.max(...viewerRects.map((rect) => rect.left + rect.width));
            const bottom = Math.max(...viewerRects.map((rect) => rect.top + rect.height));
            const containerRect = container.getBoundingClientRect();
            setSelectionRect({
              left: left - container.scrollLeft + containerRect.left,
              right: right - container.scrollLeft + containerRect.left,
              top: top - container.scrollTop + containerRect.top,
              bottom: bottom - container.scrollTop + containerRect.top
            });
            setSelectionHighlights([]);
          } else {
            setSelectionRect(null);
          }
        } else {
          setSelectionRect(null);
        }
    setSelectionText(hitHighlight.text || '');
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setActiveHighlightId(hitHighlight.id);
    const nextInfo = {
      pageIndex: hitHighlight.pageIndex ?? null,
      startOffset: hitHighlight.startOffset ?? null,
      endOffset: hitHighlight.endOffset ?? null,
      rects: hitHighlight.rects || [],
      text: hitHighlight.text || ''
    };
    setSelectionInfo(nextInfo);
    return;
  }

    if (!selectionRect && !selectionHighlights.length && !relatedSegments.length && !activeHighlight) {
      return;
    }
    if (isPointInHighlights(event)) return;
    if (isPointInRelatedHighlights(event)) return;
    clearSelectionHighlightOnly();
  };

  const closeCurrentPdf = () => {
    if (!currentId) return;
    updateHistoryHighlights(currentId, highlights);
    updateHistoryCustomChapters(currentId, customChapters);
    updateHistoryRelatedHistory(currentId, relatedHistoryByTab[currentId] || []);
    const cacheKey = getHighlightKey(currentPdf);
    if (cacheKey) {
      upsertHighlightCache(cacheKey, highlights);
    }
    setOpenTabs((prev) => {
      const nextTabs = prev.filter((tab) => tab.id !== currentId);
      pageRefsMap.current.delete(currentId);
      analysisCacheRef.current.delete(currentId);
      const pdfEntry = pdfUrlMapRef.current.get(currentId);
      if (pdfEntry?.url) URL.revokeObjectURL(pdfEntry.url);
      pdfUrlMapRef.current.delete(currentId);
      analysisStateRef.current.delete(currentId);
      scrollTopByTabRef.current.delete(currentId);
      setCenterViewByTab((prevView) => {
        const nextView = { ...prevView };
        delete nextView[currentId];
        return nextView;
      });
      setRightPanelTabByTab((prevTabs) => {
        const nextTabs = { ...prevTabs };
        delete nextTabs[currentId];
        return nextTabs;
      });
      setRelatedHistoryViewByTab((prevViews) => {
        const nextViews = { ...prevViews };
        delete nextViews[currentId];
        return nextViews;
      });
      setRelatedHistoryByTab((prevHistory) => {
        const nextHistory = { ...prevHistory };
        delete nextHistory[currentId];
        return nextHistory;
      });
      setCustomChaptersByTab((prevCustom) => {
        const nextCustom = { ...prevCustom };
        delete nextCustom[currentId];
        return nextCustom;
      });
      setScaleByTab((prevScale) => {
        const nextScale = { ...prevScale };
        delete nextScale[currentId];
        return nextScale;
      });
      setAutoScaleByTab((prevAuto) => {
        const nextAuto = { ...prevAuto };
        delete nextAuto[currentId];
        return nextAuto;
      });
      setNumPagesByTab((tabs) => {
        const next = { ...tabs };
        delete next[currentId];
        return next;
      });
      if (!nextTabs.length) {
        goHome();
      } else {
        const fallback = nextTabs[nextTabs.length - 1];
        handleTabSelect(fallback.id);
      }
      return nextTabs;
    });
  };

  const closeTabById = (tabId) => {
    if (!tabId) return;
    if (tabId === currentId) {
      closeCurrentPdf();
      return;
    }
    updateHistoryCustomChapters(tabId, customChaptersByTab[tabId] || []);
    updateHistoryRelatedHistory(tabId, relatedHistoryByTab[tabId] || []);
    pageRefsMap.current.delete(tabId);
    analysisCacheRef.current.delete(tabId);
    const pdfEntry = pdfUrlMapRef.current.get(tabId);
    if (pdfEntry?.url) URL.revokeObjectURL(pdfEntry.url);
    pdfUrlMapRef.current.delete(tabId);
    analysisStateRef.current.delete(tabId);
    scrollTopByTabRef.current.delete(tabId);
    setCenterViewByTab((prevView) => {
      const nextView = { ...prevView };
      delete nextView[tabId];
      return nextView;
    });
    setRightPanelTabByTab((prevTabs) => {
      const nextTabs = { ...prevTabs };
      delete nextTabs[tabId];
      return nextTabs;
    });
    setRelatedHistoryViewByTab((prevViews) => {
      const nextViews = { ...prevViews };
      delete nextViews[tabId];
      return nextViews;
    });
    setRelatedHistoryByTab((prevHistory) => {
      const nextHistory = { ...prevHistory };
      delete nextHistory[tabId];
      return nextHistory;
    });
    setCustomChaptersByTab((prevCustom) => {
      const nextCustom = { ...prevCustom };
      delete nextCustom[tabId];
      return nextCustom;
    });
    setScaleByTab((prevScale) => {
      const nextScale = { ...prevScale };
      delete nextScale[tabId];
      return nextScale;
    });
    setAutoScaleByTab((prevAuto) => {
      const nextAuto = { ...prevAuto };
      delete nextAuto[tabId];
      return nextAuto;
    });
    setNumPagesByTab((tabs) => {
      const next = { ...tabs };
      delete next[tabId];
      return next;
    });
    setOpenTabs((prev) => prev.filter((tab) => tab.id !== tabId));
  };

  const buildHighlightFromSelectionData = (
    color,
    info,
    text,
    chapterOverride = null
  ) => {
    if (!info || !text) return null;
    const rects = (info.rects || [])
      .filter((rect) => rect.pageIndex != null && rect.pageIndex >= 0)
      .map((rect) => ({
        pageIndex: rect.pageIndex,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h
      }));
    if (!rects.length) return null;
    const topRatio = Math.min(...rects.map((rect) => rect.y ?? 0));
    const chapter =
      chapterOverride ||
      findChapterForPosition(flatOutlineByPosition, info.pageIndex, topRatio);
    return {
      id: makeId(),
      text,
      pageIndex: info.pageIndex,
      startOffset: info.startOffset,
      endOffset: info.endOffset,
      color,
      rects,
      chapterId: chapter?.id || null,
      chapterTitle: chapter?.title || null,
      createdAt: Date.now()
    };
  };

  const buildHighlightFromSelection = (color, chapterOverride = null) =>
    buildHighlightFromSelectionData(color, selectionInfo, selectionText, chapterOverride);

  const buildCustomChapterFromSelection = () => {
    if (!selectionInfo || !selectionText) return null;
    const title = selectionText.trim();
    if (!title) return null;
    const rects = (selectionInfo.rects || []).filter(
      (rect) => rect.pageIndex != null && rect.pageIndex >= 0
    );
    if (!rects.length || selectionInfo.pageIndex == null) return null;
    const topRatio = Math.min(...rects.map((rect) => rect.y ?? 0));
    const pageIndex = selectionInfo.pageIndex;
    const page = getActivePageRefs()[pageIndex];
    const baseHeight =
      page && activeScale ? page.offsetHeight / activeScale : null;
    const top = baseHeight ? topRatio * baseHeight : null;
    return {
      id: `custom-${makeId()}`,
      title,
      pageIndex,
      top,
      topRatio,
      items: [],
      createdAt: Date.now()
    };
  };

  const createChapterFromSelection = () => {
    if (!currentId) return;
    if (activeHighlightId) {
      const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
      if (activeHighlight?.isChapterTitle) {
        setSelectionHighlights([]);
        return;
      }
    }
    const nextChapter = buildCustomChapterFromSelection();
    if (!nextChapter) return;
    const parentChapter = findChapterForPosition(
      baseFlatOutlineByPosition,
      nextChapter.pageIndex,
      nextChapter.topRatio ?? 0
    );
    const parentId =
      parentChapter && !parentChapter.isRoot ? parentChapter.id : null;
    nextChapter.parentId = parentId;
    const defaultColor = HIGHLIGHT_COLORS[0]?.fill || 'rgba(250, 204, 21, 0.45)';
    const nextHighlight = activeHighlightId
      ? null
      : buildHighlightFromSelection(defaultColor, parentChapter || null);
    const currentChapters = customChaptersByTab[currentId] || [];
    const nextChapters = [...currentChapters, nextChapter];
    setCustomChaptersByTab((prev) => ({ ...prev, [currentId]: nextChapters }));
    updateHistoryCustomChapters(currentId, nextChapters);
    setExpandedOutline((prev) => ({ ...prev, [nextChapter.id]: true }));
    setExpandedMindmap((prev) => ({ ...prev, [nextChapter.id]: true }));
    if (activeHighlightId) {
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === activeHighlightId
            ? {
                ...item,
                text: selectionText,
                color: defaultColor,
                chapterId: parentChapter?.id || null,
                chapterTitle: parentChapter?.title || null,
                isChapterTitle: true,
                chapterNodeId: nextChapter.id
              }
            : item
        )
      );
      setSelectionHighlights([]);
      return;
    }
    if (!nextHighlight) return;
    const preparedHighlight = attachTranslationToDraft({
      ...nextHighlight,
      isChapterTitle: true,
      chapterNodeId: nextChapter.id
    });
    setHighlights((prev) => [...prev, preparedHighlight]);
    setActiveHighlightId(preparedHighlight.id);
    setSelectionHighlights([]);
  };

  const applyHighlightColor = (color) => {
    if (activeHighlightId) {
      setHighlights((prev) =>
        prev.map((item) => (item.id === activeHighlightId ? { ...item, color } : item))
      );
      return;
    }
    const nextHighlight = buildHighlightFromSelection(color);
    if (!nextHighlight) return;
    const preparedHighlight = attachTranslationToDraft(nextHighlight);
    setHighlights((prev) => [...prev, preparedHighlight]);
    setActiveHighlightId(preparedHighlight.id);
    setSelectionHighlights([]);
  };

  const removeActiveHighlight = () => {
    if (!activeHighlightId) {
      clearSelection();
      return;
    }
    const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
    if (!activeHighlight) {
      clearSelection();
      return;
    }

    const findParentNode = (nodes, targetId, parent = null) => {
      for (const node of nodes || []) {
        if (node.id === targetId) return parent;
        if (node.items?.length) {
          const found = findParentNode(node.items, targetId, node);
          if (found) return found;
        }
      }
      return null;
    };

    const currentChapters = customChaptersByTab[currentId] || [];
    const chapterNodeId =
      activeHighlight.chapterNodeId ||
      (activeHighlight.isChapterTitle
        ? currentChapters.find((chapter) => chapter.title === activeHighlight.text)?.id
        : null);
    const chapterMatch = chapterNodeId
      ? currentChapters.find((chapter) => chapter.id === chapterNodeId)
      : null;
    const isChapterHighlight = Boolean(activeHighlight.isChapterTitle && chapterMatch);

    if (!isChapterHighlight) {
      setHighlights((prev) => prev.filter((item) => item.id !== activeHighlightId));
      clearSelection();
      return;
    }

    const parentNode = findParentNode(outlineDisplayNodes, chapterMatch.id, null);
    const resolvedParent = parentNode || outlineDisplayNodes[0] || null;
    const parentId = resolvedParent?.id || outlineRootId;
    const parentTitle = resolvedParent?.title || (currentPdf ? getPdfName(currentPdf) : '');

    const nextChapters = currentChapters.filter((chapter) => chapter.id !== chapterMatch.id);
    setCustomChaptersByTab((prev) => ({ ...prev, [currentId]: nextChapters }));
    updateHistoryCustomChapters(currentId, nextChapters);
    setExpandedOutline((prev) => {
      const next = { ...prev };
      delete next[chapterMatch.id];
      return next;
    });
    setExpandedMindmap((prev) => {
      const next = { ...prev };
      delete next[chapterMatch.id];
      return next;
    });

    setHighlights((prev) =>
      prev
        .filter((item) => item.id !== activeHighlightId)
        .map((item) =>
          item.chapterId === chapterMatch.id
            ? { ...item, chapterId: parentId, chapterTitle: parentTitle }
            : item
        )
    );
    clearSelection();
  };

  const handleMindmapMouseDown = (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target && typeof target.closest === 'function') {
      if (target.closest('[data-mindmap-node="true"]')) return;
    }
    event.preventDefault();
    mindmapPanRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: mindmapOffset.x,
      offsetY: mindmapOffset.y
    };
    setIsMindmapPanning(true);
  };

  const startResize = (event) => {
    event.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    resizeStartRef.current = { x: event.clientX, width: leftWidth };
    setIsResizing(true);
  };

  const jumpToPage = (pageIndex, top, topRatio) => {
    if (pageIndex == null) return;
    const target = getActivePageRefs()[pageIndex];
    if (!viewerScrollRef.current || !target) return;
    const pageHeight = target.offsetHeight || 1;
    const offset =
      top != null
        ? top * activeScale
        : typeof topRatio === 'number'
          ? topRatio * pageHeight
          : 0;
    viewerScrollRef.current.scrollTo({
      top: Math.max(0, target.offsetTop + offset - 16),
      behavior: 'smooth'
    });
  };

  const jumpToHighlight = (highlight) => {
    if (!highlight) return;
    const rects = Array.isArray(highlight.rects) ? highlight.rects : [];
    const pageIndex =
      highlight.pageIndex != null ? highlight.pageIndex : rects[0]?.pageIndex ?? null;
    if (pageIndex == null) return;
    const target = getActivePageRefs()[pageIndex];
    if (!viewerScrollRef.current || !target) return;
    const pageHeight = target.offsetHeight || 1;
    const viewerHeight = viewerScrollRef.current.clientHeight || 1;
    const pageRects = rects.filter((rect) => rect?.pageIndex === pageIndex);
    const getRectTop = (rect) =>
      rect.legacy || typeof rect.x !== 'number' ? rect.top : rect.y;
    const topRect = pageRects.reduce((acc, rect) => {
      if (!rect) return acc;
      if (!acc) return rect;
      return getRectTop(rect) < getRectTop(acc) ? rect : acc;
    }, null);
    if (!topRect) return;
    const isLegacy = topRect.legacy || typeof topRect.x !== 'number';
    const topOffset = isLegacy ? topRect.top * activeScale : topRect.y * pageHeight;
    const bottomRect = pageRects.reduce((acc, rect) => {
      if (!rect) return acc;
      if (!acc) return rect;
      const currentBottom =
        (rect.legacy || typeof rect.x !== 'number' ? rect.top + rect.height : rect.y + rect.h) || 0;
      const accBottom =
        (acc.legacy || typeof acc.x !== 'number' ? acc.top + acc.height : acc.y + acc.h) || 0;
      return currentBottom > accBottom ? rect : acc;
    }, topRect);
    const bottomOffset = isLegacy
      ? (bottomRect.top + bottomRect.height) * activeScale
      : (bottomRect.y + bottomRect.h) * pageHeight;
    const centerOffset = (topOffset + bottomOffset) / 2;
    viewerScrollRef.current.scrollTo({
      top: Math.max(0, target.offsetTop + centerOffset - viewerHeight / 2),
      behavior: 'smooth'
    });
    setActiveHighlightId(highlight.id);
  };

  const startNoteDrag = (note, event, options = {}) => {
    if (!note || event.button !== 0) return;
    const target = event.currentTarget;
    const rect = target?.getBoundingClientRect?.();
    const offsetX = rect ? event.clientX - rect.left : 0;
    const offsetY = rect ? event.clientY - rect.top : 0;
    const source = options.source || 'outline';
    const nodeInfo = options.node || null;
    dragNoteTriggeredRef.current = false;
    dragNoteRef.current = {
      id: note.id,
      chapterId: note.chapterId || outlineRootId,
      text: note.text || '',
      translation: note.translation || '',
      color: note.color,
      isChapterTitle: note.isChapterTitle,
      offsetX,
      offsetY,
      width: nodeInfo?.width || rect?.width || 0,
      height: nodeInfo?.height || rect?.height || 0,
      lines: nodeInfo?.lines || null,
      translationLines: nodeInfo?.translationLines || null,
      translationGap: nodeInfo?.translationGap || 0,
      fontSize: nodeInfo?.fontSize || null,
      translationFontSize: nodeInfo?.translationFontSize || null,
      lineHeight: nodeInfo?.lineHeight || null,
      source,
      nodeKind: nodeInfo?.kind || 'note'
    };
    if (dragNoteTimerRef.current) {
      window.clearTimeout(dragNoteTimerRef.current);
    }
    dragNoteTimerRef.current = window.setTimeout(() => {
      dragNoteTriggeredRef.current = true;
      setDraggingNoteId(note.id);
      if (rect) {
        setDragGhost({
          id: note.id,
          x: rect.left,
          y: rect.top,
          width: nodeInfo?.width || rect.width,
          height: nodeInfo?.height || rect.height,
          text: note.text || '',
          translation: note.translation || '',
          color: note.color,
          isChapterTitle: note.isChapterTitle,
          lines: nodeInfo?.lines || null,
          translationLines: nodeInfo?.translationLines || null,
          translationGap: nodeInfo?.translationGap || 0,
          fontSize: nodeInfo?.fontSize || null,
          translationFontSize: nodeInfo?.translationFontSize || null,
          lineHeight: nodeInfo?.lineHeight || null,
          kind: source,
          nodeKind: nodeInfo?.kind || 'note'
        });
      }
    }, 240);
  };

  const cancelNoteDrag = () => {
    if (dragNoteTimerRef.current) {
      window.clearTimeout(dragNoteTimerRef.current);
      dragNoteTimerRef.current = null;
    }
    if (!draggingNoteId) {
      dragNoteRef.current = null;
    }
  };

  const toggleHighlightExpanded = (noteId) => {
    if (!noteId) return;
    setExpandedHighlightIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  };

  const handleNoteClick = (note, event) => {
    if (dragNoteTriggeredRef.current || draggingNoteId) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    toggleHighlightExpanded(note.id);
  };

  const handleNoteDoubleClick = (note, event) => {
    if (!note) return;
    event.preventDefault();
    event.stopPropagation();
    jumpToHighlight(note);
  };

  function isOutlineExpanded(id, defaultExpanded) {
    const value = expandedOutline[id];
    return value === undefined ? defaultExpanded : value;
  }

  function isMindmapExpanded(id, defaultExpanded) {
    const value = expandedMindmap[id];
    return value === undefined ? defaultExpanded : value;
  }

  const toggleOutlineNode = (id, defaultExpanded = false) => {
    setExpandedOutline((prev) => {
      const current = prev[id];
      const resolved = current === undefined ? defaultExpanded : current;
      return { ...prev, [id]: !resolved };
    });
  };

  const toggleMindmapNode = (id, defaultExpanded = false) => {
    setExpandedMindmap((prev) => {
      const current = prev[id];
      const resolved = current === undefined ? defaultExpanded : current;
      return { ...prev, [id]: !resolved };
    });
  };

  const toggleFolderExpand = (id) => {
    setExpandedFolders((prev) => ({ ...prev, [id]: prev[id] === false }));
  };

  const renderFolderNodes = (parentId = null, depth = 0) => {
    const nodes = getFolderChildren(parentId);
    return nodes.map((folder) => {
      const children = getFolderChildren(folder.id);
      const hasChildren = children.length > 0;
      const isExpanded = expandedFolders[folder.id] !== false;
      return (
        <div key={folder.id}>
          <div
            className={`folder-row${activeView === folder.id ? ' active' : ''}${
              dragOverFolderId === folder.id ? ' drop-target' : ''
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onDragOver={(event) => handleFolderDragOver(event, folder)}
            onDragLeave={(event) => handleFolderDragLeave(event, folder)}
            onDrop={(event) => handleFolderDrop(event, folder)}
          >
            {hasChildren ? (
              <button
                type="button"
                className="folder-toggle"
                onClick={() => toggleFolderExpand(folder.id)}
                aria-label={isExpanded ? '收起' : '展开'}
              >
                {isExpanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="folder-toggle-spacer" />
            )}
            <button
              type="button"
              className="folder-item"
              onClick={() => setActiveView(folder.id)}
              onContextMenu={(event) => openFolderContextMenu(event, folder)}
            >
              <span className="sidebar-icon icon-folder" aria-hidden="true" />
              {folder.name}
            </button>
          </div>
          {hasChildren && isExpanded ? (
            <div className="folder-children">{renderFolderNodes(folder.id, depth + 1)}</div>
          ) : null}
        </div>
      );
    });
  };

  const renderMindMap = (layout) => {
    if (!layout) return null;
    const anchorNode = (nodeId) => {
      const target = layout.nodes.find((item) => item.id === nodeId);
      if (!target) return;
      const scale = mindmapScale;
      const displayOffset = mindmapDisplayOffset;
      mindmapAnchorRef.current = {
        id: nodeId,
        x: (target.x + target.width / 2 + layout.offset.x) * scale + displayOffset.x,
        y: (target.y + target.height / 2 + layout.offset.y) * scale + displayOffset.y
      };
    };
    const handleNodeClick = (node) => {
      if (node.children?.length) {
        anchorNode(node.id);
        toggleMindmapNode(node.id, true);
        return;
      }
      if (node.pageIndex != null) {
        jumpToPage(node.pageIndex, node.top, node.topRatio);
      }
    };
    return (
      <svg className="mindmap-svg" width="100%" height="100%">
        <g
          transform={`translate(${layout.offset.x + mindmapDisplayOffset.x} ${
            layout.offset.y + mindmapDisplayOffset.y
          }) scale(${mindmapScale})`}
        >
          <g className="mindmap-edges">
            {layout.edges.map((edge) => {
              const startX = edge.from.x + edge.from.width;
              const startY = edge.from.y + edge.from.height / 2;
              const endX = edge.to.x;
              const endY = edge.to.y + edge.to.height / 2;
              const curve = Math.min(80, Math.max(40, (endX - startX) * 0.5));
              const c1x = startX + curve;
              const c1y = startY;
              const c2x = endX - curve;
              const c2y = endY;
              const path = `M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`;
              return <path key={`${edge.from.id}-${edge.to.id}`} className="mindmap-edge" d={path} />;
            })}
          </g>
          <g className="mindmap-nodes">
            {layout.nodes.map((node) => (
              <g
                key={node.id}
                className={`mindmap-node-group ${node.kind}${
                  node.kind === 'note' && node.note?.id === draggingNoteId ? ' dragging' : ''
                }${dragOverMindmapId === node.id ? ' drag-over' : ''}`}
                transform={`translate(${node.x}, ${node.y})`}
                data-mindmap-node="true"
                data-mindmap-id={node.id}
                data-mindmap-kind={node.kind}
                role="button"
                tabIndex={0}
                onMouseDown={
                  node.kind === 'note' && node.note
                    ? (event) =>
                        startNoteDrag(node.note, event, {
                          source: 'mindmap',
                          node
                        })
                    : undefined
                }
                onMouseUp={node.kind === 'note' ? cancelNoteDrag : undefined}
                onMouseLeave={node.kind === 'note' ? cancelNoteDrag : undefined}
                onClick={(event) => {
                  if (node.kind === 'note' && node.note) {
                    handleNoteClick(node.note, event);
                    return;
                  }
                  handleNodeClick(node);
                }}
                onDoubleClick={(event) => {
                  if (node.kind === 'note' && node.note) {
                    handleNoteDoubleClick(node.note, event);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (node.kind === 'note' && node.note) {
                      handleNoteClick(node.note, event);
                      return;
                    }
                    handleNodeClick(node);
                  }
                }}
                style={node.kind === 'note' && node.note ? { '--note-color': node.note.color } : null}
              >
                <rect
                  className="mindmap-node-rect"
                  width={node.width}
                  height={node.height}
                  rx={8}
                  ry={8}
                />
                <text
                  className="mindmap-node-text"
                  x={MINDMAP_PADDING_X}
                  y={MINDMAP_PADDING_Y}
                  dominantBaseline="hanging"
                  style={{ fontSize: node.fontSize }}
                >
                  {node.lines.map((line, index) => (
                    <tspan
                      key={`${node.id}-line-${index}`}
                      x={MINDMAP_PADDING_X}
                      dy={index === 0 ? 0 : node.lineHeight}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
                {node.translationLines?.length ? (
                  <text
                    className="mindmap-node-translation"
                    x={MINDMAP_PADDING_X}
                    y={
                      MINDMAP_PADDING_Y +
                      node.lines.length * node.lineHeight +
                      (node.translationGap || 0)
                    }
                    dominantBaseline="hanging"
                    style={{ fontSize: node.translationFontSize || node.fontSize }}
                  >
                    {node.translationLines.map((line, index) => (
                      <tspan
                        key={`${node.id}-translation-${index}`}
                        x={MINDMAP_PADDING_X}
                        dy={index === 0 ? 0 : node.lineHeight}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                ) : null}
              </g>
            ))}
          </g>
        </g>
      </svg>
    );
  };

  const renderOutlineNodes = (nodes, depth = 0, prefix = []) => {
    let seq = 0;
    return nodes.map((node) => {
      const notes = highlightsByChapter.get(node.id) || [];
      const hasChildren = Boolean(node.items?.length || notes.length);
      const isExpanded = isOutlineExpanded(node.id, node.isRoot ? true : false);
      const baseOffset = 3 + depth * 14;
      const titleOffset = baseOffset + 17;
      const isCustom = Boolean(node.isCustom);
      const isRoot = Boolean(node.isRoot);
      let numberLabel = null;
      let nextPrefix = prefix;
      if (!isCustom && !isRoot) {
        seq += 1;
        nextPrefix = [...prefix, seq];
        numberLabel = nextPrefix.join('.');
      }
      return (
        <div key={node.id} className="outline-node">
          <div
            className={`outline-row${dragOverOutlineId === node.id ? ' drag-over' : ''}`}
            style={{ paddingLeft: baseOffset }}
            data-outline-id={node.id}
          >
            {hasChildren ? (
              <button
                type="button"
                className="outline-toggle"
                onClick={() => toggleOutlineNode(node.id)}
                aria-label={isExpanded ? '收起章节' : '展开章节'}
              >
                {isExpanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="outline-spacer" />
            )}
            <button
              type="button"
              className="outline-title"
              onClick={() => jumpToPage(node.pageIndex, node.top, node.topRatio)}
              disabled={node.pageIndex == null}
            >
              {numberLabel ? `${numberLabel} ${node.title}` : node.title}
            </button>
          </div>
          {hasChildren && isExpanded ? (
            <div className="outline-children">
              {notes.length ? (
                <div className="outline-notes" style={{ paddingLeft: titleOffset }}>
                  {notes.map((note) => (
                    <button
                      key={note.id}
                      type="button"
                      className={`outline-note${draggingNoteId === note.id ? ' dragging' : ''}${
                        expandedHighlightIds.has(note.id) ? ' expanded' : ''
                      }`}
                      onMouseDown={(event) => startNoteDrag(note, event)}
                      onMouseUp={cancelNoteDrag}
                      onMouseLeave={cancelNoteDrag}
                      onClick={(event) => handleNoteClick(note, event)}
                      onDoubleClick={(event) => handleNoteDoubleClick(note, event)}
                      style={{ '--note-color': note.color }}
                    >
                      <span className="outline-note-text">{note.text}</span>
                      {note.translation && !note.isChapterTitle ? (
                        <span className="outline-note-translation">{note.translation}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {node.items?.length ? renderOutlineNodes(node.items, depth + 1, nextPrefix) : null}
            </div>
          ) : null}
        </div>
      );
    });
  };

  const renderMindMapContent = () => {
    if (!currentPdf) return <div className="empty-state">上传PDF后显示思维导图</div>;
    if (isAnalyzing && !mergedOutline.length)
      return <div className="empty-state">正在识别目录...</div>;
    if (!mergedOutline.length) return <div className="empty-state">未识别到章节结构</div>;
    if (mindmapResult.error) {
      return (
        <div className="empty-state">
          {mindmapResult.error}
          {mindmapResult.detail ? (
            <div className="panel-subtitle">{mindmapResult.detail}</div>
          ) : null}
        </div>
      );
    }
    if (!mindmapResult.layout) return <div className="empty-state">正在生成思维导图...</div>;
    return renderMindMap(mindmapResult.layout);
  };

  const getTextOffsetInLayer = (targetNode, targetOffset, layer) => {
    if (!layer || !targetNode) return null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node = walker.nextNode();
    while (node) {
      if (node === targetNode) {
        return offset + targetOffset;
      }
      offset += node.textContent?.length || 0;
      node = walker.nextNode();
    }
    return null;
  };

  const updateSelectionFromWindow = () => {
    if (typeof window === 'undefined') return;
    if (isPdfScrollingRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (
      !viewerScrollRef.current ||
      !anchor ||
      !viewerScrollRef.current.contains(anchor) ||
      (focus && !viewerScrollRef.current.contains(focus))
    ) {
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const text = removeLineBreaks(selection.toString()).trim();
    if (text.length < MIN_SELECTION_CHARS) {
      return;
    }

    const textLayer =
      range.startContainer?.parentElement?.closest?.('.react-pdf__Page__textContent') || null;
    const pageDiv = textLayer?.closest?.('.pdf-page') || null;
    const pageIndex = pageDiv ? getActivePageRefs().findIndex((node) => node === pageDiv) : -1;
    const pageRect = pageDiv?.getBoundingClientRect() || null;
    const relativeRects =
      pageRect && rects.length
        ? rects
            .filter((item) => item.width > 1 && item.height > 1)
            .map((item) => ({
              pageIndex: pageIndex >= 0 ? pageIndex : null,
              x: Math.max(0, Math.min(1, (item.left - pageRect.left) / pageRect.width)),
              y: Math.max(0, Math.min(1, (item.top - pageRect.top) / pageRect.height)),
              w: Math.max(0, Math.min(1, item.width / pageRect.width)),
              h: Math.max(0, Math.min(1, item.height / pageRect.height))
            }))
        : [];
    const startOffset =
      textLayer && range.startContainer
        ? getTextOffsetInLayer(range.startContainer, range.startOffset, textLayer)
        : null;
    const endOffset =
      textLayer && range.endContainer
        ? getTextOffsetInLayer(range.endContainer, range.endOffset, textLayer)
        : null;

    setSelectionText(text);
    setSelectionRect({
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    });
    if (pageIndex >= 0 && relativeRects.length) {
      setSelectionHighlights(relativeRects);
      setSelectionInfo({
        pageIndex,
        startOffset,
        endOffset,
        rects: relativeRects,
        text
      });
    } else {
      setSelectionHighlights([]);
      setSelectionInfo(null);
    }
    setRelatedSegments([]);
    setRelatedIndex(0);
    setIsFindingRelated(false);
    setActiveHighlightId(null);
    logToMain({ type: 'selection', text });
  };

  const handleFindRelated = async () => {
    const analysisText = selectionText?.trim();
    const analysisInfo = selectionInfo
      ? { ...selectionInfo, text: selectionInfo.text || analysisText || '' }
      : null;
    if (!analysisText || isFindingRelated) return;
    setAnchorSelectionText(analysisText);
    setAnchorSelectionInfo(analysisInfo);
    setIsFindingRelated(true);
    setRelatedIndex(0);
    if (currentId) {
      setRightPanelTabForTab(currentId, 'related');
      setRelatedHistoryViewForTab(currentId, 'history');
    }
    setRelatedLogicItems([]);
    setRelatedLogicStatus('');

    let matchedRelated = [];
    let logSegments = [];

    if (canUseOpenAILogic() && fullText) {
      try {
        const rects = Array.isArray(analysisInfo?.rects)
          ? analysisInfo.rects
          : [];
        const topRatio = rects.length
          ? Math.min(...rects.map((rect) => rect?.y ?? 0))
          : null;
        const pageNumber =
          Number.isFinite(analysisInfo?.pageIndex)
            ? analysisInfo.pageIndex + 1
            : null;
        const chapter = Number.isFinite(analysisInfo?.pageIndex)
          ? findChapterForPosition(flatOutlineByPosition, analysisInfo.pageIndex, topRatio ?? 0)
          : null;
        const sectionHint = chapter?.title || '';
        const analysisItems = await requestOpenAILogic({
          fullText,
          targetSentence: analysisText,
          pageNumber,
          sectionHint
        });
        if (!analysisItems.length) {
          setRelatedLogicStatus('未返回结构化结果');
        }
        setRelatedLogicItems(analysisItems);
        logToMain({
          type: 'related-logic',
          selection: analysisText,
          count: analysisItems.length,
          items: analysisItems
        });
        const evidenceSegments = analysisItems.map((item) => ({
          ...item,
          text: String(item?.evidence_text || '').trim()
        }));
        matchedRelated = matchRelatedSegmentsToPdf(
          evidenceSegments.filter((item) => item.text),
          pageIndexData
        );
        setRelatedLogicItems(matchedRelated);
        logSegments = matchedRelated.length ? matchedRelated : evidenceSegments;
      } catch {
        matchedRelated = [];
      }
    }

    if (!matchedRelated.length) {
      if (!segments.length) {
        setRelatedLogicStatus('未获取到相关段落');
        setIsFindingRelated(false);
        return;
      }
      const candidates = findRelatedSegmentsLocal(analysisText, segments);
      let nextRelated = candidates;
      if (canUseOpenAI()) {
        try {
          const refined = await refineRelatedSegmentsWithOpenAI(analysisText, candidates);
          if (refined.length) {
            nextRelated = refined;
          }
        } catch {
          nextRelated = candidates;
        }
      }
      const normalizedCandidates = nextRelated.map((item, index) => ({
        ...item,
        evidence_text: item.evidence_text || item.text || '',
        relation_type: item.relation_type || `相关片段${index + 1}`,
        dimension: item.dimension || 'dependency_down',
        confidence: item.confidence || 'inferred'
      }));
      matchedRelated = matchRelatedSegmentsToPdf(normalizedCandidates, pageIndexData);
      setRelatedLogicItems(matchedRelated);
      logSegments = matchedRelated.length ? matchedRelated : nextRelated;
      setRelatedLogicStatus('已使用本地匹配结果');
    }

    setRelatedSegments([]);
    setIsFindingRelated(false);

    if (currentId && (matchedRelated.length || relatedLogicStatus)) {
      setRelatedHistoryViewForTab(currentId, 'current');
    }

    if (currentId && analysisInfo?.text) {
      setRelatedHistoryByTab((prev) => {
        const list = prev[currentId] || [];
        const existingIndex = list.findIndex(
          (entry) => entry.selectionText === analysisInfo.text
        );
        const entry = {
          id: existingIndex >= 0 ? list[existingIndex].id : makeId(),
          selectionText: analysisInfo.text,
          selectionInfo: analysisInfo,
          items: matchedRelated,
          status: relatedLogicStatus || '',
          createdAt: new Date().toISOString()
        };
        if (existingIndex >= 0) {
          const next = list.slice();
          next.splice(existingIndex, 1);
          return { ...prev, [currentId]: [entry, ...next] };
        }
        return { ...prev, [currentId]: [entry, ...list] };
      });
    }

    logToMain({
      type: 'related',
      selection: analysisText,
      count: logSegments.length,
      pages: logSegments.map((segment) => segment.pageIndex)
    });
  };

  const focusSelectionInfo = (info) => {
    if (!info || info.pageIndex == null) return;
    const container = viewerScrollRef.current;
    const page = getActivePageRefs()[info.pageIndex];
    if (!container || !page) return;
    const rects = Array.isArray(info.rects) ? info.rects : [];

    if (currentId) {
      setCenterViewForTab(currentId, 'pdf');
    }

    if (!rects.length) {
      container.scrollTo({ top: Math.max(0, page.offsetTop - 16), behavior: 'smooth' });
      setSelectionText(info.text || '');
      setSelectionHighlights([]);
      setSelectionRect(null);
      setSelectionInfo(info);
      setActiveHighlightId(null);
      return;
    }

    const pageWidth = page.offsetWidth || 1;
    const pageHeight = page.offsetHeight || 1;
    const viewerRects = rects.map((rect) => {
      if (typeof rect.x === 'number') {
        return {
          left: page.offsetLeft + rect.x * pageWidth,
          top: page.offsetTop + rect.y * pageHeight,
          width: rect.w * pageWidth,
          height: rect.h * pageHeight
        };
      }
      return {
        left: page.offsetLeft + rect.left * activeScale,
        top: page.offsetTop + rect.top * activeScale,
        width: rect.width * activeScale,
        height: rect.height * activeScale
      };
    });
    const left = Math.min(...viewerRects.map((rect) => rect.left));
    const top = Math.min(...viewerRects.map((rect) => rect.top));
    const right = Math.max(...viewerRects.map((rect) => rect.left + rect.width));
    const bottom = Math.max(...viewerRects.map((rect) => rect.top + rect.height));
    setSelectionText(info.text || '');
    setSelectionHighlights(
      rects.map((rect) =>
        typeof rect.x === 'number'
          ? rect
          : {
              pageIndex: info.pageIndex,
              x: Math.max(0, Math.min(1, (rect.left * activeScale) / pageWidth)),
              y: Math.max(0, Math.min(1, (rect.top * activeScale) / pageHeight)),
              w: Math.max(0, Math.min(1, (rect.width * activeScale) / pageWidth)),
              h: Math.max(0, Math.min(1, (rect.height * activeScale) / pageHeight))
            }
      )
    );
    setSelectionInfo(info);
    setActiveHighlightId(null);

    const updateRect = () => {
      const containerRect = container.getBoundingClientRect();
      setSelectionRect({
        left: left - container.scrollLeft + containerRect.left,
        right: right - container.scrollLeft + containerRect.left,
        top: top - container.scrollTop + containerRect.top,
        bottom: bottom - container.scrollTop + containerRect.top
      });
    };
    setSelectionRect(null);
    const centerOffset = Math.max(0, (container.clientHeight - (bottom - top)) / 2);
    container.scrollTo({ top: Math.max(0, top - centerOffset), behavior: 'auto' });
    requestAnimationFrame(updateRect);
  };

  const focusRelatedItem = (item) => {
    if (!item) return;
    let targetItem = item;
    if (targetItem.pageIndex == null) {
      const fallbackText = targetItem.evidence_text || targetItem.text || '';
      const match = fallbackText ? matchSegmentAcrossPages(fallbackText, pageIndexData) : null;
      if (match && match.pageIndex != null) {
        targetItem = { ...targetItem, ...match };
      } else {
        return;
      }
    }
    const container = viewerScrollRef.current;
    const page = getActivePageRefs()[targetItem.pageIndex];
    if (!container || !page) return;
    const rects = Array.isArray(targetItem.rects) ? targetItem.rects : [];
    const text = targetItem.evidence_text || targetItem.text || '';

    if (currentId) {
      setCenterViewForTab(currentId, 'pdf');
    }

    if (!rects.length) {
      container.scrollTo({ top: Math.max(0, page.offsetTop - 16), behavior: 'smooth' });
      setSelectionText(text);
      setSelectionHighlights([]);
      setSelectionRect(null);
      setSelectionInfo({ pageIndex: targetItem.pageIndex, rects: [], text });
      setActiveHighlightId(null);
      return;
    }

    const pageWidth = page.offsetWidth || 1;
    const pageHeight = page.offsetHeight || 1;
    const viewerRects = rects.map((rect) => ({
      left: page.offsetLeft + rect.left * activeScale,
      top: page.offsetTop + rect.top * activeScale,
      width: rect.width * activeScale,
      height: rect.height * activeScale
    }));
    const relativeRects = rects.map((rect) => {
      const left = rect.left * activeScale;
      const top = rect.top * activeScale;
      const width = rect.width * activeScale;
      const height = rect.height * activeScale;
      return {
        pageIndex: targetItem.pageIndex,
        x: Math.max(0, Math.min(1, left / pageWidth)),
        y: Math.max(0, Math.min(1, top / pageHeight)),
        w: Math.max(0, Math.min(1, width / pageWidth)),
        h: Math.max(0, Math.min(1, height / pageHeight))
      };
    });

    const left = Math.min(...viewerRects.map((rect) => rect.left));
    const top = Math.min(...viewerRects.map((rect) => rect.top));
    const right = Math.max(...viewerRects.map((rect) => rect.left + rect.width));
    const bottom = Math.max(...viewerRects.map((rect) => rect.top + rect.height));
    setSelectionText(text);
    setSelectionHighlights(relativeRects);
    setSelectionInfo({ pageIndex: targetItem.pageIndex, rects: relativeRects, text });
    setActiveHighlightId(null);
    setRelatedIndex(0);
    setIsFindingRelated(false);

    const updateRect = () => {
      const containerRect = container.getBoundingClientRect();
      setSelectionRect({
        left: left - container.scrollLeft + containerRect.left,
        right: right - container.scrollLeft + containerRect.left,
        top: top - container.scrollTop + containerRect.top,
        bottom: bottom - container.scrollTop + containerRect.top
      });
    };
    setSelectionRect(null);
    const centerOffset = Math.max(0, (container.clientHeight - (bottom - top)) / 2);
    container.scrollTo({ top: Math.max(0, top - centerOffset), behavior: 'auto' });
    requestAnimationFrame(updateRect);
  };

  const openRelatedHistoryItem = (entry) => {
    if (!entry || !currentId) return;
    setAnchorSelectionText(entry.selectionText || '');
    setAnchorSelectionInfo(entry.selectionInfo || null);
    setRelatedLogicItems(Array.isArray(entry.items) ? entry.items : []);
    setRelatedLogicStatus(entry.status || '');
    setRelatedHistoryViewForTab(currentId, 'current');
  };

  const jumpRelated = (direction) => {
    if (!relatedSegments.length) return;
    const total = relatedSegments.length;
    const nextIndex = (relatedIndex + direction + total) % total;
    setRelatedIndex(nextIndex);
    const nextSegment = relatedSegments[nextIndex];
    logToMain({
      type: 'related-jump',
      index: nextIndex + 1,
      total,
      pageIndex: nextSegment?.pageIndex
    });
    if (!nextSegment) return;
    logToMain({
      type: 'related-match',
      index: nextIndex + 1,
      total,
      pageIndex: nextSegment.pageIndex,
      matchedText: nextSegment.matchedText || '',
      rects: nextSegment.rects?.length || 0
    });
    if (nextSegment.pageIndex == null) return;
    const target = getActivePageRefs()[nextSegment.pageIndex];
    if (!viewerScrollRef.current || !target) return;
    const rects = Array.isArray(nextSegment.rects) ? nextSegment.rects : [];
    const topRect = rects.reduce((acc, rect) => {
      if (!rect) return acc;
      if (!acc) return rect;
      return rect.top < acc.top ? rect : acc;
    }, null);
    const offset = target.offsetTop + (topRect ? topRect.top * activeScale : 0);
    viewerScrollRef.current.scrollTo({
      top: Math.max(0, offset - 16),
      behavior: 'smooth'
    });
  };

  const maybeFitToWidth = (page) => {
    const id = currentId || currentPdf?.id;
    if (!id || isAutoScaled(id)) return;
    if (!viewerScrollRef.current) return;
    const containerWidth = viewerScrollRef.current.clientWidth || 0;
    if (!containerWidth) return;
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(200, containerWidth - 40);
    const nextScale = clampScale(availableWidth / viewport.width);
    setScaleForTab(id, nextScale);
    markAutoScale(id);
  };

  const renderTextItem = (textItem) => textItem?.str || '';

  const handleViewerScroll = () => {
    if (currentId && viewerScrollRef.current) {
      scrollTopByTabRef.current.set(currentId, viewerScrollRef.current.scrollTop);
    }
    isPdfScrollingRef.current = true;
    if (scrollEndRef.current) {
      clearTimeout(scrollEndRef.current);
    }
    scrollEndRef.current = setTimeout(() => {
      isPdfScrollingRef.current = false;
      scrollEndRef.current = null;
    }, 160);
  };

  return (
    <div
      className="app"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={(event) => handleFile(event.target.files?.[0])}
      />

      <div className="app-tabs">
        <div className={`app-tab home${currentId ? '' : ' active'}`}>
          <button type="button" className="app-tab-button" onClick={goHome} title="主界面">
            <span className="app-tab-icon" aria-hidden="true">
              ⌂
            </span>
          </button>
        </div>
        <div className="app-tab-list" ref={tabListRef} onWheel={handleTabListWheel}>
          {openTabs.map((tab) => (
            <div
              key={tab.id}
              className={`app-tab${tab.id === currentId ? ' active' : ''}`}
            >
              <button
                type="button"
                className="app-tab-button"
                onClick={() => handleTabSelect(tab.id)}
                title={tab.name}
              >
                <span className="app-tab-title">{tab.name}</span>
              </button>
              <button
                type="button"
                className="app-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTabById(tab.id);
                }}
                aria-label={`关闭 ${tab.name}`}
                title="关闭"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="app-tab-actions">
          <button
            type="button"
            className="app-tab-settings"
            onClick={handleSettingsClick}
            aria-label="设置"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </div>

      <div className="app-content">
        <div className={`content-view manager-view${isHomeView ? '' : ' is-hidden'}`}>
          <div className="manager-shell">
              <aside className="manager-sidebar">
                <div className="manager-brand">
                  <div className="manager-logo">AIPAPER</div>
                </div>
                <div className="manager-section">
                  <button
                    type="button"
                    className={`sidebar-item${activeView === VIEW_ALL ? ' active' : ''}${
                      dragOverSidebar === VIEW_ALL ? ' drop-target' : ''
                    }`}
                    onClick={() => setActiveView(VIEW_ALL)}
                    onDragOver={(event) => handleSidebarDragOver(event, VIEW_ALL)}
                    onDragLeave={(event) => handleSidebarDragLeave(event, VIEW_ALL)}
                    onDrop={(event) => handleSidebarDrop(event, VIEW_ALL)}
                  >
                    <span className="sidebar-label">
                      <span className="sidebar-icon icon-doc" aria-hidden="true" />
                      所有文档
                    </span>
                    <span className="sidebar-count">{activeCount}</span>
                  </button>
                  <button
                    type="button"
                    className={`sidebar-item${activeView === VIEW_TRASH ? ' active' : ''}${
                      dragOverSidebar === VIEW_TRASH ? ' drop-target' : ''
                    }`}
                    onClick={() => setActiveView(VIEW_TRASH)}
                    onDragOver={(event) => handleSidebarDragOver(event, VIEW_TRASH)}
                    onDragLeave={(event) => handleSidebarDragLeave(event, VIEW_TRASH)}
                    onDrop={(event) => handleSidebarDrop(event, VIEW_TRASH)}
                  >
                    <span className="sidebar-label">
                      <span className="sidebar-icon icon-trash" aria-hidden="true" />
                      回收站
                    </span>
                    <span className="sidebar-count">{trashCount}</span>
                  </button>
                </div>
                <div className="manager-section">
                  <div className="section-header">
                    <span>文件夹</span>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => openCreateFolder(null, VIEW_ALL)}
                    >
                      +
                    </button>
                  </div>
                  <div className="folder-list">
                    {folders.length ? renderFolderNodes() : <div className="sidebar-empty">暂无文件夹</div>}
                  </div>
                </div>
              </aside>
              <main className="manager-main manager-panel" onContextMenu={openCanvasContextMenu}>
                <div className="manager-toolbar">
                  <div>
                    <div className="manager-title">
                      {activeView === VIEW_TRASH
                        ? '回收站'
                        : activeView === VIEW_ALL
                        ? '所有文档'
                        : activeFolder?.name || '文件夹'}
                    </div>
                    <div className="manager-subtitle">
                      {activeView === VIEW_TRASH
                        ? '可恢复或永久删除'
                        : activeView === VIEW_ALL
                        ? '浏览全部已导入PDF'
                        : '仅显示当前文件夹的文档'}
                    </div>
                  </div>
                  <div className="manager-actions">
                    {activeView === VIEW_TRASH ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={emptyTrash}
                        disabled={!trashCount}
                      >
                        清空回收站
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="manager-content">
                  {activeView === VIEW_TRASH ? (
                    <div className="file-list">
                      {activeEntries.length ? (
                        activeEntries.map((entry) => (
                          <div
                            key={entry.id}
                            className="file-row"
                            onContextMenu={(event) => openEntryContextMenu(event, entry)}
                          >
                            <button
                              type="button"
                              className="file-name"
                              onClick={() => handleHistorySelect(entry)}
                              disabled
                            >
                              {entry.name}
                            </button>
                            <div className="file-meta">
                              <span>{formatDate(entry.addedAt)}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="empty-state">回收站暂无文件</div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="file-list">
                        {visibleFolders.length ? (
                          visibleFolders.map((folder) => (
                            <div
                              key={folder.id}
                              className={`file-row${
                                dragOverFolderId === folder.id ? ' drop-target' : ''
                              }`}
                              onDragOver={(event) => handleFolderDragOver(event, folder)}
                              onDragLeave={(event) => handleFolderDragLeave(event, folder)}
                              onDrop={(event) => handleFolderDrop(event, folder)}
                              onContextMenu={(event) => openFolderContextMenu(event, folder)}
                            >
                              <span className="file-row-icon sidebar-icon icon-folder" aria-hidden="true" />
                              <button
                                type="button"
                                className="file-name"
                                onClick={() => setActiveView(folder.id)}
                              >
                                {folder.name}
                              </button>
                              <div className="file-meta">
                                <span>文件夹</span>
                              </div>
                            </div>
                          ))
                        ) : null}
                        {activeEntries.length
                          ? activeEntries.map((entry) => (
                              <div
                                key={entry.id}
                                className="file-row"
                                onContextMenu={(event) => openEntryContextMenu(event, entry)}
                                draggable
                                onDragStart={(event) => handleEntryDragStart(event, entry)}
                                onDragEnd={handleEntryDragEnd}
                              >
                                <span className="file-row-icon sidebar-icon icon-doc" aria-hidden="true" />
                                <button
                                  type="button"
                                  className="file-name"
                                  onClick={() => handleHistorySelect(entry)}
                                >
                                  {entry.name}
                                </button>
                                <div className="file-meta">
                                  <span>{formatDate(entry.addedAt)}</span>
                                  {activeView === VIEW_ALL && entry.folderId ? (
                                    <span className="file-folder">
                                      {folders.find((item) => item.id === entry.folderId)?.name ||
                                        '未归类'}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ))
                          : null}
                        {!activeEntries.length && !visibleFolders.length ? (
                          <div className="empty-state">暂无文档</div>
                        ) : null}
                      </div>
                      {status ? <div className="status-pill">{status}</div> : null}
                    </>
                  )}
                </div>
              </main>
          </div>
          {folderDialog.open ? (
            <div className="dialog-backdrop" onMouseDown={closeFolderDialog}>
              <div
                className="dialog-card"
                role="dialog"
                aria-modal="true"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="dialog-title">
                  {folderDialog.mode === 'create' ? '新建文件夹' : '重命名文件夹'}
                </div>
                <input
                  className="dialog-input"
                  value={folderDialog.name}
                  onChange={(event) =>
                    setFolderDialog((prev) => ({ ...prev, name: event.target.value }))
                  }
                  placeholder="输入文件夹名称"
                />
                {folderError ? <div className="dialog-error">{folderError}</div> : null}
                <div className="dialog-actions">
                  <button type="button" className="ghost-button" onClick={closeFolderDialog}>
                    取消
                  </button>
                  <button type="button" className="primary-button" onClick={submitFolderDialog}>
                    确定
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className={`content-view reader-view${isHomeView ? ' is-hidden' : ''}`}>
          <div
            className={`reader-shell${isResizing ? ' resizing' : ''}`}
            ref={shellRef}
            style={{ '--left-width': `${leftWidth}px` }}
          >
            <aside className="panel history-panel">
              <div className="panel-header">
                <div className="panel-title">文档目录</div>
                <div className="panel-subtitle">
                  {currentPdf ? getPdfName(currentPdf) : '上传PDF后生成章节结构'}
                </div>
              </div>
              <div className="outline-list">
                {!currentPdf ? (
                  <div className="empty-state">上传PDF后显示目录</div>
                ) : isAnalyzing && !mergedOutline.length ? (
                  <div className="empty-state">正在识别目录...</div>
                ) : outlineDisplayNodes.length ? (
                  renderOutlineNodes(outlineDisplayNodes)
                ) : (
                  <div className="empty-state">未识别到章节结构</div>
                )}
              </div>
            </aside>
            <div
              className="panel-resizer"
              onMouseDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左侧栏宽度"
            />

            <section className="panel viewer-panel">
              <div className="viewer-toolbar">
                <div className="viewer-mode-toggle" role="tablist" aria-label="中间栏视图">
                  <button
                    type="button"
                    className={`viewer-mode-button${activeCenterView === 'pdf' ? ' active' : ''}`}
                    onClick={() => setCenterViewForTab(currentId, 'pdf')}
                    role="tab"
                    aria-selected={activeCenterView === 'pdf'}
                  >
                    PDF
                  </button>
                  <button
                    type="button"
                    className={`viewer-mode-button${activeCenterView === 'mindmap' ? ' active' : ''}`}
                    onClick={() => setCenterViewForTab(currentId, 'mindmap')}
                    role="tab"
                    aria-selected={activeCenterView === 'mindmap'}
                  >
                    思维导图
                  </button>
                </div>
                {activeCenterView === 'pdf' ? (
                  <div className="viewer-zoom-controls">
                    <span className="zoom-pill">{Math.round(activeScale * 100)}%</span>
                    <button
                      className="circle-button"
                      type="button"
                      onClick={() =>
                        setScaleForTab(
                          currentId,
                          Math.max(MIN_SCALE, activeScale - 0.1)
                        )
                      }
                    >
                      −
                    </button>
                    <button
                      className="circle-button"
                      type="button"
                      onClick={() =>
                        setScaleForTab(
                          currentId,
                          Math.min(MAX_SCALE, activeScale + 0.1)
                        )
                      }
                    >
                      +
                    </button>
                  </div>
                ) : (
                  <div className="viewer-zoom-controls">
                    <span className="zoom-pill">{Math.round(mindmapScale * 100)}%</span>
                    <button
                      className="circle-button"
                      type="button"
                      onClick={() =>
                        setMindmapScale((prev) => clampMindmapScale(prev - 0.1))
                      }
                    >
                      −
                    </button>
                    <button
                      className="circle-button"
                      type="button"
                      onClick={() =>
                        setMindmapScale((prev) => clampMindmapScale(prev + 0.1))
                      }
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
                <div className="viewer-body">
                <div
                  className={`viewer-pane pdf-pane${activeCenterView === 'pdf' ? '' : ' is-hidden'}`}
                >
                  {openTabs.length ? (
                    openTabs.map((tab) => {
                      const isActive = tab.id === currentId;
                      const tabRefs = getPageRefsForId(tab.id);
                      const totalPages = numPagesByTab[tab.id] || 0;
                      const pdfUrl = ensurePdfUrl(tab.id);
                      const tabScale = getScaleForTab(tab.id);
                      return (
                        <div
                          key={tab.id}
                          className={`viewer-scroll${isActive ? ' active' : ''}`}
                          ref={(element) => {
                            if (isActive) viewerScrollRef.current = element;
                          }}
                          onMouseDown={isActive ? handleViewerMouseDown : undefined}
                          onMouseUp={isActive ? updateSelectionFromWindow : undefined}
                          onKeyUp={isActive ? updateSelectionFromWindow : undefined}
                          onScroll={isActive ? handleViewerScroll : undefined}
                        >
                          {pdfUrl ? (
                            <Document
                              file={pdfUrl}
                              onLoadSuccess={({ numPages: total }) =>
                                setNumPagesForTab(tab.id, total)
                              }
                              loading={<div className="empty-state">正在加载PDF...</div>}
                              error={<div className="empty-state">PDF加载失败</div>}
                            >
                              {Array.from(new Array(totalPages || 0)).map((_, index) => {
                                const pageRelated = isActive
                                  ? relatedRectsByPage.get(index) || []
                                  : [];
                                const pageMarks = isActive
                                  ? highlightRectsByPage.get(index) || []
                                  : [];
                                const pageSelection = isActive
                                  ? selectionRectsByPage.get(index) || []
                                  : [];
                                return (
                                  <div
                                    key={`page_${tab.id}_${index + 1}`}
                                    className="pdf-page"
                                    ref={(element) => {
                                      tabRefs[index] = element;
                                    }}
                                  >
                                    <Page
                                      pageNumber={index + 1}
                                      scale={tabScale}
                                      renderTextLayer={isActive}
                                      renderAnnotationLayer={false}
                                      onLoadSuccess={
                                        isActive && index === 0 ? maybeFitToWidth : undefined
                                      }
                                      customTextRenderer={(textItem) => renderTextItem(textItem)}
                                    />
                                    {pageSelection.length ? (
                                      <div className="selection-overlay">
                                        {pageSelection.map((rect, rectIndex) => (
                                          <div
                                            key={`sel-${index}-${rectIndex}`}
                                            className="selection-highlight"
                                            style={{
                                              top: `${rect.y * 100}%`,
                                              left: `${rect.x * 100}%`,
                                              width: `${rect.w * 100}%`,
                                              height: `${rect.h * 100}%`
                                            }}
                                          />
                                        ))}
                                      </div>
                                    ) : null}
                                    {pageMarks.length ? (
                                      <div className="mark-overlay">
                                        {pageMarks.map((item, rectIndex) => {
                                          const isLegacy =
                                            item.rect.legacy ||
                                            typeof item.rect.x !== 'number';
                                          const style = isLegacy
                                            ? {
                                                top: item.rect.top * tabScale,
                                                left: item.rect.left * tabScale,
                                                width: item.rect.width * tabScale,
                                                height: item.rect.height * tabScale
                                              }
                                            : {
                                                top: `${item.rect.y * 100}%`,
                                                left: `${item.rect.x * 100}%`,
                                                width: `${item.rect.w * 100}%`,
                                                height: `${item.rect.h * 100}%`
                                              };
                                          return (
                                            <div
                                              key={`mark-${index}-${rectIndex}`}
                                              className={`mark-highlight${
                                                item.isActive ? ' active' : ''
                                              }`}
                                              style={{
                                                ...style,
                                                background: item.color
                                              }}
                                            />
                                          );
                                        })}
                                      </div>
                                    ) : null}
                                    {pageRelated.length ? (
                                      <div className="related-overlay">
                                        {pageRelated.map((item, rectIndex) => (
                                          <div
                                            key={`related-${index}-${rectIndex}`}
                                            className={`related-highlight${
                                              item.isCurrent ? ' current' : ''
                                            }`}
                                            style={{
                                              top: item.rect.top * tabScale,
                                              left: item.rect.left * tabScale,
                                              width: item.rect.width * tabScale,
                                              height: item.rect.height * tabScale
                                            }}
                                          />
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </Document>
                          ) : (
                            <div className="empty-state">请从左侧选择PDF</div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state">请从左侧选择PDF</div>
                  )}
                </div>
                <div
                  className={`viewer-pane mindmap-pane${
                    activeCenterView === 'mindmap' ? '' : ' is-hidden'
                  }`}
                >
                  <div
                    className={`mindmap-canvas${isMindmapPanning ? ' panning' : ''}`}
                    onMouseDown={handleMindmapMouseDown}
                  >
                    {renderMindMapContent()}
                  </div>
                </div>
              </div>
            </section>

            <aside className="panel chat-panel">
              <div className="right-panel-tabs" role="tablist" aria-label="右侧栏功能">
                <button
                  type="button"
                  className={`right-panel-tab${
                    activeRightTab === 'questions' ? ' active' : ''
                  }`}
                  onClick={() => setRightPanelTabForTab(currentId, 'questions')}
                  role="tab"
                  aria-selected={activeRightTab === 'questions'}
                >
                  阅读问题
                </button>
                <button
                  type="button"
                  className={`right-panel-tab${
                    activeRightTab === 'related' ? ' active' : ''
                  }`}
                  onClick={() => setRightPanelTabForTab(currentId, 'related')}
                  role="tab"
                  aria-selected={activeRightTab === 'related'}
                >
                  文章信息
                </button>
                <button
                  type="button"
                  className={`right-panel-tab${activeRightTab === 'chat' ? ' active' : ''}`}
                  onClick={() => setRightPanelTabForTab(currentId, 'chat')}
                  role="tab"
                  aria-selected={activeRightTab === 'chat'}
                >
                  询问AI
                </button>
              </div>

              {activeRightTab === 'questions' ? (
                <div className="panel-section">
                  <div className="questions-title-row">
                    <div className="questions-title">阅读问题</div>
                    <button
                      type="button"
                      className="question-add-button"
                      onClick={handleAddQuestion}
                    >
                      新增
                    </button>
                  </div>
                  {isAnalyzing ? (
                    <div className="status-row">
                      <span className="spinner" />
                      {status || 'AI正在通读全文...'}
                    </div>
                  ) : questions.length ? (
                    <div className="questions-list">
                      {questions.map((question) => {
                        const relatedNotes = highlightsByQuestion.get(question.id) || [];
                        const hasRelated = relatedNotes.length > 0;
                        return (
                        <div
                          key={question.id}
                          className={`question-item${
                            editingQuestionId === question.id ? ' editing' : ''
                          }`}
                          onClick={() => {
                            if (editingQuestionId === question.id) return;
                            if (hasRelated) {
                              toggleQuestionExpand(question.id);
                            }
                          }}
                          onContextMenu={(event) => openQuestionMenu(event, question)}
                        >
                          {editingQuestionId === question.id ? (
                            <textarea
                              ref={questionInputRef}
                              className="question-input"
                              value={questionDraft}
                              placeholder="输入阅读问题，Enter保存"
                              onChange={(event) => setQuestionDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                  event.preventDefault();
                                  finalizeQuestionEdit(question.id);
                                }
                              }}
                              rows={2}
                            />
                          ) : (
                            <div className="question-content">
                              <span className="question-text">{question.text}</span>
                              {hasRelated ? (
                                <span className="question-badge">{relatedNotes.length}</span>
                              ) : null}
                            </div>
                          )}
                          {expandedQuestions[question.id] &&
                          hasRelated ? (
                            <div className="question-related-list">
                              {relatedNotes.map((note) => (
                                <button
                                  key={`question-note-${note.id}`}
                                  type="button"
                                  className={`outline-note${
                                    expandedHighlightIds.has(note.id) ? ' expanded' : ''
                                  }`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleNoteClick(note, event);
                                  }}
                                  onDoubleClick={(event) => {
                                    event.stopPropagation();
                                    handleNoteDoubleClick(note, event);
                                  }}
                                  style={{ '--note-color': note.color }}
                                >
                                  <span className="outline-note-text">{note.text}</span>
                                  {note.translation && !note.isChapterTitle ? (
                                    <span className="outline-note-translation">
                                      {note.translation}
                                    </span>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )})}
                    </div>
                  ) : status ? (
                    <div className="panel-subtitle">{status}</div>
                  ) : (
                    <div className="panel-subtitle">上传PDF后会生成问题</div>
                  )}
                </div>
              ) : null}

              {activeRightTab === 'related' ? (
                <div className="panel-section">
                  <div className="questions-title-row">
                    <div className="questions-title">文章信息</div>
                  </div>
                  <div className="info-list">
                    {articleInfo.map((item) => (
                      <div key={item.label} className="info-row">
                        <span className="info-label">{item.label}</span>
                        <span className="info-value">{item.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {activeRightTab === 'chat' ? (
                <>
                  <div className="chat-body">
                    {messages.length === 0 ? (
                      <div className="empty-state">从提问开始与AI对话</div>
                    ) : (
                      messages.map((message) => (
                        <div key={message.id} className={`message ${message.role}`}>
                          <div className="message-meta">
                            {message.role === 'user' ? '你' : 'AI'}
                          </div>
                          {message.content}
                        </div>
                      ))
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  <div className="chat-input">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={onKeyDown}
                      placeholder="提问：背景知识、逻辑、公式、实验结果..."
                    />
                    <div className="chat-actions">
                      <span className="chat-hint">
                        {isChatting ? 'AI正在回复...' : 'Enter发送，Shift+Enter换行'}
                      </span>
                      <button
                        className="primary-button"
                        type="button"
                        onClick={handleSend}
                        disabled={isChatting}
                      >
                        发送
                      </button>
                    </div>
                    {chatStatus ? <div className="chat-status">{chatStatus}</div> : null}
                  </div>
                </>
              ) : null}
            </aside>
          </div>
        </div>
      </div>

      {settingsOpen ? (
        <div className="dialog-backdrop" onMouseDown={closeSettingsDialog}>
          <div
            className="dialog-card settings-card"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-title">设置</div>
            <div className="settings-field">
              <label className="settings-label" htmlFor="settings-api-key">
                API Key
              </label>
              <input
                id="settings-api-key"
                className="dialog-input"
                type="password"
                value={settingsForm.apiKey}
                onChange={(event) =>
                  setSettingsForm((prev) => ({ ...prev, apiKey: event.target.value }))
                }
                placeholder="sk-..."
              />
            </div>
            <div className="settings-field">
              <label className="settings-label" htmlFor="settings-base-url">
                API Base URL
              </label>
              <input
                id="settings-base-url"
                className="dialog-input"
                value={settingsForm.baseUrl}
                onChange={(event) =>
                  setSettingsForm((prev) => ({ ...prev, baseUrl: event.target.value }))
                }
                placeholder="https://api.openai.com/v1"
              />
            </div>
            {settingsError ? <div className="dialog-error">{settingsError}</div> : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={closeSettingsDialog}
                disabled={settingsSaving}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={saveSettings}
                disabled={settingsSaving}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activeCenterView === 'pdf' && currentId && selectionRect && selectionText && toolbarStyle ? (
        <div
          className="selection-toolbar"
          style={toolbarStyle}
          ref={selectionToolbarRef}
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="toolbar-row">
            <div className="color-picker">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  className={`color-button${activeHighlightColor === color.fill ? ' active' : ''}`}
                  style={{ background: color.swatch }}
                  onClick={() => applyHighlightColor(color.fill)}
                  title="固定高亮"
                />
              ))}
              <button
                type="button"
                className="color-button node"
                onClick={createChapterFromSelection}
                title="设为章节节点"
              >
                节点
              </button>
              <button
                type="button"
                className="color-button remove"
                onClick={removeActiveHighlight}
                title="清除高亮"
                aria-label="清除高亮"
              />
            </div>
            <div className="toolbar-divider" />
            <button
              className="toolbar-button primary related"
              type="button"
              onClick={openQuestionPicker}
              ref={relatedQuestionButtonRef}
            >
              相关问题
            </button>
          </div>
          <div className="translation-box">
            {isTranslating && !translationResult ? '正在翻译...' : translationResult}
          </div>
        </div>
      ) : null}

      {questionPicker.open && toolbarStyle && questionPickerStyle ? (
        <div className="question-picker-float" style={questionPickerStyle}>
          <div className="question-picker-title">关联到阅读问题</div>
          {questions.length ? (
            <div className="question-picker-list">
              {questions.map((question) => (
                <button
                  key={`pick-${question.id}`}
                  type="button"
                  className="question-picker-item"
                  onClick={() => attachHighlightToQuestion(question)}
                >
                  {question.text}
                </button>
              ))}
            </div>
          ) : (
            <div className="panel-subtitle">暂无阅读问题</div>
          )}
        </div>
      ) : null}

      {dragGhost ? (
        dragGhost.kind === 'mindmap' ? (
          <div
            className={`mindmap-drag-ghost${dragGhost.nodeKind === 'note' ? ' note' : ''}`}
            style={{
              left: dragGhost.x,
              top: dragGhost.y,
              width: dragGhost.width || 240,
              height: dragGhost.height || 'auto',
              '--note-color': dragGhost.color,
              fontSize: dragGhost.fontSize ? `${dragGhost.fontSize}px` : undefined,
              lineHeight: dragGhost.lineHeight ? `${dragGhost.lineHeight}px` : undefined
            }}
          >
            <div className="mindmap-ghost-text">
              {(dragGhost.lines || [dragGhost.text]).map((line, index) => (
                <div key={`ghost-line-${index}`}>{line}</div>
              ))}
            </div>
            {dragGhost.translationLines?.length && !dragGhost.isChapterTitle ? (
              <div
                className="mindmap-ghost-translation"
                style={{
                  marginTop: dragGhost.translationGap || 0,
                  fontSize: dragGhost.translationFontSize
                    ? `${dragGhost.translationFontSize}px`
                    : undefined
                }}
              >
                {dragGhost.translationLines.map((line, index) => (
                  <div key={`ghost-translation-${index}`}>{line}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className="outline-note outline-drag-ghost"
            style={{
              left: dragGhost.x,
              top: dragGhost.y,
              width: dragGhost.width || 240,
              '--note-color': dragGhost.color
            }}
          >
            <span className="outline-note-text">{dragGhost.text}</span>
            {dragGhost.translation && !dragGhost.isChapterTitle ? (
              <span className="outline-note-translation">{dragGhost.translation}</span>
            ) : null}
          </div>
        )
      ) : null}

      {dragActive ? <div className="drop-overlay">松开即可导入PDF</div> : null}

      {contextMenu.open ? (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'folder' && contextMenu.folder ? (
            <>
              <button
                type="button"
                className="context-item"
                onClick={() => {
                  setActiveView(contextMenu.folder.id);
                  closeContextMenu();
                }}
              >
                打开
              </button>
              <button
                type="button"
                className="context-item"
                onClick={() => {
                  openCreateFolder(contextMenu.folder.id, activeView);
                  closeContextMenu();
                }}
              >
                新建子文件夹
              </button>
              <button
                type="button"
                className="context-item"
                onClick={() => {
                  openRenameFolder(contextMenu.folder);
                  closeContextMenu();
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className="context-item danger"
                onClick={() => {
                  deleteFolder(contextMenu.folder);
                  closeContextMenu();
                }}
              >
                删除
              </button>
            </>
          ) : null}

          {contextMenu.kind === 'entry' && contextMenu.entry ? (
            contextMenu.entry.trashedAt ? (
              <>
                <button
                  type="button"
                  className="context-item"
                  onClick={() => {
                    restoreEntry(contextMenu.entry.id);
                    closeContextMenu();
                  }}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="context-item danger"
                  onClick={() => {
                    permanentlyDeleteEntry(contextMenu.entry);
                    closeContextMenu();
                  }}
                >
                  彻底删除
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="context-item"
                  onClick={() => {
                    handleHistorySelect(contextMenu.entry);
                    closeContextMenu();
                  }}
                >
                  打开
                </button>
                <div className="context-divider" />
                <div className="context-section">
                  <div className="context-title">移动到</div>
                  <button
                    type="button"
                    className="context-item"
                    onClick={() => {
                      moveEntryToFolder(contextMenu.entry.id, '');
                      closeContextMenu();
                    }}
                  >
                    未归类
                  </button>
                  {flatFolders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      className="context-item indent"
                      onClick={() => {
                        moveEntryToFolder(contextMenu.entry.id, folder.id);
                        closeContextMenu();
                      }}
                    >
                      {`${'  '.repeat(folder.depth)}${folder.name}`}
                    </button>
                  ))}
                </div>
                <div className="context-divider" />
                <button
                  type="button"
                  className="context-item danger"
                  onClick={() => {
                    moveEntryToTrash(contextMenu.entry.id);
                    closeContextMenu();
                  }}
                >
                  删除
                </button>
              </>
            )
          ) : null}

          {contextMenu.kind === 'canvas' ? (
            <button
              type="button"
              className="context-item"
              onClick={() => {
                openCreateFolder(
                  contextMenu.parentId || null,
                  contextMenu.parentId || VIEW_ALL
                );
                closeContextMenu();
              }}
            >
              {contextMenu.parentId ? '新建子文件夹' : '新建文件夹'}
            </button>
          ) : null}
        </div>
      ) : null}

      {questionMenu.open && questionMenu.question ? (
        <div
          className="context-menu"
          style={{ top: questionMenu.y, left: questionMenu.x }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="context-item"
            onClick={() => {
              handleEditQuestion(questionMenu.question);
              setQuestionMenu((prev) => ({ ...prev, open: false }));
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="context-item danger"
            onClick={() => {
              handleDeleteQuestion(questionMenu.question.id);
              setQuestionMenu((prev) => ({ ...prev, open: false }));
            }}
          >
            删除
          </button>
        </div>
      ) : null}
    </div>
  );
}
