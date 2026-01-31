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
  folderId: string;
  previousFolderId?: string;
  summary: string;
  content: string; // Mock content
  keywords: string[];
  fileUrl?: string;
  fileData?: ArrayBuffer;
  filePath?: string;
}

export interface TOCItem {
  id: string;
  title: string;
  page: number;
  children?: TOCItem[];
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
