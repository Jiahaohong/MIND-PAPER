import { pdfjs } from 'react-pdf';

type AskAIFn = (payload: {
  prompt: string;
  messages?: Array<{ role: 'user' | 'model'; text: string }>;
}) => Promise<{ ok: boolean; content?: string; error?: string }>;

type ParsedMetadata = {
  title: string;
  author: string;
  summary: string;
  keywords: string[];
  publishedDate?: string;
  publisher?: string;
};

type LineItem = {
  y: number;
  text: string;
  size: number;
};

const ensureWorker = () => {
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();
  }
};

const normalizeLine = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

const buildLines = (items: any[]): LineItem[] => {
  const textItems = items
    .map((item) => {
      const text = typeof item?.str === 'string' ? normalizeLine(item.str) : '';
      if (!text) return null;
      const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4] || 0);
      const y = Number(transform[5] || 0);
      const size = Math.max(Math.abs(Number(transform[0] || 0)), Math.abs(Number(transform[3] || 0)));
      return { text, x, y, size: size || 1 };
    })
    .filter(Boolean) as Array<{ text: string; x: number; y: number; size: number }>;

  const sorted = textItems.sort((a, b) => {
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });

  const lines: Array<{ y: number; parts: Array<{ x: number; text: string; size: number }> }> = [];
  sorted.forEach((item) => {
    const existing = lines.find((line) => Math.abs(line.y - item.y) <= 2);
    if (existing) {
      existing.parts.push({ x: item.x, text: item.text, size: item.size });
      existing.y = (existing.y + item.y) / 2;
      return;
    }
    lines.push({ y: item.y, parts: [{ x: item.x, text: item.text, size: item.size }] });
  });

  return lines
    .map((line) => {
      const ordered = [...line.parts].sort((a, b) => a.x - b.x);
      return {
        y: line.y,
        text: normalizeLine(ordered.map((part) => part.text).join(' ')),
        size: ordered.reduce((max, part) => Math.max(max, part.size), 1)
      };
    })
    .filter((line) => line.text.length > 0);
};

const extractKeywords = (text: string) => {
  return text
    .split(/[;,，；、]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
};

const tokenizeForMatch = (text: string) => {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
};

const jaccardSimilarity = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection += 1;
  });
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
};

const isLikelyAffiliationLine = (line: string) => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (
    /\b(university|institute|department|school|laboratory|lab|college|faculty|research|hospital|academy|center|centre|email|corresponding|address)\b/i.test(
      value
    )
  ) {
    return true;
  }
  if (/大学|学院|研究所|实验室|中心|医院|通讯作者|地址/.test(value)) {
    return true;
  }
  const digitCount = (value.match(/\d/g) || []).length;
  return digitCount >= 6;
};

