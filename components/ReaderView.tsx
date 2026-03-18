import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  ChevronDown, 
  ChevronRight, 
  FileText, 
  FileUp,
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
  RefreshCw,
  Loader2
} from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Paper, PaperReference, TOCItem, ReaderMode, AssistantTab, Message, DocNode } from '../types';
import { MOCK_TOC } from '../constants';
import type { MindMapLayout, MindMapNode } from './MindMap';
import { Tooltip } from './Tooltip';
import {
  extractPdfFullText,
  extractPdfReferencesFromLocal,
  rewriteSummaryWithAI
} from '../services/pdfMetadataService';
import { resolvePaperMetadata } from '../services/paperMetadataResolver';
import {
  buildMindmapStateV2FromOutline,
  deriveLegacyMindmapDataFromV2,
  mergeLegacyParentOverridesIntoCustomChapters,
  type MindmapStateV2,
  normalizeLegacyParentOverrides,
  parseMindmapStateV2
} from '../utils/mindmapStateV2';

const LazyMindMap = React.lazy(() =>
  import('./MindMap').then((mod) => ({ default: mod.MindMap }))
);
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const createReferenceId = (paperId: string, title: string, index: number) => {
  const normalized = `${paperId}:${index}:${String(title || '').trim()}`;
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `ref-${hash.toString(16)}`;
};

const mapReferences = (
  paperId: string,
  refs: Array<string | Partial<PaperReference>>,
  source: PaperReference['source']
): PaperReference[] =>
  refs
    .map((item, index) => {
      const title =
        typeof item === 'string' ? String(item || '').trim() : String(item?.title || '').trim();
      if (!title) return null;
      return {
        refId:
          typeof item === 'string'
            ? createReferenceId(paperId, title, index)
            : String(item?.refId || '').trim() || createReferenceId(paperId, title, index),
        order:
          typeof item === 'string'
            ? undefined
            : Number.isFinite(Number(item?.order))
            ? Number(item?.order)
            : undefined,
        title,
        source
      } satisfies PaperReference;
    })
    .filter(Boolean) as PaperReference[];

const normalizeReferenceTitle = (value: string) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();

const dedupeReferences = (references: PaperReference[]) => {
  const merged = new Map<string, PaperReference>();
  references.forEach((reference) => {
    const key = normalizeReferenceTitle(reference.title);
    if (!key) return;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, reference);
      return;
    }
    merged.set(key, {
      ...existing,
      ...(existing.order === undefined && reference.order !== undefined
        ? { order: reference.order }
        : {}),
      ...(existing.matchedPaperId ? {} : reference.matchedPaperId ? { matchedPaperId: reference.matchedPaperId } : {}),
      ...(existing.matchedTitle ? {} : reference.matchedTitle ? { matchedTitle: reference.matchedTitle } : {}),
      ...(existing.matchScore !== undefined
        ? {}
        : reference.matchScore !== undefined
        ? { matchScore: reference.matchScore }
        : {}),
      source: existing.source === reference.source ? existing.source : 'merged'
    });
  });
  return Array.from(merged.values());
};

const sortReferences = (references: PaperReference[]) =>
  [...references].sort((a, b) => {
    const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });

const buildReferenceStats = (
  references: PaperReference[],
  base?: Paper['referenceStats']
): Paper['referenceStats'] | undefined => {
  if (!references.length && !base) return undefined;
  const matchedCount = references.filter((item) => Boolean(item.matchedPaperId)).length;
  return {
    totalOpenAlex: Number(base?.totalOpenAlex || 0),
    totalSemanticScholar: Number(base?.totalSemanticScholar || 0),
    intersectionCount: Number(base?.intersectionCount || references.length || 0),
    finalCount: references.length,
    matchedCount
  };
};

const matchReferences = async (paperId: string, references: PaperReference[]) => {
  if (!references.length || typeof window === 'undefined' || !window.electronAPI?.library?.matchReferences) {
    return references;
  }
  try {
    const response = await window.electronAPI.library.matchReferences({ paperId, references });
    return response?.ok && Array.isArray(response.references) ? response.references : references;
  } catch {
    return references;
  }
};

type OutlineNode = {
  id: string;
  title: string;
  pageIndex: number | null;
  topRatio: number | null;
  leftRatio?: number | null;
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
  topRatio?: number | null;
  rects: HighlightRect[];
  chapterId: string;
  parentId?: string | null;
  isChapterTitle: boolean;
  chapterNodeId?: string | null;
  translation?: string;
  questionIds?: string[];
  source?: 'pdf' | 'manual';
  order?: number;
  version?: number;
  baseVersion?: number;
  updatedAt?: number;
  isDeleted?: boolean;
};

type BuiltHighlightDraft = {
  highlight: HighlightItem;
  siblingOrderPatch: Map<string, number>;
};

type ChatThread = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

type ReaderQuestion = {
  id: string;
  text: string;
};

type VersionedStateEnvelope<T> = {
  version: number;
  baseVersion: number;
  updatedAt: number;
  value: T;
};

type AiConversationSyncPayload = {
  threads: ChatThread[];
  activeChatId: string | null;
};

type MindmapDropPosition = 'before' | 'after' | 'inside';
type MindmapDropTarget = {
  id: string;
  kind: 'root' | 'chapter' | 'note';
  position: MindmapDropPosition;
};

type MindmapDropEntry = {
  parentId: string | null;
  kind: 'node' | 'note';
  id: string;
};

const HIGHLIGHT_COLORS = [
  { id: 'sun', swatch: '#facc15', fill: 'rgba(250, 204, 21, 0.45)' },
  { id: 'peach', swatch: '#fb923c', fill: 'rgba(251, 146, 60, 0.4)' },
  { id: 'mint', swatch: '#34d399', fill: 'rgba(52, 211, 153, 0.35)' },
  { id: 'sky', swatch: '#60a5fa', fill: 'rgba(96, 165, 250, 0.35)' },
  { id: 'rose', swatch: '#f87171', fill: 'rgba(248, 113, 113, 0.35)' }
];
const SHOW_MINDMAP_DROP_DEBUG = false;

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
};

const buildNormalizedRectKey = (rects: HighlightRect[] = []) =>
  (Array.isArray(rects) ? rects : [])
    .map((rect) =>
      [
        Number(rect?.pageIndex || 0),
        Number(rect?.x || 0).toFixed(4),
        Number(rect?.y || 0).toFixed(4),
        Number(rect?.w || 0).toFixed(4),
        Number(rect?.h || 0).toFixed(4)
      ].join(':')
    )
    .join('|');

const buildAnnotationIdentityKey = (item: Partial<HighlightItem> | null | undefined) => {
  if (!item) return '';
  const chapterNodeId = String(item.chapterNodeId || item.chapterId || '').trim();
  if (item.isChapterTitle && chapterNodeId) {
    return `chapter:${chapterNodeId}`;
  }
  const rectKey = buildNormalizedRectKey(Array.isArray(item.rects) ? item.rects : []);
  if (rectKey) {
    return `highlight:${Number(item.pageIndex || 0)}:${rectKey}`;
  }
  return '';
};

const normalizeMarkdownText = (value: string) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();

const buildMarkdownQuote = (value: string) => {
  const text = normalizeMarkdownText(value);
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .join('\n');
};

const buildMarkdownFromMindmap = (root: MindMapNode | null) => {
  if (!root) return '';

  const sections: string[] = [];
  const appendBlock = (value: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    sections.push(text);
  };

  const walk = (node: MindMapNode, level: number) => {
    if (node.kind === 'root' || node.kind === 'chapter') {
      const title = normalizeMarkdownText(node.text);
      const headingLevel = Math.max(1, Math.min(6, level));
      if (title) {
        appendBlock(`${'#'.repeat(headingLevel)} ${title}`);
      }
      (node.children || []).forEach((child) => walk(child, level + 1));
      return;
    }

    const translated = normalizeMarkdownText(node.translation || node.text || '');
    const original = normalizeMarkdownText(node.text || '');
    if (translated) {
      appendBlock(translated);
    }
    if (original) {
      appendBlock(buildMarkdownQuote(original));
    }
  };

  walk(root, 1);
  return `${sections.join('\n\n').trim()}\n`;
};

const choosePreferredAnnotationVariant = (
  left: HighlightItem | null,
  right: HighlightItem | null
): HighlightItem | null => {
  if (!left) return right;
  if (!right) return left;
  if (
    buildHighlightComparable(left) === buildHighlightComparable(right) &&
    Boolean(left.isDeleted) === Boolean(right.isDeleted)
  ) {
    if (Number(right.version || 0) > Number(left.version || 0)) return right;
    if (Number(left.version || 0) > Number(right.version || 0)) return left;
    return Number(right.updatedAt || 0) >= Number(left.updatedAt || 0) ? right : left;
  }
  if (Number(left.version || 0) === Number(right.baseVersion || 0)) return right;
  if (Number(right.version || 0) === Number(left.baseVersion || 0)) return left;
  if (Number(right.version || 0) > Number(left.version || 0)) return right;
  if (Number(left.version || 0) > Number(right.version || 0)) return left;
  return Number(right.updatedAt || 0) >= Number(left.updatedAt || 0) ? right : left;
};

const dedupeEquivalentAnnotations = (items: HighlightItem[]) => {
  const merged = new Map<string, HighlightItem>();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item) return;
    const key = buildAnnotationIdentityKey(item) || `id:${String(item.id || '').trim()}`;
    if (!key) return;
    merged.set(key, choosePreferredAnnotationVariant(merged.get(key) || null, item) as HighlightItem);
  });
  return Array.from(merged.values());
};

const createStableSelectionId = (
  prefix: string,
  pageIndex: number,
  rects: HighlightRect[],
  extra = ''
) => {
  const seed = `${prefix}|${pageIndex}|${buildNormalizedRectKey(rects)}|${String(extra || '').trim()}`;
  return `${prefix}-${hashString(seed)}`;
};

const normalizeReaderQuestion = (item: any): ReaderQuestion | null => {
  const id = String(item?.id || '').trim();
  if (!id) return null;
  return {
    id,
    text: String(item?.text || '').trim()
  };
};

const normalizeQuestionsPayload = (value: unknown): ReaderQuestion[] =>
  (Array.isArray(value) ? value : [])
    .map((item) => normalizeReaderQuestion(item))
    .filter(Boolean) as ReaderQuestion[];

const normalizeChatMessage = (item: any): Message | null => {
  if (!item || (item.role !== 'user' && item.role !== 'model')) return null;
  return {
    role: item.role,
    text: String(item.text || '')
  };
};

const normalizeChatThread = (item: any): ChatThread | null => {
  const id = String(item?.id || '').trim();
  if (!id) return null;
  return {
    id,
    title: String(item?.title || '新对话'),
    messages: (Array.isArray(item?.messages) ? item.messages : [])
      .map((msg) => normalizeChatMessage(msg))
      .filter(Boolean) as Message[],
    createdAt: Number(item?.createdAt || Date.now()) || Date.now(),
    updatedAt: Number(item?.updatedAt || Date.now()) || Date.now()
  };
};

const normalizeAiConversationPayload = (
  threads: unknown,
  activeChatId?: unknown
): AiConversationSyncPayload => {
  const normalizedThreads = (Array.isArray(threads) ? threads : [])
    .map((item) => normalizeChatThread(item))
    .filter(Boolean) as ChatThread[];
  const nextActiveChatId = String(activeChatId || '').trim();
  return {
    threads: normalizedThreads,
    activeChatId:
      nextActiveChatId && normalizedThreads.some((thread) => thread.id === nextActiveChatId)
        ? nextActiveChatId
        : null
  };
};

const normalizeMindmapStateForSync = (value: unknown): MindmapStateV2 | null =>
  value == null ? null : parseMindmapStateV2(value);

const normalizeVersionedStateEnvelope = <T,>(
  value: unknown,
  normalizePayload: (payload: unknown) => T
): VersionedStateEnvelope<T> | null => {
  if (!value || typeof value !== 'object' || !('value' in (value as Record<string, unknown>))) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  return {
    version: Math.max(1, Number(envelope.version || 1) || 1),
    baseVersion: Math.max(0, Number(envelope.baseVersion ?? 0) || 0),
    updatedAt: Number(envelope.updatedAt || Date.now()) || Date.now(),
    value: normalizePayload(envelope.value)
  };
};

const buildStateComparable = (value: unknown) => JSON.stringify(value ?? null);
const buildPaperStateAutosaveComparable = (value: unknown) =>
  JSON.stringify({
    ...(value && typeof value === 'object' ? (value as Record<string, unknown>) : {}),
    updatedAt: 0
  });

const buildNextVersionedState = <T,>(
  previous: VersionedStateEnvelope<T> | null,
  value: T
): VersionedStateEnvelope<T> => {
  const now = Date.now();
  if (!previous) {
    return {
      version: 1,
      baseVersion: 0,
      updatedAt: now,
      value
    };
  }
  if (buildStateComparable(previous.value) === buildStateComparable(value)) {
    return {
      ...previous,
      value
    };
  }
  return {
    version: Math.max(1, Number(previous.version || 1) || 1) + 1,
    baseVersion: Math.max(0, Number(previous.baseVersion ?? 0) || 0),
    updatedAt: now,
    value
  };
};

const getSavedQuestionsState = (saved: any): VersionedStateEnvelope<ReaderQuestion[]> | null => {
  const versioned = normalizeVersionedStateEnvelope(saved?.questionsState, normalizeQuestionsPayload);
  if (versioned) return versioned;
  if (Array.isArray(saved?.questions)) {
    return {
      version: 1,
      baseVersion: 0,
      updatedAt: Number(saved?.updatedAt || Date.now()) || Date.now(),
      value: normalizeQuestionsPayload(saved.questions)
    };
  }
  return null;
};

const getSavedMindmapState = (saved: any): VersionedStateEnvelope<MindmapStateV2 | null> | null => {
  const versioned = normalizeVersionedStateEnvelope(
    saved?.mindmapStateV2State,
    normalizeMindmapStateForSync
  );
  if (versioned) return versioned;
  if (Object.prototype.hasOwnProperty.call(saved || {}, 'mindmapStateV2')) {
    return {
      version: 1,
      baseVersion: 0,
      updatedAt: Number(saved?.updatedAt || Date.now()) || Date.now(),
      value: normalizeMindmapStateForSync(saved?.mindmapStateV2)
    };
  }
  return null;
};

const getSavedAiConversationState = (
  saved: any
): VersionedStateEnvelope<AiConversationSyncPayload> | null => {
  const versioned = normalizeVersionedStateEnvelope(saved?.aiConversationsState, (payload: any) =>
    normalizeAiConversationPayload(payload?.threads, payload?.activeChatId)
  );
  if (versioned) return versioned;
  if (
    Array.isArray(saved?.aiConversations) ||
    Object.prototype.hasOwnProperty.call(saved || {}, 'activeChatId')
  ) {
    return {
      version: 1,
      baseVersion: 0,
      updatedAt: Number(saved?.updatedAt || Date.now()) || Date.now(),
      value: normalizeAiConversationPayload(saved?.aiConversations, saved?.activeChatId)
    };
  }
  return null;
};

const normalizeHighlightRect = (rect: any): HighlightRect => ({
  pageIndex: Number(rect?.pageIndex || 0),
  x: Number(rect?.x || 0),
  y: Number(rect?.y || 0),
  w: Number(rect?.w || 0),
  h: Number(rect?.h || 0)
});

const buildHighlightComparable = (item: Partial<HighlightItem>) =>
  JSON.stringify({
    text: String(item?.text || '').trim(),
    color: String(item?.color || '').trim(),
    pageIndex: Number(item?.pageIndex || 0),
    topRatio: item?.topRatio == null ? null : Number(item.topRatio || 0),
    rects: Array.isArray(item?.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
    chapterId: String(item?.chapterId || '').trim(),
    parentId: item?.parentId == null ? null : String(item.parentId || '').trim(),
    isChapterTitle: Boolean(item?.isChapterTitle),
    chapterNodeId: item?.chapterNodeId == null ? null : String(item.chapterNodeId),
    translation: String(item?.translation || '').trim(),
    questionIds: Array.isArray(item?.questionIds) ? item.questionIds.filter(Boolean) : [],
    source: item?.source === 'manual' ? 'manual' : 'pdf',
    order: typeof item?.order === 'number' ? item.order : undefined
  });

const buildCustomChapterComparable = (item: Partial<OutlineNode>) =>
  JSON.stringify({
    id: String(item?.id || '').trim(),
    title: String(item?.title || '').trim(),
    pageIndex: item?.pageIndex == null ? null : Number(item.pageIndex || 0),
    topRatio: item?.topRatio == null ? null : Number(item.topRatio || 0),
    isRoot: Boolean(item?.isRoot),
    isCustom: Boolean(item?.isCustom),
    parentId: item?.parentId == null ? null : String(item.parentId || '').trim(),
    createdAt: typeof item?.createdAt === 'number' ? item.createdAt : undefined,
    order: typeof item?.order === 'number' ? item.order : undefined,
    items: Array.isArray(item?.items)
      ? item.items.map((child) => buildCustomChapterComparable(child))
      : []
  });

const areHighlightsEquivalent = (left: HighlightItem[], right: HighlightItem[]) => {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (!leftItem || !rightItem) return false;
    if (String(leftItem.id || '') !== String(rightItem.id || '')) return false;
    if (Boolean(leftItem.isDeleted) !== Boolean(rightItem.isDeleted)) return false;
    if (Number(leftItem.version || 0) !== Number(rightItem.version || 0)) return false;
    if (Number(leftItem.baseVersion || 0) !== Number(rightItem.baseVersion || 0)) return false;
    if (Number(leftItem.updatedAt || 0) !== Number(rightItem.updatedAt || 0)) return false;
    if (buildHighlightComparable(leftItem) !== buildHighlightComparable(rightItem)) return false;
  }
  return true;
};

const areCustomChaptersEquivalent = (left: OutlineNode[], right: OutlineNode[]) => {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (buildCustomChapterComparable(left[index]) !== buildCustomChapterComparable(right[index])) {
      return false;
    }
  }
  return true;
};

