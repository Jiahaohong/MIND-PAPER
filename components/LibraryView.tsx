import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder as FolderIcon,
  FileText,
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
import { Document, Page, pdfjs } from 'react-pdf';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

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
  const [thumbnailPageSize, setThumbnailPageSize] = useState<{ width: number; height: number } | null>(null);
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
  const thumbnailBlobUrlRef = useRef<string | null>(null);
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
  const parsePublishedTime = (paper: Paper) => {
    const value = String(paper.date || '').trim();
    if (!value) return 0;
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
    const resetOwnedThumbnailUrl = () => {
      if (thumbnailBlobUrlRef.current) {
        URL.revokeObjectURL(thumbnailBlobUrlRef.current);
        thumbnailBlobUrlRef.current = null;
      }
    };
    const setThumbnailFromBuffer = (buffer: ArrayBuffer) => {
      resetOwnedThumbnailUrl();
      const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      thumbnailBlobUrlRef.current = blobUrl;
      setSelectedPaperThumbnail(blobUrl);
    };
    const loadThumbnail = async () => {
      if (!selectedPaper) {
        resetOwnedThumbnailUrl();
        setSelectedPaperThumbnail(null);
        return;
      }
      if (selectedPaper.fileData) {
        setThumbnailFromBuffer(selectedPaper.fileData.slice(0));
        return;
      }
      if (selectedPaper.fileUrl) {
        resetOwnedThumbnailUrl();
        setSelectedPaperThumbnail(selectedPaper.fileUrl);
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
          setThumbnailFromBuffer(arrayBuffer);
        }
        return;
      }
      resetOwnedThumbnailUrl();
      setSelectedPaperThumbnail(null);
    };
    loadThumbnail();
    return () => {
      cancelled = true;
      resetOwnedThumbnailUrl();
    };
  }, [selectedPaper]);

  useEffect(() => {
    setThumbnailPageSize(null);
  }, [selectedPaperThumbnail, selectedPaper?.id]);

  useEffect(() => {
    const element = thumbnailViewportRef.current;
    if (!element) return;
    let rafId = 0;
    const update = () => {
      if (isPanelResizing) return;
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
                       <div className="text-sm font-medium text-gray-900 leading-tight mb-1 whitespace-normal break-words">
                         {paper.title}
                       </div>
                       <div className="text-xs text-gray-500 w-full truncate" title={paper.author}>
                         {paper.author}
                       </div>
                       <div className="text-xs text-gray-400 mt-0.5">{paper.date}</div>
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
          <div className="flex-1 p-4 overflow-auto">
            <div ref={thumbnailViewportRef} className="h-full w-full flex items-start justify-center">
              {selectedPaperThumbnail ? (
                <Document
                  key={`thumb-${selectedPaper.id}`}
                  file={selectedPaperThumbnail}
                  loading={null}
                  error={null}
                  noData={null}
                >
                  <Page
                    pageNumber={1}
                    scale={thumbnailScale}
                    loading={null}
                    error={null}
                    noData={null}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    onLoadSuccess={(page: any) => {
                      const viewport = page.getViewport({ scale: 1 });
                      setThumbnailPageSize({
                        width: viewport.width,
                        height: viewport.height
                      });
                    }}
                  />
                </Document>
              ) : (
                <div className="w-full h-full bg-white" />
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
