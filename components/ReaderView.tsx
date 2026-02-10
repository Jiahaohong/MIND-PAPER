import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  FileText, 
  Network, 
  ZoomIn, 
  ZoomOut, 
  MessageSquare, 
  Info, 
  Sparkles,
  Send,
  ArrowLeft,
  List,
  X,
  Ban,
  Plus,
  Pencil,
  RefreshCw
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Paper, TOCItem, ReaderMode, AssistantTab, Message } from '../types';
import { MOCK_TOC } from '../constants';
import type { MindMapLayout, MindMapNode } from './MindMap';
import { Tooltip } from './Tooltip';
import {
  extractMetadataWithAI,
  extractPdfFirstPageMetadata,
  extractPdfFirstPageText,
  extractPdfMetadataFromTextItems
} from '../services/pdfMetadataService';

const LazyMindMap = React.lazy(() =>
  import('./MindMap').then((mod) => ({ default: mod.MindMap }))
);
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

type OutlineNode = {
  id: string;
  title: string;
  pageIndex: number | null;
  topRatio: number | null;
  items: OutlineNode[];
  isRoot?: boolean;
  isCustom?: boolean;
  parentId?: string | null;
  createdAt?: number;
  order?: number;
};

type HighlightRect = {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

type HighlightItem = {
  id: string;
  text: string;
  color: string;
  pageIndex: number;
  rects: HighlightRect[];
  chapterId: string;
  isChapterTitle: boolean;
  chapterNodeId?: string | null;
  translation?: string;
  questionIds?: string[];
  source?: 'pdf' | 'manual';
  order?: number;
};

type ChatThread = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

const HIGHLIGHT_COLORS = [
  { id: 'sun', swatch: '#facc15', fill: 'rgba(250, 204, 21, 0.45)' },
  { id: 'peach', swatch: '#fb923c', fill: 'rgba(251, 146, 60, 0.4)' },
  { id: 'mint', swatch: '#34d399', fill: 'rgba(52, 211, 153, 0.35)' },
  { id: 'sky', swatch: '#60a5fa', fill: 'rgba(96, 165, 250, 0.35)' },
  { id: 'rose', swatch: '#f87171', fill: 'rgba(248, 113, 113, 0.35)' }
];

const toSolidColor = (fill: string) => {
  const match = fill.match(/rgba?\(([^)]+)\)/);
  if (!match) return fill;
  const parts = match[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return fill;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
};

const resolveOutlineDestination = async (
  doc: PDFDocumentProxy,
  dest: unknown,
  pageViewports: Map<number, any>
) => {
  if (!dest) return { pageIndex: null as number | null, topRatio: null as number | null };
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) {
      return { pageIndex: null, topRatio: null };
    }
    const pageRef = resolved[0];
    let pageIndex: number | null = null;
    if (typeof pageRef === 'number') {
      pageIndex = pageRef;
    } else {
      try {
        pageIndex = await doc.getPageIndex(pageRef);
      } catch {
        pageIndex = null;
      }
    }
    if (pageIndex == null) return { pageIndex: null, topRatio: null };

    const destType = resolved[1]?.name || resolved[1]?.toString?.() || '';
    let top: number | null = null;
    if (destType === 'XYZ') {
      top = typeof resolved[3] === 'number' ? resolved[3] : null;
    } else if (destType === 'FitH' || destType === 'FitBH') {
      top = typeof resolved[2] === 'number' ? resolved[2] : null;
    }
    if (top == null) return { pageIndex, topRatio: null };

    let viewport = pageViewports.get(pageIndex);
    if (!viewport) {
      const page = await doc.getPage(pageIndex + 1);
      viewport = page.getViewport({ scale: 1 });
      pageViewports.set(pageIndex, viewport);
    }
    const [, y] = viewport.convertToViewportPoint(0, top);
    const topPx = Math.max(0, y);
    const topRatio = viewport.height ? Math.max(0, Math.min(1, topPx / viewport.height)) : null;
    return { pageIndex, topRatio };
  } catch {
    return { pageIndex: null, topRatio: null };
  }
};

const buildOutlineTree = async (
  doc: PDFDocumentProxy,
  items: any[],
  parentId = '',
  pageViewports: Map<number, any> = new Map()
): Promise<OutlineNode[]> => {
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
        topRatio: destInfo.topRatio,
        items: children
      } as OutlineNode;
    })
  );

  return nodes.filter((node) => node.title || node.items.length);
};

interface ReaderViewProps {
  paper: Paper;
  pdfFile: { data: ArrayBuffer } | string | null;
  onBack: () => void;
  onUpdatePaper: (paperId: string, updates: Partial<Paper>) => void;
}