const areDocNodesEquivalent = (left: DocNode[], right: DocNode[]) =>
  buildStateComparable(left) === buildStateComparable(right);

const normalizeSyncedHighlight = (item: any): HighlightItem | null => {
  const id = String(item?.id || '').trim();
  if (!id) return null;
  return {
    id,
    text: String(item?.text || '').trim(),
    color: String(item?.color || '').trim(),
    pageIndex: Number(item?.pageIndex || 0),
    topRatio: item?.topRatio == null ? null : Number(item.topRatio || 0),
    rects: Array.isArray(item?.rects) ? item.rects.map((rect: any) => normalizeHighlightRect(rect)) : [],
    chapterId: String(item?.chapterId || '').trim(),
    parentId: item?.parentId == null ? null : String(item.parentId || '').trim(),
    isChapterTitle: Boolean(item?.isChapterTitle),
    chapterNodeId: item?.chapterNodeId == null ? null : String(item.chapterNodeId),
    translation: String(item?.translation || '').trim(),
    questionIds: Array.isArray(item?.questionIds)
      ? item.questionIds.map((value: any) => String(value || '').trim()).filter(Boolean)
      : [],
    source: item?.source === 'manual' ? 'manual' : 'pdf',
    order: typeof item?.order === 'number' ? item.order : undefined,
    version: Math.max(1, Number(item?.version || 1) || 1),
    baseVersion: Math.max(0, Number(item?.baseVersion ?? 0) || 0),
    updatedAt: Number(item?.updatedAt || 0) || Date.now(),
    isDeleted: Boolean(item?.isDeleted)
  };
};

const getLegacyHighlightAnnotations = (saved: any) => {
  const source = Array.isArray(saved?.highlights) ? saved.highlights : [];
  return dedupeEquivalentAnnotations(
    source.map((item: any) => normalizeSyncedHighlight(item)).filter(Boolean) as HighlightItem[]
  );
};

const getAnnotationsFromSavedState = (saved: any): HighlightItem[] => {
  const source = Array.isArray(saved?.annotations) ? saved.annotations : [];
  return dedupeEquivalentAnnotations(
    source.map((item: any) => normalizeSyncedHighlight(item)).filter(Boolean) as HighlightItem[]
  );
};

const getVisibleHighlights = (annotations: HighlightItem[]) =>
  annotations.filter((item) => !item.isDeleted);

const buildAnnotationsForSave = (
  currentHighlights: HighlightItem[],
  previousAnnotations: HighlightItem[]
): HighlightItem[] => {
  const now = Date.now();
  // Chapter promotion can briefly produce both a manual chapter annotation and a
  // PDF-backed chapter annotation for the same chapter node. Collapse those first
  // so the PDF-backed variant is preserved during version merging.
  const normalizedPreviousAnnotations = dedupeChapterAnnotations(
    (Array.isArray(previousAnnotations) ? previousAnnotations : [])
      .map((item) => normalizeSyncedHighlight(item))
      .filter(Boolean) as HighlightItem[]
  );
  const normalizedCurrentHighlights = dedupeChapterAnnotations(
    (Array.isArray(currentHighlights) ? currentHighlights : [])
      .map((item) => normalizeSyncedHighlight(item))
      .filter(Boolean) as HighlightItem[]
  );
  const previousMap = new Map(
    normalizedPreviousAnnotations.map((item) => [
      buildAnnotationIdentityKey(item) || String(item.id),
      item
    ])
  );
  const currentMap = new Map(
    normalizedCurrentHighlights.map((item) => [
      buildAnnotationIdentityKey(item) || String(item.id),
      item
    ])
  );
  const merged = new Map<string, HighlightItem>();
  const allIds = new Set([...previousMap.keys(), ...currentMap.keys()]);

  Array.from(allIds).forEach((id) => {
    const previous = previousMap.get(id) || null;
    const current = currentMap.get(id) || null;

    if (!previous && current) {
      merged.set(id, {
        ...current,
        version: Math.max(1, Number(current.version || 1) || 1),
        baseVersion: Math.max(0, Number(current.baseVersion ?? 0) || 0),
        updatedAt: Number(current.updatedAt || now) || now,
        isDeleted: false
      });
      return;
    }

    if (previous && !current) {
      if (previous.isDeleted) {
        merged.set(id, previous);
        return;
      }
      merged.set(id, {
        ...previous,
        isDeleted: true,
        version: Math.max(1, Number(previous.version || 1) || 1) + 1,
        baseVersion: Math.max(0, Number(previous.baseVersion ?? 0) || 0),
        updatedAt: now
      });
      return;
    }

    if (previous && current) {
      const same = buildHighlightComparable(previous) === buildHighlightComparable(current);
      if (same && previous.isDeleted === current.isDeleted) {
        merged.set(id, {
          ...current,
          version: Math.max(1, Number(previous.version || current.version || 1) || 1),
          baseVersion: Math.max(0, Number(previous.baseVersion ?? current.baseVersion ?? 0) || 0),
          updatedAt: Number(previous.updatedAt || current.updatedAt || now) || now,
          isDeleted: Boolean(previous.isDeleted)
        });
        return;
      }
      merged.set(id, {
        ...current,
        version: Math.max(1, Number(previous.version || 1) || 1) + 1,
        baseVersion: Math.max(0, Number(previous.baseVersion ?? 0) || 0),
        updatedAt: now,
        isDeleted: false
      });
    }
  });

  return dedupeEquivalentAnnotations(Array.from(merged.values())).sort((a, b) => {
    const deletedA = a.isDeleted ? 1 : 0;
    const deletedB = b.isDeleted ? 1 : 0;
    if (deletedA !== deletedB) return deletedA - deletedB;
    const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
  });
};

const dedupeChapterAnnotations = (annotations: HighlightItem[]) => {
  const noteItems: HighlightItem[] = [];
  const chapterGroups = new Map<string, HighlightItem[]>();
  (Array.isArray(annotations) ? annotations : []).forEach((item) => {
    if (!item?.isChapterTitle) {
      noteItems.push(item);
      return;
    }
    const key = String(item.chapterNodeId || item.chapterId || item.id).trim();
    const list = chapterGroups.get(key) || [];
    list.push(item);
    chapterGroups.set(key, list);
  });
  const chapterItems = Array.from(chapterGroups.entries()).map(([, items]) => {
    const sorted = items
      .slice()
      .sort((a, b) => {
        const pdfA = a.source === 'pdf' ? 1 : 0;
        const pdfB = b.source === 'pdf' ? 1 : 0;
        if (pdfA !== pdfB) return pdfB - pdfA;
        return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
      });
    const preferred = sorted[0];
    const withParentId = sorted.find((item) => String(item.parentId || '').trim().length > 0);
    const withTopRatio = sorted.find((item) => typeof item.topRatio === 'number');
    const withOrder = sorted.find((item) => typeof item.order === 'number');
    return {
      ...preferred,
      parentId: String(preferred.parentId || '').trim() || withParentId?.parentId || null,
      topRatio:
        preferred.topRatio ??
        (typeof withTopRatio?.topRatio === 'number' ? withTopRatio.topRatio : null),
      order:
        typeof preferred.order === 'number'
          ? preferred.order
          : typeof withOrder?.order === 'number'
            ? withOrder.order
            : undefined
    };
  });
  return sortHighlightItems(dedupeEquivalentAnnotations([...noteItems, ...chapterItems]));
};

