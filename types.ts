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
