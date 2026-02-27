import { pdfjs } from 'react-pdf';
import type { PaperReference } from '../types';

type AskAIFn = (payload: {
  prompt: string;
  messages?: Array<{ role: 'user' | 'model'; text: string }>;
}) => Promise<{ ok: boolean; content?: string; error?: string }>;

export type OpenSourcePaperMetadata = {
  source: 'OpenAlex' | 'Semantic Scholar';
  title?: string;
  authors?: string[];
  publication_date?: string;
  venue?: string;
  doi?: string | null;
};

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
  x: number;
  text: string;
  size: number;
};

const normalizePaperTitle = (value: string) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

const titleSimilarityScore = (query: string, target: string) => {
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
  return common / Math.max(qTokens.size, tTokens.size);
};

const fetchJsonWithTimeout = async (url: string, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    return text ? JSON.parse(text) : {};
  } finally {
    window.clearTimeout(timeout);
  }
};

const searchOpenAlexByTitle = async (title: string): Promise<OpenSourcePaperMetadata | null> => {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5`;
  const data = await fetchJsonWithTimeout(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return null;
  let best: any = null;
  let bestScore = -1;
  for (const item of results) {
    const score = titleSimilarityScore(title, String(item?.title || ''));
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best) return null;
  return {
    source: 'OpenAlex',
    title: String(best?.title || '').trim(),
    authors: Array.isArray(best?.authorships)
      ? best.authorships
          .map((auth: any) => String(auth?.author?.display_name || '').trim())
          .filter(Boolean)
      : [],
    publication_date: String(best?.publication_date || '').trim(),
    venue:
      String(best?.primary_location?.source?.display_name || '').trim() ||
      String(best?.host_venue?.display_name || '').trim(),
    doi: String(best?.doi || '').trim() || null
  };
};

const searchSemanticScholarByTitle = async (
  title: string
): Promise<OpenSourcePaperMetadata | null> => {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    title
  )}&limit=5&fields=title,authors,venue,year,publicationDate,externalIds`;
  const data = await fetchJsonWithTimeout(url);
  const results = Array.isArray(data?.data) ? data.data : [];
  if (!results.length) return null;
  let best: any = null;
  let bestScore = -1;
  for (const item of results) {
    const score = titleSimilarityScore(title, String(item?.title || ''));
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  if (!best) return null;
  return {
    source: 'Semantic Scholar',
    title: String(best?.title || '').trim(),
    authors: Array.isArray(best?.authors)
      ? best.authors.map((auth: any) => String(auth?.name || '').trim()).filter(Boolean)
      : [],
    publication_date: String(best?.publicationDate || best?.year || '').trim(),
    venue: String(best?.venue || '').trim(),
    doi: String(best?.externalIds?.DOI || '').trim() || null
  };
};

export const searchPaperOpenSourceByTitle = async (
  title: string
): Promise<OpenSourcePaperMetadata | null> => {
  const query = String(title || '').trim();
  if (!query) return null;
  const openAlex = await searchOpenAlexByTitle(query).catch(() => null);
  if (openAlex) return openAlex;
  return searchSemanticScholarByTitle(query).catch(() => null);
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

const ABSTRACT_HEADING_REGEX = /^(abstract|摘要|summary)\b[:：]?\s*/i;
const KEYWORD_HEADING_REGEX = /^(keywords?|关键[词字])\b[:：]?/i;
const SECTION_HEADING_REGEX =
  /^(introduction|引言|background|背景|methods?|methodology|approach|related work|preliminar(?:y|ies)|experiments?|results?|discussion|conclusion|references?|acknowledg(?:e)?ments?|附录|实验|方法|相关工作|结论|参考文献)\b[:：]?/i;
const NUMBERED_SECTION_REGEX =
  /^((\d+(\.\d+){0,3})|([ivx]{1,6}))[\s.、:-]+[a-z\u4e00-\u9fff]/i;
const METHOD_HEADING_REGEX =
  /^(methods?|methodology|approach|framework|model|algorithm|implementation|training|system design|proposed method|our method|方法|研究方法|技术路线|算法|模型|系统设计)\b[:：]?/i;
const METHOD_BOUNDARY_HEADING_REGEX =
  /^(experiments?|evaluation|results?|discussion|conclusion|related work|references?|appendix|limitations?|实验|评估|结果|讨论|结论|相关工作|参考文献|附录|局限)\b[:：]?/i;
const INTRO_RELATED_HEADING_REGEX =
  /^(introduction|background|related work|preliminar(?:y|ies)|引言|背景|相关工作|预备知识)\b[:：]?/i;
const EXPERIMENT_HEADING_REGEX =
  /^(experiments?|evaluation|results?|analysis|ablation|实验|评估|结果|消融|分析)\b[:：]?/i;
const END_SECTION_HEADING_REGEX =
  /^(conclusion|references?|acknowledg(?:e)?ments?|appendix|结论|参考文献|致谢|附录)\b[:：]?/i;
const METHOD_MAX_SCAN_PAGES = 12;
const METHOD_MAX_EXTRACT_PAGES = 10;
const METHOD_MAX_CHARS = 12000;
const METHOD_EARLY_SEARCH_RATIO = 0.72;
const METHOD_PREFERRED_HALF_RATIO = 0.6;
const EXPERIMENT_MAX_EXTRACT_PAGES = 12;

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

  const lineItems = lines.flatMap((line) => {
    const ordered = [...line.parts].sort((a, b) => a.x - b.x);
    if (!ordered.length) return [];
    const segments: Array<Array<{ x: number; text: string; size: number }>> = [[ordered[0]]];
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const current = ordered[i];
      // Large x-gap usually means the next chunk belongs to another column.
      if (current.x - prev.x > 80) {
        segments.push([current]);
      } else {
        segments[segments.length - 1].push(current);
      }
    }
    return segments.map((segment) => ({
      y: line.y,
      x: segment[0].x,
      text: normalizeLine(segment.map((part) => part.text).join(' ')),
      size: segment.reduce((max, part) => Math.max(max, part.size), 1)
    }));
  });

  return lineItems
    .filter((line) => line.text.length > 0)
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 2) return b.y - a.y;
      return a.x - b.x;
    });
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

