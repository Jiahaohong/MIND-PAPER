import {
  extractMetadataWithAI,
  extractPdfFirstPageMetadata,
  extractPdfFirstPageText,
  type OpenSourcePaperMetadata
} from './pdfMetadataService';

export type MetadataSource = 'open_source' | 'local' | 'ai';

type AskAIFn = (payload: {
  prompt: string;
  messages?: Array<{ role: 'user' | 'model'; text: string }>;
}) => Promise<{ ok: boolean; content?: string; error?: string }>;

type ParsedCandidate = {
  title?: string;
  author?: string;
  summary?: string;
  abstract?: string;
  keywords?: string[];
  date?: string;
  publisher?: string;
  doi?: string;
};

export type ResolvedMetadata = {
  title: string;
  author: string;
  summary: string;
  abstract: string;
  keywords: string[];
  date: string;
  publisher: string;
  doi: string;
};

const DEFAULT_PRIORITY: MetadataSource[] = ['open_source', 'local', 'ai'];

export const normalizeMetadataPriority = (raw: unknown): MetadataSource[] => {
  const input = Array.isArray(raw) ? raw : [];
  const next: MetadataSource[] = [];
  for (const item of input) {
    if (item !== 'open_source' && item !== 'local' && item !== 'ai') continue;
    if (!next.includes(item)) next.push(item);
  }
  for (const key of DEFAULT_PRIORITY) {
    if (!next.includes(key)) next.push(key);
  }
  return next.slice(0, 3);
};

const mergeIfEmpty = (target: ResolvedMetadata, candidate: ParsedCandidate) => {
  if (!target.title && candidate.title) target.title = candidate.title;
  if (!target.author && candidate.author) target.author = candidate.author;
  if (!target.summary && candidate.summary) target.summary = candidate.summary;
  if (!target.abstract && (candidate.abstract || candidate.summary)) {
    target.abstract = candidate.abstract || candidate.summary || '';
  }
  if (!target.date && candidate.date) target.date = candidate.date;
  if (!target.publisher && candidate.publisher) target.publisher = candidate.publisher;
  if (!target.doi && candidate.doi) target.doi = candidate.doi;
  if (!target.keywords.length && Array.isArray(candidate.keywords)) {
    target.keywords = candidate.keywords.filter(Boolean);
  }
};

const applyNonEmpty = (target: ResolvedMetadata, candidate: ParsedCandidate) => {
  if (candidate.title) target.title = candidate.title;
  if (candidate.author) target.author = candidate.author;
  if (candidate.summary) target.summary = candidate.summary;
  if (candidate.abstract || candidate.summary) {
    target.abstract = candidate.abstract || candidate.summary || target.abstract;
  }
  if (candidate.date) target.date = candidate.date;
  if (candidate.publisher) target.publisher = candidate.publisher;
  if (candidate.doi) target.doi = candidate.doi;
  if (Array.isArray(candidate.keywords) && candidate.keywords.length) {
    target.keywords = candidate.keywords.filter(Boolean);
  }
};

const cleanAuthorText = (value: string): string => {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^unknown?$/i.test(text) || /^unknow$/i.test(text)) return '';
  text = text
    .replace(/\b(abstract|summary|introduction|keywords?)\b[\s\S]*$/i, '')
    .replace(/[;|]+/g, ',')
    .trim();
  // Keep long author lists, but cut to a manageable prefix instead of dropping all.
  if (text.length > 220) {
    const names = text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (names.length) {
      text = names.join(', ');
    } else {
      text = text.slice(0, 220).trim();
    }
  }
  const suspicious =
    /[.!?。！？]/.test(text) ||
    /\b(we|this paper|propose|method|experiment|results?)\b/i.test(text);
  if (suspicious) {
    const head = text.split(/[\n。！？!?]/)[0].trim();
    if (head && head.length <= 220 && !/\b(we|this paper|propose)\b/i.test(head)) {
      text = head;
    } else {
      return '';
    }
  }
  return text.slice(0, 200).trim();
};

