import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder as FolderIcon,
  FileText,
  Network,
  Plus,
  Pencil,
  X,
  ChevronRight,
  ChevronDown,
  Trash2,
  RotateCcw
} from 'lucide-react';
import { Tooltip } from './Tooltip';
import { Folder, Paper } from '../types';
import { SYSTEM_FOLDER_ALL_ID, SYSTEM_FOLDER_TRASH_ID } from '../constants';
import { pdfjs } from 'react-pdf';
import { MindMap, type MindMapLayout, type MindMapNode } from './MindMap';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const CHAPTER_START_TOLERANCE = 0.03;
const MAX_THUMBNAIL_CACHE = 100;

type OutlineNode = {
  id: string;
  title: string;
  pageIndex: number | null;
  topRatio: number | null;
  items: OutlineNode[];
  isRoot?: boolean;
  isCustom?: boolean;
  parentId?: string | null;
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
  source?: 'pdf' | 'manual';
  order?: number;
};

const isManualHighlight = (item: HighlightItem) => {
  if (item.source === 'manual') return true;
  if (item.source === 'pdf') return false;
  const rects = Array.isArray(item.rects) ? item.rects : [];
  if (!rects.length) return true;
  return rects.every((rect) => Number(rect.w || 0) === 0 && Number(rect.h || 0) === 0);
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

const findChapterForPosition = (
  pageIndex: number,
  topRatio: number,
  sourceList: OutlineNode[]
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

  sortOutlineNodes(rootItems);
  return rootItems;
};

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

const buildMindmapRoot = (
  outlineDisplay: OutlineNode[],
  highlights: HighlightItem[]
): MindMapNode | null => {
  if (!outlineDisplay.length) return null;
  const rootNode = outlineDisplay[0];
  const highlightChapterNodeIdSet = new Set<string>();
  highlights.forEach((item) => {
    if (!item.isChapterTitle) return;
    if (isManualHighlight(item)) return;
    const nodeId = item.chapterNodeId || item.chapterId;
    if (nodeId) highlightChapterNodeIdSet.add(nodeId);
  });
  const highlightsByChapter = new Map<string, HighlightItem[]>();
  highlights.forEach((item) => {
    if (!item.chapterId || item.isChapterTitle) return;
    const list = highlightsByChapter.get(item.chapterId) || [];
    list.push(item);
    highlightsByChapter.set(item.chapterId, list);
  });

  const buildNode = (node: OutlineNode): MindMapNode => {
    const childItems = node.items || [];
    const childNodes = childItems.map((child) => buildNode(child));
    const noteItems = highlightsByChapter.get(node.id) || [];
    const noteNodes: MindMapNode[] = noteItems.map((note) => ({
      id: `note-${note.id}`,
      text: note.text,
      translation: note.isChapterTitle || isManualHighlight(note) ? '' : note.translation || '',
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
    translation: note.isChapterTitle || isManualHighlight(note) ? '' : note.translation || '',
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
};

interface FolderItemProps {
  folder: Folder;
  level: number;
  expandedFolders: Set<string>;
  selectedFolderId: string | null;
  dragOverFolderId: string | null;
  editingFolderId: string | null;
  folderDraft: string;
  folderInputRef: React.RefObject<HTMLInputElement>;
  onToggleFolder: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onEditFolder: (folder: Folder) => void;
  onDeleteFolder: (id: string) => void;
  onDraftChange: (value: string) => void;
  onFinalizeEdit: (id: string) => void;
  onCancelEdit: () => void;
  onFolderDragOver: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onFolderDragLeave: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onFolderDrop: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
}

const FolderItem: React.FC<FolderItemProps> = ({
  folder,
  level,
  expandedFolders,
  selectedFolderId,
  dragOverFolderId,
  editingFolderId,
  folderDraft,
  folderInputRef,
  onToggleFolder,
  onSelectFolder,
  onAddChild,
  onEditFolder,
  onDeleteFolder,
  onDraftChange,
  onFinalizeEdit,
  onCancelEdit,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop
}) => {
  const isExpanded = expandedFolders.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const isDragOver = dragOverFolderId === folder.id;
  const isEditing = editingFolderId === folder.id;
  const isSystemFolder = folder.id === SYSTEM_FOLDER_ALL_ID || folder.id === SYSTEM_FOLDER_TRASH_ID;

  return (
    <div>
      <div
        data-folder-id={folder.id}
        onDragOver={(event) => onFolderDragOver(event, folder.id)}
        onDragLeave={(event) => onFolderDragLeave(event, folder.id)}
        onDrop={(event) => onFolderDrop(event, folder.id)}
        onClick={() => {
          if (isEditing) return;
          onSelectFolder(folder.id);
          if (!isExpanded) onToggleFolder(folder.id);
        }}
        className={`group flex items-center px-2 py-1.5 text-sm cursor-pointer rounded-md select-none mx-2 mb-0.5
          ${isSelected ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}
          ${isDragOver ? 'bg-blue-100 ring-1 ring-blue-300 text-gray-800' : ''}`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFolder(folder.id);
          }}
          className="mr-1 w-4 h-4 flex items-center justify-center hover:bg-gray-200 rounded"
        >
          {folder.children.length > 0 && (
            isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          )}
        </button>
        {folder.id === SYSTEM_FOLDER_TRASH_ID ? (
          <Trash2
            size={16}
            className={`mr-2 ${isSelected ? 'text-white' : 'text-gray-400'}`}
          />
        ) : (
          <FolderIcon
            size={16}
            className={`mr-2 ${isSelected ? 'text-white' : 'text-blue-400'}`}
            fill="currentColor"
            fillOpacity={0.2}
          />
        )}
        {isEditing ? (
          <input
            ref={folderInputRef}
            value={folderDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onFinalizeEdit(folder.id);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelEdit();
              }
            }}
            className="flex-1 min-w-0 text-sm text-gray-800 bg-white border border-gray-200 rounded px-2 py-0.5 outline-none focus:ring-2 focus:ring-blue-200 select-text"
          />
        ) : (
          <span className="truncate flex-1">{folder.name}</span>
        )}
        {!isEditing && !isSystemFolder ? (
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
            <Tooltip label="新建子文件夹">
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddChild(folder.id);
                }}
              >
                <Plus size={12} />
              </button>
            </Tooltip>
            <Tooltip label="编辑文件夹">
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                onClick={(event) => {
                  event.stopPropagation();
                  onEditFolder(folder);
                }}
              >
                <Pencil size={12} />
              </button>
            </Tooltip>
            <Tooltip label="删除文件夹">
              <button
                type="button"
                className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-red-500"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteFolder(folder.id);
                }}
              >
                <X size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
      {isExpanded && folder.children.map(child => (
        <FolderItem
          key={child.id}
          folder={child}
          level={level + 1}
          expandedFolders={expandedFolders}
          selectedFolderId={selectedFolderId}
          dragOverFolderId={dragOverFolderId}
          editingFolderId={editingFolderId}
          folderDraft={folderDraft}
          folderInputRef={folderInputRef}
          onToggleFolder={onToggleFolder}
          onSelectFolder={onSelectFolder}
          onAddChild={onAddChild}
          onEditFolder={onEditFolder}
          onDeleteFolder={onDeleteFolder}
          onDraftChange={onDraftChange}
          onFinalizeEdit={onFinalizeEdit}
          onCancelEdit={onCancelEdit}
          onFolderDragOver={onFolderDragOver}
          onFolderDragLeave={onFolderDragLeave}
          onFolderDrop={onFolderDrop}
        />
      ))}
    </div>
  );
};

