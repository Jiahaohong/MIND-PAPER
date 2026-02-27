import React, { useEffect, useRef, useState } from 'react';
import { LibraryView } from './components/LibraryView';
import { ReaderView } from './components/ReaderView';
import { Folder, Paper, PaperReference } from './types';
import { INITIAL_FOLDERS, MOCK_PAPERS, SYSTEM_FOLDER_ALL_ID, SYSTEM_FOLDER_TRASH_ID } from './constants';
import { LayoutGrid, Settings, X, FileText } from 'lucide-react';
import { Tooltip } from './components/Tooltip';
import {
  extractPdfFullText,
  extractPdfReferencesFromLocal,
  rewriteSummaryWithAI
} from './services/pdfMetadataService';
import { resolvePaperMetadata } from './services/paperMetadataResolver';

const App: React.FC = () => {
  const DEFAULT_SETTINGS = {
    translationEngine: 'cnki' as 'cnki' | 'openai',
    apiKey: '',
    baseUrl: '',
    model: '',
    parsePdfWithAI: false,
    libraryPath: ''
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
  const MAX_FULL_PDF_CACHE = 20;
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

  const createPaperId = () => {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  };

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

  const hydratePaperRuntimeStatus = (paper: Paper): Paper => {
    const summary = String(paper.summary || '').trim();
    const abstract = String(paper.abstract || '').trim();
    const inferredRewriteDone =
      Boolean(summary) && Boolean(abstract) && summary !== abstract;
    return {
      ...paper,
      isParsing: Boolean(paper.isParsing),
      isBackgroundProcessing: Boolean(paper.isBackgroundProcessing),
      backgroundTask: String(paper.backgroundTask || ''),
      isRewritingSummary: Boolean(paper.isRewritingSummary),
      isVectorizing: Boolean(paper.isVectorizing),
      summaryRewriteDone:
        typeof paper.summaryRewriteDone === 'boolean'
          ? paper.summaryRewriteDone
          : inferredRewriteDone,
      vectorizationDone: Boolean(paper.vectorizationDone)
    };
  };

  const logProgress = async (stage: string, paperId?: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.logProgress) return;
    try {
      await window.electronAPI.logProgress({ stage, paperId });
    } catch {
      // ignore progress logging errors
    }
  };

  // Handlers
  const handleOpenPaper = (paper: Paper) => {
    // Check if already open
    if (!openPapers.find(p => p.id === paper.id)) {
      setOpenPapers([...openPapers, paper]);
    }
    setActivePaperId(paper.id);
  };

  const handleUpdatePaper = (paperId: string, updates: Partial<Paper>) => {
    setPapers((prev) => prev.map((paper) => (paper.id === paperId ? { ...paper, ...updates } : paper)));
    setOpenPapers((prev) =>
      prev.map((paper) => (paper.id === paperId ? { ...paper, ...updates } : paper))
    );
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

  const handleAddPdf = async (file: File, folderId: string | null): Promise<Paper | null> => {
    if (!file) return null;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      window.alert('请上传PDF格式文件。');
      return null;
    }
    if (!folderId) {
      window.alert('请先在左侧选择一个文件夹，再添加文档。');
      return null;
    }
    if (folderId === SYSTEM_FOLDER_TRASH_ID) {
      window.alert('回收站中不能添加文档。');
      return null;
    }

    const fileData = await file.arrayBuffer();
    const localPaperId = createPaperId();
    let id = localPaperId;
    const fallbackTitle = file.name.replace(/\.pdf$/i, '');
    const formatNowDate = () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      return `${year}年${month}月${day}日`;
    };
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();
    const assignedFolderId =
      folderId === SYSTEM_FOLDER_ALL_ID ? SYSTEM_FOLDER_ALL_ID : folderId;
    let filePath: string | undefined;
    if (typeof window !== 'undefined' && window.electronAPI?.library?.savePdf) {
      const response = await window.electronAPI.library.savePdf({ paperId: localPaperId, data: fileData });
      if (response?.ok && response.filePath) {
        filePath = response.filePath;
      }
    }

    const pendingPaper: Paper = {
      id,
      title: fallbackTitle,
      author: 'Unknown',
      date: formatNowDate(),
      addedDate: nowIso,
      uploadedAt: nowTs,
      folderId: assignedFolderId,
      summary: 'Uploaded PDF',
      content: '',
      keywords: [],
      publisher: '',
      fileUrl: filePath ? undefined : URL.createObjectURL(file),
      fileData: filePath ? undefined : fileData,
      filePath,
      isParsing: true,
      isBackgroundProcessing: false,
      backgroundTask: '',
      isRewritingSummary: false,
      isVectorizing: false,
      summaryRewriteDone: false,
      vectorizationDone: false
    };

    setPapers((prev) => [pendingPaper, ...prev]);

    const patchPaper = (updates: Partial<Paper>) => {
      setPapers((prev) =>
        prev.map((paper) => (paper.id === id ? { ...paper, ...updates } : paper))
      );
      setOpenPapers((prev) =>
        prev.map((paper) => (paper.id === id ? { ...paper, ...updates } : paper))
      );
    };
    const finishParsingPaper = (updates: Partial<Paper>) => {
      patchPaper({ ...updates, isParsing: false });
    };

    (async () => {
      let parsedTitle = fallbackTitle;
      let parsedAuthor = 'Unknown';
      let parsedAbstract = '';
      let parsedKeywords: string[] = [];
      let parsedDate = formatNowDate();
      let parsedPublisher = '';
      let parsedDoi = '';
      let parsedReferences: PaperReference[] = [];
      let parsedReferenceStats: Paper['referenceStats'] | undefined;
      let parseWithAI = false;
      let canUseAI = false;
      await logProgress('开始解析基本信息', id);
      if (typeof window !== 'undefined' && window.electronAPI?.settingsGet) {
        try {
          const settings = await window.electronAPI.settingsGet();
          parseWithAI = Boolean(settings?.parsePdfWithAI);
          canUseAI = Boolean(settings?.apiKey?.trim()) && Boolean(window.electronAPI?.askAI);
        } catch {
          parseWithAI = false;
          canUseAI = false;
        }
      }

      try {
        const resolved = await resolvePaperMetadata({
          fileData,
          fallbackTitle,
          fallbackDate: parsedDate,
          priority: parseWithAI && canUseAI ? ['open_source', 'ai', 'local'] : ['open_source', 'local'],
          parsePdfWithAI: parseWithAI && canUseAI,
          askAI: window.electronAPI?.askAI,
          searchOpenSource: window.electronAPI?.searchPaperOpenSource
            ? (title) => window.electronAPI!.searchPaperOpenSource!(title)
            : undefined
        });
        parsedTitle = resolved.title;
        parsedAuthor = isUnknownLike(resolved.author) ? 'Unknown' : resolved.author;
        parsedAbstract = resolved.abstract || resolved.summary || '';
        parsedKeywords = resolved.keywords;
        parsedDate = resolved.date || parsedDate;
        parsedPublisher = resolved.publisher || parsedPublisher;
        parsedDoi = resolved.doi || '';
        let apiReferences: PaperReference[] = [];
        let apiReferenceSuccess = false;
        if (parsedDoi && window.electronAPI?.searchPaperReferences) {
          const refs = await window.electronAPI.searchPaperReferences({
            doi: parsedDoi,
            title: parsedTitle
          });
          if (refs?.ok) {
            apiReferences = Array.isArray(refs.references)
              ? mapReferences(id, refs.references, 'api')
              : [];
            apiReferenceSuccess = apiReferences.length > 0;
            parsedReferenceStats = {
              totalOpenAlex: Number(refs.total_openalex || 0),
              totalSemanticScholar: Number(refs.total_semanticscholar || 0),
              intersectionCount: Number((refs.union_count ?? refs.intersection_count) || 0)
            };
          } else {
            console.warn('参考文献解析失败:', refs?.error || 'unknown');
          }
        }
        let localReferences: PaperReference[] = [];
        if (!apiReferenceSuccess) {
          const localRefs = await extractPdfReferencesFromLocal(fileData, { maxPages: 80, maxRefs: 200 });
          localReferences = localRefs.length ? mapReferences(id, localRefs, 'local') : [];
          if (localReferences.length) {
            console.log(`[references][local] paper=${id} count=${localRefs.length}`);
          }
        }
        parsedReferences = apiReferenceSuccess
          ? apiReferences
          : dedupeReferences(localReferences);
        parsedReferences = await matchReferences(id, parsedReferences);
        parsedReferences = sortReferences(parsedReferences);
        parsedReferenceStats = buildReferenceStats(parsedReferences, parsedReferenceStats);
      } catch (error) {
        console.warn('解析论文信息失败，使用默认信息:', error);
      }
      await logProgress('完成解析基本信息', id);

      const updates: Partial<Paper> = {
        title: parsedTitle,
        author: parsedAuthor,
        abstract: parsedAbstract || 'No abstract extracted.',
        keywords: parsedKeywords,
        date: parsedDate,
        publisher: parsedPublisher,
        doi: parsedDoi,
        references: parsedReferences,
        referenceStats: parsedReferenceStats,
        isBackgroundProcessing: false,
        backgroundTask: ''
      };

      await logProgress('开始入库', id);
      finishParsingPaper(updates);
      await logProgress('完成入库', id);

      if (parseWithAI && canUseAI) {
        let rewriteSummary = '';
        try {
          patchPaper({
            isBackgroundProcessing: true,
            backgroundTask: '重写摘要中',
            isRewritingSummary: true,
            summaryRewriteDone: false
          });
          await logProgress('开始重写摘要', id);
          const fullText = await extractPdfFullText(fileData, { maxChars: 260000 });
            const rewritten = await rewriteSummaryWithAI(
              {
                originalAbstract: parsedAbstract || '',
                fullText
              },
              window.electronAPI!.askAI!
            );
            if (rewritten) rewriteSummary = rewritten;
          } catch (error) {
            console.warn('重写摘要失败，使用原始摘要:', error);
          } finally {
            await logProgress('完成重写摘要', id);
            await logProgress('开始入库', id);
            patchPaper({
              ...(rewriteSummary ? { summary: rewriteSummary } : {}),
              abstract: parsedAbstract || '',
              isRewritingSummary: false,
              summaryRewriteDone: Boolean(rewriteSummary),
              isBackgroundProcessing: false,
              backgroundTask: ''
            });
            await logProgress('完成入库', id);
          }
        }
    })();

    return pendingPaper;
  };

  const getCachedPdfFile = (paper: Paper) => {
    const cache = pdfFileCacheRef.current;
    const mapped = pdfFileMap[paper.id];
    if (mapped) {
      if (cache.has(paper.id)) {
        const existing = cache.get(paper.id);
        if (existing) {
          cache.delete(paper.id);
          cache.set(paper.id, existing);
        }
      }
      return mapped;
    }
    const existing = cache.get(paper.id);
    if (existing) {
      cache.delete(paper.id);
      cache.set(paper.id, existing);
      setPdfFileMap((prev) => ({ ...prev, [paper.id]: existing }));
      return existing;
    }
    if (paper.fileData) {
      const cached = { data: paper.fileData.slice(0) };
      cache.delete(paper.id);
      cache.set(paper.id, cached);
      setPdfFileMap((prev) => ({ ...prev, [paper.id]: cached }));
      if (cache.size > MAX_FULL_PDF_CACHE) {
        const toRemove: string[] = [];
        while (cache.size > MAX_FULL_PDF_CACHE) {
          const oldest = cache.keys().next().value as string | undefined;
          if (!oldest) break;
          cache.delete(oldest);
          toRemove.push(oldest);
        }
        if (toRemove.length) {
          setPdfFileMap((prev) => {
            const next = { ...prev };
            toRemove.forEach((id) => {
              delete next[id];
            });
            return next;
          });
        }
      }
      return cached;
    }
    if (paper.fileUrl) {
      cache.delete(paper.id);
      cache.set(paper.id, paper.fileUrl);
      setPdfFileMap((prev) => ({ ...prev, [paper.id]: paper.fileUrl as string }));
      if (cache.size > MAX_FULL_PDF_CACHE) {
        const toRemove: string[] = [];
        while (cache.size > MAX_FULL_PDF_CACHE) {
          const oldest = cache.keys().next().value as string | undefined;
          if (!oldest) break;
          cache.delete(oldest);
          toRemove.push(oldest);
        }
        if (toRemove.length) {
          setPdfFileMap((prev) => {
            const next = { ...prev };
            toRemove.forEach((id) => {
              delete next[id];
            });
            return next;
          });
        }
      }
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
              const nextCache = pdfFileCacheRef.current;
              nextCache.delete(paper.id);
              nextCache.set(paper.id, cached);
              setPdfFileMap((prev) => ({ ...prev, [paper.id]: cached }));
              if (nextCache.size > MAX_FULL_PDF_CACHE) {
                const toRemove: string[] = [];
                while (nextCache.size > MAX_FULL_PDF_CACHE) {
                  const oldest = nextCache.keys().next().value as string | undefined;
                  if (!oldest) break;
                  nextCache.delete(oldest);
                  toRemove.push(oldest);
                }
                if (toRemove.length) {
                  setPdfFileMap((prev) => {
                    const next = { ...prev };
                    toRemove.forEach((id) => {
                      delete next[id];
                    });
                    return next;
                  });
                }
              }
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
    if (typeof window !== 'undefined' && window.electronAPI?.library?.deletePapers) {
      const items = papers
        .filter((paper) => trashSet.has(paper.id))
        .map((paper) => ({ id: paper.id, filePath: paper.filePath }));
      window.electronAPI.library.deletePapers({ items }).catch(() => null);
    }
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

  const handleDeletePaper = (paperId: string) => {
    const targetPaper = papers.find((paper) => paper.id === paperId);
    if (typeof window !== 'undefined' && window.electronAPI?.library?.deletePaper) {
      window.electronAPI.library
        .deletePaper({ paperId, filePath: targetPaper?.filePath })
        .catch(() => null);
    }
    pdfFileCacheRef.current.delete(paperId);
    setPdfFileMap((prev) => {
      if (!prev[paperId]) return prev;
      const next = { ...prev };
      delete next[paperId];
      return next;
    });
    setPapers((prev) => prev.filter((paper) => paper.id !== paperId));
    setOpenPapers((prev) => {
      const next = prev.filter((paper) => paper.id !== paperId);
      if (activePaperId === paperId) {
        setActivePaperId(next.length ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const handleMovePaperToFolder = (paperId: string, targetFolderId: string) => {
    if (!paperId || !targetFolderId || targetFolderId === SYSTEM_FOLDER_ALL_ID) return;
    setPapers((prev) =>
      prev.map((paper) => {
        if (paper.id !== paperId) return paper;
        if (targetFolderId === SYSTEM_FOLDER_TRASH_ID) {
          const previousFolderId =
            paper.folderId === SYSTEM_FOLDER_TRASH_ID ? paper.previousFolderId : paper.folderId;
          return {
            ...paper,
            folderId: SYSTEM_FOLDER_TRASH_ID,
            previousFolderId
          };
        }
        return {
          ...paper,
          folderId: targetFolderId,
          previousFolderId: undefined
        };
      })
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
    setPapers((prev) =>
      prev.map((paper) => {
        if (paper.id !== paperId) return paper;
        const preferredId = paper.previousFolderId && !isSystemFolderId(paper.previousFolderId)
          ? paper.previousFolderId
          : null;
        const targetId =
          (preferredId && findFolderById(folders, preferredId)?.id) || SYSTEM_FOLDER_ALL_ID;
        return { ...paper, folderId: targetId, previousFolderId: undefined };
      })
    );
  };

  const loadLibrary = async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.library) {
      setPapers(MOCK_PAPERS);
      setFolders(INITIAL_FOLDERS);
      setOpenPapers([]);
      setActivePaperId(null);
      return;
    }
    const savedFolders = await window.electronAPI.library.getFolders();
    const nextFolders =
      Array.isArray(savedFolders) && savedFolders.length
        ? ensureSystemFolders(savedFolders)
        : ensureSystemFolders(INITIAL_FOLDERS);
    const savedPapers = await window.electronAPI.library.getPapers();
    let nextPapers =
      Array.isArray(savedPapers) && savedPapers.length
        ? savedPapers.map((paper) => hydratePaperRuntimeStatus(paper))
        : [];
    if (nextPapers.length && window.electronAPI?.vector?.getPaperStatuses) {
      try {
        const statusResp = await window.electronAPI.vector.getPaperStatuses({
          paperIds: nextPapers.map((paper) => paper.id)
        });
        if (statusResp?.ok) {
          const vectorized = new Set(
            Array.isArray(statusResp.vectorizedPaperIds) ? statusResp.vectorizedPaperIds : []
          );
          nextPapers = nextPapers.map((paper) =>
            vectorized.has(paper.id) ? { ...paper, vectorizationDone: true } : paper
          );
        }
      } catch {
        // ignore vector status bootstrap errors
      }
    }
    setFolders(nextFolders);
    setPapers(nextPapers);
    setOpenPapers((prev) => {
      if (!nextPapers.length) return [];
      const map = new Map(nextPapers.map((paper) => [paper.id, paper]));
      return prev
        .filter((paper) => map.has(paper.id))
        .map((paper) => map.get(paper.id) || paper);
    });
    setActivePaperId((prev) =>
      prev && nextPapers.some((paper) => paper.id === prev) ? prev : null
    );
    setLibraryLoaded(true);
  };

  useEffect(() => {
    loadLibrary();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleProgress = (event: Event) => {
      const payload = (event as CustomEvent<{ stage?: string; paperId?: string }>).detail || {};
      const paperId = String(payload.paperId || '').trim();
      const stage = String(payload.stage || '').trim();
      if (!paperId || !stage) return;
      const applyStatus = (paper: Paper): Paper => {
        if (paper.id !== paperId) return paper;
        if (stage === '开始解析基本信息') {
          return {
            ...paper,
            isRewritingSummary: false,
            isVectorizing: false,
            summaryRewriteDone: false,
            vectorizationDone: false
          };
        }
        if (stage === '开始重写摘要') {
          return {
            ...paper,
            isRewritingSummary: true,
            summaryRewriteDone: false
          };
        }
        if (stage === '完成重写摘要') {
          return {
            ...paper,
            isRewritingSummary: false,
            summaryRewriteDone: true
          };
        }
        if (stage === '开始向量化') {
          return {
            ...paper,
            isVectorizing: true,
            vectorizationDone: false
          };
        }
        if (stage === '完成向量化') {
          return {
            ...paper,
            isVectorizing: false,
            vectorizationDone: true
          };
        }
        return paper;
      };
      setPapers((prev) => prev.map(applyStatus));
      setOpenPapers((prev) => prev.map(applyStatus));
    };
    window.addEventListener('mindpaper-progress', handleProgress as EventListener);
    return () => {
      window.removeEventListener('mindpaper-progress', handleProgress as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!libraryLoaded) return;
    if (typeof window === 'undefined' || !window.electronAPI?.library) return;
    if (window.electronAPI.library.saveSnapshot) {
      window.electronAPI.library.saveSnapshot({ folders, papers });
      return;
    }
    window.electronAPI.library.saveFolders?.(folders);
    window.electronAPI.library.savePapers?.(papers);
  }, [folders, papers, libraryLoaded]);

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
      setSettingsOpen(false);
      await loadLibrary();
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
         <div className="p-1 shrink-0">
           <Tooltip label="主界面">
             <button 
               onClick={switchToLibrary}
               className={`p-1.5 rounded-md transition-colors 
                 ${activePaperId === null ? 'bg-white text-gray-900 shadow-md shadow-gray-350/70' : 'text-gray-500 hover:bg-gray-200'}`}
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
                     group relative flex items-center min-w-[120px] max-w-[200px] px-2 py-1.5 rounded-md cursor-pointer text-xs font-medium transition-all
                     ${isActive 
                       ? 'bg-white shadow-md shadow-gray-350/70 text-gray-900' 
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
               className="p-1.5 text-gray-500 hover:bg-gray-200 rounded-md"
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
            onDeletePaper={handleDeletePaper}
            onMovePaperToFolder={handleMovePaperToFolder}
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
                  onUpdatePaper={handleUpdatePaper}
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
              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">API KEY</label>
                <input
                  type="password"
                  value={settingsForm.apiKey}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, apiKey: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="sk-..."
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">API URL</label>
                <input
                  type="text"
                  value={settingsForm.baseUrl}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">OpenAI模型</label>
                <input
                  type="text"
                  value={settingsForm.model}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, model: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="gpt-3.5-turbo"
                />
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="text-xs text-gray-500">数据保存路径</label>
                <input
                  type="text"
                  value={settingsForm.libraryPath}
                  onChange={(e) =>
                    setSettingsForm((prev) => ({ ...prev, libraryPath: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50"
                  placeholder="/Users/you/Library/MindPaper"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                  <div className="text-xs text-gray-700">AI翻译</div>
                  <button
                    type="button"
                    onClick={() =>
                      setSettingsForm((prev) => ({
                        ...prev,
                        translationEngine: prev.translationEngine === 'openai' ? 'cnki' : 'openai'
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      settingsForm.translationEngine === 'openai' ? 'bg-emerald-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        settingsForm.translationEngine === 'openai' ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
                  <div className="text-xs text-gray-700">AI解析</div>
                  <button
                    type="button"
                    onClick={() =>
                      setSettingsForm((prev) => ({ ...prev, parsePdfWithAI: !prev.parsePdfWithAI }))
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      settingsForm.parsePdfWithAI ? 'bg-emerald-500' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        settingsForm.parsePdfWithAI ? 'translate-x-5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {settingsError ? (
              <div className="mt-3 text-xs text-red-500">{settingsError}</div>
            ) : null}

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[11px] text-gray-400">
                开启 AI 功能需填写 API KEY / URL / 模型。
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
      const isUnknownLike = (value: string) => {
        const v = String(value || '').trim().toLowerCase();
        return !v || v === 'unknown' || v === 'unknow';
      };
