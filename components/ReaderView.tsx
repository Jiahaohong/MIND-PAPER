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
  Pencil
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Paper, TOCItem, ReaderMode, AssistantTab, Message } from '../types';
import { MOCK_TOC } from '../constants';
import type { MindMapLayout, MindMapNode } from './MindMap';
import { Tooltip } from './Tooltip';

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
}

export const ReaderView: React.FC<ReaderViewProps> = ({ paper, pdfFile, onBack }) => {
  const MIN_SIDE_WIDTH = 120;
  const MIN_CENTER_WIDTH = 120;
  const RESIZE_HANDLE_WIDTH = 4;
  const DEFAULT_LEFT_RATIO = 0.2;
  const DEFAULT_RIGHT_RATIO = 0.3;
  const CHAPTER_START_TOLERANCE = 0.03;

  // State
  const [viewMode, setViewMode] = useState<ReaderMode>(ReaderMode.PDF);
  const [activeTab, setActiveTab] = useState<AssistantTab>(AssistantTab.QUESTIONS);
  const [zoom, setZoom] = useState(100);
  const [expandedTOC, setExpandedTOC] = useState<Set<string>>(new Set(['1', '2']));
  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(200);
  const [numPages, setNumPages] = useState<number>(0);
  const [outlineNodes, setOutlineNodes] = useState<OutlineNode[]>([]);
  const [customChapters, setCustomChapters] = useState<OutlineNode[]>([]);
  const [selectionText, setSelectionText] = useState('');
  const [selectionRect, setSelectionRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<{ pageIndex: number; rects: HighlightRect[]; text: string } | null>(null);
  const [highlights, setHighlights] = useState<HighlightItem[]>([]);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [activeHighlightColor, setActiveHighlightColor] = useState<string | null>(null);
  const [translationResult, setTranslationResult] = useState('');
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
    const source = normalizeTranslationText(selectionText);
    if (!source) {
      translateRequestRef.current += 1;
      setTranslationResult('');
      pendingTranslationTextRef.current = null;
      return;
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
  }, [selectionText, selectionInfo?.pageIndex]);

  const findChapterForPosition = (
    pageIndex: number,
    topRatio: number,
    sourceList: OutlineNode[] = flatOutline
  ) => {
    if (!sourceList.length || pageIndex == null) return null;
    const ratio = typeof topRatio === 'number' ? topRatio : 0;
    let candidate: OutlineNode | null = null;
    sourceList.forEach((node) => {
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
      const samePageHeadings = sourceList
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
    return {
      id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: selectionText,
      color,
      pageIndex: selectionInfo.pageIndex,
      rects: selectionInfo.rects,
      chapterId,
      isChapterTitle: false,
      translation: cachedTranslation || undefined,
      ...options
    } as HighlightItem;
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
    return {
      id: `h-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      color,
      pageIndex: info.pageIndex,
      rects: info.rects,
      chapterId,
      isChapterTitle: false,
      translation: cachedTranslation || undefined,
      ...options
    } as HighlightItem;
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
    const parentChapter = findChapterForPosition(pageIndex, topRatio, baseFlatOutline);
    const parentId = parentChapter && !parentChapter.isRoot ? parentChapter.id : outlineRootId;

    const chapterNode: OutlineNode = {
      id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      pageIndex,
      topRatio,
      items: [],
      isCustom: true,
      parentId,
      createdAt: Date.now()
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
    if (dragNoteTriggeredRef.current || draggingNoteId || dragChapterTriggeredRef.current || draggingChapterId) {
      return;
    }
    if (node.kind === 'note' && node.note) {
      jumpToHighlight(node.note as HighlightItem);
      return;
    }

    const originalNode = mindmapNodeMap.get(node.id);
    const hasChildren = Boolean(originalNode?.children && originalNode.children.length);
    if (node.kind !== 'note' && hasChildren) {
      const layout = mindmapLayoutRef.current;
      if (layout) {
        const targetNode = layout.nodes.find((item) => item.id === node.id);
        if (targetNode) {
          mindmapAnchorRef.current = {
            id: node.id,
            x: targetNode.x + targetNode.width / 2 + layout.offset.x + mindmapOffset.x,
            y: targetNode.y + targetNode.height / 2 + layout.offset.y + mindmapOffset.y
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
      x: anchor.x - (target.x + target.width / 2 + layout.offset.x),
      y: anchor.y - (target.y + target.height / 2 + layout.offset.y)
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
    const baseIds = new Set(baseFlat.map((node) => node.id));

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

    customNodes.forEach((node) => {
      if (!node) return;
      const normalized: OutlineNode = {
        ...node,
        items: Array.isArray(node.items) ? node.items : [],
        isCustom: true
      };
      let parentId = node.parentId || null;
      if (!parentId || !baseIds.has(parentId)) {
        const candidate = findChapterForPosition(
          node.pageIndex ?? 0,
          node.topRatio ?? 0,
          baseFlat
        );
        parentId = candidate?.id || rootId;
      }
      if (parentId && parentId !== rootId && insertIntoParent(rootItems, parentId, normalized)) {
        return;
      }
      const rootNode = rootItems.find((item) => item.id === rootId);
      if (rootNode) {
        rootNode.items = Array.isArray(rootNode.items)
          ? [...rootNode.items, normalized]
          : [normalized];
        return;
      }
      rootItems.push(normalized);
    });

    const sortChildren = (nodes: OutlineNode[]) => {
      if (!nodes.length) return;
      nodes.sort((a, b) => {
        if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) {
          return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
        }
        if ((a.topRatio ?? 0) !== (b.topRatio ?? 0)) {
          return (a.topRatio ?? 0) - (b.topRatio ?? 0);
        }
        return a.title.localeCompare(b.title);
      });
      nodes.forEach((node) => {
        if (node.items?.length) sortChildren(node.items);
      });
    };

    sortChildren(rootItems);
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
    return applyParentOverrides(merged, chapterParentOverrides);
  }, [baseOutline, customChapters, baseFlatOutline, outlineRootId, chapterParentOverrides]);

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

  const flatOutline = useMemo(
    () => getFlatOutlineByPosition(outlineDisplay),
    [outlineDisplay]
  );

  const getHighlightSortKey = (item: HighlightItem) => {
    const rects = item.rects || [];
    const pageIndex =
      item.pageIndex ?? (rects.length ? rects[0].pageIndex : 0);
    const top = rects.length ? Math.min(...rects.map((rect) => rect.y ?? 0)) : 0;
    return { pageIndex, top };
  };

  const highlightsByChapter = useMemo(() => {
    const map = new Map<string, HighlightItem[]>();
    highlights.forEach((item) => {
      if (!item.chapterId || item.isChapterTitle) return;
      const list = map.get(item.chapterId) || [];
      list.push(item);
      map.set(item.chapterId, list);
    });
    map.forEach((list) => {
      list.sort((a, b) => {
        const aKey = getHighlightSortKey(a);
        const bKey = getHighlightSortKey(b);
        if (aKey.pageIndex !== bKey.pageIndex) return aKey.pageIndex - bKey.pageIndex;
        return aKey.top - bKey.top;
      });
    });
    return map;
  }, [highlights]);

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
        activeChatId
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

    const getNodeOrder = (node: OutlineNode, index: number) => ({
      pageIndex: typeof node.pageIndex === 'number' ? node.pageIndex : Number.POSITIVE_INFINITY,
      ratio: typeof node.topRatio === 'number' ? node.topRatio : 0,
      index
    });

    const getNoteOrder = (note: HighlightItem, index: number) => {
      const key = getHighlightSortKey(note);
      return {
        pageIndex: typeof key.pageIndex === 'number' ? key.pageIndex : Number.POSITIVE_INFINITY,
        ratio: typeof key.top === 'number' ? key.top : 0,
        index
      };
    };

    const buildNode = (node: OutlineNode): MindMapNode => {
      const childItems = node.items || [];
      const childNodes = childItems.map((child) => buildNode(child));
      const noteItems = highlightsByChapter.get(node.id) || [];
      const noteNodes: MindMapNode[] = noteItems.map((note) => ({
        id: `note-${note.id}`,
        text: note.text,
        translation: note.isChapterTitle ? '' : note.translation || '',
        kind: 'note',
        color: note.color,
        pageIndex: note.pageIndex,
        note
      }));
      const combined = [
        ...childNodes.map((child, index) => ({
          node: child,
          order: getNodeOrder(childItems[index], index)
        })),
        ...noteNodes.map((note, index) => ({
          node: note,
          order: getNoteOrder(noteItems[index], index + childNodes.length)
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

      return {
        id: node.id,
        text: node.title,
        kind: node.isRoot ? 'root' : 'chapter',
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
      translation: note.isChapterTitle ? '' : note.translation || '',
      kind: 'note',
      color: note.color,
      pageIndex: note.pageIndex,
      note
    }));
    const combinedRoot = [
      ...rootChildren.map((node, index) => ({
        node,
        order: getNodeOrder(rootNode.items?.[index] || rootNode, index)
      })),
      ...rootNoteNodes.map((node, index) => ({
        node,
        order: getNoteOrder(rootNotes[index], index + rootChildren.length)
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
      const rootId = `outline-root-${paper.id}`;
      const rootNode: OutlineNode = {
        id: rootId,
        title: paper.title || 'Document',
        pageIndex: 0,
        topRatio: 0,
        items: tree,
        isRoot: true
      };
      setOutlineNodes([rootNode]);
      setExpandedTOC(new Set([rootId]));
    } catch (error) {
      console.error('Outline load error:', error);
      setOutlineNodes([]);
    }
  };

  // --- Components ---

  // Fix: Typed as React.FC to support 'key' prop in recursive calls and list rendering
  const TOCNode: React.FC<{ item: OutlineNode, level: number }> = ({ item, level }) => {
    const notes = highlightsByChapter.get(item.id) || [];
    const hasChildren = (item.items && item.items.length > 0) || notes.length > 0;
    const isExpanded = expandedTOC.has(item.id);
    const isDropTarget =
      dragOverTocId === item.id && (Boolean(draggingTocNoteId) || Boolean(draggingTocChapterId));
    const combinedItems = [
      ...((item.items || []).map((node) => ({
        type: 'node' as const,
        node,
        sort: {
          pageIndex: node.pageIndex ?? Number.POSITIVE_INFINITY,
          top: node.topRatio ?? 1
        }
      }))),
      ...(notes.map((note) => {
        const key = getHighlightSortKey(note);
        return {
          type: 'note' as const,
          note,
          sort: {
            pageIndex: key.pageIndex ?? Number.POSITIVE_INFINITY,
            top: key.top ?? 1
          }
        };
      }))
    ].sort((a, b) => {
      if (a.sort.pageIndex !== b.sort.pageIndex) {
        return a.sort.pageIndex - b.sort.pageIndex;
      }
      if (a.sort.top !== b.sort.top) {
        return a.sort.top - b.sort.top;
      }
      if (a.type !== b.type) {
        return a.type === 'node' ? -1 : 1;
      }
      return 0;
    });

    return (
      <div className="select-none">
        <div 
          data-toc-id={item.id}
          data-toc-kind="chapter"
          className={`group flex items-center py-1 px-2 cursor-pointer text-sm text-gray-700 rounded my-0.5 ${
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
                        const clampStyle = isExpanded
                          ? { whiteSpace: 'pre-wrap' as const }
                          : {
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden'
                            };
                        return (
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
                        onDoubleClick={() =>
                          {
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
                          }
                        }
                        className={`w-full text-left text-xs rounded px-2 py-1 border border-transparent hover:bg-gray-200 flex flex-col items-start ${
                          entry.note.isChapterTitle ? 'font-semibold text-gray-800' : 'text-gray-600'
                        }`}
                        style={{ borderLeft: `3px solid ${entry.note.color}` }}
                      >
                        <span className="leading-4 w-full" style={clampStyle}>
                          {entry.note.text}
                        </span>
                        {!entry.note.isChapterTitle && entry.note.translation ? (
                          <span className="mt-0.5 text-[10px] leading-4 text-gray-500 w-full" style={clampStyle}>
                            {entry.note.translation}
                          </span>
                        ) : null}
                      </button>
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
        <div className="h-10 bg-white/80 backdrop-blur border-b border-gray-200 flex items-center justify-between px-3 sticky top-0 z-10">
          {/* Adjusted: Removed scale, increased padding for larger buttons, kept text/icon small */}
          <div className="flex bg-gray-100 p-1 rounded-lg">
            <button 
              onClick={() => switchViewMode(ReaderMode.PDF)}
              className={`flex items-center px-3 py-1 rounded-md text-xs font-medium transition-all ${viewMode === ReaderMode.PDF ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}
            >
              <FileText size={12} className="mr-1.5" /> PDF
            </button>
            <button 
              onClick={() => switchViewMode(ReaderMode.MIND_MAP)}
              className={`flex items-center px-3 py-1 rounded-md text-xs font-medium transition-all ${viewMode === ReaderMode.MIND_MAP ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}
            >
              <Network size={12} className="mr-1.5" /> Mind Map
            </button>
          </div>

          <div className="flex items-center gap-1 text-gray-500">
            <button onClick={() => setZoom(z => Math.max(50, z - 10))} className="p-1 hover:bg-gray-100 rounded">
              <ZoomOut size={14} />
            </button>
            <span className="text-xs w-8 text-center">{zoom}%</span>
            <button onClick={() => setZoom(z => Math.min(200, z + 10))} className="p-1 hover:bg-gray-100 rounded">
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
                        scale={zoom / 100}
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
                    collapsedIds={collapsedMindmapIds}
                    expandedNoteIds={expandedHighlightIds}
                    offset={mindmapOffset}
                    dragOverId={dragOverMindmapId}
                    draggingNoteId={draggingNoteId}
                    onLayoutStart={handleMindmapLayoutStart}
                    onLayout={handleMindmapLayout}
                    onNodeClick={handleMindMapNodeClick}
                    onNodeMouseDown={handleMindmapNodeMouseDown}
                    onBackgroundMouseDown={handleMindmapMouseDown}
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
              <Info size={16} />
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
                                    {!note.isChapterTitle && note.translation ? (
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
             <div className="px-4 py-5 overflow-y-auto h-full">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">文章信息</h3>
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
                    <div>{paper.date}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">统计</div>
                    <div className="grid grid-cols-2 gap-2 text-gray-600">
                       <div className="bg-gray-100 p-2 rounded">页数: 12</div>
                       <div className="bg-gray-100 p-2 rounded">参考文献: 45</div>
                    </div>
                  </div>
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
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
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
                      className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-violet-500 text-white disabled:opacity-50 hover:bg-violet-600 transition-colors"
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