const normalizePublishedYear = (value: unknown) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
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
    if (/^(abstract|摘要|summary|keywords?|关键[词字])\b[:：]?/i.test(value)) return;
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

const isLikelyAllCapsHeading = (text: string) => {
  const letters = String(text || '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 6 || letters.length > 80) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.85 && !/[.!?]$/.test(String(text || '').trim());
};

const isLikelySectionStart = (text: string) => {
  const value = normalizeLine(String(text || ''));
  if (!value) return false;
  if (KEYWORD_HEADING_REGEX.test(value)) return true;
  if (SECTION_HEADING_REGEX.test(value)) return true;
  if (NUMBERED_SECTION_REGEX.test(value) && value.length <= 140) return true;
  if (isLikelyAllCapsHeading(value)) return true;
  return false;
};

const buildColumnCenters = (lines: LineItem[]) => {
  const clusters: Array<{ center: number; count: number }> = [];
  const threshold = 90;
  lines.forEach((line) => {
    if (!Number.isFinite(line.x)) return;
    const hit = clusters.find((cluster) => Math.abs(cluster.center - line.x) <= threshold);
    if (hit) {
      const nextCount = hit.count + 1;
      hit.center = (hit.center * hit.count + line.x) / nextCount;
      hit.count = nextCount;
      return;
    }
    clusters.push({ center: line.x, count: 1 });
  });
  return clusters
    .filter((cluster) => cluster.count >= 6)
    .sort((a, b) => a.center - b.center);
};

const nearestColumnCenter = (x: number, columns: Array<{ center: number; count: number }>) => {
  if (!columns.length) return x;
  let nearest = columns[0].center;
  let distance = Math.abs(nearest - x);
  for (let i = 1; i < columns.length; i += 1) {
    const current = columns[i].center;
    const nextDistance = Math.abs(current - x);
    if (nextDistance < distance) {
      nearest = current;
      distance = nextDistance;
    }
  }
  return nearest;
};

const isLikelyAbstractNoiseLine = (value: string) => {
  const text = normalizeLine(value);
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^(page|p\.)\s*\d+$/i.test(text)) return true;
  if (/^(copyright|©|all rights reserved)/i.test(text)) return true;
  if (/^(arxiv|doi)\s*[:]/i.test(text)) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^(figure|fig\.|table)\s*\d+/i.test(text)) return true;
  return false;
};

const extractSummaryFromAbstract = (lines: LineItem[], authorEnd: number) => {
  const abstractLineIndex = lines.findIndex((line) => ABSTRACT_HEADING_REGEX.test(line.text));
  let summary = '';

  if (abstractLineIndex >= 0) {
    const abstractLines: string[] = [];
    const anchor = lines[abstractLineIndex];
    const firstLine = anchor.text.replace(ABSTRACT_HEADING_REGEX, '').trim();
    if (firstLine && !isLikelySectionStart(firstLine)) {
      abstractLines.push(firstLine);
    }

    const columns = buildColumnCenters(lines);
    const hasTwoColumns = columns.length >= 2;
    const anchorColumn = nearestColumnCenter(anchor.x, columns);
    const columnThreshold = hasTwoColumns ? 70 : 9999;
    const lineGapThreshold = Math.max(18, anchor.size * 2.4);
    let lastAcceptedY: number | null = null;

    for (let i = abstractLineIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const value = line.text.trim();
      if (!value) continue;
      if (Math.abs(line.x - anchorColumn) > columnThreshold) continue;
      if (isLikelySectionStart(value)) break;
      if (isLikelyAbstractNoiseLine(value)) continue;
      if (
        line.size > anchor.size * 1.18 &&
        value.length < 120 &&
        !/[.!?。；：:]$/.test(value)
      ) {
        break;
      }
      if (lastAcceptedY !== null) {
        const gap = lastAcceptedY - line.y;
        if (gap > lineGapThreshold && abstractLines.join(' ').length >= 120) {
          break;
        }
      }
      abstractLines.push(value);
      lastAcceptedY = line.y;
      if (abstractLines.join(' ').length > 1800) break;
    }
    summary = abstractLines.join(' ').trim();
  }

  if (!summary) {
    const fallbackLines: string[] = [];
    const start = Math.max(0, authorEnd);
    let lastAcceptedY: number | null = null;
    const fallbackGapThreshold = 22;
    for (let i = start; i < lines.length; i += 1) {
      const value = lines[i].text.trim();
      if (!value) continue;
      if (isLikelySectionStart(value)) {
        if (fallbackLines.length) break;
        continue;
      }
      if (isLikelyAbstractNoiseLine(value)) continue;
      if (/@/.test(value) || isLikelyAffiliationLine(value)) continue;
      if (lastAcceptedY !== null) {
        const gap = lastAcceptedY - lines[i].y;
        if (gap > fallbackGapThreshold && fallbackLines.join(' ').length >= 120) {
          break;
        }
      }
      fallbackLines.push(value);
      lastAcceptedY = lines[i].y;
      if (fallbackLines.join(' ').length > 1000 || fallbackLines.length >= 8) break;
    }
    summary = fallbackLines.join(' ').trim();
  }

  return summary.slice(0, 2400).trim();
};

