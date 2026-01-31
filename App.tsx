import React, { useEffect, useRef, useState } from 'react';
import { LibraryView } from './components/LibraryView';
import { ReaderView } from './components/ReaderView';
import { Folder, Paper } from './types';
import { INITIAL_FOLDERS, MOCK_PAPERS, SYSTEM_FOLDER_ALL_ID, SYSTEM_FOLDER_TRASH_ID } from './constants';
import { LayoutGrid, Settings, X, FileText } from 'lucide-react';
import { Tooltip } from './components/Tooltip';

const App: React.FC = () => {
  const DEFAULT_SETTINGS = {
    translationEngine: 'cnki' as 'cnki' | 'openai',
    apiKey: '',
    baseUrl: '',
    model: ''
  };
  // State for tabs
  const [openPapers, setOpenPapers] = useState<Paper[]>([]);
  const [activePaperId, setActivePaperId] = useState<string | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [folders, setFolders] = useState(INITIAL_FOLDERS);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const pdfFileCacheRef = useRef<Map<string, { data: ArrayBuffer } | string>>(new Map());
  const pdfLoadPendingRef = useRef<Set<string>>(new Set());
  const [pdfFileMap, setPdfFileMap] = useState<Record<string, { data: ArrayBuffer } | string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState(DEFAULT_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);

  const activePaper = openPapers.find(p => p.id === activePaperId);
  const systemFolders = [
    { id: SYSTEM_FOLDER_ALL_ID, name: '所有文档', parentId: null, children: [] },
    { id: SYSTEM_FOLDER_TRASH_ID, name: '回收站', parentId: null, children: [] }
  ];
  const isSystemFolderId = (id: string | null) =>
    id === SYSTEM_FOLDER_ALL_ID || id === SYSTEM_FOLDER_TRASH_ID;
  const ensureSystemFolders = (list: Folder[]) => {
    const filtered = list.filter(
      (folder) => folder.id !== SYSTEM_FOLDER_ALL_ID && folder.id !== SYSTEM_FOLDER_TRASH_ID
    );
    return [...systemFolders, ...filtered];
  };

  // Handlers
  const handleOpenPaper = (paper: Paper) => {
    // Check if already open
    if (!openPapers.find(p => p.id === paper.id)) {
      setOpenPapers([...openPapers, paper]);
    }
    setActivePaperId(paper.id);
  };

  const handleCloseTab = (e: React.MouseEvent, paperId: string) => {
    e.stopPropagation();
    pdfFileCacheRef.current.delete(paperId);
    setPdfFileMap((prev) => {
      if (!prev[paperId]) return prev;
      const next = { ...prev };
      delete next[paperId];
      return next;
    });
    const newPapers = openPapers.filter(p => p.id !== paperId);
    setOpenPapers(newPapers);
    
    // If we closed the active paper, switch context
    if (activePaperId === paperId) {
      if (newPapers.length > 0) {
        // Switch to the last opened paper
        setActivePaperId(newPapers[newPapers.length - 1].id);
      } else {
        // Go back to library
        setActivePaperId(null);
      }
    }
  };

  const handleAddPdf = async (file: File, folderId: string | null) => {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      window.alert('请上传PDF格式文件。');
      return;
    }

    const fileData = await file.arrayBuffer();
    const id = `p-${Date.now()}`;
    const title = file.name.replace(/\.pdf$/i, '');
    const fallbackFolder = folders.find((folder) => !isSystemFolderId(folder.id));
    const assignedFolderId =
      folderId && !isSystemFolderId(folderId)
        ? folderId
        : fallbackFolder?.id || SYSTEM_FOLDER_ALL_ID;
    let filePath: string | undefined;
    if (typeof window !== 'undefined' && window.electronAPI?.library?.savePdf) {
      const response = await window.electronAPI.library.savePdf({ paperId: id, data: fileData });
      if (response?.ok && response.filePath) {
        filePath = response.filePath;
      }
    }
    const nextPaper: Paper = {
      id,
      title,
      author: 'Unknown',
      date: new Date().toISOString().slice(0, 10),
      folderId: assignedFolderId,
      summary: 'Uploaded PDF',
      content: '',
      keywords: [],
      fileUrl: filePath ? undefined : URL.createObjectURL(file),
      fileData: filePath ? undefined : fileData,
      filePath
    };

    pdfFileCacheRef.current.set(id, { data: fileData.slice(0) });
    setPdfFileMap((prev) => ({ ...prev, [id]: { data: fileData.slice(0) } }));
    setPapers(prev => [nextPaper, ...prev]);
    handleOpenPaper(nextPaper);
  };

  const getCachedPdfFile = (paper: Paper) => {
    const cache = pdfFileCacheRef.current;
    const mapped = pdfFileMap[paper.id];
    if (mapped) return mapped;
    const existing = cache.get(paper.id);
    if (existing) return existing;
    if (paper.fileData) {
      const cached = { data: paper.fileData.slice(0) };
      cache.set(paper.id, cached);
      setPdfFileMap((prev) => ({ ...prev, [paper.id]: cached }));
      return cached;
    }
    if (paper.fileUrl) {
      cache.set(paper.id, paper.fileUrl);
      setPdfFileMap((prev) => ({ ...prev, [paper.id]: paper.fileUrl as string }));
      return paper.fileUrl;
    }
    if (
      paper.filePath &&
      typeof window !== 'undefined' &&
      window.electronAPI?.library?.readPdf
    ) {
      if (!pdfLoadPendingRef.current.has(paper.id)) {
        pdfLoadPendingRef.current.add(paper.id);
        window.electronAPI.library
          .readPdf({ paperId: paper.id, filePath: paper.filePath })
          .then((response) => {
            if (response?.ok && response.data) {
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
              const cached = { data: arrayBuffer };
              pdfFileCacheRef.current.set(paper.id, cached);
              setPdfFileMap((prev) => ({ ...prev, [paper.id]: cached }));
            }
          })
          .finally(() => {
            pdfLoadPendingRef.current.delete(paper.id);
          });
      }
    }
    return null;
  };

  const switchToLibrary = () => {
    setActivePaperId(null);
  };

  const handleEmptyTrash = () => {
    const trashIds = papers.filter((paper) => paper.folderId === SYSTEM_FOLDER_TRASH_ID).map((paper) => paper.id);
    if (!trashIds.length) return;
    const trashSet = new Set(trashIds);
    trashIds.forEach((id) => pdfFileCacheRef.current.delete(id));
    setPdfFileMap((prev) => {
      const next = { ...prev };
      trashIds.forEach((id) => {
        delete next[id];
      });
      return next;
    });
    setPapers((prev) => prev.filter((paper) => !trashSet.has(paper.id)));
    setOpenPapers((prev) => {
      const next = prev.filter((paper) => !trashSet.has(paper.id));
      if (activePaperId && trashSet.has(activePaperId)) {
        setActivePaperId(next.length ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const handleMovePapersToTrash = (folderIds: string[]) => {
    if (!folderIds.length) return;
    const folderSet = new Set(folderIds);
    setPapers((prev) =>
      prev.map((paper) =>
        folderSet.has(paper.folderId)
          ? { ...paper, folderId: SYSTEM_FOLDER_TRASH_ID, previousFolderId: paper.folderId }
          : paper
      )
    );
  };

  const handleMovePaperToTrash = (paperId: string) => {
    setPapers((prev) =>
      prev.map((paper) =>
        paper.id === paperId
          ? { ...paper, folderId: SYSTEM_FOLDER_TRASH_ID, previousFolderId: paper.folderId }
          : paper
      )
    );
  };

  const handleRestorePaper = (paperId: string) => {
    const findFolderById = (list: Folder[], targetId: string | null): Folder | null => {
      if (!targetId) return null;
      for (const folder of list) {
        if (folder.id === targetId) return folder;
        if (folder.children.length) {
          const found = findFolderById(folder.children, targetId);
          if (found) return found;
        }
      }
      return null;
    };
    const fallbackFolder = folders.find((folder) => !isSystemFolderId(folder.id));
    setPapers((prev) =>
      prev.map((paper) => {
        if (paper.id !== paperId) return paper;
        const preferredId = paper.previousFolderId && !isSystemFolderId(paper.previousFolderId)
          ? paper.previousFolderId
          : null;
        const targetId =
          (preferredId && findFolderById(folders, preferredId)?.id) ||
          fallbackFolder?.id ||
          SYSTEM_FOLDER_ALL_ID;
        return { ...paper, folderId: targetId, previousFolderId: undefined };
      })
    );
  };

  useEffect(() => {
    const loadLibrary = async () => {
      if (typeof window === 'undefined' || !window.electronAPI?.library) {
        setPapers(MOCK_PAPERS);
        setFolders(INITIAL_FOLDERS);
        return;
      }
      const savedFolders = await window.electronAPI.library.getFolders();
      if (Array.isArray(savedFolders) && savedFolders.length) {
        setFolders(ensureSystemFolders(savedFolders));
      } else {
        setFolders(ensureSystemFolders(INITIAL_FOLDERS));
      }
      const savedPapers = await window.electronAPI.library.getPapers();
      if (Array.isArray(savedPapers) && savedPapers.length) {
        setPapers(savedPapers);
      } else {
        setPapers([]);
      }
      setLibraryLoaded(true);
    };
    loadLibrary();
  }, []);

  useEffect(() => {
    if (!libraryLoaded) return;
    if (typeof window === 'undefined' || !window.electronAPI?.library) return;
    window.electronAPI.library.saveFolders(folders);
  }, [folders, libraryLoaded]);

  useEffect(() => {
    if (!libraryLoaded) return;
    if (typeof window === 'undefined' || !window.electronAPI?.library) return;
    window.electronAPI.library.savePapers(papers);
  }, [papers, libraryLoaded]);

  const loadSettings = async () => {
    setSettingsError('');
    if (typeof window === 'undefined' || !window.electronAPI?.settingsGet) {
      setSettingsError('设置仅桌面端可用');
      return;
    }
    setSettingsLoading(true);
    try {
      const data = await window.electronAPI.settingsGet();
      setSettingsForm((prev) => ({ ...prev, ...data }));
    } catch (error: any) {
      setSettingsError(error?.message || '设置加载失败');
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    setSettingsError('');
    if (typeof window === 'undefined' || !window.electronAPI?.settingsSet) {
      setSettingsError('设置仅桌面端可用');
      return;
    }
    setSettingsLoading(true);
    try {
      const data = await window.electronAPI.settingsSet(settingsForm);
      setSettingsForm((prev) => ({ ...prev, ...data }));
      setSettingsSaved(true);
      window.setTimeout(() => setSettingsSaved(false), 1500);
    } catch (error: any) {
      setSettingsError(error?.message || '设置保存失败');
    } finally {
      setSettingsLoading(false);
    }
  };

  useEffect(() => {
    if (!settingsOpen) return;
    loadSettings();
  }, [settingsOpen]);

  return (
    <div className="h-screen w-screen bg-gray-200 flex flex-col font-sans text-gray-900 overflow-hidden">
      
      {/* Safari-style Toolbar / Title Bar */}
      <div className="h-10 bg-white/80 backdrop-blur flex items-center border-b border-gray-200 select-none px-3 py-[4px] gap-4">
         
         {/* Library / Home Button */}
         <div className="py-1 shrink-0">
           <Tooltip label="主界面">
             <button 
               onClick={switchToLibrary}
               className={`p-1 rounded-md transition-colors 
                 ${activePaperId === null ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:bg-gray-200'}`}
             >
               <LayoutGrid size={16} />
             </button>
           </Tooltip>
         </div>

         {/* Tabs Container */}
         <div className="flex-1 flex items-center">
           <div className="flex p-1 rounded-lg overflow-x-auto no-scrollbar gap-1">
             {openPapers.map(paper => {
               const isActive = activePaperId === paper.id;
               return (
                 <div
                   key={paper.id}
                   onClick={() => setActivePaperId(paper.id)}
                   className={`
                     group relative flex items-center min-w-[120px] max-w-[200px] px-3 py-1 rounded-md cursor-pointer text-xs font-medium transition-all
                     ${isActive 
                       ? 'bg-white shadow-sm text-gray-900' 
                       : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'}
                   `}
                 >
                   <FileText size={12} className={`mr-2 shrink-0 ${isActive ? 'text-blue-500' : 'text-gray-400'}`} />
                   <span className="truncate flex-1 pr-4">{paper.title}</span>
                   
                   {/* Close Button */}
                   <button
                     onClick={(e) => handleCloseTab(e, paper.id)}
                     className={`absolute right-1 p-0.5 rounded-sm hover:bg-gray-200 
                       ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                   >
                     <X size={10} />
                   </button>
                 </div>
               );
             })}
           </div>
         </div>

         {/* Settings Button */}
         <div className="py-1 shrink-0">
           <Tooltip label="设置">
             <button
               className="p-1 text-gray-500 hover:bg-gray-200 rounded-md"
               onClick={() => setSettingsOpen(true)}
             >
               <Settings size={16} />
             </button>
           </Tooltip>
         </div>

      </div>

      {/* Main View Area */}
      <div className="flex-1 relative">
        <div className={activePaperId === null ? 'block h-full' : 'hidden'}>
          <LibraryView
            folders={folders}
            onFoldersChange={(next) => setFolders(ensureSystemFolders(next))}
            papers={papers}
            onAddPdf={handleAddPdf}
            onOpenPaper={handleOpenPaper}
            onEmptyTrash={handleEmptyTrash}
            onMovePapersToTrash={handleMovePapersToTrash}
            onMovePaperToTrash={handleMovePaperToTrash}
            onRestorePaper={handleRestorePaper}
          />
        </div>
        <div className={activePaperId === null ? 'hidden' : 'absolute inset-0'}>
          {openPapers.map(paper => {
            const isActive = activePaperId === paper.id;
            return (
              <div key={paper.id} className={isActive ? 'h-full' : 'hidden h-full'}>
                <ReaderView 
                  paper={paper}
                  pdfFile={getCachedPdfFile(paper)}
                  onBack={switchToLibrary} 
                />
              </div>
            );
          })}
        </div>
      </div>

      {settingsOpen ? (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
          <div className="w-[420px] bg-white rounded-xl shadow-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-gray-800">设置</div>
              <button
                className="p-1 text-gray-500 hover:bg-gray-100 rounded-md"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">翻译引擎</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSettingsForm((prev) => ({ ...prev, translationEngine: 'cnki' }))
                    }
                    className={`px-2.5 py-1 rounded-md text-xs border ${
                      settingsForm.translationEngine === 'cnki'
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    CNKI
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSettingsForm((prev) => ({ ...prev, translationEngine: 'openai' }))
                    }
                    className={`px-2.5 py-1 rounded-md text-xs border ${
                      settingsForm.translationEngine === 'openai'
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    OpenAI
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">OpenAI API Key</label>
                <input
                  type="password"
                  value={settingsForm.apiKey}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, apiKey: e.target.value }))
                  }
                  disabled={settingsForm.translationEngine !== 'openai'}
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="sk-..."
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">OpenAI Base URL</label>
                <input
                  type="text"
                  value={settingsForm.baseUrl}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  disabled={settingsForm.translationEngine !== 'openai'}
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">OpenAI Model</label>
                <input
                  type="text"
                  value={settingsForm.model}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, model: e.target.value }))
                  }
                  disabled={settingsForm.translationEngine !== 'openai'}
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="gpt-3.5-turbo"
                />
              </div>
            </div>

            {settingsError ? (
              <div className="mt-3 text-xs text-red-500">{settingsError}</div>
            ) : null}

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[11px] text-gray-400">
                CNKI 不需要配置；OpenAI 需填写 Key / Base URL。
              </div>
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={settingsLoading}
                className="px-3 py-1.5 rounded-md text-xs bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {settingsLoading ? '保存中...' : settingsSaved ? '已保存' : '保存设置'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default App;
