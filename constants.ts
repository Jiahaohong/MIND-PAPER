import { Folder, Paper, TOCItem } from './types';

export const SYSTEM_FOLDER_ALL_ID = 'system-all';
export const SYSTEM_FOLDER_TRASH_ID = 'system-trash';

export const INITIAL_FOLDERS: Folder[] = [
  {
    id: SYSTEM_FOLDER_ALL_ID,
    name: '所有文档',
    parentId: null,
    children: [],
  },
  {
    id: SYSTEM_FOLDER_TRASH_ID,
    name: '回收站',
    parentId: null,
    children: [],
  },
];

export const MOCK_PAPERS: Paper[] = [];

export const MOCK_TOC: TOCItem[] = [
  {
    id: '1',
    title: '1. Introduction',
    page: 1,
    children: [
      { id: '1.1', title: '1.1 Background', page: 1 },
      { id: '1.2', title: '1.2 Motivation', page: 2 },
    ],
  },
  {
    id: '2',
    title: '2. Architecture',
    page: 3,
    children: [
      { id: '2.1', title: '2.1 Encoder Stack', page: 3 },
      { id: '2.2', title: '2.2 Decoder Stack', page: 4 },
      { id: '2.3', title: '2.3 Attention Mechanism', page: 5 },
    ],
  },
  {
    id: '3',
    title: '3. Experiments',
    page: 7,
    children: [],
  },
  {
    id: '4',
    title: '4. Conclusion',
    page: 10,
    children: [],
  },
];

export const SUGGESTED_QUESTIONS = [
  "What is the main contribution of this paper?",
  "How does the proposed method differ from previous approaches?",
  "What were the limitations of the study?",
];