const buildDocNodesFromCurrentState = (
  paperId: string,
  baseOutline: OutlineNode[],
  annotations: HighlightItem[]
): DocNode[] => {
  const nodes: DocNode[] = [];
  const root = Array.isArray(baseOutline) ? baseOutline[0] : null;
  if (!root) return nodes;

  const walkNative = (items: OutlineNode[], parentId: string | null) => {
    items.forEach((node, index) => {
      const isRoot = Boolean(node.isRoot);
      nodes.push({
        id: node.id,
        paperId,
        kind: isRoot ? 'root' : 'native_chapter',
        parentId,
        order: typeof node.order === 'number' ? node.order : index,
        text: String(node.title || '').trim(),
        pageIndex: node.pageIndex,
        topRatio: node.topRatio,
        sourceId: node.id
      });
      if (Array.isArray(node.items) && node.items.length) {
        walkNative(node.items, node.id);
      }
    });
  };

  walkNative(baseOutline, null);

  const chapterMap = new Map<string, DocNode>();
  annotations.forEach((item, index) => {
    const manual = item.source === 'manual' || !Array.isArray(item.rects) || !item.rects.length;
    if (item.isChapterTitle) {
      const chapterId = String(item.chapterNodeId || item.chapterId || `chapter-${item.id}`).trim();
      const existing = chapterMap.get(chapterId);
      chapterMap.set(chapterId, {
        id: chapterId,
        paperId,
        kind: manual ? 'normal_chapter' : 'highlight_chapter',
        parentId:
          existing?.parentId ||
          (item.parentId || (item.chapterId && item.chapterId !== chapterId ? item.chapterId : root.id)),
        order:
          typeof item.order === 'number'
            ? item.order
            : typeof existing?.order === 'number'
              ? existing.order
              : index,
        text: String(item.text || existing?.text || '').trim(),
        pageIndex: item.pageIndex ?? existing?.pageIndex ?? null,
        topRatio: item.topRatio ?? existing?.topRatio ?? null,
        color: item.color,
        translation: item.translation,
        questionIds: Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [],
        source: item.source === 'manual' ? 'manual' : 'pdf',
        sourceId: item.id,
        chapterNodeId: chapterId,
        rects: Array.isArray(item.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
        version: Math.max(1, Number(item.version || existing?.version || 1) || 1),
        baseVersion: Math.max(0, Number(item.baseVersion ?? existing?.baseVersion ?? 0) || 0),
        updatedAt: Number(item.updatedAt || existing?.updatedAt || Date.now()) || Date.now(),
        isDeleted: Boolean(item.isDeleted)
      });
      return;
    }
    nodes.push({
      id: `highlight-${item.id}`,
      paperId,
      kind: manual ? 'normal_note' : 'highlight_note',
      parentId: item.chapterId || root.id,
      order: typeof item.order === 'number' ? item.order : index,
      text: String(item.text || '').trim(),
      pageIndex: item.pageIndex,
      topRatio: item.topRatio ?? null,
      color: item.color,
      translation: item.translation,
      questionIds: Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [],
      source: item.source === 'manual' ? 'manual' : 'pdf',
      sourceId: item.id,
      chapterNodeId: item.chapterNodeId ?? null,
      rects: Array.isArray(item.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
      version: Math.max(1, Number(item.version || 1) || 1),
      baseVersion: Math.max(0, Number(item.baseVersion ?? 0) || 0),
      updatedAt: Number(item.updatedAt || Date.now()) || Date.now(),
      isDeleted: Boolean(item.isDeleted)
    });
  });

  nodes.push(...chapterMap.values());
  return nodes;
};

const sortHighlightItems = (items: HighlightItem[]) =>
  items.slice().sort((a, b) => {
    const deletedA = a.isDeleted ? 1 : 0;
    const deletedB = b.isDeleted ? 1 : 0;
    if (deletedA !== deletedB) return deletedA - deletedB;
    const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
  });

const buildCustomChaptersFromDocNodes = (docNodes: DocNode[]): OutlineNode[] =>
  (Array.isArray(docNodes) ? docNodes : [])
    .filter((item) => item && !item.isDeleted && (item.kind === 'normal_chapter' || item.kind === 'highlight_chapter'))
    .map((item) => ({
      id: item.id,
      title: item.text,
      pageIndex: item.pageIndex ?? null,
      topRatio: item.topRatio ?? null,
      items: [],
      isCustom: true,
      parentId: item.parentId ?? null,
      createdAt: Number(item.updatedAt || Date.now()),
      order: typeof item.order === 'number' ? item.order : undefined
    }));

const buildAnnotationsFromDocNodes = (docNodes: DocNode[]): HighlightItem[] => {
  const items: HighlightItem[] = [];
  (Array.isArray(docNodes) ? docNodes : []).forEach((item) => {
    if (!item) return;
    if (item.kind === 'highlight_note' || item.kind === 'normal_note') {
      items.push({
        id: String(item.sourceId || item.id.replace(/^highlight-/, '')).trim(),
        text: item.text,
        color: item.color || HIGHLIGHT_COLORS[0].fill,
        pageIndex: Number(item.pageIndex || 0),
        topRatio: item.topRatio ?? null,
        rects: Array.isArray(item.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
        chapterId: String(item.parentId || '').trim(),
        parentId: null,
        isChapterTitle: false,
        chapterNodeId: item.chapterNodeId ?? null,
        translation: item.translation || '',
        questionIds: Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [],
        source: item.source === 'manual' ? 'manual' : 'pdf',
        order: typeof item.order === 'number' ? item.order : undefined,
        version: item.version,
        baseVersion: item.baseVersion,
        updatedAt: item.updatedAt,
        isDeleted: Boolean(item.isDeleted)
      });
      return;
    }
    if ((item.kind === 'highlight_chapter' || item.kind === 'normal_chapter') && item.sourceId) {
      items.push({
        id: String(item.sourceId || `chapter-${item.id}`).trim(),
        text: item.text,
        color: item.color || 'rgba(107, 114, 128, 0.35)',
        pageIndex: Number(item.pageIndex || 0),
        topRatio: item.topRatio ?? null,
        rects: Array.isArray(item.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
        chapterId: item.id,
        parentId: item.parentId ?? null,
        isChapterTitle: true,
        chapterNodeId: item.id,
        translation: item.translation || '',
        questionIds: Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [],
        source: item.source === 'manual' ? 'manual' : 'pdf',
        order: typeof item.order === 'number' ? item.order : undefined,
        version: item.version,
        baseVersion: item.baseVersion,
        updatedAt: item.updatedAt,
        isDeleted: Boolean(item.isDeleted)
      });
    }
  });
  return dedupeChapterAnnotations(items);
};

const buildChapterAnnotationsFromOutlineNodes = (
  customChapters: OutlineNode[],
  previousAnnotations: HighlightItem[]
) => {
  const chapterLookup = new Map<string, HighlightItem>();
  previousAnnotations.forEach((item) => {
    if (!item?.isChapterTitle) return;
    const key = String(item.chapterNodeId || item.chapterId || item.id).trim();
    if (!key) return;
    chapterLookup.set(key, item);
  });
  return dedupeChapterAnnotations(
    customChapters.map((chapter, index) => {
      const key = String(chapter.id || '').trim();
      const previous = chapterLookup.get(key);
      const annotationId = String(previous?.id || `chapter-${key}`).trim();
      return normalizeSyncedHighlight({
        ...(previous || {}),
        id: annotationId,
        text: chapter.title,
        color: previous?.color || 'rgba(107, 114, 128, 0.35)',
        pageIndex: Number(chapter.pageIndex || 0),
        topRatio: chapter.topRatio ?? null,
        rects: Array.isArray(previous?.rects) ? previous.rects : [],
        chapterId: key,
        parentId: chapter.parentId ?? null,
        isChapterTitle: true,
        chapterNodeId: key,
        translation: previous?.translation || '',
        questionIds: Array.isArray(previous?.questionIds) ? previous.questionIds : [],
        source: previous?.source === 'pdf' ? 'pdf' : 'manual',
        order:
          typeof chapter.order === 'number'
            ? chapter.order
            : typeof previous?.order === 'number'
              ? previous.order
              : index,
        version: previous?.version,
        baseVersion: previous?.baseVersion,
        updatedAt: previous?.updatedAt ?? chapter.createdAt ?? Date.now(),
        isDeleted: false
      }) as HighlightItem;
    })
  );
};

const getLegacyCustomChaptersFromSavedState = (saved: any, paperId: string) => {
  const parsedMindmapStateV2 = parseMindmapStateV2(
    (saved as any)?.mindmapStateV2State?.value ?? (saved as any)?.mindmapStateV2
  );
  if (parsedMindmapStateV2) {
    const legacy = deriveLegacyMindmapDataFromV2(parsedMindmapStateV2, {
      rootIdAlias: `outline-root-${paperId}`
    });
    return Array.isArray(legacy.customChapters) ? (legacy.customChapters as OutlineNode[]) : [];
  }
  const savedCustomChapters = Array.isArray(saved?.customChapters)
    ? (saved.customChapters as OutlineNode[])
    : [];
  const legacyOverrides = normalizeLegacyParentOverrides((saved as any)?.chapterParentOverrides);
  return mergeLegacyParentOverridesIntoCustomChapters(savedCustomChapters, legacyOverrides);
};

const migrateLegacyStateAnnotations = (saved: any, paperId: string, normalizedAnnotations: HighlightItem[]) => {
  const legacyCustomChapters = getLegacyCustomChaptersFromSavedState(saved, paperId);
  const legacyHighlights = getLegacyHighlightAnnotations(saved);
  const mergedBase = dedupeChapterAnnotations([...normalizedAnnotations, ...legacyHighlights]);
  if (!legacyCustomChapters.length) return mergedBase;
  return dedupeChapterAnnotations([
    ...mergedBase,
    ...buildChapterAnnotationsFromOutlineNodes(legacyCustomChapters, mergedBase)
  ]);
};

const sortOutlineTreeNodes = (nodes: OutlineNode[]) => {
  const sorted = [...(nodes || [])].sort((a, b) => {
    const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
    if ((a.topRatio ?? 0) !== (b.topRatio ?? 0)) return (a.topRatio ?? 0) - (b.topRatio ?? 0);
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
  });
  return sorted.map((node) => ({
    ...node,
    items: sortOutlineTreeNodes(node.items || [])
  }));
};

const buildOutlineFromDocNodes = (
  paperId: string,
  docNodes: DocNode[],
  fallbackRoot?: { id?: string; title?: string; pageIndex?: number | null; topRatio?: number | null }
): OutlineNode[] => {
  const chapterKinds = new Set<DocNode['kind']>(['root', 'native_chapter', 'highlight_chapter', 'normal_chapter']);
  const chapterNodes = (Array.isArray(docNodes) ? docNodes : []).filter(
    (item) => item && !item.isDeleted && chapterKinds.has(item.kind)
  );
  const rootDoc =
    chapterNodes.find((item) => item.kind === 'root') ||
    ({
      id: fallbackRoot?.id || `outline-root-${paperId}`,
      paperId,
      kind: 'root',
      parentId: null,
      order: 0,
      text: fallbackRoot?.title || 'Document',
      pageIndex: fallbackRoot?.pageIndex ?? 0,
      topRatio: fallbackRoot?.topRatio ?? 0
    } satisfies DocNode);

  const outlineMap = new Map<string, OutlineNode>();
  chapterNodes.forEach((item) => {
    outlineMap.set(item.id, {
      id: item.id,
      title: item.text,
      pageIndex: item.pageIndex ?? null,
      topRatio: item.topRatio ?? null,
      items: [],
      isRoot: item.kind === 'root',
      isCustom: item.kind === 'highlight_chapter' || item.kind === 'normal_chapter',
      parentId: item.parentId ?? null,
      createdAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined,
      order: typeof item.order === 'number' ? item.order : undefined
    });
  });
  if (!outlineMap.has(rootDoc.id)) {
    outlineMap.set(rootDoc.id, {
      id: rootDoc.id,
      title: rootDoc.text,
      pageIndex: rootDoc.pageIndex ?? null,
      topRatio: rootDoc.topRatio ?? null,
      items: [],
      isRoot: true,
      parentId: null,
      createdAt:
        typeof rootDoc.updatedAt === 'number' && Number.isFinite(rootDoc.updatedAt)
          ? rootDoc.updatedAt
          : undefined,
      order: typeof rootDoc.order === 'number' ? rootDoc.order : 0
    });
  }
  const rootId = rootDoc.id;
  outlineMap.forEach((node, id) => {
    if (id === rootId) return;
    const parentId = node.parentId && outlineMap.has(node.parentId) ? node.parentId : rootId;
    const parent = outlineMap.get(parentId);
    if (!parent) return;
    parent.items = [...(parent.items || []), node];
  });
  const root = outlineMap.get(rootId);
  if (!root) return [];
  return [sortOutlineTreeNodes([root])[0]];
};

const buildHighlightsByChapterFromDocNodes = (docNodes: DocNode[]): Map<string, HighlightItem[]> => {
  const map = new Map<string, HighlightItem[]>();
  (Array.isArray(docNodes) ? docNodes : [])
    .filter((item) => item && !item.isDeleted && (item.kind === 'highlight_note' || item.kind === 'normal_note'))
    .forEach((item) => {
      const parentId = String(item.parentId || '').trim();
      if (!parentId) return;
      const note: HighlightItem = {
        id: String(item.sourceId || item.id.replace(/^highlight-/, '')).trim(),
        text: item.text,
        color: item.color || HIGHLIGHT_COLORS[0].fill,
        pageIndex: Number(item.pageIndex || 0),
        rects: Array.isArray(item.rects) ? item.rects.map((rect) => normalizeHighlightRect(rect)) : [],
        chapterId: parentId,
        isChapterTitle: false,
        chapterNodeId: item.chapterNodeId ?? null,
        translation: item.translation || '',
        questionIds: Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [],
        source: item.source === 'manual' ? 'manual' : 'pdf',
        order: typeof item.order === 'number' ? item.order : undefined,
        version: item.version,
        baseVersion: item.baseVersion,
        updatedAt: item.updatedAt,
        isDeleted: Boolean(item.isDeleted)
      };
      const list = map.get(parentId) || [];
      list.push(note);
      map.set(parentId, list);
    });
  map.forEach((items, key) => {
    map.set(
      key,
      items.slice().sort((a, b) => {
        const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
      })
    );
  });
  return map;
};

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
  onCloudSync?: (
    mode?: 'auto' | 'upload' | 'download'
  ) => Promise<{ success: boolean; skipped?: boolean; mode?: 'upload' | 'download'; error?: string } | void>;
  cloudRefreshToken?: number;
  isCloudSyncing?: boolean;
}

export const ReaderView: React.FC<ReaderViewProps> = ({
  paper,
  pdfFile,
  onBack,
  onUpdatePaper,
  onCloudSync,
  cloudRefreshToken = 0,
  isCloudSyncing = false
}) => {
  const MIN_SIDE_WIDTH = 120;
  const MIN_CENTER_WIDTH = 120;
  const RESIZE_HANDLE_WIDTH = 4;
  const DEFAULT_LEFT_RATIO = 0.2;
  const DEFAULT_RIGHT_RATIO = 0.2;
  const CHAPTER_START_TOLERANCE = 0.03;

  // State
  const [viewMode, setViewMode] = useState<ReaderMode>(ReaderMode.PDF);
  const [activeTab, setActiveTab] = useState<AssistantTab>(AssistantTab.INFO);
  const [pdfZoom, setPdfZoom] = useState(100);
  const [mindmapZoom, setMindmapZoom] = useState(80);
  const [expandedTOC, setExpandedTOC] = useState<Set<string>>(new Set(['1', '2']));
  const [leftWidth, setLeftWidth] = useState(200);
  const [rightWidth, setRightWidth] = useState(200);
  const [numPages, setNumPages] = useState<number>(0);
  const [outlineNodes, setOutlineNodes] = useState<OutlineNode[]>([]);
  const [selectionText, setSelectionText] = useState('');
  const [selectionRect, setSelectionRect] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<{ pageIndex: number; rects: HighlightRect[]; text: string } | null>(null);
  const [suppressTranslation, setSuppressTranslation] = useState(false);
  const [docNodes, setDocNodes] = useState<DocNode[]>([]);
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
  const [dragOverMindmapTarget, setDragOverMindmapTarget] = useState<MindmapDropTarget | null>(null);
  const [mindmapDropLastHit, setMindmapDropLastHit] = useState('none');
  const [mindmapDropOrderDebug, setMindmapDropOrderDebug] = useState('');
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
  const [expandedHighlightIds, setExpandedHighlightIds] = useState<Set<string>>(new Set());
  const mindmapZoomScale = mindmapZoom / 100;
  const [infoRefreshing, setInfoRefreshing] = useState(false);
  const [infoRefreshError, setInfoRefreshError] = useState('');
  const [isExportingMarkdown, setIsExportingMarkdown] = useState(false);
  const [infoTitleDraft, setInfoTitleDraft] = useState(String(paper.title || ''));
  const [isInfoTitleEditing, setIsInfoTitleEditing] = useState(false);
  const [infoTitleError, setInfoTitleError] = useState('');
  const skipInfoTitleCommitRef = useRef(false);
  const logProgress = async (stage: string, paperId?: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.logProgress) return;
    try {
      await window.electronAPI.logProgress({ stage, paperId });
    } catch {
      // ignore progress logging errors
    }
  };
  const logDebugToMain = async (
    event: string,
    payload: Record<string, unknown>,
    options?: { paperId?: string }
  ) => {
    const safePayload = payload || {};
    try {
      console.log(`[reader-debug] ${event}`, safePayload);
    } catch {
      // ignore renderer console errors
    }
    if (typeof window === 'undefined' || !window.electronAPI?.debugLog) return;
    try {
      await window.electronAPI.debugLog({
        tag: 'reader-debug',
        event,
        paperId: options?.paperId || paper.id,
        payload: safePayload
      });
    } catch {
      // ignore main debug logging errors
    }
  };

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
  const lastAutosaveComparableRef = useRef<string>('');
  const suspendAutosaveRef = useRef(true);
  const resumeAutosaveTimerRef = useRef<number | null>(null);
  const loadedPaperIdRef = useRef<string | null>(null);
  const questionsStateRef = useRef<VersionedStateEnvelope<ReaderQuestion[]> | null>(null);
  const mindmapStateV2StateRef = useRef<VersionedStateEnvelope<MindmapStateV2 | null> | null>(null);
  const aiConversationsStateRef = useRef<VersionedStateEnvelope<AiConversationSyncPayload> | null>(null);
  const pdfScrollTopRef = useRef(0);
  const mindmapLayoutRef = useRef<MindMapLayout | null>(null);
  const mindmapAnchorRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const mindmapPanRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );
  const mindmapStateRef = useRef<{
    collapsedIds: string[];
    offset: { x: number; y: number };
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
  const dragOverMindmapTargetRef = useRef<MindmapDropTarget | null>(null);
  const mindmapParentMapRef = useRef<Map<string, string | null>>(new Map());
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
  const outlineDisplayRef = useRef<OutlineNode[]>([]);
  const dragStateRef = useRef<{ side: 'left' | 'right'; startX: number; start: number } | null>(null);
  const hasInitWidthsRef = useRef(false);
  const tocEditInputRef = useRef<HTMLTextAreaElement | null>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const questionPickerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfDataMasterRef = useRef<ArrayBuffer | null>(null);
  const [pdfFileForRender, setPdfFileForRender] = useState<{ data: ArrayBuffer } | string | null>(null);
  const paperContextCacheRef = useRef<Map<string, Promise<string>>>(new Map());
  const activeChat = useMemo(
    () => chatThreads.find((thread) => thread.id === activeChatId) || null,
    [chatThreads, activeChatId]
  );
  const sortedChatThreads = useMemo(
    () => [...chatThreads].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatThreads]
  );

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
    const rootId = `outline-root-${paper.id}`;
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
  const baseOutlineRef = useRef<OutlineNode[]>(baseOutline);
  baseOutlineRef.current = baseOutline;

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
  const rebuildDocNodes = useCallback(
    (nextAnnotations: HighlightItem[] = []) =>
      buildDocNodesFromCurrentState(paper.id, baseOutline, nextAnnotations),
    [paper.id, baseOutline]
  );
  const docNodesForRender = useMemo(
    () => (Array.isArray(docNodes) && docNodes.length ? docNodes : rebuildDocNodes([])),
    [docNodes, rebuildDocNodes]
  );
  const customChapters = useMemo(
    () => buildCustomChaptersFromDocNodes(docNodesForRender),
    [docNodesForRender]
  );
  const annotations = useMemo(
    () => buildAnnotationsFromDocNodes(docNodesForRender),
    [docNodesForRender]
  );
  const visibleHighlights = useMemo(() => getVisibleHighlights(annotations), [annotations]);
  const annotationById = useMemo(
    () => new Map(visibleHighlights.map((item) => [String(item.id || '').trim(), item])),
    [visibleHighlights]
  );
  const noteAnnotations = useMemo(
    () => annotations.filter((item) => item && !item.isDeleted && !item.isChapterTitle),
    [annotations]
  );
  const customChapterNodeMap = useMemo(
    () =>
      new Map(
        docNodesForRender
          .filter(
            (node) =>
              node &&
              !node.isDeleted &&
              (node.kind === 'normal_chapter' || node.kind === 'highlight_chapter')
          )
          .map((node) => [node.id, node])
      ),
    [docNodesForRender]
  );
  const chapterAnnotationByNodeId = useMemo(
    () =>
      new Map(
        annotations
          .filter((item) => item && !item.isDeleted && item.isChapterTitle)
          .map((item) => [String(item.chapterNodeId || item.chapterId || item.id).trim(), item])
      ),
    [annotations]
  );

  const setHighlights = useCallback(
    (updater: React.SetStateAction<HighlightItem[]>) => {
      setDocNodes((prevDocNodes) => {
        const prevAnnotations = buildAnnotationsFromDocNodes(prevDocNodes);
        const prevHighlights = getVisibleHighlights(prevAnnotations);
        const nextHighlights =
          typeof updater === 'function'
            ? (updater as (prevState: HighlightItem[]) => HighlightItem[])(prevHighlights)
            : updater;
        if (areHighlightsEquivalent(prevHighlights, nextHighlights)) {
          return prevDocNodes;
        }
        const nextAnnotations = dedupeChapterAnnotations(
          buildAnnotationsForSave(nextHighlights, prevAnnotations)
        );
        const nextDocNodes = rebuildDocNodes(nextAnnotations);
        return areDocNodesEquivalent(prevDocNodes, nextDocNodes) ? prevDocNodes : nextDocNodes;
      });
    },
    [rebuildDocNodes]
  );

  const setCustomChapters = useCallback(
    (updater: React.SetStateAction<OutlineNode[]>) => {
      setDocNodes((prevDocNodes) => {
        const prevCustomChapters = buildCustomChaptersFromDocNodes(prevDocNodes);
        const nextCustomChapters =
          typeof updater === 'function'
            ? (updater as (prevState: OutlineNode[]) => OutlineNode[])(prevCustomChapters)
            : updater;
        if (areCustomChaptersEquivalent(prevCustomChapters, nextCustomChapters)) {
          return prevDocNodes;
        }
        const nextAnnotations = buildAnnotationsFromDocNodes(prevDocNodes);
        const nextNotes = nextAnnotations.filter((item) => !item.isChapterTitle);
        const nextChapterAnnotations = buildChapterAnnotationsFromOutlineNodes(nextCustomChapters, nextAnnotations);
        const nextDocNodes = rebuildDocNodes(
          dedupeChapterAnnotations([...nextNotes, ...nextChapterAnnotations])
        );
        return areDocNodesEquivalent(prevDocNodes, nextDocNodes) ? prevDocNodes : nextDocNodes;
      });
    },
    [rebuildDocNodes]
  );

  const patchCustomChapterOrders = useCallback((siblingOrderPatch: Map<string, number>) => {
    if (!siblingOrderPatch.size) return;
    setCustomChapters((prev) =>
      prev.map((item) => {
        const nextOrder = siblingOrderPatch.get(item.id);
        if (typeof nextOrder !== 'number') return item;
        if (typeof item.order === 'number' && Math.abs(item.order - nextOrder) <= 1e-6) {
          return item;
        }
        return { ...item, order: nextOrder };
      })
    );
  }, [setCustomChapters]);

  const clonePdfBuffer = useCallback((value: unknown): ArrayBuffer | null => {
    if (value instanceof ArrayBuffer) {
      try {
        return value.slice(0);
      } catch {
        return null;
      }
    }
    if (ArrayBuffer.isView(value)) {
      try {
        const view = value as ArrayBufferView;
        return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      } catch {
        return null;
      }
    }
    return null;
  }, []);

  useEffect(() => {
    if (!pdfFile) {
      pdfDataMasterRef.current = null;
      setPdfFileForRender(null);
      return;
    }

    if (typeof pdfFile === 'string') {
      pdfDataMasterRef.current = null;
      setPdfFileForRender(pdfFile);
      return;
    }

    const master = clonePdfBuffer((pdfFile as any).data);
    if (master) {
      pdfDataMasterRef.current = master;
      setPdfFileForRender({ data: master.slice(0) });
      return;
    }

    if (pdfDataMasterRef.current) {
      setPdfFileForRender({ data: pdfDataMasterRef.current.slice(0) });
      return;
    }

    setPdfFileForRender(null);
  }, [paper.id, pdfFile, clonePdfBuffer]);

  const getPdfBufferForParsing = useCallback(() => {
    if (pdfDataMasterRef.current) {
      return pdfDataMasterRef.current.slice(0);
    }
    if (pdfFile && typeof pdfFile !== 'string') {
      return clonePdfBuffer((pdfFile as any).data);
    }
    return null;
  }, [pdfFile, clonePdfBuffer]);

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
      }
      return;
    }
    mindmapStateRef.current = {
      collapsedIds: Array.from(collapsedMindmapIds),
      offset: mindmapOffset
    };
  }, [viewMode]);

  const handleContentScroll = useCallback(() => {
    const container = contentAreaRef.current;
    if (container) {
      pdfScrollTopRef.current = container.scrollTop;
    }
  }, []);

  const clearMindmapTransientInteractionState = useCallback(() => {
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
    tocDragNoteTimerRef.current = null;
    tocDragChapterTimerRef.current = null;

    dragNoteRef.current = null;
    dragChapterRef.current = null;
    tocDragNoteRef.current = null;
    tocDragChapterRef.current = null;

    dragNoteTriggeredRef.current = false;
    dragChapterTriggeredRef.current = false;
    tocDragNoteTriggeredRef.current = false;
    tocDragChapterTriggeredRef.current = false;

    dragOverMindmapTargetRef.current = null;
    setDraggingNoteId(null);
    setDraggingChapterId(null);
    setDraggingTocNoteId(null);
    setDraggingTocChapterId(null);
    setDragOverMindmapTarget(null);
    setDragOverTocId(null);
    setDragGhost(null);
    setIsMindmapPanning(false);
    mindmapPanRef.current = null;
  }, []);

  const switchViewMode = (nextMode: ReaderMode) => {
    if (nextMode === viewMode) return;
    if (viewMode === ReaderMode.PDF) {
      const container = contentAreaRef.current;
      if (container) {
        pdfScrollTopRef.current = container.scrollTop;
      }
    } else {
      clearMindmapTransientInteractionState();
    }
    setViewMode(nextMode);
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) {
      clearMindmapTransientInteractionState();
    }
  }, [viewMode, clearMindmapTransientInteractionState]);

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
      await logProgress('开始解析基本信息', paper.id);
      let parseWithAI = false;
      let canUseAI = false;
      if (typeof window !== 'undefined' && window.electronAPI?.settingsGet) {
        const settings = await window.electronAPI.settingsGet();
        parseWithAI = Boolean(settings?.parsePdfWithAI);
        canUseAI = Boolean(settings?.apiKey?.trim()) && Boolean(window.electronAPI?.askAI);
      }

      const fallbackTitle = paper.title || 'Document';
      let updates: Partial<Paper> = {};
      let parseBuffer: ArrayBuffer | null = null;
      parseBuffer = getPdfBufferForParsing();
      if (!parseBuffer && typeof pdfFile === 'string') {
        const response = await fetch(pdfFile);
        parseBuffer = await response.arrayBuffer();
      }
      if (!parseBuffer) {
        throw new Error('无法读取PDF内容');
      }
      const resolved = await resolvePaperMetadata({
        fileData: parseBuffer,
        fallbackTitle,
        fallbackDate: '',
        priority: parseWithAI && canUseAI ? ['open_source', 'ai', 'local'] : ['open_source', 'local'],
        parsePdfWithAI: parseWithAI && canUseAI,
        askAI: window.electronAPI?.askAI,
        searchOpenSource: window.electronAPI?.searchPaperOpenSource
          ? (title) => window.electronAPI!.searchPaperOpenSource!(title)
          : undefined
      });
      const originalAbstract = String(resolved.abstract || resolved.summary || '').trim();
      const resolvedAuthor = String(resolved.author || '').trim();
      const nextAuthor = resolvedAuthor || 'Unknown';
      const nextDate = String(resolved.date || '').trim() || 'Unknown';
      const parsedAbstract = String(resolved.abstract || resolved.summary || '').trim();
      updates = {
        ...(resolved.title ? { title: resolved.title } : {}),
        ...(nextAuthor ? { author: nextAuthor } : {}),
        ...(parsedAbstract ? { abstract: parsedAbstract } : {}),
        keywords: Array.isArray(resolved.keywords) ? resolved.keywords : [],
        date: nextDate,
        ...(resolved.publisher ? { publisher: resolved.publisher } : {}),
        ...(resolved.doi ? { doi: resolved.doi } : {})
      };
      let apiReferences: PaperReference[] = [];
      let apiReferenceSuccess = false;
      if (resolved.doi && window.electronAPI?.searchPaperReferences) {
        const refs = await window.electronAPI.searchPaperReferences({
          doi: resolved.doi,
          title: resolved.title || paper.title
        });
        if (refs?.ok) {
          apiReferences = Array.isArray(refs.references)
            ? mapReferences(paper.id, refs.references, 'api')
            : [];
          apiReferenceSuccess = apiReferences.length > 0;
          updates.referenceStats = {
            totalOpenAlex: Number(refs.total_openalex || 0),
            totalSemanticScholar: Number(refs.total_semanticscholar || 0),
            intersectionCount: Number((refs.union_count ?? refs.intersection_count) || 0)
          };
        } else {
          console.warn('参考文献解析失败:', refs?.error || 'unknown');
        }
      }
      let localReferences: PaperReference[] = [];
      if (!apiReferenceSuccess && parseBuffer) {
        const localRefs = await extractPdfReferencesFromLocal(parseBuffer, {
          maxPages: 80,
          maxRefs: 200
        });
        if (localRefs.length) {
          localReferences = mapReferences(paper.id, localRefs, 'local');
          console.log(`[references][local] paper=${paper.id} count=${localRefs.length}`);
        }
      }
      updates.references = apiReferenceSuccess ? apiReferences : dedupeReferences(localReferences);
      updates.references = await matchReferences(paper.id, updates.references);
      updates.references = sortReferences(updates.references);
      updates.referenceStats = buildReferenceStats(updates.references, updates.referenceStats);
      await logProgress('完成解析基本信息', paper.id);

      if (parseWithAI && canUseAI && parseBuffer && originalAbstract) {
        try {
          await logProgress('开始重写摘要', paper.id);
          const fullText = await extractPdfFullText(parseBuffer as ArrayBuffer, {
            maxChars: 260000
          });
          if (fullText) {
            const rewrittenSummary = await rewriteSummaryWithAI(
              {
                originalAbstract,
                fullText
              },
              window.electronAPI!.askAI!
            );
            if (rewrittenSummary) {
              updates.summary = rewrittenSummary;
            }
          }
          await logProgress('完成重写摘要', paper.id);
        } catch (error) {
          console.warn('重写摘要失败，保留原摘要:', error);
        }
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

  const handleStartTitleEdit = () => {
    if (isCloudSyncing) return;
    skipInfoTitleCommitRef.current = false;
    setInfoTitleDraft(String(paper.title || ''));
    setInfoTitleError('');
    setIsInfoTitleEditing(true);
  };

  const applyTitleToOutlineRoot = useCallback((nextTitle: string) => {
    setOutlineNodes((prev) => {
      if (!prev.length) return prev;
      const root = prev[0];
      if (root.title === nextTitle) return prev;
      return [{ ...root, title: nextTitle }, ...prev.slice(1)];
    });
  }, []);

  const applyTitleToDocRoot = useCallback((nextTitle: string) => {
    setDocNodes((prev) => {
      if (!Array.isArray(prev) || !prev.length) return prev;
      let changed = false;
      const next = prev.map((item) => {
        if (!item || item.kind !== 'root') return item;
        if (item.text === nextTitle) return item;
        changed = true;
        return {
          ...item,
          text: nextTitle,
          updatedAt: Date.now()
        };
      });
      return changed ? next : prev;
    });
  }, []);

  const handleCancelTitleEdit = () => {
    skipInfoTitleCommitRef.current = true;
    setInfoTitleDraft(String(paper.title || ''));
    setInfoTitleError('');
    setIsInfoTitleEditing(false);
  };

  const handleCommitTitleEdit = () => {
    if (skipInfoTitleCommitRef.current) {
      skipInfoTitleCommitRef.current = false;
      return;
    }
    if (isCloudSyncing) return;
    const nextTitle = String(infoTitleDraft || '').trim();
    if (!nextTitle) {
      setInfoTitleError('标题不能为空');
      return;
    }
    const currentTitle = String(paper.title || '').trim();
    if (nextTitle === currentTitle) {
      setInfoTitleError('');
      setIsInfoTitleEditing(false);
      return;
    }
    applyTitleToOutlineRoot(nextTitle);
    applyTitleToDocRoot(nextTitle);
    onUpdatePaper(paper.id, { title: nextTitle });
    setInfoTitleError('');
    setIsInfoTitleEditing(false);
  };

  const handleToolbarCloudSync = async () => {
    if (isCloudSyncing || !onCloudSync) return;
    try {
      await onCloudSync();
    } catch (error: any) {
      console.warn('[webdav-sync] reader toolbar sync failed:', error?.message || error);
    }
  };

  const handleExportMarkdown = async () => {
    if (isExportingMarkdown) return;
    const markdown = buildMarkdownFromMindmap(mindmapRoot);
    if (!markdown.trim()) {
      window.alert('当前没有可导出的思维导图内容。');
      return;
    }
    if (typeof window === 'undefined' || !window.electronAPI?.library?.exportMarkdown) {
      window.alert('当前环境不支持导出 Markdown。');
      return;
    }
    setIsExportingMarkdown(true);
    try {
      const result = await window.electronAPI.library.exportMarkdown({
        paperTitle: paper.title || 'mind-paper-export',
        content: markdown
      });
      if (!result?.ok) {
        throw new Error(result?.error || '导出失败');
      }
    } catch (error: any) {
      window.alert(error?.message || '导出失败');
    } finally {
      setIsExportingMarkdown(false);
    }
  };

  useEffect(() => {
    pdfDocRef.current = null;
  }, [paper.id]);

  useEffect(() => {
    setInfoTitleDraft(String(paper.title || ''));
    setInfoTitleError('');
    setIsInfoTitleEditing(false);
  }, [paper.id, paper.title]);

  const clearSelection = useCallback(() => {
    setSelectionText('');
    setSelectionRect(null);
    setSelectionInfo(null);
    setActiveHighlightId(null);
    setActiveHighlightColor(null);
    setTranslationResult('');
    setSuppressTranslation(false);
  }, []);

  const clearNativeSelection = useCallback(() => {
    if (typeof window === 'undefined') return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
    }
  }, []);

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
      const activeNote = activeHighlightId ? annotationById.get(activeHighlightId) || null : null;
      if (activeNote && !activeNote.isChapterTitle) {
        const noteText = normalizeTranslationText(activeNote.text);
        if (noteText && noteText === source && activeNote.translation) {
          setTranslationResult(activeNote.translation);
          return;
        }
      }
    }

    const cached = translationCacheRef.current.get(source);
    if (cached) {
      setTranslationResult(cached);
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
      } catch (error) {
        if (translateRequestRef.current !== requestId) return;
        setTranslationResult(error?.message || '翻译失败');
      } finally {
        if (translateRequestRef.current !== requestId) return;
        pendingTranslationTextRef.current = null;
      }
    };

    run();
  }, [selectionText, selectionInfo?.pageIndex, suppressTranslation, activeHighlightId, annotations]);

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

  const getOrderForPreFirstNativeHighlight = (
    chapterId: string,
    pageIndex: number,
    topRatio: number
  ) => {
    if (!chapterId || chapterId !== outlineRootId) return undefined;
    const rootNode = outlineDisplay[0];
    const firstNativeRootChild = (rootNode?.items || []).find((node) => !node?.isCustom);
    if (!firstNativeRootChild || typeof firstNativeRootChild.pageIndex !== 'number') {
      return undefined;
    }
    const firstTopRatio =
      typeof firstNativeRootChild.topRatio === 'number' ? firstNativeRootChild.topRatio : 0;
    const isBeforeFirstNative =
      pageIndex < firstNativeRootChild.pageIndex ||
      (pageIndex === firstNativeRootChild.pageIndex &&
        topRatio + CHAPTER_START_TOLERANCE < firstTopRatio);
    if (!isBeforeFirstNative) return undefined;
    return getCombinedOrderValueBefore(outlineRootId, 'node', firstNativeRootChild.id);
  };

  const buildHighlightFromSelection = (
    color: string,
    options: Partial<HighlightItem> = {}
  ): BuiltHighlightDraft | null => {
    if (!selectionInfo || !selectionText) return;
    const topRatio = selectionInfo.rects.length
      ? Math.min(...selectionInfo.rects.map((rect) => rect.y))
      : 0;
    const leftRatio = selectionInfo.rects.length
      ? Math.min(...selectionInfo.rects.map((rect) => rect.x ?? 0))
      : 0;
    const chapterId = findParentChapterId(selectionInfo.pageIndex, topRatio);
    const cachedTranslation = translationCacheRef.current.get(
      normalizeTranslationText(selectionText)
    );
    const prefix = options.isChapterTitle ? 'chapter-highlight' : 'highlight';
    const stableId =
      typeof options.id === 'string' && options.id.trim()
        ? options.id.trim()
        : createStableSelectionId(prefix, selectionInfo.pageIndex, selectionInfo.rects, paper.id);
    const base: HighlightItem = {
      id: stableId,
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
    let siblingOrderPatch = new Map<string, number>();
    if (typeof nextOrder !== 'number' && !base.isChapterTitle) {
      const preFirstNativeOrder = getOrderForPreFirstNativeHighlight(
        base.chapterId,
        selectionInfo.pageIndex,
        topRatio
      );
      if (typeof preFirstNativeOrder === 'number') {
        nextOrder = preFirstNativeOrder;
      } else {
        const slot = getNodeOrderValueByChildPositionSlot(
          base.chapterId,
          selectionInfo.pageIndex,
          topRatio,
          leftRatio
        );
        nextOrder = slot.order;
        siblingOrderPatch = slot.siblingOrderPatch;
      }
    }
    return {
      highlight: { ...base, order: nextOrder },
      siblingOrderPatch
    };
  };

  const buildHighlightFromSelectionData = (
    color: string,
    info: { pageIndex: number; rects: HighlightRect[]; text: string } | null,
    text: string,
    options: Partial<HighlightItem> = {}
  ): BuiltHighlightDraft | null => {
    if (!info || !text) return null;
    const topRatio = info.rects.length
      ? Math.min(...info.rects.map((rect) => rect.y))
      : 0;
    const leftRatio = info.rects.length
      ? Math.min(...info.rects.map((rect) => rect.x ?? 0))
      : 0;
    const chapterId = findParentChapterId(info.pageIndex, topRatio);
    const cachedTranslation = translationCacheRef.current.get(
      normalizeTranslationText(text)
    );
    const prefix = options.isChapterTitle ? 'chapter-highlight' : 'highlight';
    const stableId =
      typeof options.id === 'string' && options.id.trim()
        ? options.id.trim()
        : createStableSelectionId(prefix, info.pageIndex, info.rects, paper.id);
    const base: HighlightItem = {
      id: stableId,
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
    let siblingOrderPatch = new Map<string, number>();
    if (typeof nextOrder !== 'number' && !base.isChapterTitle) {
      const preFirstNativeOrder = getOrderForPreFirstNativeHighlight(
        base.chapterId,
        info.pageIndex,
        topRatio
      );
      if (typeof preFirstNativeOrder === 'number') {
        nextOrder = preFirstNativeOrder;
      } else {
        const slot = getNodeOrderValueByChildPositionSlot(
          base.chapterId,
          info.pageIndex,
          topRatio,
          leftRatio
        );
        nextOrder = slot.order;
        siblingOrderPatch = slot.siblingOrderPatch;
      }
    }
    return {
      highlight: { ...base, order: nextOrder },
      siblingOrderPatch
    };
  };

  const isManualHighlight = useCallback((item: HighlightItem) => {
    if (item.source === 'manual') return true;
    if (item.source === 'pdf') return false;
    const rects = Array.isArray(item.rects) ? item.rects : [];
    if (!rects.length) return true;
    return rects.every((rect) => Number(rect.w || 0) === 0 && Number(rect.h || 0) === 0);
  }, []);

  const findParentNode = useCallback((
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
  }, []);

  const resolveParentForChapter = useCallback((chapterId: string) => {
    const custom = customChapterNodeMap.get(chapterId);
    if (custom?.parentId) return custom.parentId;
    const parentNode = findParentNode(outlineDisplayRef.current, chapterId, null);
    return parentNode?.id || outlineRootId;
  }, [customChapterNodeMap, findParentNode, outlineRootId]);

  const detachCustomChapter = useCallback((
    chapterId: string,
    options?: { keepHighlightId?: string; keepHighlightColor?: string }
  ) => {
    const parentId = resolveParentForChapter(chapterId);
    setDocNodes((prevDocNodes) => {
      const prevCustomChapters = buildCustomChaptersFromDocNodes(prevDocNodes);
      const prevAnnotations = buildAnnotationsFromDocNodes(prevDocNodes);
      const prevHighlights = getVisibleHighlights(prevAnnotations);

      const nextCustomChapters = prevCustomChapters
        .filter((item) => item.id !== chapterId)
        .map((item) =>
          item.parentId === chapterId ? { ...item, parentId } : item
        );

      const nextHighlights = prevHighlights
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
        });

      const nextNotes = nextHighlights.filter((item) => !item.isChapterTitle);
      const nextChapterAnnotations = buildChapterAnnotationsFromOutlineNodes(
        nextCustomChapters,
        prevAnnotations
      );
      const nextAnnotations = dedupeChapterAnnotations(
        buildAnnotationsForSave(
          dedupeChapterAnnotations([...nextNotes, ...nextChapterAnnotations]),
          prevAnnotations
        )
      );
      const nextDocNodes = rebuildDocNodes(nextAnnotations);
      return areDocNodesEquivalent(prevDocNodes, nextDocNodes) ? prevDocNodes : nextDocNodes;
    });
    setExpandedTOC((prev) => {
      const next = new Set(prev);
      next.delete(chapterId);
      const path = findOutlinePath(outlineDisplayRef.current, parentId);
      if (path?.length) {
        path.forEach((id) => next.add(id));
      } else if (parentId) {
        next.add(parentId);
      }
      return next;
    });
  }, [rebuildDocNodes, resolveParentForChapter]);

  const addHighlight = (color: string) => {
    clearNativeSelection();
    if (activeHighlightId) {
      const activeHighlight = annotationById.get(activeHighlightId) || null;
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
    const builtHighlight = buildHighlightFromSelection(color);
    if (!builtHighlight) return;
    patchCustomChapterOrders(builtHighlight.siblingOrderPatch);
    const newItem = builtHighlight.highlight;
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
    const builtHighlight = buildHighlightFromSelectionData(
      defaultColor,
      questionPicker.selectionInfo,
      questionPicker.selectionText,
      { questionIds: [question.id] }
    );
    if (!builtHighlight) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
      return;
    }
    patchCustomChapterOrders(builtHighlight.siblingOrderPatch);
    const nextHighlight = builtHighlight.highlight;
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
      const activeHighlight = annotationById.get(activeHighlightId) || null;
      if (activeHighlight?.isChapterTitle) {
        clearSelection();
        return;
      }
    }
    const title = selectionText.trim();
    if (!title) return;
    const rects = selectionInfo.rects.filter((rect) => rect.pageIndex >= 0);
    if (!rects.length || selectionInfo.pageIndex == null) return;
    const anchorRect = rects
      .slice()
      .sort((a, b) => {
        if ((a.pageIndex ?? 0) !== (b.pageIndex ?? 0)) return (a.pageIndex ?? 0) - (b.pageIndex ?? 0);
        if ((a.y ?? 0) !== (b.y ?? 0)) return (a.y ?? 0) - (b.y ?? 0);
        return (a.x ?? 0) - (b.x ?? 0);
      })[0];
    const topRatio =
      typeof anchorRect?.y === 'number'
        ? anchorRect.y
        : Math.min(...rects.map((rect) => rect.y ?? 0));
    const leftRatio = typeof anchorRect?.x === 'number' ? anchorRect.x : 0;
    const pageIndex =
      typeof anchorRect?.pageIndex === 'number'
        ? anchorRect.pageIndex
        : selectionInfo.pageIndex;
    const parentChapter = findChapterForPosition(pageIndex, topRatio);
    const hasNearestHeadingAbove = Boolean(parentChapter && !parentChapter.isRoot);
    const parentId = hasNearestHeadingAbove
      ? String(parentChapter?.id || '').trim() || outlineRootId
      : outlineRootId;
    const { order, siblingOrderPatch } = getNodeOrderValueByChildPositionSlot(
      parentId,
      pageIndex,
      topRatio,
      leftRatio
    );
    const rootNode = outlineDisplay[0] || null;
    const mountParentNode =
      parentId === outlineRootId ? rootNode : findOutlineNodeById(outlineDisplay, parentId);
    const summarizeChildren = (items: OutlineNode[]) =>
      (items || []).map((item) => ({
        id: item.id,
        title: item.title,
        pageIndex: item.pageIndex ?? null,
        topRatio: item.topRatio ?? null,
        leftRatio: item.leftRatio ?? null,
        order: typeof item.order === 'number' ? item.order : null,
        isCustom: Boolean(item.isCustom)
      }));
    const summarizeNotes = (items: HighlightItem[]) =>
      (items || []).map((item) => {
        const key = getHighlightSortKey(item);
        return {
          id: item.id,
          text: item.text,
          pageIndex: key.pageIndex ?? null,
          topRatio: key.top ?? null,
          leftRatio: key.left ?? null,
          order: typeof item.order === 'number' ? item.order : null
        };
      });
    const mountParentNotes = noteAnnotations.filter(
      (item) => item.chapterId === parentId && !item.isChapterTitle
    );
    void logDebugToMain('create-custom-chapter-from-selection', {
      selectedText: title,
      selectedAnchor: {
        pageIndex: anchorRect?.pageIndex ?? pageIndex,
        x: anchorRect?.x ?? null,
        y: anchorRect?.y ?? topRatio
      },
      computedPosition: {
        pageIndex,
        topRatio,
        leftRatio
      },
      mountParent: mountParentNode
        ? {
            id: mountParentNode.id,
            title: mountParentNode.title,
            isRoot: Boolean(mountParentNode.isRoot)
          }
        : null,
      mountParentChildren: summarizeChildren(mountParentNode?.items || []),
      mountParentNotes: summarizeNotes(mountParentNotes),
      rootNode: rootNode
        ? {
            id: rootNode.id,
            title: rootNode.title
          }
        : null,
      rootChildren: summarizeChildren(rootNode?.items || []),
      computedOrder: order,
      siblingOrderPatch: Array.from(siblingOrderPatch.entries()).map(([id, patchedOrder]) => ({
        id,
        order: patchedOrder
      })),
      chapterHighlightDraft: {
        pageIndex,
        topRatio,
        leftRatio,
        order
      }
    });

    const chapterNode: OutlineNode = {
      id: createStableSelectionId('custom', pageIndex, rects, `${paper.id}|${parentId}`),
      title,
      pageIndex,
      topRatio,
      leftRatio,
      items: [],
      isCustom: true,
      parentId,
      createdAt: Date.now(),
      order
    };

    setCustomChapters((prev) => {
      const withPatchedOrders =
        siblingOrderPatch.size > 0
          ? prev.map((item) => {
              const nextOrder = siblingOrderPatch.get(item.id);
              if (typeof nextOrder !== 'number') return item;
              if (typeof item.order === 'number' && Math.abs(item.order - nextOrder) <= 1e-6) {
                return item;
              }
              return { ...item, order: nextOrder };
            })
          : prev;
      return [...withPatchedOrders, chapterNode];
    });
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
                pageIndex,
                topRatio,
                rects,
                isChapterTitle: true,
                chapterId: chapterNode.id,
                chapterNodeId: chapterNode.id,
                parentId,
                order
              }
            : item
        )
      );
      setActiveHighlightId(activeHighlightId);
    } else {
      const builtChapterHighlight = buildHighlightFromSelection('rgba(107, 114, 128, 0.35)', {
        isChapterTitle: true,
        chapterId: chapterNode.id,
        chapterNodeId: chapterNode.id,
        parentId,
        pageIndex,
        topRatio,
        rects,
        order
      });
      if (builtChapterHighlight) {
        const chapterHighlight = builtChapterHighlight.highlight;
        setHighlights((prev) => [...prev, chapterHighlight]);
        setActiveHighlightId(chapterHighlight.id);
      }
    }
  };

  const removeCustomChapter = useCallback((chapterId: string, options?: { keepSelection?: boolean }) => {
    const target = customChapterNodeMap.get(chapterId);
    if (!target) return;
    detachCustomChapter(chapterId);
    if (!options?.keepSelection) {
      clearSelection();
    }
  }, [clearSelection, customChapterNodeMap, detachCustomChapter]);

  const removeHighlightNote = useCallback((note: HighlightItem) => {
    if (note.isChapterTitle) return;
    setHighlights((prev) => prev.filter((item) => item.id !== note.id));
    setExpandedHighlightIds((prev) => {
      if (!prev.has(note.id)) return prev;
      const next = new Set(prev);
      next.delete(note.id);
      return next;
    });
    setActiveHighlightId((prev) => (prev === note.id ? null : prev));
    if (mindmapEditing?.targetId === note.id) {
      setMindmapEditing(null);
      setMindmapEditValue('');
    }
  }, [mindmapEditing?.targetId, setHighlights]);

  const clearFormatting = () => {
    clearNativeSelection();
    if (activeHighlightId) {
      const activeHighlight = activeHighlightId ? annotationById.get(activeHighlightId) || null : null;
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

  const isPointInNativeSelection = useCallback((clientX: number, clientY: number) => {
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
  }, []);

  const updateSelectionFromWindow = useCallback(() => {
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
  }, []);

  const getHighlightAtPoint = useCallback((clientX: number, clientY: number) => {
    for (const highlight of visibleHighlights) {
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
  }, [visibleHighlights]);

  const handleHighlightClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (typeof window !== 'undefined') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length) {
        return;
      }
    }
    if (isPointInNativeSelection(event.clientX, event.clientY)) {
      return;
    }
    const target = getHighlightAtPoint(event.clientX, event.clientY);
    if (!target) {
      clearSelection();
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
  }, [clearSelection, getHighlightAtPoint, isPointInNativeSelection]);

  const openMarginToolbar = useCallback((
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
  }, [viewMode]);

  useEffect(() => {
    if (!selectionText || !selectionRect) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && selectionToolbarRef.current?.contains(target)) return;
      if (target && questionPickerRef.current?.contains(target)) return;
      if (isPointInNativeSelection(event.clientX, event.clientY)) return;
      if (getHighlightAtPoint(event.clientX, event.clientY)) return;
      clearSelection();
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [selectionText, selectionRect, clearSelection, getHighlightAtPoint, isPointInNativeSelection]);

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

  const handleDocumentLoad = useCallback(async (doc: PDFDocumentProxy) => {
    pdfDocRef.current = doc;
    setNumPages(doc.numPages);
    try {
      const outline = await doc.getOutline();
      const tree = outline?.length ? await buildOutlineTree(doc, outline, '') : [];
      const rootNode: OutlineNode = {
        id: `outline-root-${paper.id}`,
        title: paper.title || 'Document',
        pageIndex: 0,
        topRatio: 0,
        items: tree,
        isRoot: true
      };
      setOutlineNodes((prev) => {
        const existingRootId = prev[0]?.id || rootNode.id;
        return [{ ...rootNode, id: existingRootId }];
      });
      setDocNodes((prevDocNodes) => {
        if (!Array.isArray(prevDocNodes) || !prevDocNodes.length) return prevDocNodes;
        const currentAnnotations = buildAnnotationsFromDocNodes(prevDocNodes);
        return buildDocNodesFromCurrentState(paper.id, [{ ...rootNode }], currentAnnotations);
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
    } finally {
      if (resumeAutosaveTimerRef.current) {
        window.clearTimeout(resumeAutosaveTimerRef.current);
      }
      // Wait one frame window for automatic outline/order normalization to settle.
      resumeAutosaveTimerRef.current = window.setTimeout(() => {
        suspendAutosaveRef.current = false;
        resumeAutosaveTimerRef.current = null;
      }, 800);
    }
  }, [paper.id, paper.title]);

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
    clearMindmapTransientInteractionState();
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

  const beginNodeEditing = (payload: {
    nodeId: string;
    kind: 'note' | 'chapter';
    targetId: string;
    text: string;
  }) => {
    setMindmapEditing({
      nodeId: payload.nodeId,
      kind: payload.kind,
      targetId: payload.targetId
    });
    setMindmapEditValue(payload.text || '');
  };

  const handleTOCChapterDoubleClick = (
    item: MindMapNode,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    clearMindmapTransientInteractionState();
    if (Date.now() < tocSuppressClickUntilRef.current) return;
    if (tocDragChapterTriggeredRef.current) return;
    if (item.kind !== 'chapter') return;
    if (!customChapterIdSet.has(item.id)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveMindmapNodeId(item.id);
    beginNodeEditing({
      nodeId: item.id,
      kind: 'chapter',
      targetId: item.id,
      text: item.text || ''
    });
  };

  const handleTOCNoteDoubleClick = (
    note: HighlightItem,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    clearMindmapTransientInteractionState();
    if (Date.now() < tocSuppressClickUntilRef.current) return;
    if (tocDragNoteTriggeredRef.current) return;
    if (note.isChapterTitle) return;
    event.preventDefault();
    event.stopPropagation();
    const nodeId = `note-${note.id}`;
    setActiveMindmapNodeId(nodeId);
    beginNodeEditing({
      nodeId,
      kind: 'note',
      targetId: note.id,
      text: note.text || ''
    });
  };

  const cancelMindmapEdit = () => {
    setMindmapEditing(null);
    setMindmapEditValue('');
  };

  const commitMindmapEdit = (_node: MindMapNode | null, value: string) => {
    if (!mindmapEditing) return;
    const nextText = String(value || '').trim();
    if (!nextText) {
      cancelMindmapEdit();
      return;
    }
    if (mindmapEditing.kind === 'note') {
      const targetNote = annotationById.get(mindmapEditing.targetId) || null;
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
      const targetChapter = customChapterNodeMap.get(mindmapEditing.targetId) || null;
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

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    if (!mindmapEditing) return;
    const handlePointerDownOutsideEdit = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-toc-editing-node="true"]')) return;
      commitMindmapEdit(null, mindmapEditValue);
    };
    window.addEventListener('mousedown', handlePointerDownOutsideEdit, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDownOutsideEdit, true);
    };
  }, [viewMode, mindmapEditing, mindmapEditValue, commitMindmapEdit]);

  useEffect(() => {
    if (viewMode !== ReaderMode.PDF) return;
    if (!mindmapEditing) return;
    const handle = window.requestAnimationFrame(() => {
      if (!tocEditInputRef.current) return;
      tocEditInputRef.current.focus();
      const cursor = tocEditInputRef.current.value.length;
      tocEditInputRef.current.setSelectionRange(cursor, cursor);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [viewMode, mindmapEditing?.nodeId]);

  const getMindmapDraftText = (nodeId: string, fallback: string) => {
    if (mindmapEditing?.nodeId === nodeId) return mindmapEditValue;
    return fallback;
  };

  const handleMindmapAddChild = (node: MindMapNode) => {
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
      if (viewMode === ReaderMode.MIND_MAP) {
        setMindmapEditing({ nodeId: `note-${newNote.id}`, kind: 'note', targetId: newNote.id });
        setMindmapEditValue(newNote.text);
      }
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
    setCollapsedMindmapIds((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
    if (viewMode === ReaderMode.MIND_MAP) {
      setMindmapEditing({ nodeId: newId, kind: 'chapter', targetId: newId });
      setMindmapEditValue(chapterNode.title);
    }
  };

  const handleMindmapAddSibling = (node: MindMapNode) => {
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
      if (viewMode === ReaderMode.MIND_MAP) {
        setMindmapEditing({ nodeId: `note-${newNote.id}`, kind: 'note', targetId: newNote.id });
        setMindmapEditValue(newNote.text);
      }
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
      setCollapsedMindmapIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      if (viewMode === ReaderMode.MIND_MAP) {
        setMindmapEditing({ nodeId: newId, kind: 'chapter', targetId: newId });
        setMindmapEditValue(chapterNode.title);
      }
    }
  };

  const handleMindmapDelete = (node: MindMapNode) => {
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
      const chapterTitle = chapterAnnotationByNodeId.get(node.id) || null;
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
    setHighlights((prev) =>
      prev.map((item) =>
        item.id === note.id
          ? {
              ...item,
              text: title,
              isChapterTitle: true,
              chapterId: newId,
              chapterNodeId: newId,
              parentId,
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

  const resolveMindmapDropTarget = (
    clientX: number,
    clientY: number,
    draggingNodeId?: string | null
  ): MindmapDropTarget | null => {
    const resolveKind = (value: string | null) => {
      if (value === 'note' || value === 'chapter' || value === 'root') return value;
      return null;
    };
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    let nodeEl = target?.closest?.('[data-mindmap-id]') as HTMLElement | null;
    if (!nodeEl) {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('[data-mindmap-id][data-mindmap-kind]')
      );
      let nearest: { el: HTMLElement; score: number } | null = null;
      candidates.forEach((el) => {
        const idValue = el.getAttribute('data-mindmap-id');
        const kindValue = el.getAttribute('data-mindmap-kind');
        const kind = resolveKind(kindValue);
        if (!idValue || !kind) return;
        if (draggingNodeId && idValue === draggingNodeId) return;
        const rect = el.getBoundingClientRect();
        const dx =
          clientX < rect.left
            ? rect.left - clientX
            : clientX > rect.right
              ? clientX - rect.right
              : 0;
        const dy =
          clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
              ? clientY - rect.bottom
              : 0;
        if (dx > Math.max(96, rect.width * 1.2)) return;
        const score = dy * 3 + dx;
        if (!nearest || score < nearest.score) {
          nearest = { el, score };
        }
      });
      if (nearest && nearest.score <= 240) {
        nodeEl = nearest.el;
      }
    }
    if (!nodeEl) return null;
    const id = nodeEl.getAttribute('data-mindmap-id');
    const kindValue = nodeEl.getAttribute('data-mindmap-kind');
    if (!id || !kindValue) return null;
    if (draggingNodeId && id === draggingNodeId) return null;
    const kind = resolveKind(kindValue);
    if (!kind) return null;
    const rect = nodeEl.getBoundingClientRect();
    let position: MindmapDropPosition;
    if (clientY < rect.top) {
      position = 'before';
    } else if (clientY > rect.bottom) {
      position = 'after';
    } else {
      if (kind === 'chapter' || kind === 'root') {
        const topThreshold = rect.top + rect.height * 0.25;
        const bottomThreshold = rect.bottom - rect.height * 0.25;
        if (clientY <= topThreshold) {
          position = 'before';
        } else if (clientY >= bottomThreshold) {
          position = 'after';
        } else {
          position = 'inside';
        }
      } else {
        position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      }
    }
    return { id, kind, position };
  };

  const parseMindmapNoteNodeId = (mindmapNodeId: string) => {
    if (!mindmapNodeId.startsWith('note-')) return null;
    return mindmapNodeId.slice(5);
  };

  const formatMindmapDropTarget = (target: MindmapDropTarget | null) =>
    target ? `${target.id} | ${target.position}` : 'none';

  const resolveDropTargetEntry = (target: MindmapDropTarget | null): MindmapDropEntry | null => {
    if (!target) return null;
    if (target.kind === 'root') {
      return {
        parentId: null,
        kind: 'node',
        id: target.id
      };
    }
    if (target.kind === 'note') {
      const noteId = parseMindmapNoteNodeId(target.id);
      if (!noteId) return null;
      const note = noteAnnotations.find((item) => item.id === noteId) || null;
      if (!note) return null;
      return {
        parentId: note.chapterId || null,
        kind: 'note',
        id: note.id
      };
    }
    const resolvedParentId =
      mindmapParentMapRef.current.get(target.id) ?? tocParentMapRef.current.get(target.id) ?? null;
    return {
      parentId: resolvedParentId,
      kind: 'node',
      id: target.id
    };
  };

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!draggingNoteId) return undefined;
    if (dragNoteTimerRef.current) {
      window.clearTimeout(dragNoteTimerRef.current);
      dragNoteTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const dragInfo = dragNoteRef.current;
      const draggingNodeId = dragInfo ? `note-${dragInfo.id}` : null;
      const nextTarget = resolveMindmapDropTarget(event.clientX, event.clientY, draggingNodeId);
      dragOverMindmapTargetRef.current = nextTarget;
      setDragOverMindmapTarget(nextTarget);
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
    const handleUp = (event: MouseEvent) => {
      const dragInfo = dragNoteRef.current;
      const draggingNodeId = dragInfo ? `note-${dragInfo.id}` : null;
      const target = resolveMindmapDropTarget(event.clientX, event.clientY, draggingNodeId);
      setMindmapDropLastHit(formatMindmapDropTarget(target));
      setMindmapDropOrderDebug('');
      const targetEntry = resolveDropTargetEntry(target);
      if (dragInfo && target && targetEntry) {
        const draggedParentId = dragInfo.chapterId || null;
        const isSameParent =
          target.position !== 'inside' &&
          draggedParentId === targetEntry.parentId &&
          !(targetEntry.kind === 'note' && targetEntry.id === dragInfo.id);

        if (isSameParent && targetEntry.parentId) {
          const nextOrder =
            target.position === 'before'
              ? getCombinedOrderValueBefore(targetEntry.parentId, targetEntry.kind, targetEntry.id)
              : getCombinedOrderValueAfter(targetEntry.parentId, targetEntry.kind, targetEntry.id);
          setHighlights((prev) =>
            prev.map((item) =>
              item.id === dragInfo.id ? { ...item, order: nextOrder } : item
            )
          );
        } else {
          const nextParentId =
            target.position === 'inside'
              ? target.kind === 'chapter' || target.kind === 'root'
                ? target.id
                : targetEntry.parentId
              : targetEntry.parentId;
          if (nextParentId && nextParentId !== dragInfo.chapterId) {
            const nextOrder =
              target.position === 'before' && targetEntry.parentId === nextParentId
                ? getCombinedOrderValueBefore(nextParentId, targetEntry.kind, targetEntry.id)
                : target.position === 'after' && targetEntry.parentId === nextParentId
                  ? getCombinedOrderValueAfter(nextParentId, targetEntry.kind, targetEntry.id)
                  : getCombinedOrderValue(nextParentId);
            setHighlights((prev) =>
              prev.map((item) =>
                item.id === dragInfo.id
                  ? { ...item, chapterId: nextParentId, order: nextOrder }
                  : item
              )
            );
            setExpandedTOC((prev) => {
              const next = new Set(prev);
              next.add(nextParentId);
              return next;
            });
          }
        }
      }
      setDraggingNoteId(null);
      setDragOverMindmapTarget(null);
      dragOverMindmapTargetRef.current = null;
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
  }, [draggingNoteId, viewMode]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const handleUp = () => {
      if (draggingNoteId || draggingChapterId) return;
      if (dragNoteTimerRef.current) {
        window.clearTimeout(dragNoteTimerRef.current);
        dragNoteTimerRef.current = null;
      }
      dragNoteTriggeredRef.current = false;
      dragNoteRef.current = null;
      setDragOverMindmapTarget(null);
      dragOverMindmapTargetRef.current = null;
      setDragGhost(null);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [draggingNoteId, draggingChapterId, viewMode]);

  const handleMindmapNodeMouseDown = (
    node: MindMapNode,
    event: React.MouseEvent<SVGGElement>
  ) => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (event.button !== 0) return;
    if (event.detail >= 2) {
      clearMindmapTransientInteractionState();
      return;
    }
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
      if (!customChapterIdSet.has(node.id)) return;
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
    if (event.button !== 0) return;
    if (event.detail >= 2) {
      clearMindmapTransientInteractionState();
      return;
    }
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
    item: MindMapNode,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0) return;
    if (event.detail >= 2) {
      clearMindmapTransientInteractionState();
      return;
    }
    if (item.kind !== 'chapter') return;
    if (!customChapterIdSet.has(item.id)) return;
    event.preventDefault();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    tocDragChapterTriggeredRef.current = false;
    tocDragChapterRef.current = {
        id: item.id,
        parentId: tocParentMapRef.current.get(item.id) || null,
        text: item.text,
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
        text: item.text,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      });
    }, 220);
  };

  useEffect(() => {
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
  }, [draggingTocNoteId, dragOverTocId]);

  useEffect(() => {
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
          setCustomChapters((prev) =>
            prev.map((item) =>
              item.id === dragInfo.id ? { ...item, parentId: targetId } : item
            )
          );
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
  }, [draggingTocChapterId, dragOverTocId]);

  useEffect(() => {
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
  }, [draggingTocNoteId, draggingTocChapterId]);

  const getChapterFallbackOrderMap = (nodes: OutlineNode[]) => {
    const map = new Map<string, number>();
    let index = 0;
    nodes.forEach((node) => {
      if (typeof node.order === 'number') return;
      map.set(node.id, index);
      index += 1;
    });
    return map;
  };

  const sortChapterNodes = (nodes: OutlineNode[]) => {
    const fallbackOrder = getChapterFallbackOrderMap(nodes);
    const indexed = nodes.map((node, index) => ({ node, index }));
    indexed.sort((a, b) => {
      const aHasOrder = typeof a.node.order === 'number';
      const bHasOrder = typeof b.node.order === 'number';
      const aFallback = fallbackOrder.get(a.node.id) ?? a.index;
      const bFallback = fallbackOrder.get(b.node.id) ?? b.index;
      const aOrder = aHasOrder ? (a.node.order as number) : aFallback;
      const bOrder = bHasOrder ? (b.node.order as number) : bFallback;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (!aHasOrder && !bHasOrder) {
        if (aFallback !== bFallback) return aFallback - bFallback;
      }
      return a.index - b.index;
    });
    return indexed.map((entry) => entry.node);
  };

  const sortOutlineNodes = (nodes: OutlineNode[]) => {
    if (!nodes.length) return;
    nodes.splice(0, nodes.length, ...sortChapterNodes(nodes));
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

  const outlineDisplay = useMemo(
    () =>
      buildOutlineFromDocNodes(paper.id, docNodesForRender, {
        id: outlineRootId,
        title: baseOutline[0]?.title || paper.title || 'Document',
        pageIndex: baseOutline[0]?.pageIndex ?? 0,
        topRatio: baseOutline[0]?.topRatio ?? 0
      }),
    [paper.id, docNodesForRender, outlineRootId, baseOutline, paper.title]
  );
  outlineDisplayRef.current = outlineDisplay;

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

  const outlineNodeMap = useMemo(() => {
    const map = new Map<string, OutlineNode>();
    const walk = (nodes: OutlineNode[]) => {
      nodes.forEach((node) => {
        map.set(node.id, node);
        if (node.items?.length) walk(node.items);
      });
    };
    walk(outlineDisplay);
    return map;
  }, [outlineDisplay]);

  const getHighlightSortKey = (item: HighlightItem) => {
    const rects = item.rects || [];
    const pageIndex =
      item.pageIndex ?? (rects.length ? rects[0].pageIndex : 0);
    const top = rects.length ? Math.min(...rects.map((rect) => rect.y ?? 0)) : 0;
    const left = rects.length ? Math.min(...rects.map((rect) => rect.x ?? 0)) : 0;
    return { pageIndex, top, left };
  };

  type CombinedEntry = {
    key: string;
    kind: 'node' | 'note';
    id: string;
    order?: number;
    pageIndex: number;
    top: number;
    left: number;
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
        left: typeof node.leftRatio === 'number' ? node.leftRatio : 0,
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
          left: typeof key.left === 'number' ? key.left : 0,
          index: index + nodes.length
        };
      })
    ];
    return entries;
  };

  const getCombinedFallbackOrder = (entries: CombinedEntry[]) => {
    const fallbackSorted = entries
      .filter((entry) => typeof entry.order !== 'number')
      .slice()
      .sort((a, b) => {
        if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
        if (a.top !== b.top) return a.top - b.top;
        if (a.left !== b.left) return a.left - b.left;
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
      const aFallback = fallbackOrder.get(a.key) ?? a.index;
      const bFallback = fallbackOrder.get(b.key) ?? b.index;
      const aOrder =
        typeof a.order === 'number' ? a.order : aFallback;
      const bOrder =
        typeof b.order === 'number' ? b.order : bFallback;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return aFallback - bFallback;
    });
  };

  const formatCombinedOrderEntries = (entries: CombinedEntry[]) =>
    entries
      .map((entry) => {
        const orderText =
          typeof entry.order === 'number' ? entry.order.toFixed(4) : '-';
        return `${entry.kind === 'node' ? 'n' : 'h'}:${entry.id}(${orderText})`;
      })
      .join(' > ');

  const getCombinedOrderDebugSnapshot = (
    parentId: string,
    patch?: {
      chapterId: string;
      fromParentId: string;
      toParentId: string;
      order: number;
    }
  ) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    if (!parentNode) return '(parent-missing)';
    let nodes = [...(parentNode.items || [])];
    if (patch) {
      if (patch.fromParentId === parentId && patch.toParentId !== parentId) {
        nodes = nodes.filter((item) => item.id !== patch.chapterId);
      }
      if (patch.toParentId === parentId) {
        const currentIndex = nodes.findIndex((item) => item.id === patch.chapterId);
        if (currentIndex >= 0) {
          nodes = nodes.map((item) =>
            item.id === patch.chapterId ? { ...item, order: patch.order } : item
          );
        } else {
          const sourceNode =
            findOutlineNodeById(outlineDisplay, patch.chapterId) ||
            (customChapterNodeMap.has(patch.chapterId)
              ? {
                  id: patch.chapterId,
                  title: customChapterNodeMap.get(patch.chapterId)?.text || '',
                  pageIndex: customChapterNodeMap.get(patch.chapterId)?.pageIndex ?? null,
                  topRatio: customChapterNodeMap.get(patch.chapterId)?.topRatio ?? null,
                  items: [],
                  isCustom: true,
                  parentId: customChapterNodeMap.get(patch.chapterId)?.parentId ?? null,
                  createdAt: Number(customChapterNodeMap.get(patch.chapterId)?.updatedAt || Date.now()),
                  order: customChapterNodeMap.get(patch.chapterId)?.order
                }
              : null) ||
            null;
          if (sourceNode) {
            nodes = [...nodes, { ...sourceNode, order: patch.order }];
          }
        }
      }
    }
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId);
    const entries = sortCombinedEntries(buildCombinedEntries(nodes, notes));
    return formatCombinedOrderEntries(entries);
  };

  const getCombinedOrderValue = (parentId: string) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId);
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) return 0;
    const fallbackOrder = getCombinedFallbackOrder(entries);
    let maxOrder = -Infinity;
    entries.forEach((entry) => {
      const value =
        typeof entry.order === 'number' ? entry.order : (fallbackOrder.get(entry.key) ?? entry.index);
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
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId);
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) return undefined;
    const fallbackOrder = getCombinedFallbackOrder(entries);
    const targetKey = `${kind}:${id}`;
    const target = entries.find((entry) => entry.key === targetKey);
    if (!target) return undefined;
    if (typeof target.order === 'number') return target.order;
    return fallbackOrder.get(target.key) ?? target.index;
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
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId);
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
        : (fallbackOrder.get(current.key) ?? current.index);
    const next = sorted[index + 1];
    if (!next) return currentOrder + 1;
    const nextOrder =
      typeof next.order === 'number'
        ? next.order
        : (fallbackOrder.get(next.key) ?? next.index);
    if (nextOrder - currentOrder > 1e-6) {
      return (currentOrder + nextOrder) / 2;
    }
    return currentOrder + 0.0001;
  };

  const getCombinedOrderValueBefore = (
    parentId: string,
    kind: 'node' | 'note',
    id: string
  ) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId);
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
        : (fallbackOrder.get(current.key) ?? current.index);
    const prev = sorted[index - 1];
    if (!prev) return currentOrder - 1;
    const prevOrder =
      typeof prev.order === 'number'
        ? prev.order
        : (fallbackOrder.get(prev.key) ?? prev.index);
    if (currentOrder - prevOrder > 1e-6) {
      return (currentOrder + prevOrder) / 2;
    }
    return currentOrder - 0.0001;
  };

  const compareNodePosition = (
    left: { pageIndex?: number | null; topRatio?: number | null; leftRatio?: number | null; id?: string },
    right: { pageIndex?: number | null; topRatio?: number | null; leftRatio?: number | null; id?: string }
  ) => {
    const leftPage =
      typeof left.pageIndex === 'number' ? left.pageIndex : Number.POSITIVE_INFINITY;
    const rightPage =
      typeof right.pageIndex === 'number' ? right.pageIndex : Number.POSITIVE_INFINITY;
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftTop = typeof left.topRatio === 'number' ? left.topRatio : 0;
    const rightTop = typeof right.topRatio === 'number' ? right.topRatio : 0;
    if (leftTop !== rightTop) return leftTop - rightTop;
    const leftX = typeof left.leftRatio === 'number' ? left.leftRatio : 0;
    const rightX = typeof right.leftRatio === 'number' ? right.leftRatio : 0;
    if (leftX !== rightX) return leftX - rightX;
    return String(left.id || '').localeCompare(String(right.id || ''), undefined, {
      sensitivity: 'base'
    });
  };

  const getNodeOrderValueByChildPositionSlot = (
    parentId: string,
    pageIndex: number,
    topRatio: number,
    leftRatio = 0
  ): { order: number; siblingOrderPatch: Map<string, number> } => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    const notes = noteAnnotations.filter((item) => item.chapterId === parentId && !item.isChapterTitle);
    const entries = buildCombinedEntries(nodes, notes);
    if (!entries.length) {
      return { order: 0, siblingOrderPatch: new Map<string, number>() };
    }
    const sortedByPosition = entries
      .slice()
      .sort((a, b) =>
        compareNodePosition(
          { pageIndex: a.pageIndex, topRatio: a.top, leftRatio: a.left, id: a.key },
          { pageIndex: b.pageIndex, topRatio: b.top, leftRatio: b.left, id: b.key }
        )
      );
    const normalizedOrderByKey = new Map<string, number>();
    let lastOrder = Number.NEGATIVE_INFINITY;
    sortedByPosition.forEach((entry, index) => {
      const baseOrder =
        typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index;
      const nextOrder =
        !Number.isFinite(lastOrder) || baseOrder > lastOrder + 1e-6 ? baseOrder : lastOrder + 1;
      normalizedOrderByKey.set(entry.key, nextOrder);
      lastOrder = nextOrder;
    });

    const siblingOrderPatch = new Map<string, number>();
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    sortedByPosition.forEach((entry) => {
      if (entry.kind !== 'node') return;
      const node = nodeById.get(entry.id);
      if (!node?.isCustom) return;
      const normalized = normalizedOrderByKey.get(entry.key);
      if (typeof normalized !== 'number') return;
      if (typeof node.order !== 'number' || Math.abs(node.order - normalized) > 1e-6) {
        siblingOrderPatch.set(entry.id, normalized);
      }
    });

    const target = { pageIndex, topRatio, leftRatio, id: 'target' };
    const insertIndex = sortedByPosition.findIndex(
      (entry) =>
        compareNodePosition(
          {
            pageIndex: entry.pageIndex,
            topRatio: entry.top,
            leftRatio: entry.left,
            id: entry.key
          },
          target
        ) > 0
    );
    const prevEntry =
      insertIndex < 0 ? sortedByPosition[sortedByPosition.length - 1] : sortedByPosition[insertIndex - 1];
    const nextEntry = insertIndex < 0 ? null : sortedByPosition[insertIndex] || null;
    const prevOrder = prevEntry ? normalizedOrderByKey.get(prevEntry.key) : undefined;
    const nextOrder = nextEntry ? normalizedOrderByKey.get(nextEntry.key) : undefined;

    if (typeof prevOrder === 'number' && typeof nextOrder === 'number') {
      if (nextOrder - prevOrder > 1e-6) {
        return { order: (prevOrder + nextOrder) / 2, siblingOrderPatch };
      }
      return { order: prevOrder + 0.5, siblingOrderPatch };
    }
    if (typeof prevOrder === 'number') {
      return { order: prevOrder + 1, siblingOrderPatch };
    }
    if (typeof nextOrder === 'number') {
      return { order: nextOrder - 1, siblingOrderPatch };
    }
    return { order: 0, siblingOrderPatch };
  };

  const getNodeOrderValueAfter = (parentId: string, nodeId: string) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    if (!nodes.length) return 0;
    const fallbackOrder = getChapterFallbackOrderMap(nodes);
    const sorted = sortChapterNodes(nodes);
    const index = sorted.findIndex((node) => node.id === nodeId);
    if (index === -1) return getCombinedOrderValue(parentId);
    const current = sorted[index];
    const currentBase = fallbackOrder.get(current.id) ?? index;
    const currentOrder =
      typeof current.order === 'number' ? current.order : currentBase;
    const next = sorted[index + 1];
    if (!next) return currentOrder + 1;
    const nextBase = fallbackOrder.get(next.id) ?? currentOrder + 1;
    const nextOrder =
      typeof next.order === 'number' ? next.order : nextBase;
    if (nextOrder - currentOrder > 1e-6) {
      return (currentOrder + nextOrder) / 2;
    }
    return currentOrder + 0.0001;
  };

  const getNodeOrderValueBefore = (parentId: string, nodeId: string) => {
    const parentNode =
      parentId === outlineRootId
        ? outlineDisplay[0] || null
        : findOutlineNodeById(outlineDisplay, parentId);
    const nodes = parentNode?.items || [];
    if (!nodes.length) return 0;
    const fallbackOrder = getChapterFallbackOrderMap(nodes);
    const sorted = sortChapterNodes(nodes);
    const index = sorted.findIndex((node) => node.id === nodeId);
    if (index === -1) return getCombinedOrderValue(parentId);
    const current = sorted[index];
    const currentBase = fallbackOrder.get(current.id) ?? index;
    const currentOrder =
      typeof current.order === 'number' ? current.order : currentBase;
    const prev = sorted[index - 1];
    if (!prev) return currentOrder - 1;
    const prevBase = fallbackOrder.get(prev.id) ?? currentOrder - 1;
    const prevOrder =
      typeof prev.order === 'number' ? prev.order : prevBase;
    if (currentOrder - prevOrder > 1e-6) {
      return (currentOrder + prevOrder) / 2;
    }
    return currentOrder - 0.0001;
  };

  const highlightsByChapter = useMemo(
    () => buildHighlightsByChapterFromDocNodes(docNodesForRender),
    [docNodesForRender]
  );

  const showPdfMarginOutline = false;
  const docNodeHighlightChapterIdSet = useMemo(
    () =>
      new Set(
        docNodesForRender
          .filter((item) => item.kind === 'highlight_chapter' && !item.isDeleted)
          .map((item) => item.id)
      ),
    [docNodesForRender]
  );
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
        const isNormalChapter = child.isCustom && !docNodeHighlightChapterIdSet.has(child.id);
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
        const isNormalChapter = child.isCustom && !docNodeHighlightChapterIdSet.has(child.id);
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
        if (!child || !child.isCustom || docNodeHighlightChapterIdSet.has(child.id)) return;
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
  }, [outlineDisplay, highlightsByChapter, viewMode, expandedTOC, expandedHighlightIds, docNodeHighlightChapterIdSet]);

  const highlightsByQuestion = useMemo(() => {
    const map = new Map<string, HighlightItem[]>();
    noteAnnotations.forEach((item) => {
      const ids = Array.isArray(item.questionIds) ? item.questionIds : [];
      ids.forEach((id) => {
        if (!id) return;
        const list = map.get(id) || [];
        list.push(item);
        map.set(id, list);
      });
    });
    return map;
  }, [noteAnnotations]);

  const mindmapStateV2ForSave = useMemo(
    () => buildMindmapStateV2FromOutline(outlineDisplay[0] || null),
    [outlineDisplay]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.library) return;
    if (!paper?.id) return;
    if (!paperStateLoadedRef.current) return;
    if (isCloudSyncing) return;
    if (saveStateTimerRef.current) {
      window.clearTimeout(saveStateTimerRef.current);
    }
    saveStateTimerRef.current = window.setTimeout(() => {
      const nextQuestionsState = buildNextVersionedState(
        questionsStateRef.current,
        normalizeQuestionsPayload(questions)
      );
      const nextMindmapState = buildNextVersionedState(
        mindmapStateV2StateRef.current,
        normalizeMindmapStateForSync(mindmapStateV2ForSave)
      );
      const nextAiConversationsState = buildNextVersionedState(
        aiConversationsStateRef.current,
        normalizeAiConversationPayload(chatThreads, activeChatId)
      );
      questionsStateRef.current = nextQuestionsState;
      mindmapStateV2StateRef.current = nextMindmapState;
      aiConversationsStateRef.current = nextAiConversationsState;
      const nextStatePayload = {
        annotations,
        mindmapStateV2: nextMindmapState.value,
        mindmapStateV2State: nextMindmapState,
        questions: nextQuestionsState.value,
        questionsState: nextQuestionsState,
        aiConversations: nextAiConversationsState.value.threads,
        activeChatId: nextAiConversationsState.value.activeChatId,
        aiConversationsState: nextAiConversationsState,
        updatedAt: Date.now()
      };
      const nextComparable = buildPaperStateAutosaveComparable(nextStatePayload);
      if (suspendAutosaveRef.current) {
        // During open/load normalization, keep baseline in sync but never write local state.
        lastAutosaveComparableRef.current = nextComparable;
        return;
      }
      if (!lastAutosaveComparableRef.current) {
        // Prime baseline on initial load/cloud refresh without creating local dirty state.
        lastAutosaveComparableRef.current = nextComparable;
        return;
      }
      if (lastAutosaveComparableRef.current === nextComparable) {
        return;
      }
      void window.electronAPI?.library?.savePaperState?.(paper.id, nextStatePayload).then((result: any) => {
        if (result?.ok !== false) {
          lastAutosaveComparableRef.current = nextComparable;
        }
      });
    }, 400);
    return () => {
      if (saveStateTimerRef.current) {
        window.clearTimeout(saveStateTimerRef.current);
      }
    };
  }, [
    paper?.id,
    annotations,
    mindmapStateV2ForSave,
    questions,
    chatThreads,
    activeChatId,
    isCloudSyncing
  ]);

  const buildMindmapRoot = useCallback((): MindMapNode | null => {
    if (!outlineDisplay.length) return null;
    const rootNode = outlineDisplay[0];

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
        isNormalChapter: Boolean(node.isCustom && !docNodeHighlightChapterIdSet.has(node.id)),
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
  }, [outlineDisplay, highlightsByChapter, docNodeHighlightChapterIdSet]);

  const mindmapRoot = useMemo(() => buildMindmapRoot(), [buildMindmapRoot]);

  const mindmapNodeMap = useMemo(() => {
    if (!mindmapRoot) return new Map<string, MindMapNode>();
    const map = new Map<string, MindMapNode>();
    const walk = (node: MindMapNode) => {
      map.set(node.id, node);
      node.children?.forEach((child) => walk(child));
    };
    walk(mindmapRoot);
    return map;
  }, [mindmapRoot]);

  useEffect(() => {
    if (!mindmapRoot) {
      setActiveMindmapNodeId(null);
      return;
    }
    if (activeMindmapNodeId && mindmapNodeMap.has(activeMindmapNodeId)) return;
    setActiveMindmapNodeId(mindmapRoot.id);
  }, [mindmapRoot, mindmapNodeMap, activeMindmapNodeId]);

  const mindmapParentMap = useMemo(() => {
    if (!mindmapRoot) return new Map<string, string | null>();
    const map = new Map<string, string | null>();
    const walk = (node: MindMapNode, parentId: string | null) => {
      map.set(node.id, parentId);
      node.children?.forEach((child) => walk(child, node.id));
    };
    walk(mindmapRoot, null);
    return map;
  }, [mindmapRoot]);

  useEffect(() => {
    mindmapParentMapRef.current = mindmapParentMap;
  }, [mindmapParentMap]);

  const customChapterIdSet = useMemo(() => {
    return new Set(
      docNodesForRender
        .filter(
          (node) =>
            (node.kind === 'normal_chapter' || node.kind === 'highlight_chapter') &&
            !node.isDeleted
        )
        .map((node) => node.id)
    );
  }, [docNodesForRender]);

  const highlightChapterIdSet = useMemo(() => new Set(docNodeHighlightChapterIdSet), [docNodeHighlightChapterIdSet]);

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
    noteAnnotations.forEach((item) => {
      if (!item.chapterId || item.isChapterTitle) return;
      const list = notesByParent.get(item.chapterId) || [];
      list.push(item);
      notesByParent.set(item.chapterId, list);
    });
    const customIdSet = customChapterIdSet;
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
  }, [outlineDisplay, noteAnnotations, customChapterIdSet]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    if (!draggingChapterId) return undefined;
    if (dragChapterTimerRef.current) {
      window.clearTimeout(dragChapterTimerRef.current);
      dragChapterTimerRef.current = null;
    }
    const handleMove = (event: MouseEvent) => {
      const dragInfo = dragChapterRef.current;
      const draggingNodeId = dragInfo ? dragInfo.id : null;
      const nextTarget = resolveMindmapDropTarget(event.clientX, event.clientY, draggingNodeId);
      dragOverMindmapTargetRef.current = nextTarget;
      setDragOverMindmapTarget(nextTarget);
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
    const handleUp = (event: MouseEvent) => {
      const dragInfo = dragChapterRef.current;
      const draggingNodeId = dragInfo ? dragInfo.id : null;
      const target = resolveMindmapDropTarget(event.clientX, event.clientY, draggingNodeId);
      setMindmapDropLastHit(formatMindmapDropTarget(target));
      const targetEntry = resolveDropTargetEntry(target);
      if (dragInfo && target && targetEntry) {
        const draggedParentId = dragInfo.parentId || outlineRootId;
        const isSameParent =
          target.position !== 'inside' &&
          draggedParentId === targetEntry.parentId &&
          !(targetEntry.kind === 'node' && targetEntry.id === dragInfo.id);
        const draggedIsCustom = customChapterIdSet.has(dragInfo.id);

        if (isSameParent && draggedIsCustom && targetEntry.parentId) {
          const nextOrder =
            target.position === 'before'
              ? getCombinedOrderValueBefore(targetEntry.parentId, targetEntry.kind, targetEntry.id)
              : getCombinedOrderValueAfter(targetEntry.parentId, targetEntry.kind, targetEntry.id);
          const fromParentId = dragInfo.parentId || outlineRootId;
          const beforeSnapshot = getCombinedOrderDebugSnapshot(targetEntry.parentId);
          const afterSnapshot = getCombinedOrderDebugSnapshot(targetEntry.parentId, {
            chapterId: dragInfo.id,
            fromParentId,
            toParentId: targetEntry.parentId,
            order: nextOrder
          });
          setMindmapDropOrderDebug(
            `parent:${targetEntry.parentId}\nnext:${nextOrder.toFixed(4)}\nbefore:${beforeSnapshot}\nafter:${afterSnapshot}`
          );
          setCustomChapters((prev) =>
            prev.map((item) =>
              item.id === dragInfo.id ? { ...item, order: nextOrder } : item
            )
          );
        } else {
          const nextParentId =
            target.position === 'inside'
              ? target.kind === 'chapter' || target.kind === 'root'
                ? target.id
                : targetEntry.parentId
              : targetEntry.parentId;
          if (!nextParentId || nextParentId === dragInfo.id) {
            // no-op
          } else {
          const isDescendant = (() => {
            let current = nextParentId;
            while (current) {
              if (current === dragInfo.id) return true;
              current = mindmapParentMap.get(current) || null;
            }
            return false;
          })();
          if (!isDescendant) {
              if (draggedIsCustom) {
                const nextOrder =
                  target.position === 'before' && targetEntry.parentId === nextParentId
                    ? getCombinedOrderValueBefore(nextParentId, targetEntry.kind, targetEntry.id)
                    : target.position === 'after' && targetEntry.parentId === nextParentId
                      ? getCombinedOrderValueAfter(nextParentId, targetEntry.kind, targetEntry.id)
                      : getCombinedOrderValue(nextParentId);
                const fromParentId = dragInfo.parentId || outlineRootId;
                const beforeSnapshot = getCombinedOrderDebugSnapshot(nextParentId);
                const afterSnapshot = getCombinedOrderDebugSnapshot(nextParentId, {
                  chapterId: dragInfo.id,
                  fromParentId,
                  toParentId: nextParentId,
                  order: nextOrder
                });
                setMindmapDropOrderDebug(
                  `parent:${nextParentId}\nnext:${nextOrder.toFixed(4)}\nbefore:${beforeSnapshot}\nafter:${afterSnapshot}`
                );
                setCustomChapters((prev) =>
                  prev.map((item) =>
                    item.id === dragInfo.id
                      ? { ...item, parentId: nextParentId, order: nextOrder }
                      : item
                  )
                );
              }
            }
          }
        }
      }
      setDraggingChapterId(null);
      setDragOverMindmapTarget(null);
      dragOverMindmapTargetRef.current = null;
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
  }, [draggingChapterId, mindmapParentMap, customChapterIdSet, customChapterNodeMap, viewMode]);

  useEffect(() => {
    if (questionPicker.open && (!selectionRect || !selectionText)) {
      setQuestionPicker({ open: false, highlightId: null, selectionInfo: null, selectionText: '' });
    }
  }, [questionPicker.open, selectionRect, selectionText]);

  useEffect(() => {
    if (viewMode !== ReaderMode.MIND_MAP) return;
    const handleUp = () => {
      if (draggingChapterId || draggingNoteId) return;
      if (dragChapterTimerRef.current) {
        window.clearTimeout(dragChapterTimerRef.current);
        dragChapterTimerRef.current = null;
      }
      dragChapterTriggeredRef.current = false;
      dragChapterRef.current = null;
      setDragOverMindmapTarget(null);
      dragOverMindmapTargetRef.current = null;
      setDragGhost(null);
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, [draggingChapterId, draggingNoteId, viewMode]);

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
    visibleHighlights.forEach((highlight) => {
      highlight.rects.forEach((rect) => {
        const list = map.get(rect.pageIndex) || [];
        list.push({ rect, color: highlight.color, id: highlight.id });
        map.set(rect.pageIndex, list);
      });
    });
    return map;
  }, [visibleHighlights]);

  const pdfDocumentContent = useMemo(() => {
    if (pdfFileForRender) {
      return (
        <div className="min-h-full flex justify-center py-6 px-4">
          <Document
            file={pdfFileForRender}
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
                  onRenderTextLayerError={(error) => {
                    if (String((error as any)?.name || '') === 'AbortException') return;
                    console.error('PDF text layer render error:', error);
                  }}
                />
                {highlightRectsByPage.get(index)?.length ? (
                  <div className="absolute inset-0 pointer-events-none">
                    {highlightRectsByPage.get(index)!.map((item, rectIndex) => {
                      const isActive = item.id === activeHighlightId;
                      const swatch = HIGHLIGHT_COLORS.find((color) => color.fill === item.color)?.swatch;
                      const borderColor = isActive ? swatch || toSolidColor(item.color) : '';
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
      );
    }
    if (paper.filePath) {
      return (
        <div className="min-h-full flex items-center justify-center text-sm text-gray-400">
          正在加载PDF…
        </div>
      );
    }
    return (
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
              <p className="mt-4">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
                exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
              </p>
              <p className="mt-4">
                Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu
                fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa
                qui officia deserunt mollit anim id est laborum.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }, [
    pdfFileForRender,
    handleDocumentLoad,
    numPages,
    pdfZoom,
    highlightRectsByPage,
    activeHighlightId,
    showPdfMarginOutline,
    pdfMarginChildrenByPage,
    openMarginToolbar,
    expandedHighlightIds,
    removeCustomChapter,
    isManualHighlight,
    removeHighlightNote,
    paper.filePath,
    paper.title,
    paper.author,
    paper.date,
    paper.summary,
    paper.content
  ]);

  const selectionOverlay = useMemo(() => {
    if (typeof document === 'undefined' || viewMode !== ReaderMode.PDF) return null;
    const hasToolbar = Boolean(selectionRect && selectionText);
    const hasQuestionPicker = Boolean(questionPicker.open && questionPickerStyle);
    if (!hasToolbar && !hasQuestionPicker) return null;
    return createPortal(
      <>
        {hasToolbar ? (
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
                        <span className="w-3 h-3 rounded-sm" style={{ background: color.swatch }} />
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
        {hasQuestionPicker ? (
          <div
            ref={questionPickerRef}
            className="fixed z-30"
            style={questionPickerStyle || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-2">
              <div className="text-[11px] font-semibold text-gray-500 mb-1">关联到阅读问题</div>
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
      </>,
      document.body
    );
  }, [
    viewMode,
    selectionRect,
    selectionText,
    toolbarStyle,
    questionPicker.open,
    questionPickerStyle,
    translationResult,
    questions,
    addHighlight,
    createCustomChapterFromSelection,
    clearFormatting,
    openQuestionPicker,
    attachHighlightToQuestion
  ]);

  useEffect(() => {
    let cancelled = false;
    const shouldResetForPaperChange = loadedPaperIdRef.current !== paper.id;
    loadedPaperIdRef.current = paper.id;
    paperStateLoadedRef.current = false;
    lastAutosaveComparableRef.current = '';
    suspendAutosaveRef.current = true;
    if (resumeAutosaveTimerRef.current) {
      window.clearTimeout(resumeAutosaveTimerRef.current);
      resumeAutosaveTimerRef.current = null;
    }
    if (shouldResetForPaperChange) {
      setOutlineNodes([]);
      setExpandedTOC(new Set());
      setNumPages(0);
      setDocNodes([]);
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
      setDragOverMindmapTarget(null);
      setMindmapDropLastHit('none');
      setMindmapDropOrderDebug('');
      dragOverMindmapTargetRef.current = null;
      setDraggingTocNoteId(null);
      setDraggingTocChapterId(null);
      setDragOverTocId(null);
      setDragGhost(null);
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
      questionsStateRef.current = null;
      mindmapStateV2StateRef.current = null;
      aiConversationsStateRef.current = null;
    }
    const loadState = async () => {
      if (typeof window === 'undefined' || !window.electronAPI?.library) {
        setQuestions([]);
        questionsStateRef.current = null;
        mindmapStateV2StateRef.current = null;
        aiConversationsStateRef.current = null;
        paperStateLoadedRef.current = true;
        return;
      }
      const saved = await window.electronAPI.library.getPaperState?.(paper.id);
      if (cancelled) return;
      if (saved && typeof saved === 'object') {
        const normalizedAnnotations = dedupeChapterAnnotations(getAnnotationsFromSavedState(saved).map((item) => {
          const ids = Array.isArray(item.questionIds) ? item.questionIds.filter(Boolean) : [];
          const legacyId = (item as any).questionId;
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
        }));
        const migratedAnnotations = migrateLegacyStateAnnotations(saved, paper.id, normalizedAnnotations);
        const savedDocNodes = Array.isArray((saved as any).docNodes)
          ? ((saved as any).docNodes as DocNode[])
          : [];
        setDocNodes(
          !migratedAnnotations.length && savedDocNodes.length
            ? savedDocNodes
            : buildDocNodesFromCurrentState(
                paper.id,
                baseOutlineRef.current.length ? baseOutlineRef.current : fallbackOutline,
                migratedAnnotations
              )
        );
        const savedQuestionsState = getSavedQuestionsState(saved);
        const savedMindmapState = getSavedMindmapState(saved);
        const savedAiConversationsState = getSavedAiConversationState(saved);
        questionsStateRef.current = savedQuestionsState;
        mindmapStateV2StateRef.current = savedMindmapState;
        aiConversationsStateRef.current = savedAiConversationsState;
        setQuestions(savedQuestionsState?.value || []);
        setChatThreads(savedAiConversationsState?.value?.threads || []);
        setActiveChatId(savedAiConversationsState?.value?.activeChatId || null);
        paperStateLoadedRef.current = true;
        return;
      }
      setQuestions([]);
      setChatThreads([]);
      setActiveChatId(null);
      questionsStateRef.current = null;
      mindmapStateV2StateRef.current = null;
      aiConversationsStateRef.current = null;
      paperStateLoadedRef.current = true;
    };
    loadState();
    return () => {
      cancelled = true;
      if (resumeAutosaveTimerRef.current) {
        window.clearTimeout(resumeAutosaveTimerRef.current);
        resumeAutosaveTimerRef.current = null;
      }
    };
  }, [paper.id, cloudRefreshToken]);

  useEffect(() => {
    applyTitleToOutlineRoot(paper.title || 'Document');
    applyTitleToDocRoot(paper.title || 'Document');
  }, [paper.title, applyTitleToOutlineRoot, applyTitleToDocRoot]);

  // --- Components ---

  const TOCNode: React.FC<{ item: MindMapNode, level: number }> = ({ item, level }) => {
    const outlineItem = outlineNodeMap.get(item.id) || null;
    const childItems = item.children || [];
    const hasChildren = childItems.length > 0;
    const isExpanded = expandedTOC.has(item.id);
    const isNormalChapterInToc = item.kind === 'chapter' && Boolean(item.isNormalChapter);
    const isDropTarget =
      dragOverTocId === item.id && (Boolean(draggingTocNoteId) || Boolean(draggingTocChapterId));
    const isActiveChapter = activeMindmapNodeId === item.id;
    const isEditingChapter = item.kind === 'chapter' && mindmapEditing?.nodeId === item.id;
    const editingChapterNode = isEditingChapter ? mindmapNodeMap.get(item.id) || null : null;
    const chapterLabel = item.text || '';

    return (
      <div className="select-none">
        <div 
          data-toc-id={item.id}
          data-toc-kind="chapter"
          className={`group flex py-1 px-2 cursor-pointer rounded my-0.5 ${
            isEditingChapter ? 'items-start' : 'items-center'
          } ${
            isNormalChapterInToc ? 'text-xs text-gray-600 italic' : 'text-sm text-gray-700'
          } ${
            isEditingChapter
              ? ''
              : isDropTarget
              ? 'bg-gray-200'
              : isActiveChapter
                ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                : 'hover:bg-gray-200'
          }`}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onMouseDown={(event) => {
            if (isEditingChapter) return;
            handleTOCChapterMouseDown(item, event);
          }}
          onClick={() => {
            if (isEditingChapter) return;
            if (Date.now() < tocSuppressClickUntilRef.current) return;
            if (tocDragChapterTriggeredRef.current) return;
            if (mindmapNodeMap.has(item.id)) {
              setActiveMindmapNodeId(item.id);
            }
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
          onDoubleClick={(event) => {
            handleTOCChapterDoubleClick(item, event);
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
           {isEditingChapter ? (
             <div
               data-toc-editing-node="true"
               className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white shadow-lg p-2"
               onMouseDown={(event) => {
                 event.preventDefault();
                 event.stopPropagation();
               }}
               onClick={(event) => event.stopPropagation()}
             >
               <div className="flex items-center gap-1.5">
                 {HIGHLIGHT_COLORS.map((color) => {
                   const isActive = editingChapterNode?.color === color.fill;
                   return (
                     <button
                       key={`${item.id}-${color.id}`}
                       type="button"
                       data-toc-editing-node="true"
                       className="w-5 h-5 rounded-md border border-gray-300 flex items-center justify-center"
                       onMouseDown={(event) => {
                         event.preventDefault();
                         event.stopPropagation();
                       }}
                       onClick={() => {
                         if (!editingChapterNode) return;
                         handleMindmapToolbarColor(editingChapterNode, color.fill);
                       }}
                       style={{
                         boxShadow: isActive ? `0 0 0 2px ${color.swatch}` : 'none',
                         borderColor: isActive ? 'transparent' : undefined
                       }}
                     >
                       <span
                         className="w-3 h-3 rounded-sm"
                         style={{ background: color.swatch }}
                       />
                     </button>
                   );
                 })}
                 <button
                   type="button"
                   data-toc-editing-node="true"
                   className="w-5 h-5 rounded-md border border-gray-300 text-[10px] font-semibold text-gray-700 hover:bg-gray-50"
                   onMouseDown={(event) => {
                     event.preventDefault();
                     event.stopPropagation();
                   }}
                   onClick={() => {
                     if (!editingChapterNode) return;
                     handleMindmapToolbarMakeChapter(editingChapterNode);
                   }}
                   style={{
                     boxShadow: editingChapterNode?.kind === 'chapter' ? '0 0 0 2px #9ca3af' : 'none',
                     borderColor: editingChapterNode?.kind === 'chapter' ? 'transparent' : undefined
                   }}
                 >
                   T
                 </button>
                 <button
                   type="button"
                   data-toc-editing-node="true"
                   className="w-5 h-5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                   onMouseDown={(event) => {
                     event.preventDefault();
                     event.stopPropagation();
                   }}
                   onClick={() => {
                     if (!editingChapterNode) return;
                     handleMindmapToolbarClear(editingChapterNode);
                   }}
                 >
                   <Ban size={12} />
                 </button>
               </div>
               <textarea
                 ref={tocEditInputRef}
                 data-toc-editing-node="true"
                 value={mindmapEditValue}
                 onChange={(event) => setMindmapEditValue(event.target.value)}
                 onMouseDown={(event) => event.stopPropagation()}
                 onClick={(event) => event.stopPropagation()}
                 onDoubleClick={(event) => event.stopPropagation()}
                 onKeyDown={(event) => {
                   if (event.key === 'Escape') {
                     event.preventDefault();
                     cancelMindmapEdit();
                   }
                   if (event.key === 'Enter' && !event.shiftKey) {
                     event.preventDefault();
                     commitMindmapEdit(null, event.currentTarget.value);
                   }
                 }}
                 onBlur={(event) => {
                   commitMindmapEdit(null, event.currentTarget.value);
                 }}
                 className="mt-2 w-full min-h-[44px] text-[11px] text-gray-600 bg-gray-50 rounded-md p-2 resize-none outline-none focus:ring-2 focus:ring-blue-200"
               />
             </div>
           ) : (
             <span className="truncate flex-1">{chapterLabel}</span>
           )}
           {outlineItem?.isCustom && !isEditingChapter ? (
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
                {childItems.map((child) => {
                  if (child.kind === 'note') {
                    const note = child.note as HighlightItem | undefined;
                    if (!note) return null;
                    const noteNodeId = `note-${note.id}`;
                    const isExpanded = expandedHighlightIds.has(note.id);
                    const isActiveNote = activeMindmapNodeId === noteNodeId;
                    const isEditingNote = mindmapEditing?.nodeId === noteNodeId;
                    const editingNoteNode = isEditingNote
                      ? mindmapNodeMap.get(noteNodeId) || null
                      : null;
                    const isPlainNote = isManualHighlight(note) && !note.isChapterTitle;
                    const clampStyle = isExpanded
                      ? { whiteSpace: 'pre-wrap' as const }
                      : {
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        };

                    return (
                      <div key={note.id} style={{ paddingLeft: `${level * 12 + 14}px` }}>
                        <div className="relative group">
                          {isEditingNote ? (
                            <div
                              data-toc-editing-node="true"
                              className="w-full rounded-lg border border-gray-200 bg-white shadow-lg p-2"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <div
                                data-toc-editing-node="true"
                                className="w-full flex items-center gap-1.5"
                              >
                                {HIGHLIGHT_COLORS.map((color) => {
                                  const isActive = editingNoteNode?.color === color.fill;
                                  return (
                                    <button
                                      key={`${note.id}-${color.id}`}
                                      type="button"
                                      data-toc-editing-node="true"
                                      className="w-5 h-5 rounded-md border border-gray-300 flex items-center justify-center"
                                      onMouseDown={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                      }}
                                      onClick={() => {
                                        if (!editingNoteNode) return;
                                        handleMindmapToolbarColor(editingNoteNode, color.fill);
                                      }}
                                      style={{
                                        boxShadow: isActive ? `0 0 0 2px ${color.swatch}` : 'none',
                                        borderColor: isActive ? 'transparent' : undefined
                                      }}
                                    >
                                      <span
                                        className="w-3 h-3 rounded-sm"
                                        style={{ background: color.swatch }}
                                      />
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  data-toc-editing-node="true"
                                  className="w-5 h-5 rounded-md border border-gray-300 text-[10px] font-semibold text-gray-700 hover:bg-gray-50"
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                  onClick={() => {
                                    if (!editingNoteNode) return;
                                    handleMindmapToolbarMakeChapter(editingNoteNode);
                                  }}
                                  style={{
                                    boxShadow:
                                      editingNoteNode?.kind === 'chapter' ? '0 0 0 2px #9ca3af' : 'none',
                                    borderColor:
                                      editingNoteNode?.kind === 'chapter' ? 'transparent' : undefined
                                  }}
                                >
                                  T
                                </button>
                                <button
                                  type="button"
                                  data-toc-editing-node="true"
                                  className="w-5 h-5 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 flex items-center justify-center"
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                  onClick={() => {
                                    if (!editingNoteNode) return;
                                    handleMindmapToolbarClear(editingNoteNode);
                                  }}
                                >
                                  <Ban size={12} />
                                </button>
                              </div>
                              <textarea
                                ref={tocEditInputRef}
                                data-toc-editing-node="true"
                                value={mindmapEditValue}
                                onChange={(event) => setMindmapEditValue(event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                                onDoubleClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelMindmapEdit();
                                  }
                                  if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    commitMindmapEdit(null, event.currentTarget.value);
                                  }
                                }}
                                onBlur={(event) => {
                                  commitMindmapEdit(null, event.currentTarget.value);
                                }}
                                className="mt-2 w-full min-h-[44px] text-[11px] text-gray-600 bg-gray-50 rounded-md p-2 resize-none outline-none focus:ring-2 focus:ring-blue-200"
                                style={{
                                  fontStyle: isPlainNote ? 'italic' : 'normal'
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-toc-id={note.id}
                              data-toc-kind="note"
                              onMouseDown={(event) => {
                                handleTOCNoteMouseDown(note, event);
                              }}
                              onClick={() => {
                                if (Date.now() < tocSuppressClickUntilRef.current) return;
                                if (tocDragNoteTriggeredRef.current) return;
                                setActiveMindmapNodeId(noteNodeId);
                                jumpToHighlight(note);
                              }}
                              onDoubleClick={(event) => {
                                handleTOCNoteDoubleClick(note, event);
                              }}
                              className={`w-full text-left text-xs rounded px-2 py-1 pr-6 border border-transparent flex flex-col items-start ${
                                note.isChapterTitle ? 'font-semibold text-gray-800' : 'text-gray-600'
                              } ${
                                isActiveNote
                                  ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                                  : 'hover:bg-gray-200 group-hover:bg-gray-200'
                              } ${isPlainNote ? 'italic' : ''}`}
                              style={{
                                borderLeft: `3px solid ${note.color}`
                              }}
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
                          )}
                          {!note.isChapterTitle && !isEditingNote ? (
                            <button
                              type="button"
                              onMouseDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                removeHighlightNote(note);
                              }}
                              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
                              aria-label="删除笔记"
                            >
                              <X size={12} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  }
                  if (child.kind === 'chapter') {
                    return <TOCNode key={child.id} item={child} level={level + 1} />;
                  }
                  return null;
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const toolbarMindmapNode = activeMindmapNodeId
    ? mindmapNodeMap.get(activeMindmapNodeId) || mindmapRoot
    : mindmapRoot;
  const canToolbarAddChild =
    Boolean(toolbarMindmapNode) && (viewMode !== ReaderMode.MIND_MAP || !mindmapEditing);
  const canToolbarAddSibling =
    Boolean(toolbarMindmapNode && toolbarMindmapNode.kind !== 'root') &&
    (viewMode !== ReaderMode.MIND_MAP || !mindmapEditing);

  return (
    <div ref={containerRef} className="flex h-[calc(100vh-40px)] bg-white overflow-hidden">
      
      {/* SECTION D: Document Outline (Sidebar) */}
      <div
        className="bg-[#f9f9f9] border-r border-gray-200 flex flex-col"
        style={{ width: leftWidth }}
      >
        <div className="h-10 flex items-center gap-2 border-b border-gray-200 bg-white px-3">
          <Tooltip label="章节目录">
            <button
              type="button"
              className="flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all bg-gray-200 text-gray-900 hover:bg-gray-200"
              aria-label="章节目录"
            >
              <List size={14} />
            </button>
          </Tooltip>
          <div className="ml-auto flex items-center gap-1">
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
        </div>
        <div className="flex-1 min-h-0 relative">
          <div className="h-full overflow-y-auto p-2">
            {mindmapRoot ? <TOCNode item={mindmapRoot} level={0} /> : null}
          </div>
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
        <div className="h-10 bg-white/80 backdrop-blur border-b border-gray-200 flex items-center gap-2 px-3 sticky top-0 z-10">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            <Tooltip label="PDF">
              <button
                onClick={() => switchViewMode(ReaderMode.PDF)}
                className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${
                  viewMode === ReaderMode.PDF
                    ? 'bg-gray-200 text-gray-900'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
                }`}
                aria-label="PDF"
              >
                <FileText size={14} />
              </button>
            </Tooltip>
            <Tooltip label="思维导图">
              <button
                onClick={() => switchViewMode(ReaderMode.MIND_MAP)}
                className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${
                  viewMode === ReaderMode.MIND_MAP
                    ? 'bg-gray-200 text-gray-900'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
                }`}
                aria-label="思维导图"
              >
                <Network size={14} />
              </button>
            </Tooltip>
          </div>
          <Tooltip label={isExportingMarkdown ? '导出中' : '导出 Markdown'}>
            <button
              type="button"
              onClick={handleExportMarkdown}
              disabled={isExportingMarkdown}
              className="p-1 rounded text-gray-600 hover:bg-gray-200 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="导出 Markdown"
            >
              {isExportingMarkdown ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <FileUp size={14} />
              )}
            </button>
          </Tooltip>
          {viewMode === ReaderMode.MIND_MAP ? (
            <div className="flex-1 flex justify-center items-center gap-2">
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
          {viewMode === ReaderMode.MIND_MAP ? (
            <div className="flex items-center gap-1 text-gray-600">
              <Tooltip label={isCloudSyncing ? '云同步中' : '云同步'}>
                <button
                  onClick={handleToolbarCloudSync}
                  disabled={isCloudSyncing}
                  className="p-1 rounded hover:bg-gray-200 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="云同步"
                >
                  {isCloudSyncing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <svg
                      className="h-[14px] w-[14px]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M7 18.25h10.5a3.75 3.75 0 0 0 .24-7.49A5.75 5.75 0 0 0 6.6 9.38 4 4 0 0 0 7 18.25Z" />
                    </svg>
                  )}
                </button>
              </Tooltip>
              <button
                onClick={() => setMindmapZoom((z) => Math.max(50, z - 10))}
                className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
                aria-label="缩小思维导图"
              >
                <ZoomOut size={14} />
              </button>
              <span className="text-xs w-8 text-center">{mindmapZoom}%</span>
              <button
                onClick={() => setMindmapZoom((z) => Math.min(200, z + 10))}
                className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
                aria-label="放大思维导图"
              >
                <ZoomIn size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-gray-600">
              <Tooltip label={isCloudSyncing ? '云同步中' : '云同步'}>
                <button
                  onClick={handleToolbarCloudSync}
                  disabled={isCloudSyncing}
                  className="p-1 rounded hover:bg-gray-200 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="云同步"
                >
                  {isCloudSyncing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <svg
                      className="h-[14px] w-[14px]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M7 18.25h10.5a3.75 3.75 0 0 0 .24-7.49A5.75 5.75 0 0 0 6.6 9.38 4 4 0 0 0 7 18.25Z" />
                    </svg>
                  )}
                </button>
              </Tooltip>
              <button
                onClick={() => setPdfZoom((z) => Math.max(50, z - 10))}
                className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
                aria-label="缩小PDF"
              >
                <ZoomOut size={14} />
              </button>
              <span className="text-xs w-8 text-center">{pdfZoom}%</span>
              <button
                onClick={() => setPdfZoom((z) => Math.min(200, z + 10))}
                className="p-1 rounded hover:bg-gray-200 hover:text-gray-900"
                aria-label="放大PDF"
              >
                <ZoomIn size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div
          className={`flex-1 min-w-0 overflow-hidden relative ${
            viewMode === ReaderMode.MIND_MAP ? '' : 'hidden'
          }`}
        >
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
                dropTarget={
                  dragOverMindmapTarget
                    ? {
                        id: dragOverMindmapTarget.id,
                        position: dragOverMindmapTarget.position
                      }
                    : null
                }
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
            {SHOW_MINDMAP_DROP_DEBUG ? (
              <div className="pointer-events-none absolute top-2 right-2 z-40 rounded-md bg-black/75 text-white text-[10px] leading-4 px-2 py-1 font-mono">
                <div>{`hit: ${formatMindmapDropTarget(dragOverMindmapTarget)}`}</div>
                <div>{`last: ${mindmapDropLastHit}`}</div>
                <div className="mt-1 max-w-[460px] whitespace-pre-wrap break-all text-[9px] leading-3">
                  {mindmapDropOrderDebug || 'order: -'}
                </div>
              </div>
            ) : null}
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
          </div>
          <div
            ref={contentAreaRef}
            className={`flex-1 min-w-0 overflow-auto relative ${
              viewMode === ReaderMode.PDF ? '' : 'hidden'
            }`}
            onMouseUp={updateSelectionFromWindow}
            onClick={handleHighlightClick}
            onScroll={handleContentScroll}
          >
            {pdfDocumentContent}
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
          <Tooltip label="文章信息" wrapperClassName="flex-1 h-full">
            <button 
               onClick={() => setActiveTab(AssistantTab.INFO)}
               className={`w-full h-full flex justify-center items-center border-b-2 transition-colors ${activeTab === AssistantTab.INFO ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-transparent text-gray-400 hover:text-gray-600 hover:bg-gray-200'}`}
            >
               <FileText size={16} />
            </button>
          </Tooltip>
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
                    <div className="text-gray-400 text-xs uppercase mb-1 flex items-center justify-between">
                      <span>标题</span>
                      {!isInfoTitleEditing ? (
                        <button
                          type="button"
                          onClick={handleStartTitleEdit}
                          disabled={isCloudSyncing}
                          className="p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label="编辑标题"
                        >
                          <Pencil size={12} />
                        </button>
                      ) : null}
                    </div>
                    {isInfoTitleEditing ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={infoTitleDraft}
                          onChange={(event) => {
                            setInfoTitleDraft(event.target.value);
                            if (infoTitleError) setInfoTitleError('');
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              handleCancelTitleEdit();
                              event.currentTarget.blur();
                            }
                          }}
                          onBlur={handleCommitTitleEdit}
                          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm font-medium text-gray-800 outline-none focus:ring-2 focus:ring-blue-200"
                          placeholder="输入文章标题"
                        />
                        {infoTitleError ? (
                          <div className="text-xs text-red-500">{infoTitleError}</div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="font-medium break-words">{paper.title || '-'}</div>
                    )}
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">作者</div>
                    <div>{paper.author || 'Unknown'}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">发布日期</div>
                    <div>{formatDateYmd(paper.date) || 'Unknown'}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">发布机构</div>
                    <div>{paper.publisher || 'Unknown'}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs uppercase mb-1">参考文献</div>
                    {Array.isArray(paper.references) && paper.references.length ? (
                      <div className="space-y-1">
                        {paper.referenceStats ? (
                          <div className="text-[11px] text-gray-500">
                            并集 {paper.referenceStats.intersectionCount} / OpenAlex{' '}
                            {paper.referenceStats.totalOpenAlex} / Semantic Scholar{' '}
                            {paper.referenceStats.totalSemanticScholar}
                            {typeof paper.referenceStats.finalCount === 'number'
                              ? ` / 最终 ${paper.referenceStats.finalCount}`
                              : ''}
                            {typeof paper.referenceStats.matchedCount === 'number'
                              ? ` / 匹配 ${paper.referenceStats.matchedCount}`
                              : ''}
                          </div>
                        ) : null}
                        <div className="max-h-44 overflow-y-auto rounded-md border border-gray-200 bg-white">
                          {paper.references.map((ref, index) => (
                            <div
                              key={ref.refId || `${ref.title}-${index}`}
                              className="px-2 py-1 text-xs text-gray-700 border-b border-gray-100 last:border-b-0 break-all"
                            >
                              {typeof ref.order === 'number' ? `${ref.order}. ` : `${index + 1}. `}
                              {ref.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">暂无参考文献数据</div>
                    )}
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

      {selectionOverlay}
    </div>
  );
};