const cleanAuthorLine = (line: string) => {
  return String(line || '')
    .replace(/^by\s+/i, '')
    .replace(/[*†‡§]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

const formatZhDate = (year: number, month?: number, day?: number) => {
  if (!year || year < 1900 || year > 2100) return '';
  if (!month) return `${year}年`;
  if (month < 1 || month > 12) return `${year}年`;
  if (!day || day < 1 || day > 31) {
    return `${year}年${month}月`;
  }
  return `${year}年${month}月${day}日`;
};

const parseDateFromText = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const isoMatch = normalized.match(/\b(19|20)\d{2}[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return formatZhDate(Number(isoMatch[0].slice(0, 4)), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const monthDayYear = normalized.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i
  );
  if (monthDayYear) {
    const month = MONTH_MAP[monthDayYear[1].toLowerCase()];
    return formatZhDate(Number(monthDayYear[3]), month, Number(monthDayYear[2]));
  }

  const dayMonthYear = normalized.match(
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\b/i
  );
  if (dayMonthYear) {
    const month = MONTH_MAP[dayMonthYear[2].toLowerCase()];
    return formatZhDate(Number(dayMonthYear[3]), month, Number(dayMonthYear[1]));
  }

  const yearOnly = normalized.match(/\b((?:19|20)\d{2})\b/);
  if (yearOnly) {
    return formatZhDate(Number(yearOnly[1]));
  }

  return '';
};

const extractPublishedDate = (lines: LineItem[]) => {
  const scored: Array<{ date: string; score: number }> = [];
  const keywordScores: Array<{ regex: RegExp; score: number }> = [
    { regex: /(published|publication date|published online|online published|first published)/i, score: 50 },
    { regex: /(accepted|acceptance)/i, score: 40 },
    { regex: /(received|submitted)/i, score: 30 },
    { regex: /(copyright|©)/i, score: 20 }
  ];

  lines.forEach((line, index) => {
    const date = parseDateFromText(line.text);
    if (!date) return;
    let score = 10;
    keywordScores.forEach(({ regex, score: bonus }) => {
      if (regex.test(line.text)) score += bonus;
    });
    if (index < 20) score += 5;
    scored.push({ date, score });
  });

  if (!scored.length) return '';
  scored.sort((a, b) => b.score - a.score);
  return scored[0].date;
};

const parseJsonCandidate = (raw: string) => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const startObj = raw.indexOf('{');
  const endObj = raw.lastIndexOf('}');
  if (startObj !== -1 && endObj > startObj) {
    return raw.slice(startObj, endObj + 1).trim();
  }
  return raw.trim();
};

const extractPublisher = (lines: LineItem[], title: string) => {
  const titleTokens = new Set(tokenizeForMatch(title));
  const candidates: Array<{ text: string; score: number }> = [];
  const patterns: Array<{ regex: RegExp; score: number }> = [
    { regex: /(journal|transactions|proceedings|conference|symposium|workshop|arxiv|preprint)/i, score: 40 },
    { regex: /(ieee|acm|springer|elsevier|wiley|nature|science|neurips|icml|iclr|cvpr|aaai)/i, score: 35 },
    { regex: /(出版社|期刊|学报|会议|杂志|论文集|大会|研究会)/, score: 30 }
  ];

  lines.slice(0, 40).forEach((line, index) => {
    const value = String(line.text || '').trim();
    if (!value || value.length < 4 || value.length > 160) return;
    if (/@/.test(value)) return;
    if (/^(abstract|摘要|keywords?|关键[词字])\b[:：]?/i.test(value)) return;
    let score = 5;
    patterns.forEach(({ regex, score: bonus }) => {
      if (regex.test(value)) score += bonus;
    });
    if (index < 10) score += 5;
    if (titleTokens.size) {
      const tokens = new Set(tokenizeForMatch(value));
      const similarity = jaccardSimilarity(tokens, titleTokens);
      if (similarity >= 0.45) score -= 20;
    }
    if (score >= 20) {
      candidates.push({ text: value, score });
    }
  });

  if (!candidates.length) return '';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].text;
};

const extractMetadataFromLines = (lines: LineItem[], fallbackTitle: string) => {
  const firstPageText = lines.map((line) => line.text).join('\n');
  const abstractLineIndex = lines.findIndex((line) => /^(abstract|摘要)\b[:：]?\s*/i.test(line.text));
  const keywordLineIndex = lines.findIndex((line) => /^(keywords?|关键[词字])\b[:：]?\s*/i.test(line.text));

  const headingLimit = abstractLineIndex > 0 ? abstractLineIndex : Math.min(lines.length, 12);
  const headingLines = lines.slice(0, headingLimit);
  const titleCandidates = headingLines.filter(
    (line) =>
      line.text.length >= 8 &&
      line.text.length <= 220 &&
      !/^(abstract|摘要|keywords?|关键[词字])\b[:：]?/i.test(line.text)
  );
  const maxSize = titleCandidates.reduce((max, line) => Math.max(max, line.size), 0);
  const selectedTitleLines = titleCandidates.filter((line) => line.size >= maxSize - 0.3).slice(0, 2);
  const title = (selectedTitleLines.map((line) => line.text).join(' ').trim() || fallbackTitle).slice(0, 280);
  const titleLineTexts = new Set(selectedTitleLines.map((line) => line.text));
  const titleIndices = lines
    .map((line, index) => (titleLineTexts.has(line.text) ? index : -1))
    .filter((index) => index >= 0);
  const titleIndex = lines.findIndex((line) => line.text === titleCandidates[0]?.text);
  const lastTitleIndex = titleIndices.length ? Math.max(...titleIndices) : titleIndex;
  const authorStart = lastTitleIndex >= 0 ? lastTitleIndex + 1 : 1;
  const authorEnd =
    abstractLineIndex > authorStart ? abstractLineIndex : Math.min(authorStart + 6, lines.length);
  const titleTokenSet = new Set(tokenizeForMatch(title));
  const authorLines = lines
    .slice(authorStart, authorEnd)
    .map((line) => line.text)
    .filter(
      (line) => line && !/@/.test(line) && !/^(abstract|摘要|keywords?|关键[词字])\b[:：]?/i.test(line)
    );
  const refinedAuthorLines = authorLines
    .map((line) => cleanAuthorLine(line))
    .filter((line) => line.length > 1)
    .filter((line) => !isLikelyAffiliationLine(line))
    .filter((line) => {
      const lineTokens = tokenizeForMatch(line);
      if (!lineTokens.length) return false;
      const lineTokenSet = new Set(lineTokens);
      let overlap = 0;
      lineTokenSet.forEach((token) => {
        if (titleTokenSet.has(token)) overlap += 1;
      });
      const overlapRatio = overlap / lineTokenSet.size;
      const titleSimilarity = jaccardSimilarity(lineTokenSet, titleTokenSet);
      if (overlapRatio >= 0.6 || titleSimilarity >= 0.45) return false;
      return true;
    });
  const author = (refinedAuthorLines.join(', ') || 'Unknown').slice(0, 200);

  let summary = '';
  if (abstractLineIndex >= 0) {
    const abstractLines: string[] = [];
    const firstLine = lines[abstractLineIndex].text.replace(/^(abstract|摘要)\b[:：]?\s*/i, '').trim();
    if (firstLine) abstractLines.push(firstLine);
    for (let i = abstractLineIndex + 1; i < lines.length; i += 1) {
      const value = lines[i].text.trim();
      if (!value) continue;
      if (/^(keywords?|关键[词字])\b[:：]?/i.test(value)) break;
      if (/^(introduction|引言|1[\s.、]|i\.)/i.test(value)) break;
      abstractLines.push(value);
      if (abstractLines.join(' ').length > 1400) break;
    }
    summary = abstractLines.join(' ').trim();
  }
  if (!summary) {
    summary = lines
      .slice(Math.max(0, authorEnd), Math.min(lines.length, Math.max(authorEnd + 3, 6)))
      .map((line) => line.text)
      .join(' ')
      .trim();
  }
  summary = summary.slice(0, 2400) || 'No abstract extracted.';

  let keywords: string[] = [];
  if (keywordLineIndex >= 0) {
    const keywordFirst = lines[keywordLineIndex].text.replace(/^(keywords?|关键[词字])\b[:：]?\s*/i, '');
    keywords = extractKeywords(keywordFirst);
    if (!keywords.length && lines[keywordLineIndex + 1]) {
      keywords = extractKeywords(lines[keywordLineIndex + 1].text);
    }
  }

  const publishedDate = extractPublishedDate(lines);
  const publisher = extractPublisher(lines, title);

  return {
    metadata: {
      title: title || fallbackTitle,
      author: author || 'Unknown',
      summary: summary || 'No abstract extracted.',
      keywords,
      ...(publishedDate ? { publishedDate } : {}),
      ...(publisher ? { publisher } : {})
    },
    firstPageText
  };
};

export const extractPdfFirstPageMetadata = async (
  fileData: ArrayBuffer,
  fallbackTitle: string
): Promise<{ metadata: ParsedMetadata; firstPageText: string }> => {
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  const lines = buildLines(textContent.items || []);
  return extractMetadataFromLines(lines, fallbackTitle);
};

export const extractPdfMetadataFromTextItems = (
  items: any[],
  fallbackTitle: string
): { metadata: ParsedMetadata; firstPageText: string } => {
  const lines = buildLines(items || []);
  return extractMetadataFromLines(lines, fallbackTitle);
};

export const extractPdfFirstPageText = async (fileData: ArrayBuffer): Promise<string> => {
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  const lines = buildLines(textContent.items || []);
  return lines.map((line) => line.text).join('\n').trim();
};

export const extractMetadataWithAI = async (
  firstPageText: string,
  askAI: AskAIFn
): Promise<Partial<ParsedMetadata>> => {
  const prompt = [
    '你是论文首页信息提取器。',
    '请从下面内容提取标题、作者、摘要、关键词、发布日期。',
    '仅返回严格JSON对象，不要markdown，不要解释。',
    '格式：{"title":"","authors":[],"abstract":"","keywords":[],"publishedDate":""}',
    '',
    '【论文首页文本】',
    firstPageText || ''
  ].join('\n');
  const response = await askAI({ prompt, messages: [] });
  if (!response?.ok || !response.content) {
    throw new Error(response?.error || 'AI解析失败');
  }
  const jsonText = parseJsonCandidate(String(response.content));
  const parsed = JSON.parse(jsonText);
  const title = String(parsed?.title || '').trim();
  const abstractText = String(parsed?.abstract || '').trim();
  const authorList = Array.isArray(parsed?.authors)
    ? parsed.authors.map((item: unknown) => String(item || '').trim()).filter(Boolean)
    : [];
  const keywordList = Array.isArray(parsed?.keywords)
    ? parsed.keywords.map((item: unknown) => String(item || '').trim()).filter(Boolean)
    : [];
  const publishedDate = String(parsed?.publishedDate || '').trim();
  const publisher =
    String(parsed?.publisher || parsed?.organization || parsed?.venue || '').trim();
  return {
    ...(title ? { title: title.slice(0, 280) } : {}),
    ...(authorList.length ? { author: authorList.join(', ').slice(0, 200) } : {}),
    ...(abstractText ? { summary: abstractText.slice(0, 2400) } : {}),
    ...(keywordList.length ? { keywords: keywordList.slice(0, 12) } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(publisher ? { publisher } : {})
  };
};