export const resolvePaperMetadata = async (params: {
  fileData: ArrayBuffer;
  fallbackTitle: string;
  fallbackDate: string;
  priority?: unknown;
  parsePdfWithAI?: boolean;
  askAI?: AskAIFn;
  searchOpenSource?: (title: string) => Promise<OpenSourcePaperMetadata | null>;
}): Promise<ResolvedMetadata> => {
  const {
    fileData,
    fallbackTitle,
    fallbackDate,
    priority,
    parsePdfWithAI = false,
    askAI,
    searchOpenSource
  } = params;
  const openSourceSearcher = searchOpenSource;

  const resolved: ResolvedMetadata = {
    title: '',
    author: '',
    summary: '',
    abstract: '',
    keywords: [],
    date: '',
    publisher: '',
    doi: ''
  };
  // Keep parser to accept legacy callers, but resolution flow is fixed now.
  normalizeMetadataPriority(priority);

  let localCandidate: ParsedCandidate | null = null;
  let aiCandidate: ParsedCandidate | null = null;
  let openSourceCandidate: ParsedCandidate | null = null;
  let firstPageText = '';

  const ensureLocal = async (): Promise<ParsedCandidate> => {
    if (localCandidate) return localCandidate;
    const parsed = await extractPdfFirstPageMetadata(fileData, fallbackTitle);
    localCandidate = {
      title: parsed.metadata.title,
      author: cleanAuthorText(parsed.metadata.author || ''),
      summary: parsed.metadata.summary,
      abstract: parsed.metadata.summary,
      keywords: parsed.metadata.keywords,
      date: parsed.metadata.publishedDate,
      publisher: parsed.metadata.publisher
    };
    return localCandidate;
  };

  const ensureAI = async (): Promise<ParsedCandidate | null> => {
    if (aiCandidate) return aiCandidate;
    if (!parsePdfWithAI || !askAI) return null;
    if (!firstPageText) {
      firstPageText = await extractPdfFirstPageText(fileData);
    }
    if (!firstPageText) return null;
    const aiMetadata = await extractMetadataWithAI(firstPageText, askAI);
    aiCandidate = {
      title: aiMetadata.title,
      author: cleanAuthorText(aiMetadata.author || ''),
      summary: aiMetadata.summary,
      abstract: aiMetadata.summary,
      keywords: aiMetadata.keywords,
      date: aiMetadata.publishedDate,
      publisher: aiMetadata.publisher
    };
    return aiCandidate;
  };

  const ensureOpenSource = async (): Promise<ParsedCandidate | null> => {
    if (openSourceCandidate) return openSourceCandidate;
    if (!openSourceSearcher) return null;
    let seedTitle = resolved.title.trim() || String(fallbackTitle || '').trim();
    if (!seedTitle) {
      const local = await ensureLocal().catch(() => null);
      seedTitle = String(local?.title || '').trim();
    }
    if (!seedTitle) return null;
    const remote = await openSourceSearcher(seedTitle);
    if (!remote) return null;
    const rawAuthors = Array.isArray(remote.authors)
      ? remote.authors.map((item) => String(item ?? ''))
      : [];
    openSourceCandidate = {
      // Keep open-source fields as-is (no author cleaning).
      title: String(remote.title ?? ''),
      author: rawAuthors.join(', '),
      date: String(remote.publication_date ?? ''),
      publisher: String(remote.venue ?? ''),
      doi: String(remote.doi ?? '')
    };
    return openSourceCandidate;
  };

  // Fixed flow:
  // 1) local parse baseline
  // 2) API by title overwrite when available
  // 3) if API failed and AI enabled -> AI overwrite
  try {
    const local = await ensureLocal();
    applyNonEmpty(resolved, local);
  } catch (error) {
    console.warn('[metadata-resolver] local failed:', error);
  }

  let apiSuccess = false;
  try {
    const api = await ensureOpenSource();
    if (api) {
      applyNonEmpty(resolved, api);
      apiSuccess = true;
    }
  } catch (error) {
    console.warn('[metadata-resolver] open_source failed:', error);
  }

  if (!apiSuccess && parsePdfWithAI) {
    try {
      const ai = await ensureAI();
      if (ai) applyNonEmpty(resolved, ai);
    } catch (error) {
      console.warn('[metadata-resolver] ai failed:', error);
    }
  }

  if (!resolved.title) resolved.title = fallbackTitle;
  if (!resolved.author) resolved.author = 'Unknown';
  if (!resolved.summary) resolved.summary = 'Uploaded PDF';
  if (!resolved.abstract) resolved.abstract = resolved.summary;
  if (!resolved.date) resolved.date = fallbackDate;
  return resolved;
};