type OutlineEntry = {
  id: string;
  title: string;
  pageIndex: number | null;
  depth: number;
};

const normalizeHeading = (value: string) =>
  normalizeLine(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isIntroOrRelatedHeading = (heading: string) =>
  INTRO_RELATED_HEADING_REGEX.test(normalizeLine(heading));

const isExperimentHeading = (heading: string) =>
  EXPERIMENT_HEADING_REGEX.test(normalizeLine(heading));

const isEndSectionHeading = (heading: string) =>
  END_SECTION_HEADING_REGEX.test(normalizeLine(heading));

const scoreMethodHeading = (heading: string, titleTokens: Set<string>) => {
  const value = normalizeLine(heading);
  if (!value || value.length > 180) return -100;
  let score = 0;
  if (METHOD_HEADING_REGEX.test(value)) score += 60;
  if (/\b(method|approach|framework|algorithm|model|方法|算法|模型)\b/i.test(value)) score += 18;
  if (METHOD_BOUNDARY_HEADING_REGEX.test(value)) score -= 35;
  if (isIntroOrRelatedHeading(value)) score -= 24;
  if (isExperimentHeading(value)) score -= 45;
  if (isEndSectionHeading(value)) score -= 60;
  if (SECTION_HEADING_REGEX.test(value)) score += 10;
  if (NUMBERED_SECTION_REGEX.test(value)) score += 8;
  if (isLikelyAllCapsHeading(value)) score += 4;
  const tokens = new Set(tokenizeForMatch(value));
  const sim = jaccardSimilarity(tokens, titleTokens);
  score += Math.round(sim * 20);
  return score;
};

const computeMethodSearchUpperBound = (entries: OutlineEntry[], numPages: number) => {
  const defaultUpper = Math.max(
    1,
    Math.min(numPages, Math.ceil(numPages * METHOD_EARLY_SEARCH_RATIO))
  );
  let boundaryPage = Number.POSITIVE_INFINITY;
  entries.forEach((entry) => {
    if (typeof entry.pageIndex !== 'number') return;
    const pageIndex = Math.max(0, entry.pageIndex);
    if (isExperimentHeading(entry.title) || isEndSectionHeading(entry.title)) {
      boundaryPage = Math.min(boundaryPage, pageIndex);
    }
  });
  if (!Number.isFinite(boundaryPage)) return defaultUpper;
  return Math.max(1, Math.min(defaultUpper, Number(boundaryPage), numPages));
};

const resolveOutlinePageIndex = async (doc: any, dest: unknown): Promise<number | null> => {
  if (!dest) return null;
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return null;
    const pageRef = resolved[0];
    if (typeof pageRef === 'number') {
      return Number.isFinite(pageRef) ? pageRef : null;
    }
    const index = await doc.getPageIndex(pageRef);
    return Number.isFinite(index) ? index : null;
  } catch {
    return null;
  }
};

const buildOutlineEntries = async (
  doc: any,
  items: any[],
  depth: number,
  parentId: string
): Promise<OutlineEntry[]> => {
  const list: OutlineEntry[] = [];
  for (let i = 0; i < (items || []).length; i += 1) {
    const item = items[i];
    const id = `${parentId}.${i}`;
    const title = normalizeLine(String(item?.title || ''));
    const pageIndex = await resolveOutlinePageIndex(doc, item?.dest);
    list.push({ id, title, pageIndex, depth });
    if (Array.isArray(item?.items) && item.items.length) {
      const children = await buildOutlineEntries(doc, item.items, depth + 1, id);
      list.push(...children);
    }
  }
  return list;
};

const getLineIndexByHeading = (lines: LineItem[], heading: string) => {
  const target = normalizeHeading(heading);
  if (!target) return -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizeHeading(lines[i].text);
    if (!line) continue;
    if (line === target) return i;
    if (line.includes(target) || target.includes(line)) return i;
  }
  return -1;
};

const isLikelyMethodNoiseLine = (line: string) => {
  const value = normalizeLine(line);
  if (!value) return true;
  if (/^\d+$/.test(value)) return true;
  if (/^page\s+\d+$/i.test(value)) return true;
  if (/^(figure|fig\.|table)\s*\d+/i.test(value)) return true;
  if (/^(doi|arxiv)\s*[:]/i.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
};

const cleanMethodText = (text: string) => {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, METHOD_MAX_CHARS);
};