export const ReaderView: React.FC<ReaderViewProps> = ({ paper, pdfFile, onBack, onUpdatePaper }) => {
  const MIN_SIDE_WIDTH = 120;
  const MIN_CENTER_WIDTH = 120;
  const RESIZE_HANDLE_WIDTH = 4;
  const DEFAULT_LEFT_RATIO = 0.2;
  const DEFAULT_RIGHT_RATIO = 0.3;
  const CHAPTER_START_TOLERANCE = 0.03;

  // State
  const [viewMode, setViewMode] = useState<ReaderMode>(ReaderMode.PDF);
  const [activeTab, setActiveTab] = useState<AssistantTab>(AssistantTab.QUESTIONS);
  const [pdfZoom, setPdfZoom] = useState(100);
  const [mindmapZoom, setMindmapZoom] = useState(100);
  const [expandedTOC, setExpandedTOC] = useState<Set<string>>(new Set(['1', '2']));
  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(200);
  const [numPages, setNumPages] = useState<number>(0);
  const [outlineNodes, setOutlineNodes] = useState<OutlineNode[]>([]);
  const [customChapters, setCustomChapters] = useState<OutlineNode[]>([]);
  const [selectionText, setSelectionText] = useState('');
  const [selectionRect, setSelectionRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<{ pageIndex: number; rects: HighlightRect[]; text: string } | null>(null);
  const [suppressTranslation, setSuppressTranslation] = useState(false);
  const [highlights, setHighlights] = useState<HighlightItem[]>([]);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [activeHighlightColor, setActiveHighlightColor] = useState<string | null>(null);
  const [translationResult, setTranslationResult] = useState('');
  const [activeMindmapNodeId, setActiveMindmapNodeId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Array<{ id: string; text: string }>>([]);
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [questionGenerateError, setQuestionGenerateError] = useState('');
  const [expandedQuestions, setExpandedQuestions] = useState<Record<string, boolean>>({});
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [questionDraft, setQuestionDraft] = useState('');
  const questionEditRef = useRef<{ id: string | null; originalText: string; isNew: boolean }>({
    id: null,
    originalText: '',
    isNew: false
  });
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const [questionPicker, setQuestionPicker] = useState<{
    open: boolean;
    highlightId: string | null;
    selectionInfo: { pageIndex: number; rects: HighlightRect[]; text: string } | null;
    selectionText: string;
  }>({
    open: false,
    highlightId: null,
    selectionInfo: null,
    selectionText: ''
  });
  
  // Chat State
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [askPaperEnabled, setAskPaperEnabled] = useState(true);
  const [collapsedMindmapIds, setCollapsedMindmapIds] = useState<Set<string>>(new Set());
  const [mindmapOffset, setMindmapOffset] = useState({ x: 0, y: 0 });
  const [isMindmapPanning, setIsMindmapPanning] = useState(false);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [draggingChapterId, setDraggingChapterId] = useState<string | null>(null);
  const [dragOverMindmapId, setDragOverMindmapId] = useState<string | null>(null);
  const [draggingTocNoteId, setDraggingTocNoteId] = useState<string | null>(null);
  const [draggingTocChapterId, setDraggingTocChapterId] = useState<string | null>(null);
  const [dragOverTocId, setDragOverTocId] = useState<string | null>(null);
  const [mindmapEditing, setMindmapEditing] = useState<{
    nodeId: string;
    kind: 'note' | 'chapter';
    targetId: string;
  } | null>(null);
  const [mindmapEditValue, setMindmapEditValue] = useState('');
  const [dragGhost, setDragGhost] = useState<{
    id: string;
    text: string;
    color?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    lines?: string[];
    fontSize?: number;
    lineHeight?: number;
  } | null>(null);
  const [chapterParentOverrides, setChapterParentOverrides] = useState<Record<string, string>>({});
  const [expandedHighlightIds, setExpandedHighlightIds] = useState<Set<string>>(new Set());
  const mindmapZoomScale = mindmapZoom / 100;
  const [infoRefreshing, setInfoRefreshing] = useState(false);
  const [infoRefreshError, setInfoRefreshError] = useState('');

  const formatDateYmd = (value: string) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const zhMatch = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (zhMatch) {
      return `${Number(zhMatch[1])}/${Number(zhMatch[2])}/${Number(zhMatch[3])}`;
    }
    const zhMonth = raw.match(/(\d{4})年(\d{1,2})月/);
    if (zhMonth) {
      return `${Number(zhMonth[1])}/${Number(zhMonth[2])}/1`;
    }
    if (/^\d{4}$/.test(raw)) return `${raw}/1/1`;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return `${parsed.getFullYear()}/${parsed.getMonth() + 1}/${parsed.getDate()}`;
  };
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const translateRequestRef = useRef(0);
  const translationCacheRef = useRef<Map<string, string>>(new Map());
  const pendingTranslationTextRef = useRef<string | null>(null);
  const saveStateTimerRef = useRef<number | null>(null);
  const paperStateLoadedRef = useRef(false);
  const pdfScrollTopRef = useRef(0);
  const mindmapLayoutRef = useRef<MindMapLayout | null>(null);
  const mindmapAnchorRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const mindmapPanRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );
  const mindmapStateRef = useRef<{
    collapsedIds: string[];
    offset: { x: number; y: number };
    chapterParentOverrides: Record<string, string>;
  } | null>(null);
  const dragNoteTimerRef = useRef<number | null>(null);
  const dragNoteRef = useRef<{
    id: string;
    chapterId: string;
    text: string;
    color?: string;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    lines?: string[];
    fontSize?: number;
    lineHeight?: number;
  } | null>(null);
  const dragNoteTriggeredRef = useRef(false);
  const dragChapterTimerRef = useRef<number | null>(null);
  const dragChapterRef = useRef<{
    id: string;
    parentId: string | null;
    text: string;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    lines?: string[];
    fontSize?: number;
    lineHeight?: number;
  } | null>(null);
  const dragChapterTriggeredRef = useRef(false);
  const tocDragNoteTimerRef = useRef<number | null>(null);
  const tocDragNoteRef = useRef<{
    id: string;
    chapterId: string;
    text: string;
    color?: string;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    lines?: string[];
    fontSize?: number;
    lineHeight?: number;
  } | null>(null);
  const tocDragNoteTriggeredRef = useRef(false);
  const tocDragChapterTimerRef = useRef<number | null>(null);
  const tocDragChapterRef = useRef<{
    id: string;
    parentId: string | null;
    text: string;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    lines?: string[];
    fontSize?: number;
    lineHeight?: number;
  } | null>(null);
  const tocDragChapterTriggeredRef = useRef(false);
  const tocSuppressClickUntilRef = useRef(0);
  const tocParentMapRef = useRef<Map<string, string | null>>(new Map());
  const dragStateRef = useRef<{ side: 'left' | 'right'; startX: number; start: number } | null>(null);
  const hasInitWidthsRef = useRef(false);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const questionPickerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const paperContextCacheRef = useRef<Map<string, Promise<string>>>(new Map());
  const activeChat = useMemo(
    () => chatThreads.find((thread) => thread.id === activeChatId) || null,
    [chatThreads, activeChatId]
  );
  const sortedChatThreads = useMemo(
    () => [...chatThreads].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatThreads]
  );

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeChat?.messages]);

  useEffect(() => {
    if (hasInitWidthsRef.current) return;
    let rafId = 0;
    let attempts = 0;

    const initWidths = () => {
      const container = containerRef.current;
      if (!container) return;
      const total = container.clientWidth - RESIZE_HANDLE_WIDTH * 2;
      if (total <= 0 && attempts < 5) {
        attempts += 1;
        rafId = window.requestAnimationFrame(initWidths);
        return;
      }
      if (total > 0) {
        setLeftWidth(Math.round(total * DEFAULT_LEFT_RATIO));
        setRightWidth(Math.round(total * DEFAULT_RIGHT_RATIO));
        hasInitWidthsRef.current = true;
      }
    };

    initWidths();
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    const container = contentAreaRef.current;
    if (!container) return;
    if (viewMode !== ReaderMode.PDF) return;
    const targetTop = pdfScrollTopRef.current;
    const rafId = window.requestAnimationFrame(() => {
      container.scrollTop = targetTop;
      window.requestAnimationFrame(() => {
        container.scrollTop = targetTop;
      });
    });
    const timeoutId = window.setTimeout(() => {
      container.scrollTop = targetTop;
    }, 80);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [viewMode, numPages]);

  useEffect(() => {
    if (viewMode === ReaderMode.MIND_MAP) {
      const saved = mindmapStateRef.current;
      if (saved) {
        setCollapsedMindmapIds(new Set(saved.collapsedIds));
        setMindmapOffset(saved.offset);
        setChapterParentOverrides(saved.chapterParentOverrides);
      }
      return;
    }
    mindmapStateRef.current = {
      collapsedIds: Array.from(collapsedMindmapIds),
      offset: mindmapOffset,
      chapterParentOverrides
    };
  }, [viewMode]);

  const handleContentScroll = () => {
    if (viewMode !== ReaderMode.PDF) return;
    const container = contentAreaRef.current;
    if (container) {
      pdfScrollTopRef.current = container.scrollTop;
    }
  };

  const switchViewMode = (nextMode: ReaderMode) => {
    if (nextMode === viewMode) return;
    if (viewMode === ReaderMode.PDF) {
      const container = contentAreaRef.current;
      if (container) {
        pdfScrollTopRef.current = container.scrollTop;
      }
    }
    setViewMode(nextMode);
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const containerWidth = containerRef.current?.clientWidth ?? 0;
      const delta = e.clientX - drag.startX;
      if (drag.side === 'left') {
        const maxLeft = containerWidth
          ? Math.max(MIN_SIDE_WIDTH, containerWidth - rightWidth - MIN_CENTER_WIDTH - RESIZE_HANDLE_WIDTH * 2)
          : 360;
        const next = Math.max(MIN_SIDE_WIDTH, Math.min(maxLeft, drag.start + delta));
        setLeftWidth(next);
      } else {
        const maxRight = containerWidth
          ? Math.max(MIN_SIDE_WIDTH, containerWidth - leftWidth - MIN_CENTER_WIDTH - RESIZE_HANDLE_WIDTH * 2)
          : 360;
        const next = Math.max(MIN_SIDE_WIDTH, Math.min(maxRight, drag.start - delta));
        setRightWidth(next);
      }
    };

    const handleUp = () => {
      dragStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  // Handlers
  const toggleTOC = (id: string) => {
    const next = new Set(expandedTOC);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedTOC(next);
  };

  const createNewChat = () => {
    const now = Date.now();
    const nextId = `chat-${now}-${Math.random().toString(16).slice(2)}`;
    const nextThread: ChatThread = {
      id: nextId,
      title: '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    setChatThreads((prev) => [nextThread, ...prev]);
    setActiveChatId(nextId);
    setInput('');
    return nextId;
  };

  const deleteChat = (chatId: string) => {
    setChatThreads((prev) => prev.filter((item) => item.id !== chatId));
    setActiveChatId((prev) => (prev === chatId ? null : prev));
    setInput('');
  };

  const getPaperContext = useCallback(async () => {
    const cachedTask = paperContextCacheRef.current.get(paper.id);
    if (cachedTask) return cachedTask;
    const task = (async () => {
      const doc = pdfDocRef.current;
      if (doc) {
        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          const page = await doc.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (pageText) {
            pages.push(`[Page ${pageNumber}] ${pageText}`);
          }
        }
        const fullText = pages.join('\n\n');
        if (fullText) return fullText.slice(0, 120000);
      }
      const fallback = [paper.title, paper.summary, paper.content]
        .filter(Boolean)
        .join('\n\n')
        .trim();
      return fallback.slice(0, 120000);
    })();
    paperContextCacheRef.current.set(paper.id, task);
    return task;
  }, [paper.content, paper.id, paper.summary, paper.title]);

  const parseQuestionSuggestions = (raw: string) => {
    const pickQuestionText = (item: unknown): string => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const obj = item as Record<string, unknown>;
      const candidates = [obj.question, obj.text, obj.title, obj.q];
      for (const value of candidates) {
        const next = String(value || '').trim();
        if (next) return next;
      }
      return '';
    };

    const toQuestions = (payload: unknown): string[] => {
      if (Array.isArray(payload)) {
        return payload.map(pickQuestionText).filter(Boolean).slice(0, 5);
      }
      if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        if (Array.isArray(obj.questions)) {
          return obj.questions.map(pickQuestionText).filter(Boolean).slice(0, 5);
        }
        if (Array.isArray(obj.data)) {
          return obj.data.map(pickQuestionText).filter(Boolean).slice(0, 5);
        }
      }
      return [];
    };

    const extractJsonCandidate = (text: string) => {
      const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
      }
      const firstArray = text.indexOf('[');
      const lastArray = text.lastIndexOf(']');
      if (firstArray !== -1 && lastArray > firstArray) {
        return text.slice(firstArray, lastArray + 1).trim();
      }
      const firstObject = text.indexOf('{');
      const lastObject = text.lastIndexOf('}');
      if (firstObject !== -1 && lastObject > firstObject) {
        return text.slice(firstObject, lastObject + 1).trim();
      }
      return text.trim();
    };

    const text = String(raw || '').trim();
    if (!text) return [] as string[];

    const jsonCandidate = extractJsonCandidate(text);
    try {
      const parsed = JSON.parse(jsonCandidate);
      const fromJson = toQuestions(parsed);
      if (fromJson.length) return fromJson;
    } catch {
      // fallback below
    }

    // Handle malformed JSON-like output such as repeated `"问题": "..."` lines.
    const questionMatches = Array.from(
      text.matchAll(/"(?:问题|question|Question)"\s*:\s*"([^"]+)"/g)
    )
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    if (questionMatches.length) return questionMatches;

    return text
      .split('\n')
      .map((line) => line.replace(/^\s*[-*\d.、)\]]+\s*/, '').trim())
      .filter((line) => {
        if (!line) return false;
        if (/^[\[\]{},"']+$/.test(line)) return false;
        if (/^(question|focus|method|title|text)\s*[:：]?\s*$/i.test(line)) return false;
        return true;
      })
      .slice(0, 5);
  };

  const handleGenerateQuestions = async () => {
    if (isGeneratingQuestions) return;
    setQuestionGenerateError('');
    setIsGeneratingQuestions(true);
    try {
      if (typeof window === 'undefined' || !window.electronAPI?.askAI) {
        throw new Error('AI功能仅支持桌面端，请检查预加载配置。');
      }
      const paperContext = await getPaperContext();
      const prompt = [
        '你是论文阅读助手。',
        '请基于下面论文内容，提出3到5个可以帮助读者理解论文的关键问题。',
        '要求：',
        '1. 问题具体、可回答；',
        '2. 覆盖方法、贡献、实验或局限中的核心点；',
        '3. 问题必须使用简体中文。',
        '4. 只返回严格JSON，不要Markdown代码块，不要```json前缀，不要解释。',
        '5. 输出格式必须是：{"questions":["问题1","问题2","问题3"]}。',
        '',
        '【论文内容】',
        paperContext || [paper.title, paper.summary, paper.content].filter(Boolean).join('\n\n')
      ].join('\n');
      const aiResponse = await window.electronAPI.askAI({ prompt, messages: [] });
      if (!aiResponse?.ok) {
        throw new Error(aiResponse?.error || 'AI提问生成失败');
      }
      const parsed = parseQuestionSuggestions(aiResponse.content || '');
      if (!parsed.length) {
        throw new Error('AI未返回有效问题，请重试');
      }
      const now = Date.now();
      setQuestions(
        parsed.map((text, index) => ({
          id: `q-ai-${now}-${index}`,
          text
        }))
      );
    } catch (error: any) {
      setQuestionGenerateError(error?.message || 'AI提问生成失败');
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim()) return;
    const userText = input.trim();
    const userMsg: Message = { role: 'user', text: userText };
    const targetChatId = activeChatId || createNewChat();
    const existingMessages =
      chatThreads.find((thread) => thread.id === targetChatId)?.messages || [];
    setChatThreads((prev) =>
      prev.map((thread) => {
        if (thread.id !== targetChatId) return thread;
        return {
          ...thread,
          title: thread.messages.length ? thread.title : userText.slice(0, 40),
          messages: [...thread.messages, userMsg],
          updatedAt: Date.now()
        };
      })
    );
    setInput('');
    setIsTyping(true);

    try {
      let finalPrompt = userText;
      if (askPaperEnabled) {
        const paperContext = await getPaperContext();
        finalPrompt = paperContext
          ? [
              '你将收到一篇论文内容和用户问题。',
              '请优先依据论文内容回答；若论文内容不足，可补充你自身知识并明确说明。',
              '',
              '【论文内容】',
              paperContext,
              '',
              '【用户问题】',
              userText
            ].join('\n')
          : userText;
      }

      if (typeof window === 'undefined' || !window.electronAPI?.askAI) {
        throw new Error('AI功能仅支持桌面端，请检查预加载配置。');
      }
      const contextMessages = [...existingMessages, userMsg].map((item) => ({
        role: item.role,
        text: item.text
      }));
      const aiResponse = await window.electronAPI.askAI({
        prompt: finalPrompt,
        messages: contextMessages
      });
      if (!aiResponse?.ok) {
        throw new Error(aiResponse?.error || 'AI请求失败');
      }
      const content = String(aiResponse.content || '').trim();
      setChatThreads((prev) =>
        prev.map((thread) => {
          if (thread.id !== targetChatId) return thread;
          return {
            ...thread,
            messages: [...thread.messages, { role: 'model', text: content || 'AI 未返回内容。' }],
            updatedAt: Date.now()
          };
        })
      );
    } catch (e) {
      const errorText = e instanceof Error ? e.message : 'AI请求失败';
      setChatThreads((prev) =>
        prev.map((thread) => {
          if (thread.id !== targetChatId) return thread;
          return {
            ...thread,
            messages: [...thread.messages, { role: 'model', text: `请求失败：${errorText}` }],
            updatedAt: Date.now()
          };
        })
      );
    } finally {
      setIsTyping(false);
    }
  };

  const handleRefreshMetadata = async () => {
    if (infoRefreshing) return;
    setInfoRefreshing(true);
    setInfoRefreshError('');
    try {
      let parseWithAI = false;
      let canUseAI = false;
      if (typeof window !== 'undefined' && window.electronAPI?.settingsGet) {
        const settings = await window.electronAPI.settingsGet();
        parseWithAI = Boolean(settings?.parsePdfWithAI);
        canUseAI = Boolean(settings?.apiKey?.trim()) && Boolean(window.electronAPI?.askAI);
      }

      const fallbackTitle = paper.title || 'Document';
      let updates: Partial<Paper> = {};

      if (parseWithAI && canUseAI) {
        let firstPageText = '';
        if (pdfDocRef.current) {
          const page = await pdfDocRef.current.getPage(1);
          const textContent = await page.getTextContent();
          const parsed = extractPdfMetadataFromTextItems(textContent.items, fallbackTitle);
          firstPageText = parsed.firstPageText;
        } else if (pdfFile && typeof pdfFile !== 'string' && pdfFile.data) {
          firstPageText = await extractPdfFirstPageText(pdfFile.data);
        } else if (typeof pdfFile === 'string') {
          const response = await fetch(pdfFile);
          const buffer = await response.arrayBuffer();
          firstPageText = await extractPdfFirstPageText(buffer);
        }

        if (!firstPageText) {
          throw new Error('无法读取PDF首页内容');
        }
        const aiMetadata = await extractMetadataWithAI(firstPageText, window.electronAPI!.askAI!);
        updates = {
          ...(aiMetadata.title ? { title: aiMetadata.title } : {}),
          ...(aiMetadata.author ? { author: aiMetadata.author } : {}),
          ...(aiMetadata.summary ? { summary: aiMetadata.summary } : {}),
          ...(aiMetadata.keywords ? { keywords: aiMetadata.keywords } : {}),
          ...(aiMetadata.publishedDate ? { date: aiMetadata.publishedDate } : {}),
          ...(aiMetadata.publisher ? { publisher: aiMetadata.publisher } : {})
        };
      } else {
        let parsed: { metadata: any } | null = null;
        if (pdfDocRef.current) {
          const page = await pdfDocRef.current.getPage(1);
          const textContent = await page.getTextContent();
          parsed = extractPdfMetadataFromTextItems(textContent.items, fallbackTitle);
        } else if (pdfFile && typeof pdfFile !== 'string' && pdfFile.data) {
          parsed = await extractPdfFirstPageMetadata(pdfFile.data, fallbackTitle);
        } else if (typeof pdfFile === 'string') {
          const response = await fetch(pdfFile);
          const buffer = await response.arrayBuffer();
          parsed = await extractPdfFirstPageMetadata(buffer, fallbackTitle);
        }
        if (!parsed) {
          throw new Error('无法读取PDF首页内容');
        }
        const meta = parsed.metadata || {};
        updates = {
          ...(meta.title ? { title: meta.title } : {}),
          ...(meta.author ? { author: meta.author } : {}),
          ...(meta.summary ? { summary: meta.summary } : {}),
          ...(meta.keywords ? { keywords: meta.keywords } : {}),
          ...(meta.publishedDate ? { date: meta.publishedDate } : {}),
          ...(meta.publisher ? { publisher: meta.publisher } : {})
        };
      }

      if (Object.keys(updates).length) {
        onUpdatePaper(paper.id, updates);
      }
    } catch (error: any) {
      setInfoRefreshError(error?.message || '解析失败');
    } finally {
      setInfoRefreshing(false);
    }
  };

  useEffect(() => {
    pdfDocRef.current = null;
  }, [paper.id]);

  const clearSelection = () => {
    setSelectionText('');
    setSelectionRect(null);
    setSelectionInfo(null);
    setActiveHighlightId(null);
    setActiveHighlightColor(null);
    setTranslationResult('');
    setSuppressTranslation(false);
  };

  const clearNativeSelection = () => {
    if (typeof window === 'undefined') return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  };

  const normalizeTranslationText = (value: string) =>
    String(value || '').replace(/\s+/g, ' ').trim();

  const requestTranslation = async (text: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.translateText) {
      throw new Error('翻译不可用，请在桌面端使用');
    }
    const response = await window.electronAPI.translateText({ text });
    if (!response?.ok) {
      throw new Error(response?.error || '翻译失败');
    }
    return response.content || '';
  };

  useEffect(() => {
    if (suppressTranslation) {
      translateRequestRef.current += 1;
      setTranslationResult('');
      pendingTranslationTextRef.current = null;
      return;
    }
    const source = normalizeTranslationText(selectionText);
    if (!source) {
      translateRequestRef.current += 1;
      setTranslationResult('');
      pendingTranslationTextRef.current = null;
      return;
    }

    if (activeHighlightId) {
      const activeNote = highlights.find((item) => item.id === activeHighlightId);
      if (activeNote && !activeNote.isChapterTitle) {
        const noteText = normalizeTranslationText(activeNote.text);
        if (noteText && noteText === source && activeNote.translation) {
          setTranslationResult(activeNote.translation);
          return;
        }
      }
    }

    const cached = translationCacheRef.current.get(source);
    const targetPageIndex = selectionInfo?.pageIndex ?? null;
    if (cached) {
      setTranslationResult(cached);
      setHighlights((prev) =>
        prev.map((item) => {
          if (item.isChapterTitle) return item;
          if (item.text !== source) return item;
          if (targetPageIndex !== null && item.pageIndex !== targetPageIndex) return item;
          if (item.translation === cached) return item;
          return { ...item, translation: cached };
        })
      );
      return;
    }

    if (pendingTranslationTextRef.current === source) {
      return;
    }

    setTranslationResult(source);
    const requestId = translateRequestRef.current + 1;
    translateRequestRef.current = requestId;
    pendingTranslationTextRef.current = source;

    const run = async () => {
      try {
        const content = await requestTranslation(source);
        if (translateRequestRef.current !== requestId) return;
        const finalText = String(content || '').trim() || '未返回翻译结果';
        translationCacheRef.current.set(source, finalText);
        setTranslationResult(finalText);
        setHighlights((prev) =>
          prev.map((item) => {
            if (item.isChapterTitle) return item;
            if (item.text !== source) return item;
            if (targetPageIndex !== null && item.pageIndex !== targetPageIndex) return item;
            if (item.translation === finalText) return item;
            return { ...item, translation: finalText };
          })
        );
      } catch (error) {
        if (translateRequestRef.current !== requestId) return;
        setTranslationResult(error?.message || '翻译失败');
      } finally {
        if (translateRequestRef.current !== requestId) return;
        pendingTranslationTextRef.current = null;
      }
    };

    run();
  }, [selectionText, selectionInfo?.pageIndex, suppressTranslation, activeHighlightId, highlights]);

  const findChapterForPosition = (
    pageIndex: number,
    topRatio: number,
    sourceList?: OutlineNode[]
  ) => {
    const list = sourceList && sourceList.length ? sourceList : highlightParentOutline;
    if (!list.length || pageIndex == null) return null;
    const ratio = typeof topRatio === 'number' ? topRatio : 0;
    let candidate: OutlineNode | null = null;
    list.forEach((node) => {
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
      const samePageHeadings = list
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

  const findParentChapterId = (pageIndex: number, topRatio: number) => {
    const chapter = findChapterForPosition(pageIndex, topRatio);
    if (chapter?.id) return chapter.id;
    return outlineRootId || `outline-root-${paper.id}`;
  };

  const buildHighlightFromSelection = (
    color: string,
    options: Partial<HighlightItem> = {}
  ) => {
    if (!selectionInfo || !selectionText) return;
    const topRatio = selectionInfo.rects.length
      ? Math.min(...selectionInfo.rects.map((rect) => rect.y))
      : 0;
    const chapterId = findParentChapterId(selectionInfo.pageIndex, topRatio);
    const cachedTranslation = translationCacheRef.current.get(
      normalizeTranslationText(selectionText)
    );
    const base: HighlightItem = {
      id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: selectionText,
      color,
      pageIndex: selectionInfo.pageIndex,
      rects: selectionInfo.rects,
      chapterId,
      isChapterTitle: false,
      translation: cachedTranslation || undefined,
      source: 'pdf',
      ...options
    } as HighlightItem;
    let nextOrder = base.order;
    if (typeof nextOrder !== 'number' && !base.isChapterTitle) {
      nextOrder = getCombinedOrderValue(base.chapterId);
    }
    return { ...base, order: nextOrder };
  };

  const buildHighlightFromSelectionData = (
    color: string,
    info: { pageIndex: number; rects: HighlightRect[]; text: string } | null,
    text: string,
    options: Partial<HighlightItem> = {}
  ) => {
    if (!info || !text) return null;
    const topRatio = info.rects.length
      ? Math.min(...info.rects.map((rect) => rect.y))
      : 0;
    const chapterId = findParentChapterId(info.pageIndex, topRatio);
    const cachedTranslation = translationCacheRef.current.get(
      normalizeTranslationText(text)
    );
    const base: HighlightItem = {
      id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      color,
      pageIndex: info.pageIndex,
      rects: info.rects,
      chapterId,
      isChapterTitle: false,
      translation: cachedTranslation || undefined,
      source: 'pdf',
      ...options
    } as HighlightItem;
    let nextOrder = base.order;
    if (typeof nextOrder !== 'number' && !base.isChapterTitle) {
      nextOrder = getCombinedOrderValue(base.chapterId);
    }
    return { ...base, order: nextOrder };
  };

  const isManualHighlight = (item: HighlightItem) => {
    if (item.source === 'manual') return true;
    if (item.source === 'pdf') return false;
    const rects = Array.isArray(item.rects) ? item.rects : [];
    if (!rects.length) return true;
    return rects.every((rect) => Number(rect.w || 0) === 0 && Number(rect.h || 0) === 0);
  };

  const findParentNode = (
    nodes: OutlineNode[],
    targetId: string,
    parent: OutlineNode | null = null
  ): OutlineNode | null => {
    for (const node of nodes) {
      if (node.id === targetId) return parent;
      if (node.items?.length) {
        const found = findParentNode(node.items, targetId, node);
        if (found) return found;
      }
    }
    return null;
  };

  const resolveParentForChapter = (chapterId: string) => {
    const custom = customChapters.find((item) => item.id === chapterId);
    if (custom?.parentId) return custom.parentId;
    const parentNode = findParentNode(outlineDisplay, chapterId, null);
    return parentNode?.id || outlineRootId;
  };

  const detachCustomChapter = (
    chapterId: string,
    options?: { keepHighlightId?: string; keepHighlightColor?: string }
  ) => {
    const parentId = resolveParentForChapter(chapterId);
    setCustomChapters((prev) =>
      prev
        .filter((item) => item.id !== chapterId)
        .map((item) =>
          item.parentId === chapterId ? { ...item, parentId } : item
        )
    );
    setHighlights((prev) =>
      prev
        .filter((item) => {
          if (options?.keepHighlightId) return true;
          return !(item.isChapterTitle && item.chapterNodeId === chapterId);
        })
        .map((item) => {
          if (options?.keepHighlightId && item.id === options.keepHighlightId) {
            return {
              ...item,
              isChapterTitle: false,
              chapterId: parentId,
              chapterNodeId: null,
              color: options.keepHighlightColor || item.color
            };
          }
          if (item.chapterId === chapterId) {
            return { ...item, chapterId: parentId };
          }
          return item;
        })
    );
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      next.delete(chapterId);
      return next;
    });
  };

  const addHighlight = (color: string) => {
    clearNativeSelection();
    if (activeHighlightId) {
      const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
      if (!activeHighlight) return;
      if (activeHighlight.isChapterTitle) {
        const chapterId = activeHighlight.chapterNodeId || activeHighlight.chapterId;
        if (chapterId) {
          detachCustomChapter(chapterId, {
          keepHighlightId: activeHighlight.id,
          keepHighlightColor: color
          });
        }
      } else {
        setHighlights((prev) =>
          prev.map((item) =>
            item.id === activeHighlightId ? { ...item, color, isChapterTitle: false } : item
          )
        );
      }
      return;
    }
    const newItem = buildHighlightFromSelection(color);
    if (!newItem) return;
    setHighlights((prev) => [...prev, newItem]);
    setActiveHighlightId(newItem.id);
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      const path = findOutlinePath(outlineDisplay, newItem.chapterId);
      if (path?.length) {
        path.forEach((id) => next.add(id));
      } else {
        next.add(newItem.chapterId);
      }
      return next;
    });
  };

  const startQuestionEdit = (question: { id: string; text: string }, isNew = false) => {
    questionEditRef.current = {
      id: question.id,
      originalText: question.text || '',
      isNew
    };
    setEditingQuestionId(question.id);
    setQuestionDraft(question.text || '');
  };

  const handleAddQuestion = () => {
    const next = { id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`, text: '' };
    setQuestions((prev) => [...prev, next]);
    startQuestionEdit(next, true);
  };

  const handleEditQuestion = (question: { id: string; text: string }) => {
    startQuestionEdit(question, false);
  };

  const handleDeleteQuestion = (questionId: string) => {
    setQuestions((prev) => prev.filter((item) => item.id !== questionId));
    setHighlights((prev) =>
      prev.map((item) => ({
        ...item,
        questionIds: (item.questionIds || []).filter((id) => id !== questionId)
      }))
    );
    setExpandedQuestions((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    if (editingQuestionId === questionId) {
      setEditingQuestionId(null);
      setQuestionDraft('');
      questionEditRef.current = { id: null, originalText: '', isNew: false };
    }
  };

  const finalizeQuestionEdit = (questionId: string | null) => {
    if (!questionId) return;
    const trimmed = questionDraft.trim();
    const { originalText, isNew } = questionEditRef.current || {};
    if (!trimmed) {
      if (isNew) {
        setQuestions((prev) => prev.filter((item) => item.id !== questionId));
      } else if (originalText) {
        setQuestions((prev) =>
          prev.map((item) => (item.id === questionId ? { ...item, text: originalText } : item))
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
    setEditingQuestionId(null);
    setQuestionDraft('');
    questionEditRef.current = { id: null, originalText: '', isNew: false };
  };

  const toggleQuestionExpand = (questionId: string) => {
    setExpandedQuestions((prev) => ({
      ...prev,
      [questionId]: !prev[questionId]
    }));
  };

  const openQuestionPicker = () => {
    if (!selectionInfo || !selectionText) return;
    setQuestionPicker({
      open: true,
      highlightId: activeHighlightId,
      selectionInfo,
      selectionText
    });
  };

  const attachHighlightToQuestion = (question: { id: string; text: string }) => {
    if (!question) return;
    if (questionPicker.highlightId) {
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === questionPicker.highlightId
            ? {
                ...item,
                questionIds: Array.from(
                  new Set([...(item.questionIds || []), question.id])
                )
              }
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
      questionPicker.selectionText,
      { questionIds: [question.id] }
    );
    if (!nextHighlight) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
      return;
    }
    setHighlights((prev) => [...prev, nextHighlight]);
    setActiveHighlightId(nextHighlight.id);
    setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
  };

  useEffect(() => {
    if (!editingQuestionId) return;
    questionInputRef.current?.focus?.();
    questionInputRef.current?.select?.();
  }, [editingQuestionId]);

  useEffect(() => {
    if (!editingQuestionId) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(`[data-question-id="${editingQuestionId}"]`)) return;
      finalizeQuestionEdit(editingQuestionId);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [editingQuestionId, questionDraft]);

  const createCustomChapterFromSelection = () => {
    clearNativeSelection();
    if (!selectionInfo || !selectionText) return;
    if (activeHighlightId) {
      const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
      if (activeHighlight?.isChapterTitle) {
        clearSelection();
        return;
      }
    }
    const title = selectionText.trim();
    if (!title) return;
    const rects = selectionInfo.rects.filter((rect) => rect.pageIndex >= 0);
    if (!rects.length || selectionInfo.pageIndex == null) return;
    const topRatio = Math.min(...rects.map((rect) => rect.y ?? 0));
    const pageIndex = selectionInfo.pageIndex;
    const parentChapter = findChapterForPosition(pageIndex, topRatio, highlightParentOutline);
    const parentId = parentChapter && !parentChapter.isRoot ? parentChapter.id : outlineRootId;
    const activeHighlight = activeHighlightId
      ? highlights.find((item) => item.id === activeHighlightId)
      : null;
    const order =
      activeHighlight && !activeHighlight.isChapterTitle
        ? getCombinedEntryOrderValue(parentId, 'note', activeHighlight.id) ??
          getCombinedOrderValue(parentId)
        : getCombinedOrderValue(parentId);

    const chapterNode: OutlineNode = {
      id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      pageIndex,
      topRatio,
      items: [],
      isCustom: true,
      parentId,
      createdAt: Date.now(),
      order
    };

    setCustomChapters((prev) => [...prev, chapterNode]);
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      next.add(parentId);
      next.add(chapterNode.id);
      return next;
    });
    if (activeHighlightId) {
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === activeHighlightId
            ? {
                ...item,
                text: selectionText,
                color: 'rgba(107, 114, 128, 0.35)',
                isChapterTitle: true,
                chapterId: chapterNode.id,
                chapterNodeId: chapterNode.id
              }
            : item
        )
      );
      setActiveHighlightId(activeHighlightId);
    } else {
      const chapterHighlight = buildHighlightFromSelection('rgba(107, 114, 128, 0.35)', {
        isChapterTitle: true,
        chapterId: chapterNode.id,
        chapterNodeId: chapterNode.id
      });
      if (chapterHighlight) {
        setHighlights((prev) => [...prev, chapterHighlight]);
        setActiveHighlightId(chapterHighlight.id);
      }
    }
  };

  const removeCustomChapter = (chapterId: string, options?: { keepSelection?: boolean }) => {
    const target = customChapters.find((item) => item.id === chapterId);
    if (!target) return;
    detachCustomChapter(chapterId);
    if (!options?.keepSelection) {
      clearSelection();
    }
  };

  const clearFormatting = () => {
    clearNativeSelection();
    if (activeHighlightId) {
      const activeHighlight = highlights.find((item) => item.id === activeHighlightId);
      if (activeHighlight?.isChapterTitle && activeHighlight.chapterNodeId) {
        removeCustomChapter(activeHighlight.chapterNodeId);
        return;
      }
    }
    if (!selectionInfo || !selectionText) return;
    setHighlights((prev) =>
      prev.filter(
        (item) =>
          !(item.pageIndex === selectionInfo.pageIndex && item.text === selectionText)
      )
    );
    clearSelection();
  };

  const isPointInNativeSelection = (clientX: number, clientY: number) => {
    if (typeof window === 'undefined') return false;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    if (!rects.length) {
      const rect = range.getBoundingClientRect();
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    }
    return rects.some(
      (rect) =>
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
    );
  };

  const updateSelectionFromWindow = () => {
    if (typeof window === 'undefined') return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const anchor = selection.anchorNode;
    if (!contentAreaRef.current || !anchor || !contentAreaRef.current.contains(anchor)) return;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return;

    const textLayer =
      range.startContainer?.parentElement?.closest?.('.react-pdf__Page__textContent') || null;
    const pageDiv = textLayer?.closest?.('[data-page-index]') || null;
    const pageIndex = pageDiv ? Number(pageDiv.getAttribute('data-page-index')) : -1;
    if (pageIndex < 0 || !pageDiv) return;

    const pageRect = pageDiv.getBoundingClientRect();
    const relativeRects = rects
      .filter((item) => item.width > 1 && item.height > 1)
      .map((item) => ({
        pageIndex,
        x: Math.max(0, Math.min(1, (item.left - pageRect.left) / pageRect.width)),
        y: Math.max(0, Math.min(1, (item.top - pageRect.top) / pageRect.height)),
        w: Math.max(0, Math.min(1, item.width / pageRect.width)),
        h: Math.max(0, Math.min(1, item.height / pageRect.height))
      }));

    setSelectionText(text);
    setSuppressTranslation(false);
    setSelectionRect({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    });
    setSelectionInfo({
      pageIndex,
      rects: relativeRects,
      text
    });
    setActiveHighlightId(null);
    setActiveHighlightColor(null);
  };

  const getHighlightAtPoint = (clientX: number, clientY: number) => {
    for (const highlight of highlights) {
      for (const rect of highlight.rects) {
        const page = pageRefs.current[rect.pageIndex];
        if (!page) continue;
        const pageRect = page.getBoundingClientRect();
        const left = pageRect.left + rect.x * pageRect.width;
        const top = pageRect.top + rect.y * pageRect.height;
        const width = rect.w * pageRect.width;
        const height = rect.h * pageRect.height;
        if (clientX >= left && clientX <= left + width && clientY >= top && clientY <= top + height) {
          return { highlight, rect, pageRect };
        }
      }
    }
    return null;
  };

  const handleHighlightClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (viewMode !== ReaderMode.PDF) return;
    if (isPointInNativeSelection(event.clientX, event.clientY)) {
      return;
    }
    const target = getHighlightAtPoint(event.clientX, event.clientY);
    if (!target) {
      clearSelection();
      clearNativeSelection();
      return;
    }
    const { highlight, rect, pageRect } = target;
    setActiveHighlightId(highlight.id);
    setActiveHighlightColor(highlight.color);
    setSelectionText(highlight.text);
    setSuppressTranslation(false);
    setSelectionInfo({
      pageIndex: highlight.pageIndex,
      rects: highlight.rects,
      text: highlight.text
    });
    setSelectionRect({
      left: pageRect.left + rect.x * pageRect.width,
      right: pageRect.left + (rect.x + rect.w) * pageRect.width,
      top: pageRect.top + rect.y * pageRect.height,
      bottom: pageRect.top + (rect.y + rect.h) * pageRect.height
    });
  };

  const openMarginToolbar = (
    event: React.MouseEvent<HTMLElement>,
    item: {
      kind: 'note' | 'chapter';
      label: string;
      note?: HighlightItem;
      node?: OutlineNode;
      color?: string;
    }
  ) => {
    if (viewMode !== ReaderMode.PDF) return;
    event.preventDefault();
    event.stopPropagation();
    clearNativeSelection();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const text =
      item.kind === 'note' && item.note ? item.note.text : item.label;
    const safeText = text && text.trim().length ? text : item.label || ' ';
    setSelectionRect({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    });
    setSelectionText(safeText);
    setSuppressTranslation(item.kind === 'chapter');
    if (item.kind === 'note' && item.note?.translation) {
      setTranslationResult(item.note.translation);
    } else if (item.kind === 'chapter') {
      setTranslationResult('');
    }
    if (item.kind === 'note' && item.note) {
      const note = item.note;
      setSelectionInfo({
        pageIndex: note.pageIndex,
        rects: Array.isArray(note.rects) ? note.rects : [],
        text: note.text
      });
      setActiveHighlightId(note.id);
      setActiveHighlightColor(note.color);
      return;
    }
    setSelectionInfo(null);
    setActiveHighlightId(null);
    setActiveHighlightColor(null);
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    if (!selectionText || !selectionRect) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && selectionToolbarRef.current?.contains(target)) return;
      if (target && questionPickerRef.current?.contains(target)) return;
      if (isPointInNativeSelection(event.clientX, event.clientY)) return;
      if (getHighlightAtPoint(event.clientX, event.clientY)) return;
      clearSelection();
      clearNativeSelection();
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [viewMode, selectionText, selectionRect, highlights]);

  const toolbarStyle = useMemo(() => {
    if (!selectionRect || typeof window === 'undefined') return null;
    const menuWidth = 320;
    const menuHeight = 140;
    const left = Math.max(
      12,
      Math.min(selectionRect.left, window.innerWidth - menuWidth - 12)
    );
    const top = Math.min(
      selectionRect.bottom + 8,
      window.innerHeight - menuHeight - 12
    );
    return { left: `${left}px`, top: `${top}px` };
  }, [selectionRect]);

  const questionPickerStyle = useMemo(() => {
    if (!toolbarStyle || typeof window === 'undefined') return null;
    const pickerWidth = 220;
    const pickerHeight = 180;
    const baseLeft = Number.parseFloat(toolbarStyle.left || '0') + 320 + 2;
    const left = Math.min(
      window.innerWidth - pickerWidth - 12,
      Math.max(12, baseLeft)
    );
    const baseTop = Number.parseFloat(toolbarStyle.top || '0');
    const top = Math.min(
      window.innerHeight - pickerHeight - 12,
      Math.max(12, baseTop)
    );
    return { left: `${left}px`, top: `${top}px` };
  }, [toolbarStyle]);

  const jumpToHighlight = (note: HighlightItem) => {
    const page = pageRefs.current[note.pageIndex];
    const container = contentAreaRef.current;
    if (!page || !container) return;
    const rect = note.rects[0];
    if (!rect) return;
    const top = page.offsetTop + rect.y * page.clientHeight;
    container.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    setActiveHighlightId(note.id);
  };

  const handleMindMapNodeClick = (node: MindMapNode) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    setActiveMindmapNodeId(node.id);
    if (dragNoteTriggeredRef.current || draggingNoteId || dragChapterTriggeredRef.current || draggingChapterId) {
      return;
    }
    if (node.kind === 'note' && node.note) {
      jumpToHighlight(node.note as HighlightItem);
      return;
    }

    if (typeof node.pageIndex !== 'number') return;
    const target = pageRefs.current[node.pageIndex];
    const container = contentAreaRef.current;
    if (!target || !container) return;
    const offset =
      typeof node.topRatio === 'number' ? node.topRatio * target.clientHeight : 0;
    const top = target.offsetTop + offset;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  const handleMindmapToggleCollapse = (node: MindMapNode) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const originalNode = mindmapNodeMap.get(node.id);
    const hasChildren = Boolean(originalNode?.children && originalNode.children.length);
    if (!hasChildren) return;
    const layout = mindmapLayoutRef.current;
    if (layout) {
      const targetNode = layout.nodes.find((item) => item.id === node.id);
      if (targetNode) {
        mindmapAnchorRef.current = {
          id: node.id,
          x:
            (targetNode.x + targetNode.width / 2 + layout.offset.x) * mindmapZoomScale +
            mindmapOffset.x,
          y:
            (targetNode.y + targetNode.height / 2 + layout.offset.y) * mindmapZoomScale +
            mindmapOffset.y
        };
      }
    }
    setCollapsedMindmapIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  };

  const handleMindmapNodeDoubleClick = (
    node: MindMapNode,
    event: React.MouseEvent<SVGGElement>
  ) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      if (note.isChapterTitle) return;
      event.preventDefault();
      event.stopPropagation();
      setMindmapEditing({ nodeId: node.id, kind: 'note', targetId: note.id });
      setMindmapEditValue(note.text || '');
      return;
    }
    if (node.kind === 'chapter' && customChapterIdSet.has(node.id)) {
      event.preventDefault();
      event.stopPropagation();
      setMindmapEditing({ nodeId: node.id, kind: 'chapter', targetId: node.id });
      setMindmapEditValue(node.text || '');
    }
  };

  const cancelMindmapEdit = () => {
    setMindmapEditing(null);
    setMindmapEditValue('');
  };

  const commitMindmapEdit = (node: MindMapNode, value: string) => {
    if (!mindmapEditing) return;
    const nextText = String(value || '').trim();
    if (!nextText) {
      cancelMindmapEdit();
      return;
    }
    if (mindmapEditing.kind === 'note') {
      const targetNote = highlights.find((item) => item.id === mindmapEditing.targetId);
      const isManual = targetNote ? isManualHighlight(targetNote) : false;
      const stableOrder =
        targetNote && typeof targetNote.order === 'number'
          ? targetNote.order
          : targetNote
            ? getCombinedEntryOrderValue(targetNote.chapterId, 'note', targetNote.id)
            : undefined;
      setHighlights((prev) =>
        prev.map((item) =>
          item.id === mindmapEditing.targetId
            ? {
                ...item,
                text: nextText,
                translation: isManual ? nextText : undefined,
                order: stableOrder ?? item.order
              }
            : item
        )
      );
      cancelMindmapEdit();
      return;
    }
    if (mindmapEditing.kind === 'chapter') {
      const parentId = resolveParentForChapter(mindmapEditing.targetId);
      const targetChapter = customChapters.find((item) => item.id === mindmapEditing.targetId);
      const stableOrder =
        targetChapter && typeof targetChapter.order === 'number'
          ? targetChapter.order
          : getCombinedEntryOrderValue(parentId, 'node', mindmapEditing.targetId);
      setCustomChapters((prev) =>
        prev.map((item) =>
          item.id === mindmapEditing.targetId
            ? { ...item, title: nextText, order: stableOrder ?? item.order }
            : item
        )
      );
      setHighlights((prev) =>
        prev.map((item) =>
          item.isChapterTitle && item.chapterNodeId === mindmapEditing.targetId
            ? { ...item, text: nextText, translation: undefined }
            : item
        )
      );
      cancelMindmapEdit();
    }
  };

  const getMindmapDraftText = (nodeId: string, fallback: string) => {
    if (mindmapEditing?.nodeId === nodeId) return mindmapEditValue;
    return fallback;
  };

  const handleMindmapAddChild = (node: MindMapNode) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      const chapterId = note.chapterId || outlineRootId;
      const pageIndex =
        typeof note.pageIndex === 'number'
          ? note.pageIndex
          : typeof node.pageIndex === 'number'
            ? node.pageIndex
            : 0;
      const baseTop = note.rects?.[0]?.y ?? 0.99;
      const rects = [
        {
          pageIndex,
          x: 0,
          y: Math.min(0.99, baseTop + 0.0001),
          w: 0,
          h: 0
        }
      ];
      const newNote: HighlightItem = {
        id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: '新笔记',
        color: HIGHLIGHT_COLORS[0]?.fill || 'rgba(250, 204, 21, 0.45)',
        pageIndex,
        rects,
        chapterId,
        isChapterTitle: false,
        translation: '新笔记',
        source: 'manual',
        order: getCombinedOrderValue(chapterId)
      };
      setHighlights((prev) => [...prev, newNote]);
      setActiveHighlightId(newNote.id);
      setExpandedTOC((prev) => {
        const next = new Set(prev);
        next.add(chapterId);
        return next;
      });
      setCollapsedMindmapIds((prev) => {
        if (!prev.has(chapterId)) return prev;
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
      setMindmapEditing({ nodeId: `note-${newNote.id}`, kind: 'note', targetId: newNote.id });
      setMindmapEditValue(newNote.text);
      return;
    }

    const parentId = node.kind === 'root' ? outlineRootId : node.id;
    const pageIndex = typeof node.pageIndex === 'number' ? node.pageIndex : 0;
    const topRatio = typeof node.topRatio === 'number' ? node.topRatio : 0;
    const newId = `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const order = getCombinedOrderValue(parentId);
    const chapterNode: OutlineNode = {
      id: newId,
      title: '新节点',
      pageIndex,
      topRatio,
      items: [],
      isCustom: true,
      parentId,
      createdAt: Date.now(),
      order
    };
    setCustomChapters((prev) => [...prev, chapterNode]);
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      next.add(parentId);
      next.add(newId);
      return next;
    });
    setChapterParentOverrides((prev) => ({
      ...prev,
      [newId]: parentId
    }));
    setCollapsedMindmapIds((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    setMindmapEditing({ nodeId: newId, kind: 'chapter', targetId: newId });
    setMindmapEditValue(chapterNode.title);
  };

  const handleMindmapAddSibling = (node: MindMapNode) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (node.kind === 'root') return;
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      const chapterId = note.chapterId || outlineRootId;
      const pageIndex =
        typeof note.pageIndex === 'number'
          ? note.pageIndex
          : typeof node.pageIndex === 'number'
            ? node.pageIndex
            : 0;
      const baseTop = note.rects?.[0]?.y ?? 0.99;
      const rects = [
        {
          pageIndex,
          x: 0,
          y: Math.min(0.99, baseTop + 0.0001),
          w: 0,
          h: 0
        }
      ];
      const newNote: HighlightItem = {
        id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: '新笔记',
        color: HIGHLIGHT_COLORS[0]?.fill || 'rgba(250, 204, 21, 0.45)',
        pageIndex,
        rects,
        chapterId,
        isChapterTitle: false,
        translation: '新笔记',
        source: 'manual',
        order: getCombinedOrderValueAfter(chapterId, 'note', note.id)
      };
      setHighlights((prev) => [...prev, newNote]);
      setActiveHighlightId(newNote.id);
      setExpandedTOC((prev) => {
        const next = new Set(prev);
        next.add(chapterId);
        return next;
      });
      setCollapsedMindmapIds((prev) => {
        if (!prev.has(chapterId)) return prev;
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
      setMindmapEditing({ nodeId: `note-${newNote.id}`, kind: 'note', targetId: newNote.id });
      setMindmapEditValue(newNote.text);
      return;
    }

    if (node.kind === 'chapter') {
      const parentId = mindmapParentMap.get(node.id) || outlineRootId;
      if (!parentId) return;
      const pageIndex = typeof node.pageIndex === 'number' ? node.pageIndex : 0;
      const topRatioBase = typeof node.topRatio === 'number' ? node.topRatio : 0;
      const topRatio = Math.min(0.99, Math.max(0, topRatioBase + 0.0001));
      const newId = `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const order = getNodeOrderValueAfter(parentId, node.id);
      const chapterNode: OutlineNode = {
        id: newId,
        title: '新节点',
        pageIndex,
        topRatio,
        items: [],
        isCustom: true,
        parentId,
        createdAt: Date.now(),
        order
      };
      setCustomChapters((prev) => [...prev, chapterNode]);
      setExpandedTOC((prev) => {
        const next = new Set(prev);
        next.add(parentId);
        next.add(newId);
        return next;
      });
      setChapterParentOverrides((prev) => ({
        ...prev,
        [newId]: parentId
      }));
      setCollapsedMindmapIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      setMindmapEditing({ nodeId: newId, kind: 'chapter', targetId: newId });
      setMindmapEditValue(chapterNode.title);
    }
  };

  const removeHighlightNote = (note: HighlightItem) => {
    if (note.isChapterTitle) return;
    setHighlights((prev) => prev.filter((item) => item.id !== note.id));
    setExpandedHighlightIds((prev) => {
      if (!prev.has(note.id)) return prev;
      const next = new Set(prev);
      next.delete(note.id);
      return next;
    });
    if (activeHighlightId === note.id) {
      setActiveHighlightId(null);
    }
    if (mindmapEditing?.targetId === note.id) {
      cancelMindmapEdit();
    }
  };

  const handleMindmapDelete = (node: MindMapNode) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      removeHighlightNote(note);
      return;
    }
    if (node.kind === 'chapter' && customChapterIdSet.has(node.id)) {
      removeCustomChapter(node.id, { keepSelection: true });
      if (mindmapEditing?.targetId === node.id) {
        cancelMindmapEdit();
      }
    }
  };

  const isMindmapNodeDeletable = (node: MindMapNode) => {
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      return !note.isChapterTitle;
    }
    if (node.kind === 'chapter') return customChapterIdSet.has(node.id);
    return false;
  };

  const isMindmapNodeSiblingAddable = (node: MindMapNode) => node.kind !== 'root';

  const handleMindmapToolbarColor = (node: MindMapNode, color: string) => {
    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      if (note.isChapterTitle && note.chapterNodeId) {
        const draftText = getMindmapDraftText(`note-${note.id}`, note.text || '');
        detachCustomChapter(note.chapterNodeId, {
          keepHighlightId: note.id,
          keepHighlightColor: color
        });
        setHighlights((prev) =>
          prev.map((item) => (item.id === note.id ? { ...item, text: draftText } : item))
        );
        setMindmapEditing({ nodeId: `note-${note.id}`, kind: 'note', targetId: note.id });
        setMindmapEditValue(draftText);
        return;
      }
      setHighlights((prev) =>
        prev.map((item) => (item.id === note.id ? { ...item, color } : item))
      );
      return;
    }
    if (node.kind === 'chapter' && customChapterIdSet.has(node.id)) {
      const chapterTitle = highlights.find(
        (item) => item.isChapterTitle && item.chapterNodeId === node.id
      );
      const draftText = getMindmapDraftText(node.id, node.text || '');
      if (chapterTitle) {
        detachCustomChapter(node.id, {
          keepHighlightId: chapterTitle.id,
          keepHighlightColor: color
        });
        setHighlights((prev) =>
          prev.map((item) =>
            item.id === chapterTitle.id ? { ...item, text: draftText } : item
          )
        );
        setMindmapEditing({
          nodeId: `note-${chapterTitle.id}`,
          kind: 'note',
          targetId: chapterTitle.id
        });
        setMindmapEditValue(draftText || chapterTitle.text || node.text || '');
        return;
      }
      const parentId = resolveParentForChapter(node.id);
      const text = String(draftText || node.text || '').trim() || '新笔记';
      const pageIndex = typeof node.pageIndex === 'number' ? node.pageIndex : 0;
      const topRatio =
        typeof node.topRatio === 'number' ? Math.min(0.99, Math.max(0, node.topRatio)) : 0.99;
      const rects = [
        {
          pageIndex,
          x: 0,
          y: topRatio,
          w: 0,
          h: 0
        }
      ];
      const newNote: HighlightItem = {
        id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text,
        color,
        pageIndex,
        rects,
        chapterId: parentId,
        isChapterTitle: false,
        translation: text,
        source: 'manual',
        order: getCombinedEntryOrderValue(parentId, 'node', node.id)
      };
      detachCustomChapter(node.id);
      setHighlights((prev) => [...prev, newNote]);
      setActiveHighlightId(newNote.id);
      setExpandedTOC((prev) => {
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });
      setCollapsedMindmapIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      setMindmapEditing({ nodeId: `note-${newNote.id}`, kind: 'note', targetId: newNote.id });
      setMindmapEditValue(draftText || text);
    }
  };

  const handleMindmapToolbarMakeChapter = (node: MindMapNode) => {
    if (node.kind !== 'note' || !node.note) return;
    const note = node.note as HighlightItem;
    if (note.isChapterTitle) return;
    const draftText = getMindmapDraftText(node.id, note.text || '');
    const title = String(draftText || '').trim();
    if (!title) return;
    const rects = Array.isArray(note.rects) ? note.rects.filter((rect) => rect.pageIndex >= 0) : [];
    const topRatio = rects.length ? Math.min(...rects.map((rect) => rect.y ?? 0)) : 0;
    const pageIndex =
      typeof note.pageIndex === 'number'
        ? note.pageIndex
        : rects.length
          ? rects[0].pageIndex
          : 0;
    const parentId = note.chapterId || outlineRootId;
    const newId = `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const order =
      getCombinedEntryOrderValue(parentId, 'note', note.id) ??
      getCombinedOrderValue(parentId);
    const chapterNode: OutlineNode = {
      id: newId,
      title,
      pageIndex,
      topRatio,
      items: [],
      isCustom: true,
      parentId,
      createdAt: Date.now(),
      order
    };
    setCustomChapters((prev) => [...prev, chapterNode]);
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      next.add(parentId);
      next.add(newId);
      return next;
    });
    setChapterParentOverrides((prev) => ({
      ...prev,
      [newId]: parentId
    }));
    setHighlights((prev) =>
      prev.map((item) =>
        item.id === note.id
          ? {
              ...item,
              text: title,
              isChapterTitle: true,
              chapterId: newId,
              chapterNodeId: newId,
              color: 'rgba(107, 114, 128, 0.35)'
            }
          : item
      )
    );
    setActiveHighlightId(note.id);
    setMindmapEditing({ nodeId: newId, kind: 'chapter', targetId: newId });
    setMindmapEditValue(draftText);
  };

  const handleMindmapToolbarClear = (node: MindMapNode) => {
    handleMindmapDelete(node);
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP && mindmapEditing) {
      cancelMindmapEdit();
    }
  }, [viewMode, mindmapEditing]);

  const handleMindmapLayout = (layout: MindMapLayout | null) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    mindmapLayoutRef.current = layout;
    const anchor = mindmapAnchorRef.current;
    if (!layout || !anchor) return;
    const target = layout.nodes.find((item) => item.id === anchor.id);
    if (!target) {
      mindmapAnchorRef.current = null;
      return;
    }
    const nextOffset = {
      x: anchor.x - (target.x + target.width / 2 + layout.offset.x) * mindmapZoomScale,
      y: anchor.y - (target.y + target.height / 2 + layout.offset.y) * mindmapZoomScale
    };
    setMindmapOffset(nextOffset);
    mindmapAnchorRef.current = null;
  };

  const handleMindmapLayoutStart = () => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const anchor = mindmapAnchorRef.current;
    if (!anchor) return;
    setMindmapOffset({
      x: anchor.x,
      y: anchor.y
    });
  };

  const handleMindmapMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (event.button !== 0) return;
    mindmapPanRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: mindmapOffset.x,
      offsetY: mindmapOffset.y
    };
    setIsMindmapPanning(true);
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!isMindmapPanning) return;
    const handleMove = (event: MouseEvent) => {
      const start = mindmapPanRef.current;
      if (!start) return;
      setMindmapOffset({
        x: start.offsetX + (event.clientX - start.x),
        y: start.offsetY + (event.clientY - start.y)
      });
    };
    const handleUp = () => {
      setIsMindmapPanning(false);
      mindmapPanRef.current = null;
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
  }, [isMindmapPanning, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!draggingNoteId) return undefined;
    if (dragNoteTimerRef.current) {
      window.clearTimeout(dragNoteTimerRef.current);
      dragNoteTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const mindmapNode = target?.closest?.('[data-mindmap-id]');
      let mindmapId = mindmapNode?.getAttribute('data-mindmap-id') || null;
      const mindmapKind = mindmapNode?.getAttribute('data-mindmap-kind') || null;
      if (mindmapKind === 'note') {
        mindmapId = null;
      }
      setDragOverMindmapId(mindmapId);
      const dragInfo = dragNoteRef.current;
      if (dragInfo) {
        setDragGhost((prev) => ({
          ...(prev || {}),
          id: dragInfo.id,
          text: dragInfo.text || prev?.text || '',
          color: dragInfo.color || prev?.color,
          width: dragInfo.width || prev?.width || 0,
          height: dragInfo.height || prev?.height || 0,
          lines: dragInfo.lines || prev?.lines,
          fontSize: dragInfo.fontSize || prev?.fontSize,
          lineHeight: dragInfo.lineHeight || prev?.lineHeight,
          x: event.clientX - (dragInfo.offsetX || 0),
          y: event.clientY - (dragInfo.offsetY || 0)
        }));
      }
    };
    const handleUp = () => {
      const dragInfo = dragNoteRef.current;
      const targetId = dragOverMindmapId;
      if (dragInfo && targetId && targetId !== dragInfo.chapterId) {
        setHighlights((prev) =>
          prev.map((item) =>
            item.id === dragInfo.id ? { ...item, chapterId: targetId } : item
          )
        );
        setExpandedTOC((prev) => {
          const next = new Set(prev);
          next.add(targetId);
          return next;
        });
      }
      setDraggingNoteId(null);
      setDragOverMindmapId(null);
      setDragGhost(null);
      dragNoteTriggeredRef.current = false;
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
  }, [draggingNoteId, dragOverMindmapId, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const handleUp = () => {
      if (draggingNoteId) return;
      if (dragNoteTimerRef.current) {
        window.clearTimeout(dragNoteTimerRef.current);
        dragNoteTimerRef.current = null;
      }
      dragNoteTriggeredRef.current = false;
      dragNoteRef.current = null;
      setDragOverMindmapId(null);
      setDragGhost(null);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [draggingNoteId, viewMode]);

  const handleMindmapNodeMouseDown = (
    node: MindMapNode,
    event: React.MouseEvent<SVGGElement>
  ) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (event.button !== 0) return;
    setActiveMindmapNodeId(node.id);
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    if (node.kind === 'note' && node.note) {
      const note = node.note as HighlightItem;
      dragNoteTriggeredRef.current = false;
      dragNoteRef.current = {
        id: note.id,
        chapterId: note.chapterId,
        text: note.text,
        color: note.color,
        offsetX,
        offsetY,
        width: rect.width,
        height: rect.height,
        lines: (node as any).lines || undefined,
        fontSize: (node as any).fontSize || undefined,
        lineHeight: (node as any).lineHeight || undefined
      };
      if (dragNoteTimerRef.current) {
        window.clearTimeout(dragNoteTimerRef.current);
      }
      dragNoteTimerRef.current = window.setTimeout(() => {
        dragNoteTriggeredRef.current = true;
        setDraggingNoteId(note.id);
        setDragGhost({
          id: note.id,
          text: note.text,
          color: note.color,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          lines: (node as any).lines || undefined,
          fontSize: (node as any).fontSize || undefined,
          lineHeight: (node as any).lineHeight || undefined
        });
      }, 200);
      return;
    }

    if (node.kind === 'chapter') {
      dragChapterTriggeredRef.current = false;
      dragChapterRef.current = {
        id: node.id,
        parentId: mindmapParentMap.get(node.id) || null,
        text: node.text,
        offsetX,
        offsetY,
        width: rect.width,
        height: rect.height,
        lines: (node as any).lines || undefined,
        fontSize: (node as any).fontSize || undefined,
        lineHeight: (node as any).lineHeight || undefined
      };
      if (dragChapterTimerRef.current) {
        window.clearTimeout(dragChapterTimerRef.current);
      }
      dragChapterTimerRef.current = window.setTimeout(() => {
        dragChapterTriggeredRef.current = true;
        setDraggingChapterId(node.id);
        setDragGhost({
          id: node.id,
          text: node.text,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          lines: (node as any).lines || undefined,
          fontSize: (node as any).fontSize || undefined,
          lineHeight: (node as any).lineHeight || undefined
        });
      }, 200);
    }
  };

  const handleTOCNoteMouseDown = (
    note: HighlightItem,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (viewMode !== ReaderMode.PDF) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    tocDragNoteTriggeredRef.current = false;
    tocDragNoteRef.current = {
      id: note.id,
      chapterId: note.chapterId,
      text: note.text,
      color: note.color,
      offsetX,
      offsetY,
      width: rect.width,
      height: rect.height
    };
    setDragOverTocId(null);
    if (tocDragNoteTimerRef.current) {
      window.clearTimeout(tocDragNoteTimerRef.current);
    }
    tocDragNoteTimerRef.current = window.setTimeout(() => {
      tocDragNoteTriggeredRef.current = true;
      setDraggingTocNoteId(note.id);
      setDragGhost({
        id: note.id,
        text: note.text,
        color: note.color,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    }, 220);
  };

  const handleTOCChapterMouseDown = (
    item: OutlineNode,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (viewMode !== ReaderMode.PDF) return;
    if (event.button !== 0) return;
    if (item.isRoot) return;
    event.preventDefault();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    tocDragChapterTriggeredRef.current = false;
    tocDragChapterRef.current = {
        id: item.id,
        parentId: tocParentMapRef.current.get(item.id) || null,
        text: item.title,
        offsetX,
        offsetY,
      width: rect.width,
      height: rect.height
    };
    setDragOverTocId(null);
    if (tocDragChapterTimerRef.current) {
      window.clearTimeout(tocDragChapterTimerRef.current);
    }
    tocDragChapterTimerRef.current = window.setTimeout(() => {
      tocDragChapterTriggeredRef.current = true;
      setDraggingTocChapterId(item.id);
      setDragGhost({
        id: item.id,
        text: item.title,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    }, 220);
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    if (!draggingTocNoteId) return undefined;
    if (tocDragNoteTimerRef.current) {
      window.clearTimeout(tocDragNoteTimerRef.current);
      tocDragNoteTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const tocNode = target?.closest?.('[data-toc-id]');
      const tocKind = tocNode?.getAttribute('data-toc-kind') || null;
      const tocId = tocKind === 'chapter' ? tocNode?.getAttribute('data-toc-id') || null : null;
      setDragOverTocId(tocId);
      const dragInfo = tocDragNoteRef.current;
      if (dragInfo) {
        setDragGhost((prev) => ({
          ...(prev || {}),
          id: dragInfo.id,
          text: dragInfo.text || prev?.text || '',
          color: dragInfo.color || prev?.color,
          width: dragInfo.width || prev?.width || 0,
          height: dragInfo.height || prev?.height || 0,
          x: event.clientX - (dragInfo.offsetX || 0),
          y: event.clientY - (dragInfo.offsetY || 0)
        }));
      }
    };
    const handleUp = () => {
      const dragInfo = tocDragNoteRef.current;
      const targetId = dragOverTocId;
      if (dragInfo && targetId && targetId !== dragInfo.chapterId) {
        setHighlights((prev) =>
          prev.map((item) =>
            item.id === dragInfo.id ? { ...item, chapterId: targetId } : item
          )
        );
        setExpandedTOC((prev) => {
          const next = new Set(prev);
          next.add(targetId);
          return next;
        });
      }
      tocSuppressClickUntilRef.current = Date.now() + 180;
      setDraggingTocNoteId(null);
      setDragOverTocId(null);
      setDragGhost(null);
      tocDragNoteTriggeredRef.current = false;
      tocDragNoteRef.current = null;
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
  }, [draggingTocNoteId, dragOverTocId, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    if (!draggingTocChapterId) return undefined;
    if (tocDragChapterTimerRef.current) {
      window.clearTimeout(tocDragChapterTimerRef.current);
      tocDragChapterTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const tocNode = target?.closest?.('[data-toc-id]');
      const tocKind = tocNode?.getAttribute('data-toc-kind') || null;
      const tocId = tocKind === 'chapter' ? tocNode?.getAttribute('data-toc-id') || null : null;
      setDragOverTocId(tocId);
      const dragInfo = tocDragChapterRef.current;
      if (dragInfo) {
        setDragGhost((prev) => ({
          ...(prev || {}),
          id: dragInfo.id,
          text: dragInfo.text || prev?.text || '',
          width: dragInfo.width || prev?.width || 0,
          height: dragInfo.height || prev?.height || 0,
          x: event.clientX - (dragInfo.offsetX || 0),
          y: event.clientY - (dragInfo.offsetY || 0)
        }));
      }
    };
    const handleUp = () => {
      const dragInfo = tocDragChapterRef.current;
      const targetId = dragOverTocId;
      if (dragInfo && targetId && targetId !== dragInfo.id) {
        const isDescendant = (() => {
          let current = tocParentMapRef.current.get(targetId) || null;
          while (current) {
            if (current === dragInfo.id) return true;
            current = tocParentMapRef.current.get(current) || null;
          }
          return false;
        })();
        if (!isDescendant) {
          setChapterParentOverrides((prev) => ({
            ...prev,
            [dragInfo.id]: targetId
          }));
          setExpandedTOC((prev) => {
            const next = new Set(prev);
            next.add(targetId);
            return next;
          });
        }
      }
      tocSuppressClickUntilRef.current = Date.now() + 180;
      setDraggingTocChapterId(null);
      setDragOverTocId(null);
      setDragGhost(null);
      tocDragChapterTriggeredRef.current = false;
      tocDragChapterRef.current = null;
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
  }, [draggingTocChapterId, dragOverTocId, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    const handleUp = () => {
      if (draggingTocNoteId || draggingTocChapterId) return;
      if (tocDragNoteTimerRef.current) {
        window.clearTimeout(tocDragNoteTimerRef.current);
        tocDragNoteTimerRef.current = null;
      }
      if (tocDragChapterTimerRef.current) {
        window.clearTimeout(tocDragChapterTimerRef.current);
        tocDragChapterTimerRef.current = null;
      }
      tocDragNoteTriggeredRef.current = false;
      tocDragChapterTriggeredRef.current = false;
      tocDragNoteRef.current = null;
      tocDragChapterRef.current = null;
      setDragOverTocId(null);
      setDragGhost(null);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [draggingTocNoteId, draggingTocChapterId, viewMode]);

  const fallbackOutline = useMemo<OutlineNode[]>(() => {
    const convert = (items: TOCItem[], parentId = 'mock') =>
      items.map((item, index) => {
        const id = `${parentId}${parentId ? '.' : ''}${index}`;
        return {
          id,
          title: item.title,
          pageIndex: Number.isFinite(item.page) ? Math.max(0, item.page - 1) : null,
          topRatio: null,
          items: item.children ? convert(item.children, id) : []
        };
      });
    const rootId = `outline-root-fallback-${paper.id}`;
    return [
      {
        id: rootId,
        title: paper.title || 'Document',
        pageIndex: 0,
        topRatio: 0,
        items: convert(MOCK_TOC, 'mock'),
        isRoot: true
      }
    ];
  }, [paper.id, paper.title]);

  const baseOutline = useMemo(
    () => (outlineNodes.length ? outlineNodes : fallbackOutline),
    [outlineNodes, fallbackOutline]
  );

  const outlineRootId = baseOutline[0]?.id || `outline-root-${paper.id}`;

  const getFlatOutlineByPosition = (nodes: OutlineNode[]) => {
    const list: OutlineNode[] = [];
    const walk = (items: OutlineNode[]) => {
      items.forEach((node) => {
        list.push(node);
        if (node.items?.length) walk(node.items);
      });
    };
    walk(nodes);
    return list
      .filter((node) => typeof node.pageIndex === 'number')
      .sort((a, b) => {
        if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) {
          return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
        }
        return (a.topRatio ?? 0) - (b.topRatio ?? 0);
      });
  };

  const baseFlatOutline = useMemo(() => getFlatOutlineByPosition(baseOutline), [baseOutline]);

  const sortOutlineNodes = (nodes: OutlineNode[]) => {
    if (!nodes.length) return;
    const baseSorted = nodes.map((node) => node);
    baseSorted.sort((a, b) => {
      if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) {
        return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
      }
      if ((a.topRatio ?? 0) !== (b.topRatio ?? 0)) {
        return (a.topRatio ?? 0) - (b.topRatio ?? 0);
      }
      return a.title.localeCompare(b.title);
    });
    const baseOrder = new Map<string, number>();
    baseSorted.forEach((node, index) => {
      baseOrder.set(node.id, index);
    });

    const indexed = nodes.map((node, index) => ({ node, index }));
    indexed.sort((a, b) => {
      const aBase = baseOrder.get(a.node.id) ?? a.index;
      const bBase = baseOrder.get(b.node.id) ?? b.index;
      const aOrder = typeof a.node.order === 'number' ? a.node.order : aBase;
      const bOrder = typeof b.node.order === 'number' ? b.node.order : bBase;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (aBase !== bBase) return aBase - bBase;
      return a.node.title.localeCompare(b.node.title);
    });
    nodes.splice(0, nodes.length, ...indexed.map((entry) => entry.node));
    nodes.forEach((node) => {
      if (node.items?.length) sortOutlineNodes(node.items);
    });
  };

  const mergeOutlineWithCustom = (
    outline: OutlineNode[],
    customNodes: OutlineNode[],
    baseFlat: OutlineNode[],
    rootId: string
  ) => {
    if (!customNodes.length) return outline;
    const cloneNodes = (nodes: OutlineNode[]) =>
      (nodes || []).map((node) => ({
        ...node,
        items: cloneNodes(node.items || [])
      }));
    const rootItems = cloneNodes(outline);

    const insertIntoParent = (nodes: OutlineNode[], parentId: string, child: OutlineNode) => {
      for (const node of nodes) {
        if (node.id === parentId) {
          node.items = Array.isArray(node.items) ? [...node.items, child] : [child];
          return true;
        }
        if (node.items?.length && insertIntoParent(node.items, parentId, child)) return true;
      }
      return false;
    };

    const appendToRoot = (child: OutlineNode) => {
      const rootNode = rootItems.find((item) => item.id === rootId);
      if (rootNode) {
        rootNode.items = Array.isArray(rootNode.items)
          ? [...rootNode.items, child]
          : [child];
        return;
      }
      rootItems.push(child);
    };

    const pendingByParent: Array<{ child: OutlineNode; parentId: string }> = [];

    customNodes.forEach((node) => {
      if (!node) return;
      const normalized: OutlineNode = {
        ...node,
        items: Array.isArray(node.items) ? node.items : [],
        isCustom: true
      };
      const parentId = node.parentId || null;
      if (parentId) {
        if (parentId === rootId) {
          appendToRoot(normalized);
          return;
        }
        if (insertIntoParent(rootItems, parentId, normalized)) return;
        pendingByParent.push({ child: normalized, parentId });
        return;
      }
      const fallbackParent = (() => {
        const candidate = findChapterForPosition(
          node.pageIndex ?? 0,
          node.topRatio ?? 0,
          baseFlat
        );
        return candidate?.id || rootId;
      })();
      if (
        fallbackParent &&
        fallbackParent !== rootId &&
        insertIntoParent(rootItems, fallbackParent, normalized)
      ) {
        return;
      }
      appendToRoot(normalized);
    });

    if (pendingByParent.length) {
      const unresolved = [...pendingByParent];
      let progressed = true;
      while (unresolved.length && progressed) {
        progressed = false;
        for (let i = unresolved.length - 1; i >= 0; i -= 1) {
          const current = unresolved[i];
          if (insertIntoParent(rootItems, current.parentId, current.child)) {
            unresolved.splice(i, 1);
            progressed = true;
          }
        }
      }
      unresolved.forEach(({ child }) => {
        const candidate = findChapterForPosition(
          child.pageIndex ?? 0,
          child.topRatio ?? 0,
          baseFlat
        );
        const fallbackParent = candidate?.id || rootId;
        if (
          fallbackParent &&
          fallbackParent !== rootId &&
          insertIntoParent(rootItems, fallbackParent, child)
        ) {
          return;
        }
        appendToRoot(child);
      });
    }

    sortOutlineNodes(rootItems);
    return rootItems;
  };

  const applyParentOverrides = (
    outline: OutlineNode[],
    overrides: Record<string, string>
  ) => {
    if (!overrides || !Object.keys(overrides).length) return outline;
    const cloneNodes = (nodes: OutlineNode[]) =>
      (nodes || []).map((node) => ({
        ...node,
        items: cloneNodes(node.items || [])
      }));
    const rootItems = cloneNodes(outline);
    const idToNode = new Map<string, OutlineNode>();
    const idToParent = new Map<string, OutlineNode | null>();

    const walk = (nodes: OutlineNode[], parent: OutlineNode | null) => {
      nodes.forEach((node) => {
        idToNode.set(node.id, node);
        idToParent.set(node.id, parent);
        if (node.items?.length) walk(node.items, node);
      });
    };
    walk(rootItems, null);

    const isDescendant = (ancestorId: string, targetId: string) => {
      let current = idToParent.get(targetId) || null;
      while (current) {
        if (current.id === ancestorId) return true;
        current = idToParent.get(current.id) || null;
      }
      return false;
    };

    Object.entries(overrides).forEach(([nodeId, nextParentId]) => {
      if (!nodeId || !nextParentId || nodeId === nextParentId) return;
      const node = idToNode.get(nodeId);
      const nextParent = idToNode.get(nextParentId);
      if (!node || !nextParent) return;
      if (isDescendant(nodeId, nextParentId)) return;
      const currentParent = idToParent.get(nodeId);
      if (currentParent) {
        currentParent.items = (currentParent.items || []).filter((item) => item.id !== nodeId);
      } else {
        const rootIndex = rootItems.findIndex((item) => item.id === nodeId);
        if (rootIndex >= 0) rootItems.splice(rootIndex, 1);
      }
      nextParent.items = Array.isArray(nextParent.items) ? [...nextParent.items, node] : [node];
      idToParent.set(nodeId, nextParent);
    });

    return rootItems;
  };

  const outlineDisplay = useMemo(() => {
    const merged = mergeOutlineWithCustom(baseOutline, customChapters, baseFlatOutline, outlineRootId);
    const applied = applyParentOverrides(merged, chapterParentOverrides);
    sortOutlineNodes(applied);
    return applied;
  }, [baseOutline, customChapters, baseFlatOutline, outlineRootId, chapterParentOverrides]);

  const findOutlineNodeById = (nodes: OutlineNode[], targetId: string): OutlineNode | null => {
    for (const node of nodes) {
      if (node.id === targetId) return node;
      if (node.items?.length) {
        const found = findOutlineNodeById(node.items, targetId);
        if (found) return found;
      }
    }
    return null;
  };

  useEffect(() => {
    const map = new Map<string, string | null>();
    const walk = (nodes: OutlineNode[], parentId: string | null) => {
      nodes.forEach((node) => {
        map.set(node.id, parentId);
        if (node.items?.length) {
          walk(node.items, node.id);
        }
      });
    };
    walk(outlineDisplay, null);
    tocParentMapRef.current = map;
  }, [outlineDisplay]);

  const getHighlightSortKey = (item: HighlightItem) => {
    const rects = item.rects || [];
    const pageIndex =
      item.pageIndex ?? (rects.length ? rects[0].pageIndex : 0);
    const top = rects.length ? Math.min(...rects.map((rect) => rect.y ?? 0)) : 0;
    return { pageIndex, top };
  };

  type CombinedEntry = {
    key: string;
    kind: 'node' | 'note';
    id: string;
    order?: number;
    pageIndex: number;
    top: number;
    index: number;
  };

  const buildCombinedEntries = (nodes: OutlineNode[], notes: HighlightItem[]) => {
    const entries: CombinedEntry[] = [
      ...nodes.map((node, index) => ({
        key: `node:${node.id}`,
        kind: 'node' as const,
        id: node.id,
        order: node.order,
        pageIndex:
          typeof node.pageIndex === 'number' ? node.pageIndex : Number.POSITIVE_INFINITY,
        top: typeof node.topRatio === 'number' ? node.topRatio : 0,
        index
      })),
      ...notes.map((note, index) => {
        const key = getHighlightSortKey(note);
        return {
          key: `note:${note.id}`,
          kind: 'note' as const,
          id: note.id,
          order: note.order,
          pageIndex:
            typeof key.pageIndex === 'number' ? key.pageIndex : Number.POSITIVE_INFINITY,
          top: typeof key.top === 'number' ? key.top : 0,
          index: index + nodes.length
        };
      })
    ];
    return entries;
  };

  const getCombinedFallbackOrder = (entries: CombinedEntry[]) => {
    const fallbackSorted = entries.slice().sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      if (a.top !== b.top) return a.top - b.top;
      return a.index - b.index;
    });
    const map = new Map<string, number>();
    fallbackSorted.forEach((entry, idx) => {
      map.set(entry.key, idx);
    });
    return map;
  };

  const sortCombinedEntries = (entries: CombinedEntry[]) => {
    const fallbackOrder = getCombinedFallbackOrder(entries);
    return entries.slice().sort((a, b) => {
      const aOrder =
        typeof a.order === 'number' ? a.order : (fallbackOrder.get(a.key) ?? 0);
      const bOrder =
        typeof b.order === 'number' ? b.order : (fallbackOrder.get(b.key) ?? 0);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (fallbackOrder.get(a.key) ?? 0) - (fallbackOrder.get(b.key) ?? 0);
    });
  };

  const getCombinedOrderValue = (parentId: string) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = highlights.filter(
      (item) => item.chapterId === parentId && !item.isChapterTitle
    );
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) return 0;
    const fallbackOrder = getCombinedFallbackOrder(entries);
    let maxOrder = -Infinity;
    entries.forEach((entry) => {
      const value =
        typeof entry.order === 'number' ? entry.order : (fallbackOrder.get(entry.key) ?? 0);
      if (value > maxOrder) maxOrder = value;
    });
    if (!Number.isFinite(maxOrder)) return 0;
    return maxOrder + 1;
  };

  const getCombinedEntryOrderValue = (
    parentId: string,
    kind: 'node' | 'note',
    id: string
  ) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = highlights.filter(
      (item) => item.chapterId === parentId && !item.isChapterTitle
    );
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) return undefined;
    const fallbackOrder = getCombinedFallbackOrder(entries);
    const targetKey = `${kind}:${id}`;
    const target = entries.find((entry) => entry.key === targetKey);
    if (!target) return undefined;
    if (typeof target.order === 'number') return target.order;
    return fallbackOrder.get(target.key);
  };

  const getCombinedOrderValueAfter = (
    parentId: string,
    kind: 'node' | 'note',
    id: string
  ) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = highlights.filter(
      (item) => item.chapterId === parentId && !item.isChapterTitle
    );
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) return 0;
    const sorted = sortCombinedEntries(entries);
    const fallbackOrder = getCombinedFallbackOrder(entries);
    const targetKey = `${kind}:${id}`;
    const index = sorted.findIndex((entry) => entry.key === targetKey);
    if (index === -1) return getCombinedOrderValue(parentId);
    const current = sorted[index];
    const currentOrder =
      typeof current.order === 'number'
        ? current.order
        : (fallbackOrder.get(current.key) ?? index);
    const next = sorted[index + 1];
    if (!next) return currentOrder + 1;
    const nextOrder =
      typeof next.order === 'number'
        ? next.order
        : (fallbackOrder.get(next.key) ?? currentOrder + 1);
    if (nextOrder - currentOrder > 1e-6) {
      return (currentOrder + nextOrder) / 2;
    }
    return currentOrder + 0.0001;
  };

  const getNodeOrderValueAfter = (parentId: string, nodeId: string) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    if (!nodes.length) return 0;
    const baseSorted = nodes.slice().sort((a, b) => {
      if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) {
        return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
      }
      if ((a.topRatio ?? 0) !== (b.topRatio ?? 0)) {
        return (a.topRatio ?? 0) - (b.topRatio ?? 0);
      }
      return a.title.localeCompare(b.title);
    });
    const baseOrder = new Map<string, number>();
    baseSorted.forEach((node, index) => {
      baseOrder.set(node.id, index);
    });
    const indexed = nodes.map((node, index) => ({ node, index }));
    indexed.sort((a, b) => {
      const aBase = baseOrder.get(a.node.id) ?? a.index;
      const bBase = baseOrder.get(b.node.id) ?? b.index;
      const aOrder = typeof a.node.order === 'number' ? a.node.order : aBase;
      const bOrder = typeof b.node.order === 'number' ? b.node.order : bBase;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (aBase !== bBase) return aBase - bBase;
      return a.node.title.localeCompare(b.node.title);
    });
    const sorted = indexed.map((entry) => entry.node);
    const index = sorted.findIndex((node) => node.id === nodeId);
    if (index === -1) return getCombinedOrderValue(parentId);
    const current = sorted[index];
    const currentBase = baseOrder.get(current.id) ?? index;
    const currentOrder =
      typeof current.order === 'number' ? current.order : currentBase;
    const next = sorted[index + 1];
    if (!next) return currentOrder + 1;
    const nextBase = baseOrder.get(next.id) ?? currentOrder + 1;
    const nextOrder =
      typeof next.order === 'number' ? next.order : nextBase;
    if (nextOrder - currentOrder > 1e-6) {
      return (currentOrder + nextOrder) / 2;
    }
    return currentOrder + 0.0001;
  };

  const highlightsByChapter = useMemo(() => {
    const map = new Map<string, HighlightItem[]>();
    highlights.forEach((item) => {
      if (!item.chapterId || item.isChapterTitle) return;
      const list = map.get(item.chapterId) || [];
      list.push(item);
      map.set(item.chapterId, list);
    });
    return map;
  }, [highlights]);

  const showPdfMarginOutline = false;
  const pdfMarginChildrenByPage = useMemo(() => {
    const map = new Map<
      number,
      Array<{
        parentId: string;
        topRatio: number;
        sortIndex?: number;
        items: Array<{
          key: string;
          label: string;
          kind: 'note' | 'chapter';
          color?: string;
          indentPx?: number;
          note?: HighlightItem;
          node?: OutlineNode;
          sortPage: number;
          sortTop: number;
          sortIndex?: number;
        }>;
      }>
    >();
    if (!showPdfMarginOutline || viewMode !== ReaderMode.PDF || !outlineDisplay.length) return map;

    const highlightChapterNodeIdSet = new Set<string>();
    highlights.forEach((item) => {
      if (!item.isChapterTitle) return;
      if (isManualHighlight(item)) return;
      const nodeId = item.chapterNodeId || item.chapterId;
      if (nodeId) highlightChapterNodeIdSet.add(nodeId);
    });

    const clampTopRatio = (value: number) => Math.max(0, Math.min(0.99, value));

    const estimateMarginChapterHeightRatio = (label: string) => {
      const text = String(label || '').trim();
      if (!text) return 0.02;
      const charsPerLine = 16;
      const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
      const lineHeightPx = 18;
      const paddingPx = 8;
      const pageHeightPx = 1120;
      const heightPx = paddingPx * 2 + lines * lineHeightPx;
      const ratio = heightPx / pageHeightPx;
      return Math.max(0.012, Math.min(0.2, ratio));
    };

    const estimateMarginNoteHeightRatio = (label: string) => {
      const text = String(label || '').trim();
      if (!text) return 0.018;
      const charsPerLine = 20;
      const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
      const lineHeightPx = 16;
      const paddingPx = 6;
      const pageHeightPx = 1120;
      const heightPx = paddingPx * 2 + lines * lineHeightPx;
      const ratio = heightPx / pageHeightPx;
      return Math.max(0.01, Math.min(0.16, ratio));
    };

    const nodeDepthMap = new Map<string, number>();
    const buildNodeDepth = (node: OutlineNode, depth: number) => {
      nodeDepthMap.set(node.id, depth);
      (node.items || []).forEach((child) => buildNodeDepth(child, depth + 1));
    };

    const normalChapterPlacement = new Map<
      string,
      { pageIndex: number; topRatio: number; sortIndex: number; indentPx: number }
    >();
    const normalNotePlacement = new Map<
      string,
      { pageIndex: number; topRatio: number; sortIndex: number; indentPx: number }
    >();
    const computeNormalChapterPlacement = (parent: OutlineNode) => {
      const siblings = parent.items || [];
      let prevNode: OutlineNode | null = null;
      siblings.forEach((child, index) => {
        const isNormalChapter = child.isCustom && !highlightChapterNodeIdSet.has(child.id);
        const depth = nodeDepthMap.get(child.id) ?? 0;
        const indentPx = depth * 12;
        let pageIndex: number;
        let topRatio: number;

        if (prevNode) {
          const prevPlacement = normalChapterPlacement.get(prevNode.id);
          const prevPageIndex =
            typeof prevPlacement?.pageIndex === 'number'
              ? prevPlacement.pageIndex
              : typeof prevNode.pageIndex === 'number'
                ? prevNode.pageIndex
                : typeof parent.pageIndex === 'number'
                  ? parent.pageIndex
                  : typeof child.pageIndex === 'number'
                    ? child.pageIndex
                    : 0;
          const prevTopRatio =
            typeof prevPlacement?.topRatio === 'number'
              ? prevPlacement.topRatio
              : typeof prevNode.topRatio === 'number'
                ? prevNode.topRatio
                : typeof parent.topRatio === 'number'
                  ? parent.topRatio
                  : typeof child.topRatio === 'number'
                    ? child.topRatio
                    : 0;
          const prevHeightRatio = estimateMarginChapterHeightRatio(prevNode.title);
          pageIndex = prevPageIndex;
          topRatio = clampTopRatio(prevTopRatio + prevHeightRatio);
        } else {
          const basePageIndex =
            typeof parent.pageIndex === 'number'
              ? parent.pageIndex
              : typeof child.pageIndex === 'number'
                ? child.pageIndex
                : 0;
          const baseTopRatio =
            typeof parent.topRatio === 'number'
              ? parent.topRatio
              : typeof child.topRatio === 'number'
                ? child.topRatio
                : 0;
          pageIndex = basePageIndex;
          topRatio = clampTopRatio(baseTopRatio);
        }

        if (isNormalChapter) {
          normalChapterPlacement.set(child.id, { pageIndex, topRatio, sortIndex: index, indentPx });
        }

        prevNode = child;
      });

      siblings.forEach((child) => computeNormalChapterPlacement(child));
    };

    const computeNormalNotePlacement = (parent: OutlineNode) => {
      const nodes = parent.items || [];
      const notes = highlightsByChapter.get(parent.id) || [];
      const nodeMap = new Map(nodes.map((child) => [child.id, child]));
      const noteMap = new Map(notes.map((note) => [note.id, note]));
      const combinedEntries = sortCombinedEntries(buildCombinedEntries(nodes, notes));
      let prevMetrics: { pageIndex: number; topRatio: number; heightRatio: number } | null = null;
      const parentDepth = nodeDepthMap.get(parent.id) ?? 0;
      const noteIndentPx = parentDepth * 12 + 6;

      combinedEntries.forEach((entry, index) => {
        if (entry.kind === 'note') {
          const note = noteMap.get(entry.id);
          if (!note) return;
          const key = getHighlightSortKey(note);
          if (isManualHighlight(note)) {
            let pageIndex: number;
            let topRatio: number;
            if (prevMetrics) {
              pageIndex = prevMetrics.pageIndex;
              topRatio = clampTopRatio(prevMetrics.topRatio + prevMetrics.heightRatio);
            } else {
              pageIndex =
                typeof parent.pageIndex === 'number'
                  ? parent.pageIndex
                  : typeof key.pageIndex === 'number'
                    ? key.pageIndex
                    : typeof note.pageIndex === 'number'
                      ? note.pageIndex
                      : 0;
              const baseTop =
                typeof parent.topRatio === 'number'
                  ? parent.topRatio
                  : typeof key.top === 'number'
                    ? key.top
                    : 0;
              topRatio = clampTopRatio(baseTop);
            }
            normalNotePlacement.set(note.id, {
              pageIndex,
              topRatio,
              sortIndex: index,
              indentPx: noteIndentPx
            });
            prevMetrics = {
              pageIndex,
              topRatio,
              heightRatio: estimateMarginNoteHeightRatio(note.text)
            };
          } else {
            const pageIndex =
              typeof key.pageIndex === 'number'
                ? key.pageIndex
                : typeof note.pageIndex === 'number'
                  ? note.pageIndex
                  : 0;
            const topRatio = clampTopRatio(
              typeof key.top === 'number' ? key.top : 0
            );
            prevMetrics = {
              pageIndex,
              topRatio,
              heightRatio: estimateMarginNoteHeightRatio(note.text)
            };
          }
          return;
        }
        const child = nodeMap.get(entry.id);
        if (!child) return;
        const isNormalChapter = child.isCustom && !highlightChapterNodeIdSet.has(child.id);
        if (isNormalChapter) {
          const placement = normalChapterPlacement.get(child.id);
          if (placement) {
            prevMetrics = {
              pageIndex: placement.pageIndex,
              topRatio: placement.topRatio,
              heightRatio: estimateMarginChapterHeightRatio(child.title)
            };
            return;
          }
        }
        const pageIndex =
          typeof child.pageIndex === 'number'
            ? child.pageIndex
            : typeof parent.pageIndex === 'number'
              ? parent.pageIndex
              : 0;
        const topRatio = clampTopRatio(
          typeof child.topRatio === 'number' ? child.topRatio : 0
        );
        prevMetrics = {
          pageIndex,
          topRatio,
          heightRatio: estimateMarginChapterHeightRatio(child.title)
        };
      });

      nodes.forEach((child) => computeNormalNotePlacement(child));
    };

    const groupsByPage = new Map<number, Map<string, { parentId: string; topRatio: number; sortIndex?: number; items: Array<{
      key: string;
      label: string;
      kind: 'note' | 'chapter';
      color?: string;
      indentPx?: number;
      note?: HighlightItem;
      node?: OutlineNode;
      sortPage: number;
      sortTop: number;
      sortIndex?: number;
    }>}>>();

    const addToGroup = (
      anchor: { anchorId: string; pageIndex: number; topRatio: number; sortIndex?: number },
      item: {
        key: string;
        label: string;
        kind: 'note' | 'chapter';
        color?: string;
        note?: HighlightItem;
        node?: OutlineNode;
        sortPage: number;
        sortTop: number;
        sortIndex?: number;
        indentPx?: number;
      }
    ) => {
      const pageIndex = Number.isFinite(anchor.pageIndex) ? anchor.pageIndex : item.sortPage;
      const topRatio = Number.isFinite(anchor.topRatio) ? anchor.topRatio : 0;
      if (!Number.isFinite(pageIndex)) return;
      const pageMap = groupsByPage.get(pageIndex) || new Map();
      let group = pageMap.get(anchor.anchorId);
      if (!group) {
        group = { parentId: anchor.anchorId, topRatio, sortIndex: anchor.sortIndex, items: [] };
        pageMap.set(anchor.anchorId, group);
      } else if (typeof group.sortIndex !== 'number' && typeof anchor.sortIndex === 'number') {
        group.sortIndex = anchor.sortIndex;
      }
      group.items.push(item);
      groupsByPage.set(pageIndex, pageMap);
    };

    const walk = (node: OutlineNode, ancestorsExpanded: boolean) => {
      const childrenVisible =
        ancestorsExpanded && (node.isRoot ? true : expandedTOC.has(node.id));
      const nodes = node.items || [];
      const notes = highlightsByChapter.get(node.id) || [];
      notes.forEach((note) => {
        if (!childrenVisible) return;
        if (!note || !isManualHighlight(note)) return;
        const placement = normalNotePlacement.get(note.id);
        if (!placement) return;
        addToGroup(
          {
            anchorId: `note-${note.id}`,
            pageIndex: placement.pageIndex,
            topRatio: placement.topRatio,
            sortIndex: placement.sortIndex
          },
          {
            key: `note-${note.id}`,
            label: note.text,
            kind: 'note' as const,
            color: note.color,
            note,
            sortPage: placement.pageIndex,
            sortTop: placement.topRatio,
            sortIndex: placement.sortIndex,
            indentPx: placement.indentPx
          }
        );
      });

      nodes.forEach((child) => {
        if (!childrenVisible) return;
        if (!child || !child.isCustom || highlightChapterNodeIdSet.has(child.id)) return;
        const placement = normalChapterPlacement.get(child.id);
        if (!placement) return;
        addToGroup(
          {
            anchorId: child.id,
            pageIndex: placement.pageIndex,
            topRatio: placement.topRatio,
            sortIndex: placement.sortIndex
          },
          {
            key: `node-${child.id}`,
            label: child.title,
            kind: 'chapter' as const,
            node: child,
            sortPage: placement.pageIndex,
            sortTop: placement.topRatio,
            sortIndex: placement.sortIndex,
            indentPx: placement.indentPx
          }
        );
      });
      if (!childrenVisible) return;
      nodes.forEach((child) => walk(child, childrenVisible));
    };

    const root = outlineDisplay[0];
    if (root) {
      buildNodeDepth(root, 0);
      computeNormalChapterPlacement(root);
      computeNormalNotePlacement(root);
      walk(root, true);
    }
    groupsByPage.forEach((pageMap, pageIndex) => {
      const list = Array.from(pageMap.values());
      list.forEach((group) => {
        group.items.sort((a, b) => {
          const aIndex = typeof a.sortIndex === 'number' ? a.sortIndex : null;
          const bIndex = typeof b.sortIndex === 'number' ? b.sortIndex : null;
          if (aIndex !== null && bIndex !== null && aIndex !== bIndex) {
            return aIndex - bIndex;
          }
          if (aIndex !== null && bIndex === null) return -1;
          if (aIndex === null && bIndex !== null) return 1;
          if (a.sortPage !== b.sortPage) return a.sortPage - b.sortPage;
          return a.sortTop - b.sortTop;
        });
      });
      list.sort((a, b) => {
        if (a.topRatio !== b.topRatio) return a.topRatio - b.topRatio;
        const aIndex = typeof a.sortIndex === 'number' ? a.sortIndex : null;
        const bIndex = typeof b.sortIndex === 'number' ? b.sortIndex : null;
        if (aIndex !== null && bIndex !== null && aIndex !== bIndex) {
          return aIndex - bIndex;
        }
        if (aIndex !== null && bIndex === null) return -1;
        if (aIndex === null && bIndex !== null) return 1;
        return 0;
      });
      map.set(pageIndex, list);
    });
    return map;
  }, [outlineDisplay, highlightsByChapter, highlights, viewMode, expandedTOC, expandedHighlightIds]);

  const highlightsByQuestion = useMemo(() => {
    const map = new Map<string, HighlightItem[]>();
    highlights.forEach((item) => {
      const ids = Array.isArray(item.questionIds) ? item.questionIds : [];
      ids.forEach((id) => {
        if (!id) return;
        const list = map.get(id) || [];
        list.push(item);
        map.set(id, list);
      });
    });
    return map;
  }, [highlights]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.library) return;
    if (!paper?.id) return;
    if (!paperStateLoadedRef.current) return;
    if (saveStateTimerRef.current) {
      window.clearTimeout(saveStateTimerRef.current);
    }
    saveStateTimerRef.current = window.setTimeout(() => {
      window.electronAPI?.library?.savePaperState?.(paper.id, {
        highlights,
        customChapters,
        questions,
        aiConversations: chatThreads,
        activeChatId,
        updatedAt: Date.now()
      });
    }, 400);
    return () => {
      if (saveStateTimerRef.current) {
        window.clearTimeout(saveStateTimerRef.current);
      }
    };
  }, [paper?.id, highlights, customChapters, questions, chatThreads, activeChatId]);

  const buildMindmapRoot = useCallback((): MindMapNode | null => {
    if (!outlineDisplay.length) return null;
    const rootNode = outlineDisplay[0];
    const highlightChapterNodeIdSet = new Set<string>();
    highlights.forEach((item) => {
      if (!item.isChapterTitle) return;
      if (isManualHighlight(item)) return;
      const nodeId = item.chapterNodeId || item.chapterId;
      if (nodeId) highlightChapterNodeIdSet.add(nodeId);
    });

    const buildNode = (node: OutlineNode): MindMapNode => {
      const childItems = node.items || [];
      const childNodes = childItems.map((child) => buildNode(child));
      const noteItems = highlightsByChapter.get(node.id) || [];
      const noteNodes: MindMapNode[] = noteItems.map((note) => ({
        id: `note-${note.id}`,
        text: note.text,
        translation:
          note.isChapterTitle || isManualHighlight(note) ? '' : note.translation || '',
        kind: 'note',
        color: note.color,
        pageIndex: note.pageIndex,
        note
      }));
      const childNodeMap = new Map(childItems.map((child, index) => [child.id, childNodes[index]]));
      const noteNodeMap = new Map(noteItems.map((note, index) => [note.id, noteNodes[index]]));
      const combinedEntries = sortCombinedEntries(buildCombinedEntries(childItems, noteItems));
      const combined = combinedEntries
        .map((entry) =>
          entry.kind === 'node'
            ? childNodeMap.get(entry.id)
            : noteNodeMap.get(entry.id)
        )
        .filter(Boolean) as MindMapNode[];

      return {
        id: node.id,
        text: node.title,
        kind: node.isRoot ? 'root' : 'chapter',
        isNormalChapter: Boolean(node.isCustom && !highlightChapterNodeIdSet.has(node.id)),
        pageIndex: node.pageIndex,
        topRatio: node.topRatio,
        children: combined
      };
    };

    const rootChildren = (rootNode.items || []).map((child) => buildNode(child));
    const rootNotes = highlightsByChapter.get(rootNode.id) || [];
    const rootNoteNodes: MindMapNode[] = rootNotes.map((note) => ({
      id: `note-${note.id}`,
      text: note.text,
      translation:
        note.isChapterTitle || isManualHighlight(note) ? '' : note.translation || '',
      kind: 'note',
      color: note.color,
      pageIndex: note.pageIndex,
      note
    }));
    const rootChildMap = new Map(
      (rootNode.items || []).map((child, index) => [child.id, rootChildren[index]])
    );
    const rootNoteMap = new Map(rootNotes.map((note, index) => [note.id, rootNoteNodes[index]]));
    const rootCombinedEntries = sortCombinedEntries(
      buildCombinedEntries(rootNode.items || [], rootNotes)
    );
    const combinedRoot = rootCombinedEntries
      .map((entry) =>
        entry.kind === 'node'
          ? rootChildMap.get(entry.id)
          : rootNoteMap.get(entry.id)
      )
      .filter(Boolean) as MindMapNode[];

    return {
      id: rootNode.id,
      text: rootNode.title,
      kind: 'root',
      children: combinedRoot
    };
  }, [outlineDisplay, highlightsByChapter]);

  const mindmapRoot = useMemo(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return null;
    return buildMindmapRoot();
  }, [viewMode, buildMindmapRoot]);

  const mindmapNodeMap = useMemo(() => {
    if (viewMode !== ReaderMode.MIND_MAP || !mindmapRoot) return new Map<string, MindMapNode>();
    const map = new Map<string, MindMapNode>();
    const walk = (node: MindMapNode) => {
      map.set(node.id, node);
      node.children?.forEach((child) => walk(child));
    };
    walk(mindmapRoot);
    return map;
  }, [mindmapRoot, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!mindmapRoot) {
      setActiveMindmapNodeId(null);
      return;
    }
    if (activeMindmapNodeId && mindmapNodeMap.has(activeMindmapNodeId)) return;
    setActiveMindmapNodeId(mindmapRoot.id);
  }, [viewMode, mindmapRoot, mindmapNodeMap, activeMindmapNodeId]);

  const mindmapParentMap = useMemo(() => {
    if (viewMode !== ReaderMode.MIND_MAP || !mindmapRoot) return new Map<string, string | null>();
    const map = new Map<string, string | null>();
    const walk = (node: MindMapNode, parentId: string | null) => {
      map.set(node.id, parentId);
      node.children?.forEach((child) => walk(child, node.id));
    };
    walk(mindmapRoot, null);
    return map;
  }, [mindmapRoot, viewMode]);

  const customChapterIdSet = useMemo(() => {
    return new Set(customChapters.map((item) => item.id));
  }, [customChapters]);

  const highlightChapterIdSet = useMemo(() => {
    const set = new Set<string>();
    highlights.forEach((item) => {
      if (!item.isChapterTitle) return;
      if (isManualHighlight(item)) return;
      const nodeId = item.chapterNodeId || item.chapterId;
      if (nodeId) set.add(nodeId);
    });
    return set;
  }, [highlights]);

  const highlightParentOutline = useMemo(() => {
    const list = getFlatOutlineByPosition(outlineDisplay);
    if (!list.length) return list;
    return list.filter((node) => {
      if (node.isRoot) return true;
      if (!node.isCustom) return true;
      return highlightChapterIdSet.has(node.id);
    });
  }, [outlineDisplay, highlightChapterIdSet]);

  useEffect(() => {
    if (!outlineDisplay.length) return;
    const notesByParent = new Map<string, HighlightItem[]>();
    highlights.forEach((item) => {
      if (!item.chapterId || item.isChapterTitle) return;
      const list = notesByParent.get(item.chapterId) || [];
      list.push(item);
      notesByParent.set(item.chapterId, list);
    });
    const customIdSet = new Set(customChapters.map((item) => item.id));
    const missingHighlightOrders = new Map<string, number>();
    const missingCustomOrders = new Map<string, number>();

    const walk = (node: OutlineNode) => {
      const nodes = node.items || [];
      const notes = notesByParent.get(node.id) || [];
      if (nodes.length || notes.length) {
        const entries = buildCombinedEntries(nodes, notes);
        if (entries.length) {
          const fallbackOrder = getCombinedFallbackOrder(entries);
          entries.forEach((entry) => {
            if (entry.kind === 'note') {
              const note = notes.find((item) => item.id === entry.id);
              if (note && typeof note.order !== 'number') {
                const order = fallbackOrder.get(entry.key);
                if (typeof order === 'number') {
                  missingHighlightOrders.set(note.id, order);
                }
              }
              return;
            }
            if (entry.kind === 'node' && customIdSet.has(entry.id)) {
              const chapter = nodes.find((item) => item.id === entry.id);
              if (chapter && typeof chapter.order !== 'number') {
                const order = fallbackOrder.get(entry.key);
                if (typeof order === 'number') {
                  missingCustomOrders.set(chapter.id, order);
                }
              }
            }
          });
        }
      }
      nodes.forEach((child) => walk(child));
    };

    const root = outlineDisplay[0];
    if (root) {
      walk(root);
    }

    if (missingHighlightOrders.size) {
      setHighlights((prev) =>
        prev.map((item) => {
          const order = missingHighlightOrders.get(item.id);
          return typeof order === 'number' ? { ...item, order } : item;
        })
      );
    }
    if (missingCustomOrders.size) {
      setCustomChapters((prev) =>
        prev.map((item) => {
          const order = missingCustomOrders.get(item.id);
          return typeof order === 'number' ? { ...item, order } : item;
        })
      );
    }
  }, [outlineDisplay, highlights, customChapters]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!draggingChapterId) return undefined;
    if (dragChapterTimerRef.current) {
      window.clearTimeout(dragChapterTimerRef.current);
      dragChapterTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const mindmapNode = target?.closest?.('[data-mindmap-id]');
      let mindmapId = mindmapNode?.getAttribute('data-mindmap-id') || null;
      const mindmapKind = mindmapNode?.getAttribute('data-mindmap-kind') || null;
      if (mindmapKind === 'note') {
        mindmapId = null;
      }
      setDragOverMindmapId(mindmapId);
      const dragInfo = dragChapterRef.current;
      if (dragInfo) {
        setDragGhost((prev) => ({
          ...(prev || {}),
          id: dragInfo.id,
          text: dragInfo.text || prev?.text || '',
          width: dragInfo.width || prev?.width || 0,
          height: dragInfo.height || prev?.height || 0,
          lines: dragInfo.lines || prev?.lines,
          fontSize: dragInfo.fontSize || prev?.fontSize,
          lineHeight: dragInfo.lineHeight || prev?.lineHeight,
          x: event.clientX - (dragInfo.offsetX || 0),
          y: event.clientY - (dragInfo.offsetY || 0)
        }));
      }
    };
    const handleUp = () => {
      const dragInfo = dragChapterRef.current;
      const targetId = dragOverMindmapId;
      if (dragInfo && targetId && targetId !== dragInfo.id) {
        const isDescendant = (() => {
          let current = mindmapParentMap.get(targetId) || null;
          while (current) {
            if (current === dragInfo.id) return true;
            current = mindmapParentMap.get(current) || null;
          }
          return false;
        })();
        if (!isDescendant) {
          setChapterParentOverrides((prev) => ({
            ...prev,
            [dragInfo.id]: targetId
          }));
        }
      }
      setDraggingChapterId(null);
      setDragOverMindmapId(null);
      setDragGhost(null);
      dragChapterTriggeredRef.current = false;
      dragChapterRef.current = null;
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
  }, [draggingChapterId, dragOverMindmapId, mindmapParentMap, viewMode]);

  useEffect(() => {
    if (questionPicker.open && (!selectionRect || !selectionText)) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
    }
  }, [questionPicker.open, selectionRect, selectionText]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const handleUp = () => {
      if (draggingChapterId) return;
      if (dragChapterTimerRef.current) {
        window.clearTimeout(dragChapterTimerRef.current);
        dragChapterTimerRef.current = null;
      }
      dragChapterTriggeredRef.current = false;
      dragChapterRef.current = null;
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [draggingChapterId, viewMode]);

  const findOutlinePath = (nodes: OutlineNode[], targetId: string, path: string[] = []): string[] | null => {
    for (const node of nodes) {
      const nextPath = [...path, node.id];
      if (node.id === targetId) return nextPath;
      if (node.items?.length) {
        const childPath = findOutlinePath(node.items, targetId, nextPath);
        if (childPath) return childPath;
      }
    }
    return null;
  };

  const highlightRectsByPage = useMemo(() => {
    const map = new Map<number, { rect: HighlightRect; color: string; id: string }[]>();
    highlights.forEach((highlight) => {
      highlight.rects.forEach((rect) => {
        const list = map.get(rect.pageIndex) || [];
        list.push({ rect, color: highlight.color, id: highlight.id });
        map.set(rect.pageIndex, list);
      });
    });
    return map;
  }, [highlights]);

  useEffect(() => {
    let cancelled = false;
    paperStateLoadedRef.current = false;
    setOutlineNodes([]);
    setExpandedTOC(new Set());
    setNumPages(0);
    setHighlights([]);
    setCustomChapters([]);
    setSelectionText('');
    setSelectionRect(null);
    setSelectionInfo(null);
    setActiveHighlightId(null);
    setActiveHighlightColor(null);
    setTranslationResult('');
    setExpandedHighlightIds(new Set());
    setCollapsedMindmapIds(new Set());
    setMindmapOffset({ x: 0, y: 0 });
    setIsMindmapPanning(false);
    setDraggingNoteId(null);
    setDraggingChapterId(null);
    setDragOverMindmapId(null);
    setDraggingTocNoteId(null);
    setDraggingTocChapterId(null);
    setDragOverTocId(null);
    setDragGhost(null);
    setChapterParentOverrides({});
    setMindmapEditing(null);
    setMindmapEditValue('');
    setChatThreads([]);
    setActiveChatId(null);
    setInput('');
    setIsTyping(false);
    if (typeof window !== 'undefined') {
      if (dragNoteTimerRef.current) {
        window.clearTimeout(dragNoteTimerRef.current);
      }
      if (dragChapterTimerRef.current) {
        window.clearTimeout(dragChapterTimerRef.current);
      }
      if (tocDragNoteTimerRef.current) {
        window.clearTimeout(tocDragNoteTimerRef.current);
      }
      if (tocDragChapterTimerRef.current) {
        window.clearTimeout(tocDragChapterTimerRef.current);
      }
    }
    dragNoteTimerRef.current = null;
    dragChapterTimerRef.current = null;
    dragNoteRef.current = null;
    dragNoteTriggeredRef.current = false;
    dragChapterRef.current = null;
    dragChapterTriggeredRef.current = false;
    tocDragNoteTimerRef.current = null;
    tocDragChapterTimerRef.current = null;
    tocDragNoteRef.current = null;
    tocDragNoteTriggeredRef.current = false;
    tocDragChapterRef.current = null;
    tocDragChapterTriggeredRef.current = false;
    mindmapLayoutRef.current = null;
    mindmapAnchorRef.current = null;
    mindmapPanRef.current = null;
    mindmapStateRef.current = null;
    const loadState = async () => {
      if (typeof window === 'undefined' || !window.electronAPI?.library) {
        setQuestions([]);
        paperStateLoadedRef.current = true;
        return;
      }
      const saved = await window.electronAPI.library.getPaperState?.(paper.id);
      if (cancelled) return;
      if (saved && typeof saved === 'object') {
        const normalizedHighlights = Array.isArray(saved.highlights)
          ? saved.highlights.map((item: any) => {
              const ids = Array.isArray(item.questionIds)
                ? item.questionIds.filter(Boolean)
                : [];
              const legacyId = item.questionId;
              if (legacyId && !ids.includes(legacyId)) {
                ids.push(legacyId);
              }
              const next = { ...item, questionIds: ids };
              if (isManualHighlight(next) && !next.isChapterTitle && !next.translation) {
                const text = String(next.text || '').trim();
                if (text) {
                  next.translation = text;
                }
              }
              delete (next as any).questionId;
              delete (next as any).questionText;
              return next;
            })
          : [];
        setHighlights(normalizedHighlights);
        setCustomChapters(Array.isArray(saved.customChapters) ? saved.customChapters : []);
        const savedQuestions = Array.isArray(saved.questions) ? saved.questions : [];
        setQuestions(savedQuestions);
        const savedChats = Array.isArray(saved.aiConversations)
          ? saved.aiConversations
              .map((item: any) => ({
                id: String(item?.id || ''),
                title: String(item?.title || '新对话'),
                messages: Array.isArray(item?.messages)
                  ? item.messages
                      .filter((msg: any) => msg && (msg.role === 'user' || msg.role === 'model'))
                      .map((msg: any) => ({
                        role: msg.role,
                        text: String(msg.text || '')
                      }))
                  : [],
                createdAt: Number(item?.createdAt || Date.now()),
                updatedAt: Number(item?.updatedAt || Date.now())
              }))
              .filter((item: ChatThread) => item.id)
          : [];
        setChatThreads(savedChats);
        const savedActiveId =
          typeof saved.activeChatId === 'string' &&
          savedChats.some((item: ChatThread) => item.id === saved.activeChatId)
            ? saved.activeChatId
            : null;
        setActiveChatId(savedActiveId);
        paperStateLoadedRef.current = true;
        return;
      }
      setQuestions([]);
      setChatThreads([]);
      setActiveChatId(null);
      paperStateLoadedRef.current = true;
    };
    loadState();
    return () => {
      cancelled = true;
    };
  }, [paper.id]);

  const handleDocumentLoad = async (doc: PDFDocumentProxy) => {
    pdfDocRef.current = doc;
    setNumPages(doc.numPages);
    try {
      const outline = await doc.getOutline();
      const tree = outline?.length ? await buildOutlineTree(doc, outline, '') : [];
      setOutlineNodes((prev) => {
        const existingRootId = prev[0]?.id || `outline-root-${paper.id}`;
        const rootNode: OutlineNode = {
          id: existingRootId,
          title: paper.title || 'Document',
          pageIndex: 0,
          topRatio: 0,
          items: tree,
          isRoot: true
        };
        return [rootNode];
      });
      const rootId = `outline-root-${paper.id}`;
      setExpandedTOC((prev) => {
        const next = new Set(prev);
        next.add(rootId);
        return next;
      });
    } catch (error) {
      console.error('Outline load error:', error);
      setOutlineNodes([]);
    }
  };

  useEffect(() => {
    setOutlineNodes((prev) => {
      if (!prev.length) return prev;
      const root = prev[0];
      const nextTitle = paper.title || 'Document';
      if (root.title === nextTitle) return prev;
      return [{ ...root, title: nextTitle }, ...prev.slice(1)];
    });
  }, [paper.title]);

  // --- Components ---

  // Fix: Typed as React.FC to support 'key' prop in recursive calls and list rendering
  const TOCNode: React.FC<{ item: OutlineNode, level: number }> = ({ item, level }) => {
    const notes = highlightsByChapter.get(item.id) || [];
    const hasChildren = (item.items && item.items.length > 0) || notes.length > 0;
    const isExpanded = expandedTOC.has(item.id);
    const isNormalChapterInToc = item.isCustom && !highlightChapterIdSet.has(item.id);
    const isDropTarget =
      dragOverTocId === item.id && (Boolean(draggingTocNoteId) || Boolean(draggingTocChapterId));
    const nodeMap = new Map((item.items || []).map((node) => [node.id, node]));
    const noteMap = new Map(notes.map((note) => [note.id, note]));
    const combinedItems = sortCombinedEntries(
      buildCombinedEntries(item.items || [], notes)
    ).map((entry) =>
      entry.kind === 'note'
        ? { type: 'note' as const, note: noteMap.get(entry.id)! }
        : { type: 'node' as const, node: nodeMap.get(entry.id)! }
    );

    return (
      <div className="select-none">
        <div 
          data-toc-id={item.id}
          data-toc-kind="chapter"
          className={`group flex items-center py-1 px-2 cursor-pointer rounded my-0.5 ${
            isNormalChapterInToc ? 'text-xs text-gray-600 italic' : 'text-sm text-gray-700'
          } ${
            isDropTarget ? 'bg-gray-200' : 'hover:bg-gray-200'
          }`}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onMouseDown={(event) => {
            handleTOCChapterMouseDown(item, event);
          }}
          onClick={() => {
            if (Date.now() < tocSuppressClickUntilRef.current) return;
            if (tocDragChapterTriggeredRef.current) return;
            if (typeof item.pageIndex === 'number') {
              const target = pageRefs.current[item.pageIndex];
              const container = contentAreaRef.current;
              if (target && container) {
                const offset =
                  typeof item.topRatio === 'number' ? item.topRatio * target.clientHeight : 0;
                const top = target.offsetTop + offset;
                container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
              }
            }
          }}
        >
           <button
             type="button"
             className="w-4 h-4 mr-1 flex items-center justify-center text-gray-400"
             onMouseDown={(event) => event.stopPropagation()}
             onClick={(event) => {
               event.stopPropagation();
               if (hasChildren) toggleTOC(item.id);
             }}
             aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
           >
             {hasChildren && (
                isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
             )}
           </button>
           <span className="truncate flex-1">{item.title}</span>
           {item.isCustom ? (
             <Tooltip label="取消自定义章节">
               <button
                 type="button"
                 onMouseDown={(event) => event.stopPropagation()}
                 onClick={(event) => {
                   event.stopPropagation();
                   removeCustomChapter(item.id);
                 }}
                 className="ml-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
               >
                 <X size={12} />
               </button>
             </Tooltip>
           ) : null}
        </div>
        {isExpanded && (
          <div>
            {hasChildren ? (
              <div className="space-y-1">
                {combinedItems.map((entry) =>
                  entry.type === 'note' ? (
                    <div key={entry.note.id} style={{ paddingLeft: `${level * 12 + 14}px` }}>
                      {(() => {
                        const isExpanded = expandedHighlightIds.has(entry.note.id);
                        const isPlainNote =
                          isManualHighlight(entry.note) && !entry.note.isChapterTitle;
                        const clampStyle = isExpanded
                          ? { whiteSpace: 'pre-wrap' as const }
                          : {
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden'
                            };
                        return (
                          <div className="relative group">
                            <button
                              type="button"
                              data-toc-id={entry.note.id}
                              data-toc-kind="note"
                              onMouseDown={(event) => {
                                handleTOCNoteMouseDown(entry.note, event);
                              }}
                              onClick={() => {
                                if (Date.now() < tocSuppressClickUntilRef.current) return;
                                if (tocDragNoteTriggeredRef.current) return;
                                jumpToHighlight(entry.note);
                              }}
                              onDoubleClick={() => {
                                if (Date.now() < tocSuppressClickUntilRef.current) return;
                                setExpandedHighlightIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(entry.note.id)) {
                                    next.delete(entry.note.id);
                                  } else {
                                    next.add(entry.note.id);
                                  }
                                  return next;
                                });
                              }}
                              className={`w-full text-left text-xs rounded px-2 py-1 pr-6 border border-transparent hover:bg-gray-200 group-hover:bg-gray-200 flex flex-col items-start ${
                                entry.note.isChapterTitle ? 'font-semibold text-gray-800' : 'text-gray-600'
                              } ${isPlainNote ? 'italic' : ''}`}
                              style={{
                                borderLeft: `3px solid ${entry.note.color}`
                              }}
                            >
                              <span className="leading-4 w-full" style={clampStyle}>
                                {entry.note.text}
                              </span>
                        {!entry.note.isChapterTitle &&
                        !isManualHighlight(entry.note) &&
                        entry.note.translation ? (
                          <span className="mt-0.5 text-[10px] leading-4 text-gray-500 w-full" style={clampStyle}>
                            {entry.note.translation}
                          </span>
                        ) : null}
                            </button>
                            {!entry.note.isChapterTitle ? (
                              <button
                                type="button"
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeHighlightNote(entry.note);
                                }}
                                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
                                aria-label="删除笔记"
                              >
                                <X size={12} />
                              </button>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <TOCNode key={entry.node.id} item={entry.node} level={level + 1} />
                  )
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const toolbarMindmapNode =
    viewMode === ReaderMode.MIND_MAP
      ? activeMindmapNodeId
        ? mindmapNodeMap.get(activeMindmapNodeId) || mindmapRoot
        : mindmapRoot
      : null;
  const canToolbarAddChild =
    viewMode === ReaderMode.MIND_MAP && !mindmapEditing && Boolean(toolbarMindmapNode);
  const canToolbarAddSibling =
    viewMode === ReaderMode.MIND_MAP &&
    !mindmapEditing &&
    Boolean(toolbarMindmapNode && toolbarMindmapNode.kind !== 'root');

  return (
    <div ref={containerRef} className="flex h-[calc(100vh-40px)] bg-white overflow-hidden">
      
      {/* SECTION D: Document Outline (Sidebar) */}
      <div
        className="bg-[#f9f9f9] border-r border-gray-200 flex flex-col"
        style={{ width: leftWidth }}
      >
        {/* Updated Header: Matches App Title Bar Height (h-10) */}
        <div className="h-10 flex border-b border-gray-200 bg-white">
           <Tooltip label="文章目录" wrapperClassName="flex-1 h-full">
             <button
               className="w-full h-full flex justify-center items-center border-b-2 border-blue-400 text-blue-600 bg-blue-50"
             >
               <List size={16} />
             </button>
           </Tooltip>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {outlineDisplay.map(item => (
            <TOCNode key={item.id} item={item} level={0} />
          ))}
        </div>
      </div>

      {/* Resize Handle (Left) */}
      <div
        className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-gray-200/80"
        onMouseDown={(e) => {
          dragStateRef.current = { side: 'left', startX: e.clientX, start: leftWidth };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* SECTION E: Main Content (PDF / MindMap) */}
      <div className="flex-1 min-w-0 flex flex-col bg-gray-50 relative">
        {/* Toolbar: Matches App Title Bar Height (h-10) */}
        <div className="h-10 bg-white/80 backdrop-blur border-b border-gray-200 flex items-center px-3 sticky top-0 z-10">
          {/* Adjusted: Removed scale, increased padding for larger buttons, kept text/icon small */}
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            <Tooltip label="PDF">
              <button 
                onClick={() => switchViewMode(ReaderMode.PDF)}
                className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${viewMode === ReaderMode.PDF ? 'bg-gray-200 text-gray-900' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
                aria-label="PDF"
              >
                <FileText size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Mind Map">
              <button 
                onClick={() => switchViewMode(ReaderMode.MIND_MAP)}
                className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${viewMode === ReaderMode.MIND_MAP ? 'bg-gray-200 text-gray-900' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'}`}
                aria-label="Mind Map"
              >
                <Network size={14} />
              </button>
            </Tooltip>
          </div>

          <div className="flex-1 flex justify-center">
            {viewMode === ReaderMode.MIND_MAP ? (
              <div className="flex items-center gap-2 px-1 py-1">
              <Tooltip label="新增子节点">
                <button
                  type="button"
                  disabled={!canToolbarAddChild}
                  onClick={() => {
                    if (!toolbarMindmapNode || !canToolbarAddChild) return;
                    handleMindmapAddChild(toolbarMindmapNode);
                  }}
                  className="p-1 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="5" cy="12" r="2" fill="currentColor" stroke="none" />
                    <line x1="8" y1="12" x2="12" y2="12" />
                    <rect x="12.5" y="7" width="8.5" height="10" rx="2" ry="2" strokeDasharray="3 2" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip label="新增同级节点">
                <button
                  type="button"
                  disabled={!canToolbarAddSibling}
                  onClick={() => {
                    if (!toolbarMindmapNode || !canToolbarAddSibling) return;
                    handleMindmapAddSibling(toolbarMindmapNode);
                  }}
                  className="p-1 text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="5" cy="6" r="2" fill="currentColor" stroke="none" />
                    <line x1="7" y1="6" x2="12" y2="6" />
                    <line x1="7" y1="6" x2="12" y2="16" />
                    <rect x="12" y="3" width="9" height="6" rx="2" ry="2" />
                    <rect x="12" y="13" width="9" height="6" rx="2" ry="2" strokeDasharray="3 2" />
                  </svg>
                </button>
              </Tooltip>
            </div>
            ) : (
              <div className="flex-1" />
            )}
          </div>

          <div className="flex items-center gap-1 text-gray-600">
            <button
              onClick={() => {
                if (viewMode === ReaderMode.PDF) {
                  setPdfZoom((z) => Math.max(50, z - 10));
                } else {
                  setMindmapZoom((z) => Math.max(50, z - 10));
                }
              }}
              className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
            >
              <ZoomOut size={14} />
            </button>
            <span className="text-xs w-8 text-center">
              {viewMode === ReaderMode.PDF ? pdfZoom : mindmapZoom}%
            </span>
            <button
              onClick={() => {
                if (viewMode === ReaderMode.PDF) {
                  setPdfZoom((z) => Math.min(200, z + 10));
                } else {
                  setMindmapZoom((z) => Math.min(200, z + 10));
                }
              }}
              className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
            >
              <ZoomIn size={14} />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div
          ref={contentAreaRef}
          className="flex-1 min-w-0 overflow-auto relative"
          onMouseUp={viewMode === ReaderMode.PDF ? updateSelectionFromWindow : undefined}
          onMouseDown={handleHighlightClick}
          onScroll={handleContentScroll}
        >
          <div className={viewMode === ReaderMode.PDF ? 'block' : 'hidden'}>
            {pdfFile ? (
              <div className="min-h-full flex justify-center py-6 px-4">
                <Document
                  file={pdfFile}
                  onLoadSuccess={handleDocumentLoad}
                  onLoadError={(error) => {
                    console.error('PDF load error:', error);
                  }}
                  onSourceError={(error) => {
                    console.error('PDF source error:', error);
                  }}
                  loading={<div className="text-sm text-gray-400">正在加载PDF…</div>}
                  error={<div className="text-sm text-red-500">PDF加载失败</div>}
                >
                  {Array.from(new Array(numPages || 0), (_, index) => (
                    <div
                      key={`page_${index + 1}`}
                      ref={(el) => {
                        pageRefs.current[index] = el;
                      }}
                      data-page-index={index}
                      className="mb-4 last:mb-0 relative"
                    >
                      <Page
                        pageNumber={index + 1}
                        width={800}
                        scale={pdfZoom / 100}
                        renderAnnotationLayer={false}
                        renderTextLayer
                      />
                      {highlightRectsByPage.get(index)?.length ? (
                        <div className="absolute inset-0 pointer-events-none">
                          {highlightRectsByPage.get(index)!.map((item, rectIndex) => {
                            const isActive = item.id === activeHighlightId;
                            const swatch = HIGHLIGHT_COLORS.find((color) => color.fill === item.color)?.swatch;
                            const borderColor = isActive ? (swatch || toSolidColor(item.color)) : '';
                            return (
                              <div
                                key={`mark-${index}-${rectIndex}`}
                                className="absolute mix-blend-multiply opacity-40"
                                style={{
                                  top: `${item.rect.y * 100}%`,
                                  left: `${item.rect.x * 100}%`,
                                  width: `${item.rect.w * 100}%`,
                                  height: `${item.rect.h * 100}%`,
                                  background: item.color,
                                  boxShadow: isActive ? `0 0 0 1px ${borderColor}` : undefined
                                }}
                              />
                            );
                          })}
                        </div>
                      ) : null}
                      {showPdfMarginOutline && pdfMarginChildrenByPage.get(index)?.length ? (
                        <div className="absolute top-0 bottom-0 left-full ml-4 w-[220px]">
                          {pdfMarginChildrenByPage.get(index)!.map((group) => {
                            const topRatio = typeof group.topRatio === 'number' ? group.topRatio : 0;
                            const clampedTop = Math.max(0, Math.min(1, topRatio));
                            return (
                              <div
                                key={`margin-${index}-${group.parentId}`}
                                className="absolute left-0"
                                style={{ top: `${clampedTop * 100}%` }}
                              >
                                <div className="flex flex-col gap-1">
                                  {group.items.map((item) => {
                                    const swatch =
                                      item.kind === 'note' && item.color
                                        ? HIGHLIGHT_COLORS.find((color) => color.fill === item.color)?.swatch ||
                                          toSolidColor(item.color)
                                        : '#9ca3af';
                                    const label = item.label?.trim() || '（空白）';
                                    if (item.kind === 'chapter') {
                                      return (
                                        <div key={item.key} className="relative group">
                                          <button
                                            type="button"
                                            className="group w-full text-left flex items-center py-1 px-2 cursor-pointer text-sm text-gray-700 rounded my-0.5 hover:bg-gray-200"
                                            style={{ paddingLeft: `${8 + (item.indentPx || 0)}px` }}
                                            onMouseDown={(event) => event.stopPropagation()}
                                            onClick={(event) => openMarginToolbar(event, item)}
                                          >
                                            <span className="truncate flex-1">{label}</span>
                                          </button>
                                          {item.node?.isCustom ? (
                                            <button
                                              type="button"
                                              onMouseDown={(event) => event.stopPropagation()}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                removeCustomChapter(item.node!.id);
                                              }}
                                              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
                                              aria-label="删除章节"
                                            >
                                              <X size={12} />
                                            </button>
                                          ) : null}
                                        </div>
                                      );
                                    }
                                    const isExpanded = expandedHighlightIds.has(item.note?.id || '');
                                    const clampStyle = isExpanded
                                      ? { whiteSpace: 'pre-wrap' as const }
                                      : {
                                          display: '-webkit-box',
                                          WebkitLineClamp: 2,
                                          WebkitBoxOrient: 'vertical',
                                          overflow: 'hidden'
                                        };
                                    return (
                                      <div key={item.key} className="relative group">
                                        <button
                                          type="button"
                                          className="w-full text-left text-xs rounded px-2 py-1 pr-6 border border-transparent hover:bg-gray-200 flex flex-col items-start text-gray-600"
                                          style={{
                                            borderLeft: `3px solid ${swatch}`,
                                            paddingLeft: `${8 + (item.indentPx || 0)}px`
                                          }}
                                          onMouseDown={(event) => event.stopPropagation()}
                                          onClick={(event) => openMarginToolbar(event, item)}
                                          onDoubleClick={(event) => {
                                            event.stopPropagation();
                                            if (!item.note) return;
                                            setExpandedHighlightIds((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(item.note!.id)) {
                                                next.delete(item.note!.id);
                                              } else {
                                                next.add(item.note!.id);
                                              }
                                              return next;
                                            });
                                          }}
                                        >
                                          <span className="leading-4 w-full" style={clampStyle}>
                                            {label}
                                          </span>
                                          {item.note &&
                                          !item.note.isChapterTitle &&
                                          !isManualHighlight(item.note) &&
                                          item.note.translation ? (
                                            <span
                                              className="mt-0.5 text-[10px] leading-4 text-gray-500 w-full"
                                              style={clampStyle}
                                            >
                                              {item.note.translation}
                                            </span>
                                          ) : null}
                                        </button>
                                        {item.note && !item.note.isChapterTitle ? (
                                          <button
                                            type="button"
                                            onMouseDown={(event) => event.stopPropagation()}
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              removeHighlightNote(item.note!);
                                            }}
                                            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
                                            aria-label="删除笔记"
                                          >
                                            <X size={12} />
                                          </button>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Document>
              </div>
            ) : paper.filePath ? (
              <div className="min-h-full flex items-center justify-center text-sm text-gray-400">
                正在加载PDF…
              </div>
            ) : (
              <div className="min-h-full flex justify-center py-8 px-4 origin-top transition-transform duration-200">
                <div className="w-[800px] bg-white shadow-lg min-h-[1100px] text-gray-800">
                  <div className="p-12">
                    <h1 className="text-3xl font-serif font-bold mb-4">{paper.title}</h1>
                    <p className="text-sm text-gray-500 mb-8 border-b pb-4">{paper.author} • {paper.date}</p>
                    <div className="prose max-w-none font-serif leading-relaxed">
                      <p className="mb-4 font-bold">Abstract</p>
                      <p className="mb-8 italic text-gray-600">{paper.summary}</p>
                      <p className="mb-4 font-bold">1. Introduction</p>
                      <p>{paper.content}</p>
                      <p className="mt-4">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
                      <p className="mt-4">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className={viewMode === ReaderMode.MIND_MAP ? 'block h-full' : 'hidden'}>
            {viewMode === ReaderMode.MIND_MAP ? (
              <>
                <React.Suspense
                  fallback={
                    <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
                      正在加载思维导图...
                    </div>
                  }
                >
                  <LazyMindMap
                    root={mindmapRoot}
                    zoomScale={mindmapZoomScale}
                    collapsedIds={collapsedMindmapIds}
                    expandedNoteIds={expandedHighlightIds}
                    offset={mindmapOffset}
                    dragOverId={dragOverMindmapId}
                    draggingNoteId={draggingNoteId}
                    selectedNodeId={activeMindmapNodeId}
                    onLayoutStart={handleMindmapLayoutStart}
                    onLayout={handleMindmapLayout}
                    onNodeClick={handleMindMapNodeClick}
                    onNodeDoubleClick={handleMindmapNodeDoubleClick}
                    onNodeMouseDown={handleMindmapNodeMouseDown}
                    onBackgroundMouseDown={handleMindmapMouseDown}
                    onNodeToggleCollapse={handleMindmapToggleCollapse}
                    toolbarColors={HIGHLIGHT_COLORS}
                    onToolbarColorSelect={handleMindmapToolbarColor}
                    onToolbarMakeChapter={handleMindmapToolbarMakeChapter}
                    onToolbarClear={handleMindmapToolbarClear}
                    editingNodeId={mindmapEditing?.nodeId || null}
                    editingValue={mindmapEditValue}
                    onEditChange={setMindmapEditValue}
                    onEditCommit={commitMindmapEdit}
                    onEditCancel={cancelMindmapEdit}
                    onNoteToggleExpand={(noteId) =>
                      setExpandedHighlightIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(noteId)) {
                          next.delete(noteId);
                        } else {
                          next.add(noteId);
                        }
                        return next;
                      })
                    }
                  />
                </React.Suspense>
                {dragGhost ? (
                  <div
                    className="fixed z-40 pointer-events-none"
                    style={{
                      left: dragGhost.x,
                      top: dragGhost.y,
                      width: dragGhost.width,
                      height: dragGhost.height,
                      background: dragGhost.color
                        ? 'rgba(255,255,255,0.9)'
                        : 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(148, 163, 184, 0.7)',
                      borderRadius: 8,
                      boxShadow: '0 8px 16px rgba(15, 23, 42, 0.15)',
                      opacity: 0.7,
                      padding: '6px 8px'
                    }}
                  >
                    {(dragGhost.lines && dragGhost.lines.length
                      ? dragGhost.lines
                      : [dragGhost.text]
                    ).map((line, index) => (
                      <div
                        key={`${dragGhost.id}-line-${index}`}
                        style={{
                          fontSize: dragGhost.fontSize ? `${dragGhost.fontSize}px` : '12px',
                          lineHeight: dragGhost.lineHeight ? `${dragGhost.lineHeight}px` : '14px',
                          color: '#111827'
                        }}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Resize Handle (Right) */}
      <div
        className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-gray-200/80"
        onMouseDown={(e) => {
          dragStateRef.current = { side: 'right', startX: e.clientX, start: rightWidth };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* SECTION F: Assistant Panel */}
      <div
        className="bg-white border-l border-gray-200 flex flex-col z-20"
        style={{ width: rightWidth }}
      >
        {/* Tabs: Matches App Title Bar Height (h-10) */}
        <div className="h-10 flex border-b border-gray-200">
          <Tooltip label="阅读问题" wrapperClassName="flex-1 h-full">
            <button 
              onClick={() => setActiveTab(AssistantTab.QUESTIONS)}
              className={`w-full h-full flex justify-center items-center border-b-2 transition-colors ${activeTab === AssistantTab.QUESTIONS ? 'border-emerald-400 text-emerald-600 bg-emerald-50' : 'border-transparent text-gray-400 hover:text-gray-600 hover:bg-gray-200'}`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6.7 6.2C6.9 5.4 7.6 4.9 8.4 4.9C9.4 4.9 10.2 5.6 10.2 6.6C10.2 7.2 9.9 7.6 9.4 7.9C8.8 8.3 8.6 8.6 8.6 9.1V9.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8.6" cy="11.3" r="1" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip label="文章信息" wrapperClassName="flex-1 h-full">
            <button 
               onClick={() => setActiveTab(AssistantTab.INFO)}
               className={`w-full h-full flex justify-center items-center border-b-2 transition-colors ${activeTab === AssistantTab.INFO ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-transparent text-gray-400 hover:text-gray-600 hover:bg-gray-200'}`}
            >
               <FileText size={16} />
            </button>
          </Tooltip>
          <Tooltip label="询问AI" wrapperClassName="flex-1 h-full">
            <button 
               onClick={() => setActiveTab(AssistantTab.AI)}
               className={`w-full h-full flex justify-center items-center border-b-2 transition-colors ${activeTab === AssistantTab.AI ? 'border-purple-400 text-purple-600 bg-purple-50' : 'border-transparent text-gray-400 hover:text-gray-600 hover:bg-gray-200'}`}
            >
               <Sparkles size={16} />
            </button>
          </Tooltip>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-hidden flex flex-col relative bg-[#fcfcfc]">
          
          {/* Tab 1: Questions */}
          {activeTab === AssistantTab.QUESTIONS && (
            <div className="h-full flex flex-col">
              <div className="px-4 pt-4 pb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">阅读问题</h3>
                <Tooltip label="新增阅读问题">
                  <button
                    type="button"
                    onClick={handleAddQuestion}
                    className="p-1 rounded-md text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2">
                {questions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-start pt-16 gap-2 px-4">
                    <button
                      type="button"
                      onClick={handleGenerateQuestions}
                      disabled={isGeneratingQuestions}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <Sparkles size={14} />
                      {isGeneratingQuestions ? 'AI提问中...' : 'AI提问'}
                    </button>
                    {questionGenerateError ? (
                      <div className="text-xs text-red-500 text-center">{questionGenerateError}</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-1 pt-1">
                    {questions.map((q) => {
                      const count = highlightsByQuestion.get(q.id)?.length || 0;
                      const hasNotes = count > 0;
                      const notes = (highlightsByQuestion.get(q.id) || []).slice().sort((a, b) => {
                        const aKey = getHighlightSortKey(a);
                        const bKey = getHighlightSortKey(b);
                        if (aKey.pageIndex !== bKey.pageIndex) return aKey.pageIndex - bKey.pageIndex;
                        return aKey.top - bKey.top;
                      });
                      const isExpanded = Boolean(expandedQuestions[q.id]);
                      const isEditing = editingQuestionId === q.id;
                      return (
                        <div key={q.id} className="space-y-2">
                          <div
                            data-question-id={q.id}
                            className="group flex items-center py-1 px-2 hover:bg-gray-200 cursor-pointer text-sm text-gray-700 rounded my-0.5"
                            onClick={() => {
                              if (isEditing) return;
                              if (hasNotes) toggleQuestionExpand(q.id);
                            }}
                          >
                            {isEditing ? (
                              <textarea
                                ref={questionInputRef}
                                value={questionDraft}
                                onChange={(event) => setQuestionDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    finalizeQuestionEdit(q.id);
                                  }
                                }}
                                className="flex-1 min-w-0 text-sm bg-white border border-emerald-100 rounded-md px-2 py-1 outline-none focus:ring-2 focus:ring-emerald-100 resize-none"
                                placeholder="输入阅读问题..."
                                onClick={(event) => event.stopPropagation()}
                                rows={2}
                              />
                            ) : (
                              <span className="flex-1 break-words">{q.text}</span>
                            )}
                            {!isEditing ? (
                              <div className="ml-auto flex items-center gap-1">
                                <Tooltip label="编辑问题" placement="top">
                                  <button
                                    type="button"
                                    className="w-5 h-5 flex items-center justify-center rounded-md text-gray-400 opacity-0 group-hover:opacity-100 hover:text-gray-600 hover:bg-gray-200"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleEditQuestion(q);
                                    }}
                                  >
                                    <Pencil size={12} />
                                  </button>
                                </Tooltip>
                                <Tooltip label="删除问题" placement="top">
                                  <button
                                    type="button"
                                    className="w-5 h-5 flex items-center justify-center rounded-md text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-500"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleDeleteQuestion(q.id);
                                    }}
                                  >
                                    <X size={12} />
                                  </button>
                                </Tooltip>
                                {count > 0 ? (
                                  <span className="text-xs text-gray-400 ml-1">
                                    {count}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          {isExpanded && notes.length ? (
                            <div className="space-y-1">
                              {notes.map((note) => {
                                const noteExpanded = expandedHighlightIds.has(note.id);
                                const clampStyle = noteExpanded
                                  ? { whiteSpace: 'pre-wrap' as const }
                                  : {
                                      display: '-webkit-box',
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: 'vertical',
                                      overflow: 'hidden'
                                    };
                                return (
                                  <button
                                    key={`question-note-${note.id}`}
                                    type="button"
                                    onClick={() => jumpToHighlight(note)}
                                    onDoubleClick={() =>
                                      setExpandedHighlightIds((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(note.id)) {
                                          next.delete(note.id);
                                        } else {
                                          next.add(note.id);
                                        }
                                        return next;
                                      })
                                    }
                                    className={`w-full text-left text-xs rounded px-2 py-1 border border-transparent hover:bg-gray-200 flex flex-col items-start ${
                                      note.isChapterTitle ? 'font-semibold text-gray-800' : 'text-gray-600'
                                    }`}
                                    style={{ borderLeft: `3px solid ${note.color}` }}
                                  >
                                    <span className="leading-4 w-full" style={clampStyle}>
                                      {note.text}
                                    </span>
                                    {!note.isChapterTitle &&
                                    !isManualHighlight(note) &&
                                    note.translation ? (
                                      <span
                                        className="mt-0.5 text-[10px] leading-4 text-gray-500 w-full"
                                        style={clampStyle}
                                      >
                                        {note.translation}
                                      </span>
                                    ) : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Info */}
          {activeTab === AssistantTab.INFO && (
             <div className="px-4 py-4 overflow-y-auto h-full">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">文章信息</h3>
                  <Tooltip label="重新解析">
                    <button
                      type="button"
                      onClick={handleRefreshMetadata}
                      disabled={infoRefreshing}
                      className="p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={infoRefreshing ? 'animate-spin' : ''} />
                    </button>
                  </Tooltip>
                </div>
                <div className="space-y-4 text-sm">
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">标题</div>
                    <div className="font-medium">{paper.title}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">作者</div>
                    <div>{paper.author}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">发布日期</div>
                    <div>{formatDateYmd(paper.date)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">发布机构</div>
                    <div>{paper.publisher || '-'}</div>
                  </div>
                  {infoRefreshError ? (
                    <div className="text-xs text-red-500">{infoRefreshError}</div>
                  ) : null}
                </div>
             </div>
          )}

          {/* Tab 3: AI Chat */}
          {activeTab === AssistantTab.AI && (
            <div className="flex flex-col h-full">
              {sortedChatThreads.length ? (
                activeChat ? (
                  <div className="border-b border-gray-200 bg-white px-2 py-1">
                    <div className="flex items-center py-1 px-2 text-sm text-gray-700 rounded my-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveChatId(null);
                          setInput('');
                        }}
                        className="mr-2 p-1 rounded-md text-gray-500 hover:bg-gray-200"
                      >
                        <ArrowLeft size={14} />
                      </button>
                      <span className="truncate flex-1">{activeChat.title}</span>
                    </div>
                  </div>
                ) : (
                  <div className="max-h-28 border-b border-gray-200 bg-white overflow-y-auto px-2 py-1">
                    <div className="space-y-0.5">
                      {sortedChatThreads.map((thread) => {
                        const firstUserText =
                          thread.messages.find((msg) => msg.role === 'user')?.text ||
                          thread.messages[0]?.text ||
                          thread.title;
                        const firstSentence =
                          firstUserText
                            .split(/[\n。！？!?]/)
                            .map((part) => part.trim())
                            .find(Boolean) || '新对话';
                        return (
                          <div
                            key={thread.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              setActiveChatId(thread.id);
                              setInput('');
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                setActiveChatId(thread.id);
                                setInput('');
                              }
                            }}
                            className="w-full text-left group flex items-center py-1 px-2 hover:bg-gray-200 cursor-pointer text-sm text-gray-700 rounded my-0.5"
                          >
                            <span className="truncate flex-1">{firstSentence}</span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                deleteChat(thread.id);
                              }}
                              className="ml-2 p-1 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-red-500"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              ) : null}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {activeChat ? (
                  activeChat.messages.map((msg, idx) => (
                    <div key={`${activeChat.id}-${idx}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm shadow-sm
                        ${msg.role === 'user' 
                          ? 'bg-violet-500 text-white rounded-br-none' 
                          : 'bg-white border border-gray-200 text-gray-700 rounded-bl-none'
                        }`}>
                        {msg.text}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center text-gray-400 mt-10 text-sm">
                    <Sparkles size={32} className="mx-auto mb-2 opacity-50" />
                    <p>输入问题可直接开始新对话</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="p-3 border-t border-gray-200 bg-white">
                <div className="rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isTyping) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder="问问AI"
                    disabled={isTyping}
                    rows={2}
                    className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-gray-400 leading-6 max-h-32 overflow-y-auto"
                  />
                  <div className="mt-1 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setAskPaperEnabled((prev) => !prev)}
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors ${
                        askPaperEnabled
                          ? 'bg-violet-100 text-violet-700'
                          : 'bg-gray-200 text-gray-600'
                      }`}
                      aria-label="切换询问Paper模式"
                    >
                      询问文章
                    </button>
                    <button
                      onClick={handleSendMessage}
                      disabled={!input.trim() || isTyping}
                      className="inline-flex items-center justify-center p-1 rounded-md bg-violet-500 text-white disabled:opacity-50 hover:bg-violet-600 transition-colors"
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {viewMode === ReaderMode.PDF && dragGhost ? (
        <div
          className="fixed z-40 pointer-events-none"
          style={{
            left: dragGhost.x,
            top: dragGhost.y,
            width: dragGhost.width,
            height: dragGhost.height,
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(148, 163, 184, 0.7)',
            borderRadius: 8,
            boxShadow: '0 8px 16px rgba(15, 23, 42, 0.15)',
            opacity: 0.7,
            padding: '6px 8px'
          }}
        >
          {(dragGhost.lines && dragGhost.lines.length ? dragGhost.lines : [dragGhost.text]).map(
            (line, index) => (
              <div
                key={`${dragGhost.id}-pdf-line-${index}`}
                style={{
                  fontSize: dragGhost.fontSize ? `${dragGhost.fontSize}px` : '12px',
                  lineHeight: dragGhost.lineHeight ? `${dragGhost.lineHeight}px` : '14px',
                  color: '#111827'
                }}
              >
                {line}
              </div>
            )
          )}
        </div>
      ) : null}

      {viewMode === ReaderMode.PDF && selectionRect && selectionText ? (
        <div
          className="fixed z-30"
          style={toolbarStyle || undefined}
          ref={selectionToolbarRef}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="w-80 rounded-lg border border-gray-200 bg-white shadow-lg p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {HIGHLIGHT_COLORS.map((color) => (
                  <Tooltip key={color.id} label="高亮" placement="top">
                    <button
                      type="button"
                      className="w-5 h-5 rounded-md border border-gray-300 flex items-center justify-center"
                      onClick={() => addHighlight(color.fill)}
                    >
                      <span
                        className="w-3 h-3 rounded-sm"
                        style={{ background: color.swatch }}
                      />
                    </button>
                  </Tooltip>
                ))}
                <Tooltip label="章节标题" placement="top">
                  <button
                    type="button"
                    className="w-5 h-5 rounded-md border border-gray-300 text-[10px] font-semibold text-gray-700 hover:bg-gray-50"
                    onClick={createCustomChapterFromSelection}
                  >
                    T
                  </button>
                </Tooltip>
                <Tooltip label="清除格式" placement="top">
                  <button
                    type="button"
                    className="w-5 h-5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                    onClick={clearFormatting}
                  >
                    <Ban size={12} />
                  </button>
                </Tooltip>
              </div>
              <Tooltip label="相关问题" placement="top">
                <button
                  type="button"
                  className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
                  onClick={openQuestionPicker}
                >
                  相关问题
                </button>
              </Tooltip>
            </div>
            <div className="mt-2 text-[11px] text-gray-500 bg-gray-50 rounded-md p-2 min-h-[44px]">
              {translationResult || '选中文本以显示翻译'}
            </div>
          </div>
        </div>
      ) : null}

      {questionPicker.open && questionPickerStyle ? (
        <div
          ref={questionPickerRef}
          className="fixed z-30"
          style={questionPickerStyle}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-2">
            <div className="text-[11px] font-semibold text-gray-500 mb-1">
              关联到阅读问题
            </div>
            {questions.length ? (
              <div className="max-h-48 overflow-y-auto space-y-1">
                {questions.map((question) => (
                  <button
                    key={question.id}
                    type="button"
                    className="w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-100"
                    onClick={() => attachHighlightToQuestion(question)}
                  >
                    {question.text}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-gray-400 px-2 py-2">暂无阅读问题</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
