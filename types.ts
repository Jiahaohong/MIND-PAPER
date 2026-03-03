export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  children: Folder[];
}

export interface Paper {
  id: string;
  title: string;
  author: string;
  date: string;
  addedDate?: string;
  uploadedAt?: number;
  folderId: string;
  previousFolderId?: string;
  summary: string;
  abstract?: string;
  content: string; // Mock content
  method?: string;
  keywords: string[];
  publisher?: string;
  doi?: string;
  version?: number;
  baseVersion?: number;
  updatedAt?: number;
  references?: PaperReference[];
  referenceStats?: {
    totalOpenAlex: number;
    totalSemanticScholar: number;
    intersectionCount: number;
    finalCount?: number;
    matchedCount?: number;
  };
  fileUrl?: string;
  fileData?: ArrayBuffer;
  filePath?: string;
  isParsing?: boolean;
  isBackgroundProcessing?: boolean;
  backgroundTask?: string;
  isRewritingSummary?: boolean;
  isVectorizing?: boolean;
  summaryRewriteDone?: boolean;
  vectorizationDone?: boolean;
}

export interface TOCItem {
  id: string;
  title: string;
  page: number;
  children?: TOCItem[];
}

export interface PaperReference {
  refId: string;
  title: string;
  order?: number;
  source: 'api' | 'local' | 'merged';
  matchedPaperId?: string;
  matchedTitle?: string;
  matchScore?: number;
}

export type DocNodeKind =
  | 'root'
  | 'native_chapter'
  | 'highlight_chapter'
  | 'highlight_note'
  | 'normal_chapter'
  | 'normal_note';

export interface DocNodeRect {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DocNode {
  id: string;
  paperId: string;
  kind: DocNodeKind;
  parentId: string | null;
  order: number;
  text: string;
  pageIndex?: number | null;
  topRatio?: number | null;
  color?: string;
  translation?: string;
  questionIds?: string[];
  source?: 'pdf' | 'manual';
  sourceId?: string;
  chapterNodeId?: string | null;
  rects?: DocNodeRect[];
  version?: number;
  baseVersion?: number;
  updatedAt?: number;
  isDeleted?: boolean;
}

export enum ReaderMode {
  PDF = 'PDF',
  MIND_MAP = 'MIND_MAP',
}

export enum AssistantTab {
  QUESTIONS = 'QUESTIONS',
  INFO = 'INFO',
  AI = 'AI',
}

export interface Message {
  role: 'user' | 'model';
  text: string;
}