const collectMethodText = async (
  doc: any,
  getPageLines: (pageIndex: number) => Promise<LineItem[]>,
  startPage: number,
  endPageExclusive: number,
  options?: {
    startHeading?: string;
    boundaryPage?: number;
    boundaryHeading?: string;
    boundaryLineIndex?: number;
  }
) => {
  const chunks: string[] = [];
  const finalEnd = Math.min(doc.numPages, Math.max(startPage + 1, endPageExclusive));
  for (let pageIndex = startPage; pageIndex < finalEnd; pageIndex += 1) {
    const lines = await getPageLines(pageIndex);
    let startLine = 0;
    let endLine = lines.length;
    if (pageIndex === startPage && options?.startHeading) {
      const idx = getLineIndexByHeading(lines, options.startHeading);
      if (idx >= 0) startLine = Math.min(lines.length, idx + 1);
    }
    if (typeof options?.boundaryPage === 'number' && pageIndex === options.boundaryPage) {
      if (typeof options.boundaryLineIndex === 'number') {
        endLine = Math.max(startLine, Math.min(endLine, options.boundaryLineIndex));
      } else if (options.boundaryHeading) {
        const idx = getLineIndexByHeading(lines, options.boundaryHeading);
        if (idx >= 0) endLine = Math.max(startLine, Math.min(endLine, idx));
      }
    }
    for (let i = startLine; i < endLine; i += 1) {
      const value = lines[i].text.trim();
      if (!value) continue;
      if (isLikelyMethodNoiseLine(value)) continue;
      chunks.push(value);
      if (chunks.join('\n').length > METHOD_MAX_CHARS * 1.2) {
        return cleanMethodText(chunks.join('\n'));
      }
    }
    if (typeof options?.boundaryPage === 'number' && pageIndex === options.boundaryPage) break;
  }
  return cleanMethodText(chunks.join('\n'));
};

