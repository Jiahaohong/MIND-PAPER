import React, { useEffect, useRef, useState } from 'react';
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

interface FolderItemProps {
  folder: Folder;
  level: number;
  expandedFolders: Set<string>;
  selectedFolderId: string | null;
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
}

const FolderItem: React.FC<FolderItemProps> = ({
  folder,
  level,
  expandedFolders,
  selectedFolderId,
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
  onCancelEdit
}) => {
  const isExpanded = expandedFolders.has(folder.id);
  const isSelected = selectedFolderId === folder.id;
  const isEditing = editingFolderId === folder.id;
  const isSystemFolder = folder.id === SYSTEM_FOLDER_ALL_ID || folder.id === SYSTEM_FOLDER_TRASH_ID;

  return (
    <div>
      <div
        data-folder-id={folder.id}
        onClick={() => {
          if (isEditing) return;
          onSelectFolder(folder.id);
          if (!isExpanded) onToggleFolder(folder.id);
        }}
        className={`group flex items-center px-2 py-1.5 text-sm cursor-pointer rounded-md select-none mx-2 mb-0.5
          ${isSelected ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}`}
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
        />
      ))}
    </div>
  );
};

interface LibraryViewProps {
  folders: Folder[];
  onFoldersChange: (folders: Folder[]) => void;
  papers: Paper[];
  onAddPdf: (file: File, folderId: string | null) => void;
  onOpenPaper: (paper: Paper) => void;
  onEmptyTrash: () => void;
  onMovePapersToTrash: (folderIds: string[]) => void;
  onMovePaperToTrash: (paperId: string) => void;
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
  onRestorePaper
}) => {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root-1']));
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const folderEditRef = useRef<{ id: string | null; originalName: string; isNew: boolean }>({
    id: null,
    originalName: '',
    isNew: false
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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

  const selectedPaper = papers.find(p => p.id === selectedPaperId);

  const handleAddClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onAddPdf(file, selectedFolderId);
    event.target.value = '';
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (selectedFolderId === SYSTEM_FOLDER_TRASH_ID) return;
    const file = event.dataTransfer.files?.[0];
    if (file) onAddPdf(file, selectedFolderId);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
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
    <div className="flex h-[calc(100vh-28px)] bg-white text-gray-800">
      
      {/* SECTION A: Sidebar (Folders) */}
      <div className="w-64 bg-[#f6f5f4]/80 backdrop-blur-xl border-r border-gray-200 flex flex-col">
        <div className="p-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Library</div>
        <div className="flex-1 overflow-y-auto pt-2">
          {folders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              level={0}
              expandedFolders={expandedFolders}
              selectedFolderId={selectedFolderId}
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

      {/* SECTION B: File List */}
      <div
        className="w-80 bg-white border-r border-gray-200 flex flex-col"
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
          {selectedFolderId === SYSTEM_FOLDER_TRASH_ID ? (
            <Tooltip label="清空回收站">
              <button
                onClick={onEmptyTrash}
                className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Add PDF">
              <button
                onClick={handleAddClick}
                className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"
              >
                <Plus size={14} />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {selectedFolderId ? (
             getFolderPapers(selectedFolderId).map(paper => (
               <div
                 key={paper.id}
                 onClick={() => setSelectedPaperId(paper.id)}
                 onDoubleClick={() => onOpenPaper(paper)}
                 className={`group px-4 py-3 border-b border-gray-100 cursor-pointer 
                    ${selectedPaperId === paper.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
               >
                 <div className="flex items-start justify-between gap-3">
                   <div className="flex items-start min-w-0">
                     <FileText size={20} className="text-gray-400 mt-1 mr-3 shrink-0" />
                     <div className="min-w-0">
                       <div className="text-sm font-medium text-gray-900 leading-tight mb-1 truncate">{paper.title}</div>
                       <div className="text-xs text-gray-500">{paper.author}</div>
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

      {/* SECTION C: Details */}
      <div className="flex-1 bg-gray-50 flex flex-col">
        {selectedPaper ? (
          <div className="p-8 max-w-2xl mx-auto w-full">
            <div className="bg-white shadow-sm border border-gray-200 rounded-xl p-8 flex flex-col items-center text-center">
              <div className="w-24 h-32 bg-gray-100 border border-gray-200 mb-6 shadow-md flex items-center justify-center">
                 <FileText size={48} className="text-gray-300" />
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">{selectedPaper.title}</h2>
              <p className="text-gray-600 mb-6">{selectedPaper.author}</p>
              
              <div className="w-full text-left space-y-4">
                <div>
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Summary</h3>
                  <p className="text-sm text-gray-700 leading-relaxed">{selectedPaper.summary}</p>
                </div>
                <div>
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Keywords</h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedPaper.keywords.map(k => (
                      <span key={k} className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <button 
                onClick={() => onOpenPaper(selectedPaper)}
                className="mt-8 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm font-medium text-sm transition-colors"
              >
                Open Document
              </button>
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