interface LibraryViewProps {
  folders: Folder[];
  onFoldersChange: (folders: Folder[]) => void;
  papers: Paper[];
  onAddPdf: (file: File, folderId: string | null) => Promise<Paper | null>;
  onOpenPaper: (paper: Paper) => void;
  onEmptyTrash: () => void;
  onMovePapersToTrash: (folderIds: string[]) => void;
  onMovePaperToTrash: (paperId: string) => void;
  onDeletePaper: (paperId: string) => void;
  onMovePaperToFolder: (paperId: string, folderId: string) => void;
  onRestorePaper: (paperId: string) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  folders,
  onFoldersChange: _onFoldersChange,
  papers,
  onAddPdf,
  onOpenPaper,
  onEmptyTrash,
  onMovePapersToTrash,
  onMovePaperToTrash,
  onDeletePaper,
  onMovePaperToFolder,
  onRestorePaper
}) => {
  const MIN_LEFT_WIDTH = 180;
  const MIN_MIDDLE_WIDTH = 240;
  const MIN_RIGHT_WIDTH = 280;
  const RESIZE_HANDLE_WIDTH = 4;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(SYSTEM_FOLDER_ALL_ID);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [draggingPaperId, setDraggingPaperId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [selectedPaperThumbnail, setSelectedPaperThumbnail] = useState<string | null>(null);
  const [selectedThumbnailPaperId, setSelectedThumbnailPaperId] = useState<string | null>(null);
  const [thumbnailPageSize, setThumbnailPageSize] = useState<{ width: number; height: number } | null>(null);
  const [previewMode, setPreviewMode] = useState<'pdf' | 'mindmap'>('pdf');
  const [mindmapRoot, setMindmapRoot] = useState<MindMapNode | null>(null);
  const [mindmapLoading, setMindmapLoading] = useState(false);
  const [mindmapOffset, setMindmapOffset] = useState({ x: 0, y: 0 });
  const [collapsedMindmapIds, setCollapsedMindmapIds] = useState<Set<string>>(new Set());
  const [expandedMindmapNoteIds, setExpandedMindmapNoteIds] = useState<Set<string>>(new Set());
  const [activeMindmapNodeId, setActiveMindmapNodeId] = useState<string | null>(null);
  const mindmapCacheRef = useRef<
    Map<string, { root: MindMapNode | null; updatedAt: number | null }>
  >(new Map());
  const mindmapPanRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  );
  const mindmapLayoutRef = useRef<MindMapLayout | null>(null);
  const mindmapAnchorRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const mindmapZoomScale = 0.7;
  const [thumbnailViewportSize, setThumbnailViewportSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0
  });
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [leftWidth, setLeftWidth] = useState(256);
  const [middleWidth, setMiddleWidth] = useState(320);
  const [rightWidth, setRightWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    boundary: 'left-middle' | 'middle-right';
    startX: number;
    left: number;
    middle: number;
    right: number;
  } | null>(null);
  const hasInitWidthsRef = useRef(false);
  const thumbnailCacheRef = useRef<
    Map<string, { url: string; owned: boolean; pageSize?: { width: number; height: number } }>
  >(new Map());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root-1']));
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortField, setSortField] = useState<'title' | 'author' | 'publishedDate' | 'uploadedAt'>('uploadedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const folderEditRef = useRef<{ id: string | null; originalName: string; isNew: boolean }>({
    id: null,
    originalName: '',
    isNew: false
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const thumbnailViewportRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // --- Helpers ---
  const toggleFolder = (id: string) => {
    const next = new Set(expandedFolders);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedFolders(next);
  };

  const createFolder = (name: string, parentId: string | null) => ({
    id: `f-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    parentId,
    children: [] as Folder[]
  });

  const addChildFolder = (list: Folder[], parentId: string | null, folder: Folder) => {
    if (!parentId) return [...list, folder];
    return list.map((item) =>
      item.id === parentId
        ? { ...item, children: [...item.children, folder] }
        : { ...item, children: addChildFolder(item.children, parentId, folder) }
    );
  };

  const updateFolderName = (list: Folder[], targetId: string, name: string) =>
    list.map((item) =>
      item.id === targetId
        ? { ...item, name }
        : { ...item, children: updateFolderName(item.children, targetId, name) }
    );

  const collectFolderIds = (list: Folder[], targetId: string): Set<string> => {
    const ids = new Set<string>();
    const walk = (items: Folder[]) => {
      items.forEach((item) => {
        if (item.id === targetId) {
          const collect = (node: Folder) => {
            ids.add(node.id);
            node.children.forEach(collect);
          };
          collect(item);
        } else if (item.children.length) {
          walk(item.children);
        }
      });
    };
    walk(list);
    return ids;
  };

  const removeFolder = (list: Folder[], targetId: string) =>
    list
      .filter((item) => item.id !== targetId)
      .map((item) => ({ ...item, children: removeFolder(item.children, targetId) }));

  const startFolderEdit = (folder: Folder, isNew = false) => {
    folderEditRef.current = { id: folder.id, originalName: folder.name, isNew };
    setEditingFolderId(folder.id);
    setFolderDraft(folder.name);
  };

  const finalizeFolderEdit = (folderId: string | null) => {
    if (!folderId) return;
    const trimmed = folderDraft.trim();
    const { originalName, isNew } = folderEditRef.current || {};
    if (!trimmed) {
      if (isNew) {
        _onFoldersChange(removeFolder(folders, folderId));
      } else if (originalName) {
        _onFoldersChange(updateFolderName(folders, folderId, originalName));
      }
      setEditingFolderId(null);
      setFolderDraft('');
      folderEditRef.current = { id: null, originalName: '', isNew: false };
      return;
    }
    _onFoldersChange(updateFolderName(folders, folderId, trimmed));
    setEditingFolderId(null);
    setFolderDraft('');
    folderEditRef.current = { id: null, originalName: '', isNew: false };
  };

  const handleAddFolder = (parentId: string | null) => {
    if (parentId === SYSTEM_FOLDER_ALL_ID || parentId === SYSTEM_FOLDER_TRASH_ID) return;
    const nextFolder = createFolder('New Folder', parentId);
    _onFoldersChange(addChildFolder(folders, parentId, nextFolder));
    if (parentId) {
      setExpandedFolders((prev) => new Set(prev).add(parentId));
    }
    setSelectedFolderId(nextFolder.id);
    startFolderEdit(nextFolder, true);
  };

  const cancelFolderEdit = () => {
    setEditingFolderId(null);
    setFolderDraft('');
    folderEditRef.current = { id: null, originalName: '', isNew: false };
  };

  const handleDeleteFolder = (targetId: string) => {
    if (targetId === SYSTEM_FOLDER_ALL_ID || targetId === SYSTEM_FOLDER_TRASH_ID) return;
    const removed = collectFolderIds(folders, targetId);
    if (removed.size) {
      onMovePapersToTrash(Array.from(removed));
    }
    _onFoldersChange(removeFolder(folders, targetId));
    if (selectedFolderId && removed.has(selectedFolderId)) {
      setSelectedFolderId(null);
    }
  };

  const getFolderPapers = (folderId: string | null) => {
    if (!folderId) return [];
    if (folderId === SYSTEM_FOLDER_ALL_ID) {
      return papers.filter((paper) => paper.folderId !== SYSTEM_FOLDER_TRASH_ID);
    }
    if (folderId === SYSTEM_FOLDER_TRASH_ID) {
      return papers.filter((paper) => paper.folderId === SYSTEM_FOLDER_TRASH_ID);
    }
    return papers.filter(p => p.folderId === folderId);
  };

  const findFolderName = (list: Folder[], targetId: string | null): string | null => {
    if (!targetId) return null;
    for (const item of list) {
      if (item.id === targetId) return item.name;
      if (item.children.length) {
        const found = findFolderName(item.children, targetId);
        if (found) return found;
      }
    }
    return null;
  };

  const visiblePapers = selectedFolderId ? getFolderPapers(selectedFolderId) : [];
  const parseUploadTime = (paper: Paper) => {
    const match = /^p-(\d+)/.exec(paper.id || '');
    if (match?.[1]) {
      const ts = Number(match[1]);
      if (Number.isFinite(ts)) return ts;
    }
    return 0;
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

  const formatUploadDateYmd = (paper: Paper) => {
    const ts = parseUploadTime(paper);
    if (!ts) return '';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  };
  const parsePublishedTime = (paper: Paper) => {
    const value = String(paper.date || '').trim();
    if (!value) return 0;
    const zhMatch = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (zhMatch) {
      return Number(zhMatch[1]) * 10000 + Number(zhMatch[2]) * 100 + Number(zhMatch[3]);
    }
    const zhMonth = value.match(/(\d{4})年(\d{1,2})月/);
    if (zhMonth) {
      return Number(zhMonth[1]) * 10000 + Number(zhMonth[2]) * 100;
    }
    if (/^\d{4}$/.test(value)) return Number(value) * 10000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const sortedVisiblePapers = useMemo(() => {
    const list = [...visiblePapers];
    list.sort((a, b) => {
      let result = 0;
      if (sortField === 'title') {
        result = (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN', { sensitivity: 'base' });
      } else if (sortField === 'author') {
        result = (a.author || '').localeCompare(b.author || '', 'zh-Hans-CN', { sensitivity: 'base' });
      } else if (sortField === 'publishedDate') {
        result = parsePublishedTime(a) - parsePublishedTime(b);
      } else {
        result = parseUploadTime(a) - parseUploadTime(b);
      }
      if (result === 0) {
        result = (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN', { sensitivity: 'base' });
      }
      return sortOrder === 'asc' ? result : -result;
    });
    return list;
  }, [visiblePapers, sortField, sortOrder]);
  const selectedPaper = visiblePapers.find((paper) => paper.id === selectedPaperId) || null;
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

  const handleMindmapToggleCollapse = (node: MindMapNode) => {
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

  const handleMindMapNodeClick = (node: MindMapNode) => {
    setActiveMindmapNodeId(node.id);
  };

  useEffect(() => {
    const activeIds = new Set(papers.map((paper) => paper.id));
    thumbnailCacheRef.current.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        if (entry.owned) {
          URL.revokeObjectURL(entry.url);
        }
        thumbnailCacheRef.current.delete(id);
      }
    });
    mindmapCacheRef.current.forEach((_value, id) => {
      if (!activeIds.has(id)) {
        mindmapCacheRef.current.delete(id);
      }
    });
  }, [papers]);

  const getPdfDataForPaper = async (paper: Paper): Promise<ArrayBuffer | null> => {
    if (paper.fileData) return paper.fileData.slice(0);
    if (paper.filePath && typeof window !== 'undefined' && window.electronAPI?.library?.readPdf) {
      const response = await window.electronAPI.library.readPdf({
        paperId: paper.id,
        filePath: paper.filePath
      });
      if (response?.ok && response.data) {
        if (response.data instanceof ArrayBuffer) return response.data.slice(0);
        if (ArrayBuffer.isView(response.data)) {
          return response.data.buffer.slice(
            response.data.byteOffset,
            response.data.byteOffset + response.data.byteLength
          );
        }
        return response.data as ArrayBuffer;
      }
    }
    if (paper.fileUrl) {
      try {
        const fetched = await fetch(paper.fileUrl);
        return await fetched.arrayBuffer();
      } catch {
        return null;
      }
    }
    return null;
  };

  useEffect(() => {
    if (!sortMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-sort-menu-anchor]')) return;
      setSortMenuOpen(false);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!selectedPaperId) return;
    if (!selectedPaper) {
      setSelectedPaperId(null);
    }
  }, [selectedPaper, selectedPaperId]);
  const syncThumbnailViewportSize = () => {
    const element = thumbnailViewportRef.current;
    if (!element) return;
    const nextWidth = element.clientWidth;
    const nextHeight = element.clientHeight;
    setThumbnailViewportSize((prev) => {
      if (Math.abs(prev.width - nextWidth) < 2 && Math.abs(prev.height - nextHeight) < 2) {
        return prev;
      }
      return { width: nextWidth, height: nextHeight };
    });
  };

  const thumbnailScale = (() => {
    if (!thumbnailPageSize || !thumbnailViewportSize.width || !thumbnailViewportSize.height) return 1;
    const fitWidth = thumbnailViewportSize.width / thumbnailPageSize.width;
    const fitHeight = thumbnailViewportSize.height / thumbnailPageSize.height;
    const scale = Math.min(1, fitWidth, fitHeight);
    if (!Number.isFinite(scale) || scale <= 0) return 1;
    return Math.round(scale * 100) / 100;
  })();

  const clampWidths = (left: number, middle: number, right: number, totalWidth: number) => {
    const total = Math.max(0, totalWidth - RESIZE_HANDLE_WIDTH * 2);
    if (!total) {
      return { left, middle, right };
    }

    let nextLeft = Math.max(MIN_LEFT_WIDTH, left);
    let nextMiddle = Math.max(MIN_MIDDLE_WIDTH, middle);
    let nextRight = Math.max(MIN_RIGHT_WIDTH, right);

    const sum = nextLeft + nextMiddle + nextRight;
    if (sum > total) {
      let overflow = sum - total;
      const reduceRight = Math.min(overflow, nextRight - MIN_RIGHT_WIDTH);
      nextRight -= reduceRight;
      overflow -= reduceRight;
      const reduceMiddle = Math.min(overflow, nextMiddle - MIN_MIDDLE_WIDTH);
      nextMiddle -= reduceMiddle;
      overflow -= reduceMiddle;
      const reduceLeft = Math.min(overflow, nextLeft - MIN_LEFT_WIDTH);
      nextLeft -= reduceLeft;
      overflow -= reduceLeft;
      if (overflow > 0) {
        // If viewport is extremely small, allow right column to shrink below min last.
        nextRight = Math.max(120, nextRight - overflow);
      }
    } else if (sum < total) {
      nextRight += total - sum;
    }

    return { left: nextLeft, middle: nextMiddle, right: nextRight };
  };

  useEffect(() => {
    if (hasInitWidthsRef.current) return;
    let rafId = 0;
    const init = () => {
      const container = containerRef.current;
      if (!container) return;
      const total = container.clientWidth - RESIZE_HANDLE_WIDTH * 2;
      if (total <= 0) {
        rafId = window.requestAnimationFrame(init);
        return;
      }
      const initial = clampWidths(
        Math.round(total * 0.22),
        Math.round(total * 0.28),
        Math.round(total * 0.5),
        container.clientWidth
      );
      setLeftWidth(initial.left);
      setMiddleWidth(initial.middle);
      setRightWidth(initial.right);
      hasInitWidthsRef.current = true;
    };
    init();
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const container = containerRef.current;
      if (!container || !hasInitWidthsRef.current) return;
      const next = clampWidths(leftWidth, middleWidth, rightWidth, container.clientWidth);
      setLeftWidth(next.left);
      setMiddleWidth(next.middle);
      setRightWidth(next.right);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [leftWidth, middleWidth, rightWidth]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const drag = dragStateRef.current;
      const container = containerRef.current;
      if (!drag || !container) return;
      const total = container.clientWidth - RESIZE_HANDLE_WIDTH * 2;
      const delta = event.clientX - drag.startX;
      if (drag.boundary === 'left-middle') {
        const maxLeft = Math.max(MIN_LEFT_WIDTH, total - drag.right - MIN_MIDDLE_WIDTH);
        const nextLeft = Math.min(maxLeft, Math.max(MIN_LEFT_WIDTH, drag.left + delta));
        const nextMiddle = total - drag.right - nextLeft;
        setLeftWidth(nextLeft);
        setMiddleWidth(nextMiddle);
        setRightWidth(drag.right);
      } else {
        const maxMiddle = Math.max(MIN_MIDDLE_WIDTH, total - drag.left - MIN_RIGHT_WIDTH);
        const nextMiddle = Math.min(maxMiddle, Math.max(MIN_MIDDLE_WIDTH, drag.middle + delta));
        const nextRight = total - drag.left - nextMiddle;
        setLeftWidth(drag.left);
        setMiddleWidth(nextMiddle);
        setRightWidth(nextRight);
      }
    };
    const handleUp = () => {
      dragStateRef.current = null;
      setIsPanelResizing(false);
      syncThumbnailViewportSize();
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

  useEffect(() => {
    let cancelled = false;
    const setCachedThumbnail = (
      paperId: string,
      url: string,
      owned: boolean,
      pageSize?: { width: number; height: number } | null
    ) => {
      const map = thumbnailCacheRef.current;
      const prev = map.get(paperId);
      if (prev?.owned && prev.url !== url) {
        URL.revokeObjectURL(prev.url);
      }
      if (map.has(paperId)) {
        map.delete(paperId);
      }
      map.set(paperId, {
        url,
        owned,
        pageSize: pageSize || prev?.pageSize
      });
      while (map.size > MAX_THUMBNAIL_CACHE) {
        const oldest = map.keys().next().value as string | undefined;
        if (!oldest) break;
        const entry = map.get(oldest);
        if (entry?.owned) {
          URL.revokeObjectURL(entry.url);
        }
        map.delete(oldest);
      }
      setSelectedPaperThumbnail(url);
      setThumbnailPageSize(pageSize || prev?.pageSize || null);
      setSelectedThumbnailPaperId(paperId);
    };
    const setThumbnailFromBuffer = (paperId: string, buffer: ArrayBuffer) => {
      if (typeof document === 'undefined') return;
      const task = async () => {
        const loadingTask = pdfjs.getDocument({ data: buffer.slice(0) });
        const doc = await loadingTask.promise;
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          await doc.destroy();
          return;
        }
        const renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((result) => resolve(result), 'image/png')
        );
        await doc.destroy();
        if (cancelled) return;
        if (!blob) return;
        const blobUrl = URL.createObjectURL(blob);
        setCachedThumbnail(paperId, blobUrl, true, {
          width: viewport.width,
          height: viewport.height
        });
      };
      task().catch(() => null);
    };
    const loadThumbnail = async () => {
      if (previewMode !== 'pdf') return;
      if (!selectedPaper) {
        setSelectedPaperThumbnail(null);
        setThumbnailPageSize(null);
        setSelectedThumbnailPaperId(null);
        return;
      }
      const cached = thumbnailCacheRef.current.get(selectedPaper.id);
      if (cached) {
        if (thumbnailCacheRef.current.has(selectedPaper.id)) {
          thumbnailCacheRef.current.delete(selectedPaper.id);
          thumbnailCacheRef.current.set(selectedPaper.id, cached);
        }
        setSelectedPaperThumbnail(cached.url);
        setThumbnailPageSize(cached.pageSize || null);
        setSelectedThumbnailPaperId(selectedPaper.id);
        return;
      }
      setSelectedPaperThumbnail(null);
      setThumbnailPageSize(null);
      setSelectedThumbnailPaperId(null);
      if (selectedPaper.fileData) {
        setThumbnailFromBuffer(selectedPaper.id, selectedPaper.fileData.slice(0));
        return;
      }
      if (selectedPaper.fileUrl) {
        setCachedThumbnail(selectedPaper.id, selectedPaper.fileUrl, false);
        return;
      }
      if (
        selectedPaper.filePath &&
        typeof window !== 'undefined' &&
        window.electronAPI?.library?.readPdf
      ) {
        const response = await window.electronAPI.library.readPdf({
          paperId: selectedPaper.id,
          filePath: selectedPaper.filePath
        });
        if (cancelled || !response?.ok || !response.data) return;
        let arrayBuffer: ArrayBuffer;
        if (response.data instanceof ArrayBuffer) {
          arrayBuffer = response.data.slice(0);
        } else if (ArrayBuffer.isView(response.data)) {
          arrayBuffer = response.data.buffer.slice(
            response.data.byteOffset,
            response.data.byteOffset + response.data.byteLength
          );
        } else {
          arrayBuffer = response.data as ArrayBuffer;
        }
        if (!cancelled) {
          setThumbnailFromBuffer(selectedPaper.id, arrayBuffer);
        }
        return;
      }
      setSelectedPaperThumbnail(null);
      setThumbnailPageSize(null);
      setSelectedThumbnailPaperId(null);
    };
    loadThumbnail();
    return () => {
      cancelled = true;
    };
  }, [selectedPaper, previewMode]);

  useEffect(() => {
    let cancelled = false;
    const loadMindmap = async () => {
      if (previewMode !== 'mindmap' || !selectedPaper) {
        setMindmapRoot(null);
        setMindmapLoading(false);
        return;
      }
      setMindmapLoading(true);
      try {
        const state =
          typeof window !== 'undefined' && window.electronAPI?.library?.getPaperState
            ? await window.electronAPI.library.getPaperState(selectedPaper.id)
            : null;
        const stateUpdatedAt =
          typeof state?.updatedAt === 'number' ? state.updatedAt : null;
        if (mindmapCacheRef.current.has(selectedPaper.id)) {
          const cached = mindmapCacheRef.current.get(selectedPaper.id) || null;
          if (cached && cached.updatedAt === stateUpdatedAt) {
            setMindmapRoot(cached.root);
            setMindmapLoading(false);
            return;
          }
        }
        const pdfData = await getPdfDataForPaper(selectedPaper);
        if (!pdfData) {
          if (!cancelled) setMindmapRoot(null);
          return;
        }
        const loadingTask = pdfjs.getDocument({ data: pdfData.slice(0) });
        const doc = await loadingTask.promise;
        const outline = await doc.getOutline();
        const tree = outline?.length ? await buildOutlineTree(doc, outline, '') : [];
        const rootId = `outline-root-${selectedPaper.id}`;
        const rootNode: OutlineNode = {
          id: rootId,
          title: selectedPaper.title || 'Untitled',
          pageIndex: 0,
          topRatio: 0,
          items: tree,
          isRoot: true
        };
        const baseOutline = [rootNode];
        const baseFlat = getFlatOutlineByPosition(baseOutline);
        const customChapters = Array.isArray(state?.customChapters) ? state.customChapters : [];
        const chapterParentOverrides = state?.chapterParentOverrides || {};
        const highlights = Array.isArray(state?.highlights) ? state.highlights : [];
        const merged = mergeOutlineWithCustom(baseOutline, customChapters, baseFlat, rootId);
        const outlineDisplay = applyParentOverrides(merged, chapterParentOverrides);
        const root = buildMindmapRoot(outlineDisplay, highlights);
        if (!cancelled) {
          mindmapCacheRef.current.set(selectedPaper.id, { root, updatedAt: stateUpdatedAt });
          setMindmapRoot(root);
        }
        await doc.destroy();
      } catch (error) {
        if (!cancelled) {
          setMindmapRoot(null);
        }
      } finally {
        if (!cancelled) setMindmapLoading(false);
      }
    };
    loadMindmap();
    return () => {
      cancelled = true;
    };
  }, [previewMode, selectedPaper?.id, selectedPaper?.title]);

  useEffect(() => {
    setMindmapOffset({ x: 0, y: 0 });
    setCollapsedMindmapIds(new Set());
    setExpandedMindmapNoteIds(new Set());
    setActiveMindmapNodeId(null);
  }, [selectedPaper?.id, previewMode]);

  useEffect(() => {
    if (previewMode !== 'mindmap') return;
    if (!mindmapRoot) {
      setActiveMindmapNodeId(null);
      return;
    }
    if (activeMindmapNodeId && mindmapNodeMap.has(activeMindmapNodeId)) return;
    setActiveMindmapNodeId(mindmapRoot.id);
  }, [previewMode, mindmapRoot, mindmapNodeMap, activeMindmapNodeId]);

  useEffect(() => {
    if (!selectedPaper) {
      setThumbnailPageSize(null);
      return;
    }
    const cached = thumbnailCacheRef.current.get(selectedPaper.id);
    if (cached?.pageSize) {
      setThumbnailPageSize(cached.pageSize);
    } else {
      setThumbnailPageSize(null);
    }
  }, [selectedPaperThumbnail, selectedPaper?.id]);

  useEffect(() => {
    const element = thumbnailViewportRef.current;
    if (!element) return;
    let rafId = 0;
    const update = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        syncThumbnailViewportSize();
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [selectedPaper?.id, isPanelResizing]);

  const handleAddClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const created = await onAddPdf(file, selectedFolderId);
      if (created?.id) {
        setSelectedPaperId(created.id);
      }
    }
    event.target.value = '';
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (selectedFolderId === SYSTEM_FOLDER_TRASH_ID) return;
    const file = event.dataTransfer.files?.[0];
    if (file) {
      const created = await onAddPdf(file, selectedFolderId);
      if (created?.id) {
        setSelectedPaperId(created.id);
      }
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleFolderDragOver = (event: React.DragEvent<HTMLDivElement>, folderId: string) => {
    if (!draggingPaperId || folderId === SYSTEM_FOLDER_ALL_ID) return;
    event.preventDefault();
    setDragOverFolderId(folderId);
  };

  const handleFolderDragLeave = (_event: React.DragEvent<HTMLDivElement>, folderId: string) => {
    setDragOverFolderId((prev) => (prev === folderId ? null : prev));
  };

  const handleFolderDrop = (event: React.DragEvent<HTMLDivElement>, folderId: string) => {
    event.preventDefault();
    const paperIdFromData = event.dataTransfer.getData('application/x-mind-paper-paper-id');
    const paperId = paperIdFromData || draggingPaperId;
    setDragOverFolderId(null);
    setDraggingPaperId(null);
    if (!paperId || folderId === SYSTEM_FOLDER_ALL_ID) return;
    onMovePaperToFolder(paperId, folderId);
    setSelectedFolderId(folderId);
  };

  useEffect(() => {
    if (!editingFolderId) return;
    folderInputRef.current?.focus?.();
    folderInputRef.current?.select?.();
  }, [editingFolderId]);

  useEffect(() => {
    if (!editingFolderId) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(`[data-folder-id="${editingFolderId}"]`)) return;
      finalizeFolderEdit(editingFolderId);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [editingFolderId, folderDraft]);
  // --- Render ---
  return (
    <div ref={containerRef} className="flex h-[calc(100vh-28px)] bg-white text-gray-800 overflow-hidden">
      
      {/* SECTION A: Sidebar (Folders) */}
      <div
        className="flex-none bg-[#f6f5f4]/80 backdrop-blur-xl border-r border-gray-200 flex flex-col"
        style={{ width: leftWidth }}
      >
        <div className="p-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">文库</div>
        <div className="flex-1 overflow-y-auto pt-2">
          {folders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              level={0}
              expandedFolders={expandedFolders}
              selectedFolderId={selectedFolderId}
              dragOverFolderId={dragOverFolderId}
              editingFolderId={editingFolderId}
              folderDraft={folderDraft}
              folderInputRef={folderInputRef}
              onToggleFolder={toggleFolder}
              onSelectFolder={setSelectedFolderId}
              onAddChild={handleAddFolder}
              onEditFolder={(target) => startFolderEdit(target, false)}
              onDeleteFolder={handleDeleteFolder}
              onDraftChange={setFolderDraft}
              onFinalizeEdit={finalizeFolderEdit}
              onCancelEdit={cancelFolderEdit}
              onFolderDragOver={handleFolderDragOver}
              onFolderDragLeave={handleFolderDragLeave}
              onFolderDrop={handleFolderDrop}
            />
          ))}
        </div>

        <div className="border-t border-gray-200 px-2 pt-2 pb-5">
          <button
            type="button"
            onClick={() => handleAddFolder(null)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-gray-600 rounded-md hover:bg-gray-200"
          >
            <Plus size={14} className="text-gray-400" />
            新建文件夹
          </button>
        </div>
      </div>

      <div
        className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-gray-200/80"
        onMouseDown={(event) => {
          setIsPanelResizing(true);
          dragStateRef.current = {
            boundary: 'left-middle',
            startX: event.clientX,
            left: leftWidth,
            middle: middleWidth,
            right: rightWidth
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* SECTION B: File List */}
      <div
        className="flex-none bg-white flex flex-col"
        style={{ width: middleWidth }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={handleFileChange}
        />
        <div className="h-10 px-3 flex items-center justify-between border-b border-gray-100">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            {selectedFolderId ? findFolderName(folders, selectedFolderId) || 'Documents' : 'Documents'}
          </div>
          <div className="relative flex items-center gap-1" data-sort-menu-anchor>
            <Tooltip label="排序">
              <button
                type="button"
                onClick={() => setSortMenuOpen((prev) => !prev)}
                className={`p-1 rounded-md text-gray-500 ${sortMenuOpen ? 'bg-gray-100' : 'hover:bg-gray-100'}`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 3.5H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M2 7H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M2 10.5H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </Tooltip>
            {sortMenuOpen ? (
              <div
                ref={sortMenuRef}
                className="absolute right-0 top-8 z-30 w-52 rounded-md border border-gray-200 bg-white shadow-md p-2"
              >
                <div className="flex gap-1 mb-2">
                  <button
                    type="button"
                    onClick={() => setSortOrder('asc')}
                    className={`flex-1 px-2 py-1 rounded text-xs ${
                      sortOrder === 'asc' ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    正序
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortOrder('desc')}
                    className={`flex-1 px-2 py-1 rounded text-xs ${
                      sortOrder === 'desc' ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    倒序
                  </button>
                </div>
                <div className="h-px bg-gray-100 mb-2" />
                <div className="text-[11px] text-gray-400 px-1 mb-1">排序字段</div>
                <div className="space-y-1">
                  {[
                    { value: 'title', label: '论文题目' },
                    { value: 'author', label: '论文作者' },
                    { value: 'publishedDate', label: '论文发布时间' },
                    { value: 'uploadedAt', label: '论文上传时间' }
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() =>
                        setSortField(item.value as 'title' | 'author' | 'publishedDate' | 'uploadedAt')
                      }
                      className={`w-full text-left px-2 py-1 rounded text-xs ${
                        sortField === item.value ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {selectedFolderId === SYSTEM_FOLDER_TRASH_ID ? (
              <Tooltip label="清空回收站">
                <button
                  onClick={onEmptyTrash}
                  className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="添加文档">
                <button
                  onClick={handleAddClick}
                  className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {selectedFolderId ? (
             sortedVisiblePapers.map(paper => (
               <div
                 key={paper.id}
                 onClick={() => setSelectedPaperId(paper.id)}
                 onDoubleClick={() => onOpenPaper(paper)}
                 draggable={selectedFolderId !== SYSTEM_FOLDER_TRASH_ID}
                 onDragStart={(event) => {
                   if (selectedFolderId === SYSTEM_FOLDER_TRASH_ID) {
                     event.preventDefault();
                     return;
                   }
                   event.dataTransfer.effectAllowed = 'move';
                   event.dataTransfer.setData('application/x-mind-paper-paper-id', paper.id);
                   setDraggingPaperId(paper.id);
                 }}
                 onDragEnd={() => {
                   setDraggingPaperId(null);
                   setDragOverFolderId(null);
                 }}
                 className={`group px-3 py-3 border-b border-gray-100 cursor-pointer 
                    ${selectedPaperId === paper.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
               >
                 <div className="flex items-start justify-between gap-3">
                   <div className="flex items-start min-w-0">
                     <FileText size={20} className="text-gray-400 mt-1 mr-3 shrink-0" />
                     <div className="min-w-0">
                       {paper.isParsing ? (
                         <div className="space-y-2 py-0.5">
                           <div className="skeleton-shimmer h-3 w-5/6 rounded" />
                           <div className="skeleton-shimmer h-3 w-3/5 rounded" />
                           <div className="flex items-center justify-between">
                             <div className="skeleton-shimmer h-3 w-16 rounded" />
                             <div className="skeleton-shimmer h-3 w-16 rounded" />
                           </div>
                         </div>
                       ) : (
                         <>
                           <div className="text-xs font-normal text-gray-900 leading-tight mb-1 whitespace-normal break-words">
                             {paper.title}
                           </div>
                           <div className="text-xs text-gray-500 w-full truncate" title={paper.author}>
                             {paper.author}
                           </div>
                           <div className="text-xs text-gray-400 mt-0.5 flex items-center justify-between">
                             <span>{formatDateYmd(paper.date)}</span>
                             <span>{formatUploadDateYmd(paper)}</span>
                           </div>
                         </>
                       )}
                     </div>
                   </div>
                   {selectedFolderId !== SYSTEM_FOLDER_TRASH_ID ? (
                     <Tooltip label="删除">
                       <button
                         type="button"
                         onClick={(event) => {
                           event.stopPropagation();
                           onMovePaperToTrash(paper.id);
                         }}
                         className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                       >
                         <Trash2 size={14} />
                       </button>
                     </Tooltip>
                   ) : (
                     <div className="flex flex-col gap-1 items-end">
                       <Tooltip label="恢复">
                         <button
                           type="button"
                           onClick={(event) => {
                             event.stopPropagation();
                             onRestorePaper(paper.id);
                           }}
                           className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                         >
                           <RotateCcw size={14} />
                         </button>
                       </Tooltip>
                       <Tooltip label="删除">
                         <button
                           type="button"
                           onClick={(event) => {
                             event.stopPropagation();
                             onDeletePaper(paper.id);
                           }}
                           className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                         >
                           <Trash2 size={14} />
                         </button>
                       </Tooltip>
                     </div>
                   )}
                 </div>
               </div>
             ))
          ) : (
            <div className="p-8 text-center text-gray-400 text-sm">Select a folder</div>
          )}
        </div>
      </div>

      <div
        className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-gray-200/80"
        onMouseDown={(event) => {
          setIsPanelResizing(true);
          dragStateRef.current = {
            boundary: 'middle-right',
            startX: event.clientX,
            left: leftWidth,
            middle: middleWidth,
            right: rightWidth
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* SECTION C: Details */}
      <div
        className="flex-none bg-gray-50 border-l border-gray-200 flex flex-col overflow-y-auto"
        style={{ width: rightWidth }}
      >
        {selectedPaper ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
              <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
                <Tooltip label="PDF">
                  <button
                    type="button"
                    onClick={() => setPreviewMode('pdf')}
                    className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${
                      previewMode === 'pdf'
                        ? 'bg-gray-200 text-gray-900'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
                    }`}
                    aria-label="PDF"
                  >
                    <FileText size={14} />
                  </button>
                </Tooltip>
                <Tooltip label="Mind Map">
                  <button
                    type="button"
                    onClick={() => setPreviewMode('mindmap')}
                    className={`flex items-center px-2 py-1 rounded-md text-xs font-medium transition-all ${
                      previewMode === 'mindmap'
                        ? 'bg-gray-200 text-gray-900'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
                    }`}
                    aria-label="Mind Map"
                  >
                    <Network size={14} />
                  </button>
                </Tooltip>
              </div>
            </div>
            <div className={`flex-1 overflow-auto ${previewMode === 'pdf' ? 'p-2' : 'p-0'}`}>
              {previewMode === 'pdf' ? (
                <div ref={thumbnailViewportRef} className="h-full w-full flex items-start justify-center">
                  {selectedPaperThumbnail && selectedThumbnailPaperId === selectedPaper.id ? (
                    <img
                      src={selectedPaperThumbnail}
                      alt={selectedPaper.title}
                      style={{
                        width: thumbnailPageSize ? thumbnailPageSize.width * thumbnailScale : 'auto',
                        height: thumbnailPageSize ? thumbnailPageSize.height * thumbnailScale : 'auto'
                      }}
                      className="block max-w-full max-h-full"
                    />
                  ) : (
                    <div className="w-full h-full bg-white" />
                  )}
                </div>
              ) : (
                <div className="h-full w-full">
                  {mindmapLoading ? (
                    <div className="h-full w-full flex items-center justify-center text-xs text-gray-400">
                      正在生成思维导图...
                    </div>
                  ) : mindmapRoot ? (
                    <MindMap
                      root={mindmapRoot}
                      zoomScale={mindmapZoomScale}
                      collapsedIds={collapsedMindmapIds}
                      expandedNoteIds={expandedMindmapNoteIds}
                      offset={mindmapOffset}
                      selectedNodeId={activeMindmapNodeId}
                      onNodeClick={handleMindMapNodeClick}
                      onLayout={(layout) => {
                        mindmapLayoutRef.current = layout;
                        const anchor = mindmapAnchorRef.current;
                        if (!layout || !anchor) return;
                        const target = layout.nodes.find((item) => item.id === anchor.id);
                        if (!target) {
                          mindmapAnchorRef.current = null;
                          return;
                        }
                        const nextOffset = {
                          x:
                            anchor.x -
                            (target.x + target.width / 2 + layout.offset.x) * mindmapZoomScale,
                          y:
                            anchor.y -
                            (target.y + target.height / 2 + layout.offset.y) * mindmapZoomScale
                        };
                        setMindmapOffset(nextOffset);
                        mindmapAnchorRef.current = null;
                      }}
                      onLayoutStart={() => {
                        const anchor = mindmapAnchorRef.current;
                        if (!anchor) return;
                        setMindmapOffset({ x: anchor.x, y: anchor.y });
                      }}
                      onNodeToggleCollapse={handleMindmapToggleCollapse}
                      onNoteToggleExpand={(noteId) =>
                        setExpandedMindmapNoteIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(noteId)) {
                            next.delete(noteId);
                          } else {
                            next.add(noteId);
                          }
                          return next;
                        })
                      }
                      onBackgroundMouseDown={(event) => {
                        if (event.button !== 0) return;
                        mindmapPanRef.current = {
                          x: event.clientX,
                          y: event.clientY,
                          offsetX: mindmapOffset.x,
                          offsetY: mindmapOffset.y
                        };
                        document.body.style.cursor = 'grabbing';
                        document.body.style.userSelect = 'none';
                        const handleMove = (moveEvent: MouseEvent) => {
                          const start = mindmapPanRef.current;
                          if (!start) return;
                          setMindmapOffset({
                            x: start.offsetX + (moveEvent.clientX - start.x),
                            y: start.offsetY + (moveEvent.clientY - start.y)
                          });
                        };
                        const handleUp = () => {
                          mindmapPanRef.current = null;
                          document.body.style.cursor = '';
                          document.body.style.userSelect = '';
                          window.removeEventListener('mousemove', handleMove);
                          window.removeEventListener('mouseup', handleUp);
                        };
                        window.addEventListener('mousemove', handleMove);
                        window.addEventListener('mouseup', handleUp);
                      }}
                    />
                  ) : (
                    <div className="h-full w-full flex items-center justify-center text-xs text-gray-400">
                      暂无思维导图
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            No paper selected
          </div>
        )}
      </div>
    </div>
  );
};