const extractMetadataFromLines = (lines: LineItem[], fallbackTitle: string) => {
  const firstPageText = lines.map((line) => line.text).join('\n');
  const abstractLineIndex = lines.findIndex((line) => ABSTRACT_HEADING_REGEX.test(line.text));
  const keywordLineIndex = lines.findIndex((line) => KEYWORD_HEADING_REGEX.test(line.text));

  const headingLimit = abstractLineIndex > 0 ? abstractLineIndex : Math.min(lines.length, 12);
  const headingLines = lines.slice(0, headingLimit);
  const titleCandidates = headingLines.filter(
    (line) =>
      line.text.length >= 8 &&
      line.text.length <= 220 &&
      !/^(abstract|摘要|summary|keywords?|关键[词字])\b[:：]?/i.test(line.text)
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
      (line) =>
        line &&
        !/@/.test(line) &&
        !/^(abstract|摘要|summary|keywords?|关键[词字])\b[:：]?/i.test(line)
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

  const summary = extractSummaryFromAbstract(lines, authorEnd) || 'No abstract extracted.';

  let keywords: string[] = [];
  if (keywordLineIndex >= 0) {
    const keywordFirst = lines[keywordLineIndex].text.replace(KEYWORD_HEADING_REGEX, '');
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

export const extractPdfMethodSection = async (
  fileData: ArrayBuffer,
  paperTitle = ''
): Promise<string> => {
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const pageLineCache = new Map<number, LineItem[]>();
  const getPageLines = async (pageIndex: number) => {
    const cached = pageLineCache.get(pageIndex);
    if (cached) return cached;
    const page = await doc.getPage(pageIndex + 1);
    const textContent = await page.getTextContent();
    const lines = buildLines(textContent.items || []);
    pageLineCache.set(pageIndex, lines);
    return lines;
  };

  try {
    const titleTokens = new Set(tokenizeForMatch(paperTitle));
    let methodSearchUpperBound = Math.max(
      1,
      Math.min(doc.numPages, Math.ceil(doc.numPages * METHOD_EARLY_SEARCH_RATIO))
    );
    let outlineEntries: OutlineEntry[] = [];

    // 1) Outline-driven extraction
    const outline = await doc.getOutline();
    if (Array.isArray(outline) && outline.length) {
      const entries = await buildOutlineEntries(doc, outline, 0, 'outline');
      outlineEntries = entries;
      methodSearchUpperBound = computeMethodSearchUpperBound(entries, doc.numPages);

      const scored = entries
        .filter((entry) => typeof entry.pageIndex === 'number')
        .map((entry, index) => ({
          entry,
          index,
          score: (() => {
            let next = scoreMethodHeading(entry.title, titleTokens) - entry.depth * 2;
            const pageIndex = Number(entry.pageIndex || 0);
            if (pageIndex >= methodSearchUpperBound) next -= 100;
            if (pageIndex > Math.floor(doc.numPages * METHOD_PREFERRED_HALF_RATIO)) next -= 12;
            if (isIntroOrRelatedHeading(entry.title)) next -= 8;
            return next;
          })()
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      if (scored.length && scored[0].score >= 32) {
        const target = scored[0].entry;
        const startPage = Math.max(0, target.pageIndex || 0);
        if (startPage < methodSearchUpperBound) {
        let boundaryPage: number | null = null;
        let boundaryHeading = '';
        for (const candidate of entries.slice(scored[0].index + 1)) {
          if (candidate.depth > target.depth) continue;
          if (typeof candidate.pageIndex !== 'number') continue;
          if (candidate.pageIndex <= startPage) continue;
          boundaryPage = candidate.pageIndex;
          boundaryHeading = candidate.title;
          break;
        }
        const endExclusive = Math.min(
          doc.numPages,
          Math.max(
            startPage + 1,
            Math.min(
              boundaryPage ?? doc.numPages,
              methodSearchUpperBound,
              startPage + METHOD_MAX_EXTRACT_PAGES
            )
          )
        );
        const outlineMethod = await collectMethodText(doc, getPageLines, startPage, endExclusive, {
          startHeading: target.title
        });
        if (outlineMethod.length >= 120) return outlineMethod;
      }
      }

      // 1.1) No explicit method heading: use the last non-intro heading before "实验/结果/结论/参考文献"
      const topEntries = entries.filter(
        (entry) =>
          entry.depth <= 1 &&
          typeof entry.pageIndex === 'number' &&
          Number(entry.pageIndex) <= methodSearchUpperBound
      );
      const boundaryIndex = topEntries.findIndex(
        (entry) => isExperimentHeading(entry.title) || isEndSectionHeading(entry.title)
      );
      if (boundaryIndex > 0) {
        const candidates = topEntries
          .slice(0, boundaryIndex)
          .filter(
            (entry) =>
              !isIntroOrRelatedHeading(entry.title) &&
              !isExperimentHeading(entry.title) &&
              !isEndSectionHeading(entry.title)
          );
        const heuristic = candidates.length ? candidates[candidates.length - 1] : null;
        if (heuristic && typeof heuristic.pageIndex === 'number') {
          const startPage = Math.max(0, heuristic.pageIndex);
          const boundaryPage = Number(topEntries[boundaryIndex].pageIndex);
          const endExclusive = Math.min(
            doc.numPages,
            Math.max(
              startPage + 1,
              Math.min(boundaryPage, methodSearchUpperBound, startPage + METHOD_MAX_EXTRACT_PAGES)
            )
          );
          const outlineFallbackMethod = await collectMethodText(
            doc,
            getPageLines,
            startPage,
            endExclusive,
            {
              startHeading: heuristic.title
            }
          );
          if (outlineFallbackMethod.length >= 120) return outlineFallbackMethod;
        }
      }
    }

    // 2) Heading scan fallback (first N pages)
    let fallbackStart: { pageIndex: number; lineIndex: number; heading: string; score: number } | null =
      null;
    if (!outlineEntries.length) {
      methodSearchUpperBound = Math.max(
        1,
        Math.min(doc.numPages, Math.ceil(doc.numPages * METHOD_EARLY_SEARCH_RATIO))
      );
    }
    let scanUpperBound = Math.min(
      methodSearchUpperBound,
      Math.min(doc.numPages, Math.max(METHOD_MAX_SCAN_PAGES, methodSearchUpperBound))
    );
    for (let pageIndex = 0; pageIndex < scanUpperBound; pageIndex += 1) {
      const lines = await getPageLines(pageIndex);
      const pageMaxSize = lines.reduce((max, line) => Math.max(max, line.size), 1);
      for (let i = 0; i < lines.length; i += 1) {
        const value = lines[i].text.trim();
        if (!value) continue;
        const looksLikeHeading =
          SECTION_HEADING_REGEX.test(value) ||
          NUMBERED_SECTION_REGEX.test(value) ||
          isLikelyAllCapsHeading(value);
        if (looksLikeHeading && (isExperimentHeading(value) || isEndSectionHeading(value))) {
          scanUpperBound = Math.max(1, Math.min(scanUpperBound, pageIndex));
          break;
        }
        let score = scoreMethodHeading(value, titleTokens);
        if (score < 30) continue;
        if (lines[i].size >= pageMaxSize * 0.92) score += 6;
        if (value.length > 140) score -= 8;
        if (pageIndex > Math.floor(doc.numPages * METHOD_PREFERRED_HALF_RATIO)) score -= 8;
        if (!fallbackStart || score > fallbackStart.score) {
          fallbackStart = { pageIndex, lineIndex: i, heading: value, score };
        }
      }
      if (pageIndex + 1 >= scanUpperBound) break;
    }

    if (!fallbackStart) return '';

    let boundary: { pageIndex: number; lineIndex: number; heading: string } | null = null;
    const boundaryPageLimit = Math.min(
      Math.max(fallbackStart.pageIndex + 1, scanUpperBound),
      fallbackStart.pageIndex + METHOD_MAX_EXTRACT_PAGES,
      doc.numPages
    );
    for (let pageIndex = fallbackStart.pageIndex; pageIndex < boundaryPageLimit; pageIndex += 1) {
      const lines = await getPageLines(pageIndex);
      const startLine = pageIndex === fallbackStart.pageIndex ? fallbackStart.lineIndex + 1 : 0;
      for (let i = startLine; i < lines.length; i += 1) {
        const value = lines[i].text.trim();
        if (!value) continue;
        if (METHOD_BOUNDARY_HEADING_REGEX.test(value) && (SECTION_HEADING_REGEX.test(value) || NUMBERED_SECTION_REGEX.test(value) || isLikelyAllCapsHeading(value))) {
          boundary = { pageIndex, lineIndex: i, heading: value };
          break;
        }
      }
      if (boundary) break;
    }

    const endExclusive = boundary
      ? Math.min(
          doc.numPages,
          Math.max(fallbackStart.pageIndex + 1, Math.min(boundary.pageIndex + 1, boundaryPageLimit))
        )
      : Math.min(
          doc.numPages,
          Math.max(fallbackStart.pageIndex + 1, Math.min(boundaryPageLimit, fallbackStart.pageIndex + METHOD_MAX_EXTRACT_PAGES))
        );
    const fallbackMethod = await collectMethodText(
      doc,
      getPageLines,
      fallbackStart.pageIndex,
      endExclusive,
      {
        startHeading: fallbackStart.heading,
        boundaryPage: boundary?.pageIndex,
        boundaryHeading: boundary?.heading,
        boundaryLineIndex: boundary?.lineIndex
      }
    );
    return fallbackMethod;
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
};

export const extractPdfExperimentSection = async (
  fileData: ArrayBuffer
): Promise<string> => {
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const pageLineCache = new Map<number, LineItem[]>();
  const getPageLines = async (pageIndex: number) => {
    const cached = pageLineCache.get(pageIndex);
    if (cached) return cached;
    const page = await doc.getPage(pageIndex + 1);
    const textContent = await page.getTextContent();
    const lines = buildLines(textContent.items || []);
    pageLineCache.set(pageIndex, lines);
    return lines;
  };

  try {
    const outline = await doc.getOutline();
    if (Array.isArray(outline) && outline.length) {
      const entries = await buildOutlineEntries(doc, outline, 0, 'outline');
      const startCandidate = entries.find(
        (entry) =>
          typeof entry.pageIndex === 'number' &&
          entry.pageIndex >= 0 &&
          isExperimentHeading(entry.title)
      );
      if (startCandidate && typeof startCandidate.pageIndex === 'number') {
        const startPage = Math.max(0, startCandidate.pageIndex);
        const boundaryCandidate = entries.find(
          (entry) =>
            typeof entry.pageIndex === 'number' &&
            entry.pageIndex > startPage &&
            entry.depth <= startCandidate.depth &&
            isEndSectionHeading(entry.title)
        );
        const endExclusive = Math.min(
          doc.numPages,
          Math.max(
            startPage + 1,
            Math.min(
              boundaryCandidate?.pageIndex ?? doc.numPages,
              startPage + EXPERIMENT_MAX_EXTRACT_PAGES
            )
          )
        );
        const outlineExperiment = await collectMethodText(doc, getPageLines, startPage, endExclusive, {
          startHeading: startCandidate.title
        });
        if (outlineExperiment.length >= 120) return outlineExperiment;
      }
    }

    let start: { pageIndex: number; lineIndex: number; heading: string } | null = null;
    let boundary: { pageIndex: number; lineIndex: number; heading: string } | null = null;
    for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
      const lines = await getPageLines(pageIndex);
      for (let i = 0; i < lines.length; i += 1) {
        const value = lines[i].text.trim();
        if (!value) continue;
        const looksLikeHeading =
          SECTION_HEADING_REGEX.test(value) ||
          NUMBERED_SECTION_REGEX.test(value) ||
          isLikelyAllCapsHeading(value);
        if (!start) {
          if (looksLikeHeading && isExperimentHeading(value)) {
            start = { pageIndex, lineIndex: i, heading: value };
          }
          continue;
        }
        if (
          looksLikeHeading &&
          isEndSectionHeading(value) &&
          (pageIndex > start.pageIndex || i > start.lineIndex)
        ) {
          boundary = { pageIndex, lineIndex: i, heading: value };
          break;
        }
      }
      if (boundary) break;
    }

    if (!start) return '';
    const endExclusive = boundary
      ? Math.min(
          doc.numPages,
          Math.max(start.pageIndex + 1, boundary.pageIndex + 1)
        )
      : Math.min(doc.numPages, Math.max(start.pageIndex + 1, start.pageIndex + EXPERIMENT_MAX_EXTRACT_PAGES));
    return collectMethodText(doc, getPageLines, start.pageIndex, endExclusive, {
      startHeading: start.heading,
      boundaryPage: boundary?.pageIndex,
      boundaryHeading: boundary?.heading,
      boundaryLineIndex: boundary?.lineIndex
    });
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
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

export const extractPdfFullText = async (
  fileData: ArrayBuffer,
  options?: { maxPages?: number; maxChars?: number }
): Promise<string> => {
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const maxPages = Math.max(1, Math.min(doc.numPages, options?.maxPages || doc.numPages));
  const maxChars = Math.max(4000, options?.maxChars || 220000);
  const chunks: string[] = [];
  let charCount = 0;
  try {
    for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const textContent = await page.getTextContent();
      const lines = buildLines(textContent.items || []);
      const pageText = lines.map((line) => line.text).join('\n').trim();
      if (!pageText) continue;
      const pageChunk = `\n\n[Page ${pageNo}]\n${pageText}`;
      chunks.push(pageChunk);
      charCount += pageChunk.length;
      if (charCount >= maxChars) break;
    }
    return chunks.join('').trim();
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
};

export const extractPdfReferencesFromLocal = async (
  fileData: ArrayBuffer,
  options?: { maxPages?: number; maxRefs?: number }
): Promise<PaperReference[]> => {
  type RefLine = LineItem & { pageNo: number };

  const maxPages = Math.max(1, options?.maxPages || 80);
  const maxRefs = Math.max(10, options?.maxRefs || 200);
  ensureWorker();
  const loadingTask = pdfjs.getDocument({ data: fileData.slice(0) });
  const doc = await loadingTask.promise;
  const allLines: RefLine[] = [];
  try {
    const pageLimit = Math.max(1, Math.min(doc.numPages, maxPages));
    for (let pageNo = 1; pageNo <= pageLimit; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const textContent = await page.getTextContent();
      const pageLines = buildLines(textContent.items || []);
      pageLines.forEach((line) => {
        if (line.text) {
          allLines.push({ ...line, pageNo });
        }
      });
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }
  if (!allLines.length) return [];

  const headingRegex =
    /^(references?|bibliography|reference list|works cited|参考文献|参考资料|文献)\s*$/i;
  const explicitStopRegex =
    /^(appendix|appendices|supplementary|acknowledg(?:e)?ments?|致谢|附录)\b/i;
  const entryStartRegex = /^\s*(\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)])\s+/;
  const allCapsHeadingRegex = /^[A-Z][A-Z\s/&-]{2,}$/;
  const spaceNorm = (value: string) => normalizeLine(value).trim();

  const headingIndex = allLines.findIndex((line) => headingRegex.test(spaceNorm(line.text)));
  if (headingIndex < 0) return [];

  const bodySizes = allLines
    .map((line) => Number(line.size || 0))
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((a, b) => a - b);
  const bodySizeMedian = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 10;

  const collectGapSamples = () => {
    const gaps: number[] = [];
    for (let i = headingIndex + 1; i < Math.min(allLines.length, headingIndex + 120); i += 1) {
      const prev = allLines[i - 1];
      const curr = allLines[i];
      if (!prev || !curr) continue;
      if (prev.pageNo !== curr.pageNo) continue;
      const gap = prev.y - curr.y;
      if (gap > 0 && gap < 80) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    return gaps;
  };

  const gapSamples = collectGapSamples();
  const medianGap = gapSamples.length ? gapSamples[Math.floor(gapSamples.length / 2)] : 10;
  const entryGapThreshold = Math.max(14, medianGap * 1.8);

  const looksLikeSectionHeading = (line: RefLine) => {
    const text = spaceNorm(line.text);
    if (!text) return false;
    if (explicitStopRegex.test(text)) return true;
    const maybeSection =
      SECTION_HEADING_REGEX.test(text) ||
      NUMBERED_SECTION_REGEX.test(text) ||
      allCapsHeadingRegex.test(text);
    if (!maybeSection) return false;
    return Number(line.size || 0) >= bodySizeMedian * 1.02 || text.length <= 80;
  };

  const looksLikeReferenceStartWithoutMarker = (text: string) => {
    const normalized = spaceNorm(text);
    if (!normalized) return false;
    if (entryStartRegex.test(normalized)) return true;
    if (/^[A-Z][A-Za-z'`-]+,\s/.test(normalized)) return true;
    if (/^[A-Z][A-Za-z'`-]+(?:\s+[A-Z][A-Za-z'`-]+){0,4}\s+\(\d{4}[a-z]?\)/.test(normalized)) {
      return true;
    }
    if (/^[A-Z][A-Za-z'`-]+(?:\s+[A-Z]\.){1,3}/.test(normalized)) return true;
    if (/^[\u4e00-\u9fff]{2,6}[，,、]/.test(normalized)) return true;
    return false;
  };

  const refs: string[] = [];
  let current = '';
  let lastLine: RefLine | null = null;
  let seenRefContent = false;

  for (let i = headingIndex + 1; i < allLines.length; i += 1) {
    const line = allLines[i];
    const raw = spaceNorm(line.text);
    if (!raw) continue;
    if (seenRefContent && looksLikeSectionHeading(line)) break;

    const isNewEntry = entryStartRegex.test(raw);
    const gap =
      lastLine && lastLine.pageNo === line.pageNo ? Math.max(0, lastLine.y - line.y) : entryGapThreshold + 1;
    const shouldSplitByGap =
      !isNewEntry &&
      Boolean(current) &&
      gap >= entryGapThreshold &&
      looksLikeReferenceStartWithoutMarker(raw);

    if (isNewEntry || shouldSplitByGap) {
      if (current) refs.push(current);
      current = raw;
      seenRefContent = true;
    } else if (current) {
      current = `${current} ${raw}`.trim();
    } else {
      if (looksLikeReferenceStartWithoutMarker(raw)) {
        current = raw;
        seenRefContent = true;
      }
    }

    if (refs.length >= maxRefs) break;
    lastLine = line;
  }

  if (current && refs.length < maxRefs) refs.push(current);

  const parseOrder = (value: string) => {
    const match = value.match(/^\s*(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})[.)])\s+/);
    const raw = match?.[1] || match?.[2] || match?.[3] || '';
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  };

  const extractTitle = (value: string) => {
    const line = value.replace(entryStartRegex, '').replace(/\s+/g, ' ').trim();
    if (!line) return '';

    const quoted =
      line.match(/["“”](.{8,240}?)["“”]/)?.[1] ||
      line.match(/[‘’'](.{8,240}?)[‘’']/)?.[1];
    if (quoted) return quoted.trim();

    const yearMatch = line.match(/\(?\b(19|20)\d{2}\b\)?[a-z]?[.,)]?\s*(.+)$/i);
    if (yearMatch?.[2]) {
      const afterYear = yearMatch[2].trim();
      const sentence = afterYear.split(/\.\s+/).map((part) => part.trim()).find((part) => part.length > 8);
      if (sentence) return sentence.replace(/\.$/, '').trim();
    }

    const parts = line
      .split(/\.\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const titleLike = parts.find(
      (part) =>
        part.length > 8 &&
        !/\b(19|20)\d{2}\b/.test(part) &&
        !/@/.test(part) &&
        !/^(vol|pp|pages?)\b/i.test(part)
    );
    return (titleLike || line).replace(/\.$/, '').trim();
  };

  return refs
    .map((item, index) => {
      const title = extractTitle(item);
      if (!title || title.length < 4) return null;
      return {
        refId: `local-ref-${index + 1}`,
        order: parseOrder(item),
        title,
        source: 'local'
      } satisfies PaperReference;
    })
    .filter(Boolean)
    .slice(0, maxRefs) as PaperReference[];
};

const splitTextForAI = (text: string, maxChars = 16000) => {
  const input = String(text || '').trim();
  if (!input) return [];
  if (input.length <= maxChars) return [input];
  const parts = input
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return [input.slice(0, maxChars)];
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (part.length <= maxChars) {
      current = part;
      continue;
    }
    for (let i = 0; i < part.length; i += maxChars) {
      chunks.push(part.slice(i, i + maxChars));
    }
    current = '';
  }
  if (current) chunks.push(current);
  return chunks;
};

export const extractMethodWithAI = async (
  fullText: string,
  askAI: AskAIFn
): Promise<string> => {
  const text = String(fullText || '').trim();
  if (!text) return '';

  const chunks = splitTextForAI(text, 16000);
  const notes: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = [
      'You extract the method section from an academic paper.',
      'Only use the provided text and summarize method-related content:',
      '- core idea',
      '- model/algorithm',
      '- training or optimization objective',
      '- key implementation details',
      'Exclude experiments, results, conclusion, acknowledgements, and references.',
      'Return plain English only (no markdown), up to 220 words.',
      'If method details are insufficient, return: "Method details are not provided."',
      `Chunk: ${i + 1}/${chunks.length}`,
      '',
      '[Paper Text Chunk]',
      chunks[i]
    ].join('\n');
    const response = await askAI({ prompt, messages: [] });
    if (!response?.ok || !response.content) continue;
    const note = String(response.content || '').trim();
    if (note) notes.push(note);
  }
  if (!notes.length) return '';
  if (notes.length === 1) return notes[0].slice(0, 12000).trim();

  const mergePrompt = [
    'You merge method notes extracted from multiple chunks of one paper.',
    'Combine them into one coherent English method summary.',
    'Keep only method-related facts, avoid hallucinations, no markdown, up to 700 words.',
    '',
    '[Chunk Method Notes]',
    notes.map((note, idx) => `Chunk ${idx + 1}:\n${note}`).join('\n\n')
  ].join('\n');
  const merged = await askAI({ prompt: mergePrompt, messages: [] });
  if (merged?.ok && merged.content) {
    return String(merged.content || '').trim().slice(0, 12000);
  }
  return notes.join('\n\n').slice(0, 12000).trim();
};

export const rewriteSummaryWithAI = async (
  payload: {
    originalAbstract: string;
    fullText: string;
  },
  askAI: AskAIFn
): Promise<string> => {
  const originalAbstract = String(payload.originalAbstract || '').trim();
  const fullText = String(payload.fullText || '').trim();

  if (!fullText) return originalAbstract;
  const chunks = splitTextForAI(fullText, 14000);
  const evidenceNotes: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const prompt = [
      'You are extracting evidence for rewriting a richer academic abstract.',
      'From this chunk, extract only factual points useful for an abstract:',
      '- research problem/background',
      '- core method idea and technical mechanism',
      '- datasets, settings, and evaluation protocol',
      '- key quantitative findings (metrics/numbers if present)',
      '- limitations or boundary conditions',
      'Return concise plain text notes in source language (max 160 words).',
      'If this chunk contains no useful evidence, return exactly: N/A',
      `Chunk: ${i + 1}/${chunks.length}`,
      '',
      '[Chunk Text]',
      chunks[i]
    ].join('\n');
    const response = await askAI({ prompt, messages: [] });
    if (!response?.ok || !response.content) continue;
    const note = String(response.content || '').trim();
    if (!note || /^n\/a$/i.test(note)) continue;
    evidenceNotes.push(note);
  }

  const rewritePrompt = [
    'You are a senior research editor rewriting an abstract.',
    'Task: rewrite a richer, detail-oriented abstract using only provided evidence.',
    'Hard constraints:',
    '1) Do not fabricate any fact, metric, dataset, or claim.',
    '2) Keep language consistent with source text.',
    '3) Keep academic and concise style, plain text only (no markdown, no bullet list).',
    '4) Target length: 220-320 words.',
    '5) Cover these elements naturally in one coherent paragraph:',
    '   research context/problem, core method, experimental setup, key results, and practical contribution.',
    '6) If specific numbers are missing, describe results qualitatively instead of guessing.',
    '7) Preserve the original abstract intent but enrich technical detail.',
    '',
    '[Original Abstract]',
    originalAbstract || 'N/A',
    '',
    '[Evidence Notes From Full Paper]',
    evidenceNotes.length ? evidenceNotes.join('\n\n') : 'N/A'
  ].join('\n');
  const rewritten = await askAI({ prompt: rewritePrompt, messages: [] });
  if (!rewritten?.ok || !rewritten.content) return originalAbstract;
  return String(rewritten.content || '').trim().slice(0, 2400);
};

export const extractMetadataWithAI = async (
  firstPageText: string,
  askAI: AskAIFn
): Promise<Partial<ParsedMetadata>> => {
  const prompt = [
    '你是论文首页信息提取器。',
    '请从下面内容提取标题、作者、发布年份、摘要、关键词。',
    '仅返回严格JSON对象，不要markdown，不要解释。',
    '格式：{"title":"","authors":[],"publishedYear":"","abstract":"","keywords":[]}',
    '如果关键词缺失，请返回空数组 []。',
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
  const publishedYear = normalizePublishedYear(parsed?.publishedYear || parsed?.publishedDate);
  const publisher =
    String(parsed?.publisher || parsed?.organization || parsed?.venue || '').trim();
  return {
    ...(title ? { title: title.slice(0, 280) } : {}),
    ...(authorList.length ? { author: authorList.join(', ').slice(0, 200) } : {}),
    ...(abstractText ? { summary: abstractText.slice(0, 2400) } : {}),
    keywords: keywordList.slice(0, 12),
    ...(publishedYear ? { publishedDate: publishedYear } : {}),
    ...(publisher ? { publisher } : {})
  };
};
