module.exports = function createSqliteModule(deps = {}) {
  const {
    path,
    fs,
    fsNative,
    syncPendingKey,
    getLibraryPaths,
    loadSettings,
    sanitizePaperForMeta,
    normalizePaperForStorage,
    getPaperArticleId,
    deletePaperVectorPoints,
    enqueueSummaryVectorSync,
    migrateExistingLibraryToSqlite
  } = deps;

  let sqliteDriver = null;
  let libraryDb = null;
  let libraryDbRoot = '';
  let libraryStoreReadyPromise = null;

  const safeJsonParse = (value, fallback) => {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const getSqliteDriver = () => {
    if (sqliteDriver) return sqliteDriver;
    try {
      sqliteDriver = require('better-sqlite3');
      return sqliteDriver;
    } catch (error) {
      throw new Error(`缺少 better-sqlite3 依赖: ${error?.message || error}`);
    }
  };

  const closeLibraryDb = () => {
    if (!libraryDb) return;
    try {
      libraryDb.close();
    } catch {
      // ignore close errors
    }
    libraryDb = null;
    libraryDbRoot = '';
  };

  const resetLibraryStore = () => {
    closeLibraryDb();
    libraryStoreReadyPromise = null;
  };

  const getLibraryDb = () => {
    const paths = getLibraryPaths();
    if (libraryDb && libraryDbRoot === paths.root) return libraryDb;
    closeLibraryDb();
    const Database = getSqliteDriver();
    libraryDb = new Database(paths.sqlitePath);
    libraryDbRoot = paths.root;
    libraryDb.pragma('journal_mode = WAL');
    libraryDb.pragma('synchronous = NORMAL');
    libraryDb.pragma('foreign_keys = ON');
    return libraryDb;
  };

  const ensureLibrarySqliteSchema = () => {
    const db = getLibraryDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        base_version INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL DEFAULT '',
        added_date TEXT NOT NULL DEFAULT '',
        uploaded_at INTEGER NOT NULL DEFAULT 0,
        folder_id TEXT NOT NULL DEFAULT '',
        previous_folder_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        abstract TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        publisher TEXT NOT NULL DEFAULT '',
        doi TEXT NOT NULL DEFAULT '',
        references_json TEXT NOT NULL DEFAULT '[]',
        reference_stats_json TEXT,
        file_path TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paper_states (
        paper_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_papers_sort_order ON papers(sort_order);
      CREATE INDEX IF NOT EXISTS idx_papers_folder_id ON papers(folder_id);
    `);
    const columns = db.prepare("PRAGMA table_info('papers')").all();
    const columnNames = new Set(columns.map((column) => String(column?.name || '').trim()));
    if (!columnNames.has('version')) {
      db.exec('ALTER TABLE papers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
    }
    if (!columnNames.has('base_version')) {
      db.exec('ALTER TABLE papers ADD COLUMN base_version INTEGER NOT NULL DEFAULT 0;');
      db.exec('UPDATE papers SET base_version = version WHERE base_version = 0;');
    }
  };

  const getLibraryKv = (key, fallback = null) => {
    const db = getLibraryDb();
    const row = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get(String(key || '').trim());
    if (!row) return fallback;
    return safeJsonParse(row.value_json, fallback);
  };

  const setLibraryKv = (key, value) => {
    const db = getLibraryDb();
    db.prepare(
      `
        INSERT INTO app_kv (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `
    ).run(String(key || '').trim(), JSON.stringify(value ?? null), Date.now());
  };

  const getSyncPending = () => Boolean(getLibraryKv(syncPendingKey, false));

  const setSyncPending = (value) => {
    setLibraryKv(syncPendingKey, Boolean(value));
  };

  const deletePaperStatesFromSqlite = (paperIds = []) => {
    const ids = Array.isArray(paperIds) ? paperIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return;
    const db = getLibraryDb();
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM paper_states WHERE paper_id IN (${placeholders})`).run(...ids);
  };

  const deletePapersFromSqlite = (paperIds = []) => {
    const ids = Array.isArray(paperIds) ? paperIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return [];
    deletePaperStatesFromSqlite(ids);
    const db = getLibraryDb();
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...ids);
    return ids;
  };

  const mapSqlitePaperRow = (row, paths = getLibraryPaths()) =>
    sanitizePaperForMeta(
      {
        id: row?.id,
        title: row?.title,
        author: row?.author,
        date: row?.date,
        addedDate: row?.added_date,
        uploadedAt: row?.uploaded_at,
        folderId: row?.folder_id,
        previousFolderId: row?.previous_folder_id,
        summary: row?.summary,
        abstract: row?.abstract,
        content: row?.content,
        keywords: safeJsonParse(row?.keywords_json, []),
        publisher: row?.publisher,
        doi: row?.doi,
        version: row?.version,
        baseVersion: row?.base_version,
        updatedAt: row?.updated_at,
        references: safeJsonParse(row?.references_json, []),
        referenceStats: safeJsonParse(row?.reference_stats_json, undefined),
        filePath: row?.file_path
      },
      String(row?.file_path || '').trim() || path.join(paths.papersDir, `${getPaperArticleId(row?.id)}.pdf`)
    );

  const loadFoldersFromSqlite = async () => {
    const folders = getLibraryKv('folders', []);
    return Array.isArray(folders) ? folders : [];
  };

  const loadLibraryDataFromSqliteFile = (sqlitePath, options = {}) => {
    const targetPath = String(sqlitePath || '').trim();
    if (!targetPath || !fsNative.existsSync(targetPath)) {
      return { folders: [], papers: [], states: [] };
    }
    const Database = getSqliteDriver();
    const db = new Database(targetPath, { readonly: true, fileMustExist: true });
    const paths = {
      ...getLibraryPaths(),
      root: options.root || path.dirname(targetPath),
      papersDir: options.papersDir || path.join(options.root || path.dirname(targetPath), 'papers'),
      sqlitePath: targetPath
    };
    try {
      const foldersRow = db.prepare('SELECT value_json FROM app_kv WHERE key = ?').get('folders');
      const folders = Array.isArray(safeJsonParse(foldersRow?.value_json, []))
        ? safeJsonParse(foldersRow?.value_json, [])
        : [];
      const paperRows = db.prepare('SELECT * FROM papers ORDER BY sort_order ASC, uploaded_at ASC, id ASC').all();
      const stateRows = db
        .prepare('SELECT paper_id, state_json FROM paper_states ORDER BY updated_at ASC, paper_id ASC')
        .all();
      return {
        folders,
        papers: paperRows.map((row) => mapSqlitePaperRow(row, paths)),
        states: stateRows.map((row) => ({
          paperId: String(row?.paper_id || '').trim(),
          state: safeJsonParse(row?.state_json, {})
        }))
      };
    } finally {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  };

  const saveFoldersToSqlite = async (folders) => {
    const payload = Array.isArray(folders) ? folders : [];
    setLibraryKv('folders', payload);
    return payload;
  };

  const loadPapersFromSqlite = async () => {
    const db = getLibraryDb();
    const paths = getLibraryPaths();
    const rows = db.prepare('SELECT * FROM papers ORDER BY sort_order ASC, uploaded_at ASC, id ASC').all();
    return rows.map((row) => mapSqlitePaperRow(row, paths));
  };

  const buildPaperStorageComparable = (paper) =>
    JSON.stringify({
      title: String(paper?.title || '').trim(),
      author: String(paper?.author || '').trim(),
      date: String(paper?.date || '').trim(),
      addedDate: String(paper?.addedDate || '').trim(),
      uploadedAt: Number(paper?.uploadedAt || 0),
      folderId: String(paper?.folderId || '').trim(),
      previousFolderId: String(paper?.previousFolderId || '').trim(),
      summary: String(paper?.summary || '').trim(),
      abstract: String(paper?.abstract || '').trim(),
      content: String(paper?.content || ''),
      keywords: Array.isArray(paper?.keywords) ? paper.keywords : [],
      publisher: String(paper?.publisher || '').trim(),
      doi: String(paper?.doi || '').trim(),
      baseVersion: Math.max(0, Number(paper?.baseVersion ?? 0) || 0),
      references: Array.isArray(paper?.references) ? paper.references : [],
      referenceStats: paper?.referenceStats || null,
      filePath: String(paper?.filePath || '').trim()
    });

  const savePapersToSqlite = async (papers, paths, options = {}) => {
    const preserveIncomingVersion = Boolean(options?.preserveIncomingVersion);
    const source = Array.isArray(papers) ? papers : [];
    const runtimeStateById = new Map(
      source
        .map((paper) => [
          String(paper?.id || '').trim(),
          {
            isParsing: Boolean(paper?.isParsing),
            isBackgroundProcessing: Boolean(paper?.isBackgroundProcessing)
          }
        ])
        .filter((entry) => entry[0])
    );

    const normalizedPapers = [];
    for (let index = 0; index < source.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const normalized = await normalizePaperForStorage(source[index], paths);
      if (!normalized) continue;
      normalizedPapers.push({ order: index, paper: normalized });
    }

    const db = getLibraryDb();
    const existingRows = db.prepare('SELECT * FROM papers').all();
    const existingById = new Map(
      existingRows
        .map((row) => {
          const mapped = mapSqlitePaperRow(row, paths);
          const id = String(mapped?.id || '').trim();
          if (!id) return null;
          return [
            id,
            {
              row,
              mapped,
              comparable: buildPaperStorageComparable(mapped)
            }
          ];
        })
        .filter(Boolean)
    );
    const existingIds = db.prepare('SELECT id FROM papers').all().map((row) => String(row.id || '').trim());
    const nextIds = new Set(normalizedPapers.map((item) => String(item.paper?.id || '').trim()).filter(Boolean));
    const removedPaperIds = existingIds.filter((id) => id && !nextIds.has(id));

    const upsertPaper = db.prepare(`
      INSERT INTO papers (
        id, sort_order, title, author, date, added_date, uploaded_at, folder_id, previous_folder_id,
        version, base_version, summary, abstract, content, keywords_json, publisher, doi, references_json,
        reference_stats_json, file_path, updated_at
      ) VALUES (
        @id, @sort_order, @title, @author, @date, @added_date, @uploaded_at, @folder_id, @previous_folder_id,
        @version, @base_version,
        @summary, @abstract, @content, @keywords_json, @publisher, @doi, @references_json,
        @reference_stats_json, @file_path, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        sort_order = excluded.sort_order,
        title = excluded.title,
        author = excluded.author,
        date = excluded.date,
        added_date = excluded.added_date,
        uploaded_at = excluded.uploaded_at,
        folder_id = excluded.folder_id,
        previous_folder_id = excluded.previous_folder_id,
        version = excluded.version,
        base_version = excluded.base_version,
        summary = excluded.summary,
        abstract = excluded.abstract,
        content = excluded.content,
        keywords_json = excluded.keywords_json,
        publisher = excluded.publisher,
        doi = excluded.doi,
        references_json = excluded.references_json,
        reference_stats_json = excluded.reference_stats_json,
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `);

    const writeTransaction = db.transaction((items) => {
      items.forEach(({ order, paper }) => {
        const existing = existingById.get(String(paper?.id || '').trim());
        const nextComparable = buildPaperStorageComparable(paper);
        const unchanged = existing && existing.comparable === nextComparable;
        const existingVersion = Number(existing?.row?.version || existing?.mapped?.version || 1);
        const existingBaseVersion = Math.max(
          0,
          Number(existing?.row?.base_version ?? existing?.mapped?.baseVersion ?? existingVersion) || 0
        );
        const incomingVersion = Math.max(1, Number(paper?.version || existingVersion || 1) || 1);
        const incomingBaseVersion = Math.max(
          0,
          Number(paper?.baseVersion ?? existingBaseVersion ?? 0) || 0
        );
        const version = preserveIncomingVersion
          ? incomingVersion
          : unchanged
            ? existingVersion
            : existingVersion + 1;
        const baseVersion = preserveIncomingVersion
          ? incomingBaseVersion
          : unchanged
            ? existingBaseVersion
            : existingBaseVersion;
        const updatedAt = preserveIncomingVersion
          ? Number(paper?.updatedAt || existing?.row?.updated_at || existing?.mapped?.updatedAt || Date.now())
          : unchanged
            ? Number(existing?.row?.updated_at || existing?.mapped?.updatedAt || Date.now())
            : Date.now();
        upsertPaper.run({
          id: paper.id,
          sort_order: order,
          title: paper.title || '',
          author: paper.author || '',
          date: paper.date || '',
          added_date: paper.addedDate || '',
          uploaded_at: Number(paper.uploadedAt || 0),
          folder_id: paper.folderId || '',
          previous_folder_id: paper.previousFolderId || '',
          version,
          base_version: baseVersion,
          summary: paper.summary || '',
          abstract: paper.abstract || '',
          content: paper.content || '',
          keywords_json: JSON.stringify(Array.isArray(paper.keywords) ? paper.keywords : []),
          publisher: paper.publisher || '',
          doi: paper.doi || '',
          references_json: JSON.stringify(Array.isArray(paper.references) ? paper.references : []),
          reference_stats_json: paper.referenceStats ? JSON.stringify(paper.referenceStats) : null,
          file_path: paper.filePath || '',
          updated_at: updatedAt
        });
        paper.version = version;
        paper.baseVersion = baseVersion;
        paper.updatedAt = updatedAt;
      });
      if (!items.length) {
        db.prepare('DELETE FROM papers').run();
        db.prepare('DELETE FROM paper_states').run();
        return;
      }
      if (removedPaperIds.length) {
        deletePaperStatesFromSqlite(removedPaperIds);
        const placeholders = removedPaperIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...removedPaperIds);
      }
    });

    writeTransaction(normalizedPapers);

    if (removedPaperIds.length) {
      await deletePaperVectorPoints(removedPaperIds);
    }

    const persistedPapers = normalizedPapers.map((item) => item.paper);
    const vectorReadyPapers = persistedPapers.filter((paper) => {
      const state = runtimeStateById.get(String(paper?.id || '').trim());
      return !state?.isParsing && !state?.isBackgroundProcessing;
    });
    if (vectorReadyPapers.length) {
      void enqueueSummaryVectorSync(vectorReadyPapers);
    }
    return persistedPapers;
  };

  const markAllPapersBaseVersionCurrent = (paperIds = null) => {
    const db = getLibraryDb();
    const ids = Array.isArray(paperIds)
      ? paperIds.map((id) => String(id || '').trim()).filter(Boolean)
      : null;
    if (ids && !ids.length) return 0;
    if (!ids) {
      const result = db.prepare('UPDATE papers SET base_version = version').run();
      return Number(result?.changes || 0);
    }
    const placeholders = ids.map(() => '?').join(', ');
    const result = db.prepare(`UPDATE papers SET base_version = version WHERE id IN (${placeholders})`).run(...ids);
    return Number(result?.changes || 0);
  };

  const savePaperStateToSqlite = async (paperId, state) => {
    const normalizedPaperId = String(paperId || '').trim();
    if (!normalizedPaperId) return { ok: false, error: '缺少paperId' };
    const db = getLibraryDb();
    db.prepare(
      `
        INSERT INTO paper_states (paper_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `
    ).run(normalizedPaperId, JSON.stringify(state || {}), Date.now());
    return { ok: true };
  };

  const loadPaperStateFromSqlite = async (paperId) => {
    const normalizedPaperId = String(paperId || '').trim();
    if (!normalizedPaperId) return null;
    const db = getLibraryDb();
    const row = db.prepare('SELECT state_json FROM paper_states WHERE paper_id = ?').get(normalizedPaperId);
    return row ? safeJsonParse(row.state_json, null) : null;
  };

  const loadPaperStatesFromSqlite = async () => {
    const db = getLibraryDb();
    return db
      .prepare('SELECT paper_id, state_json FROM paper_states ORDER BY updated_at ASC, paper_id ASC')
      .all()
      .map((row) => ({
        paperId: String(row?.paper_id || '').trim(),
        state: safeJsonParse(row?.state_json, {})
      }))
      .filter((item) => item.paperId);
  };

  const markPaperStateAnnotationsBaseVersionCurrent = async (paperIds = null) => {
    const db = getLibraryDb();
    const ids = Array.isArray(paperIds)
      ? paperIds.map((id) => String(id || '').trim()).filter(Boolean)
      : null;
    if (ids && !ids.length) return 0;
    const rows = ids
      ? db
          .prepare(
            `SELECT paper_id, state_json FROM paper_states WHERE paper_id IN (${ids
              .map(() => '?')
              .join(', ')})`
          )
          .all(...ids)
      : db.prepare('SELECT paper_id, state_json FROM paper_states').all();
    const update = db.prepare(
      `
        UPDATE paper_states
        SET state_json = ?, updated_at = ?
        WHERE paper_id = ?
      `
    );
    const cloneJsonValue = (value, fallback = null) => {
      try {
        return JSON.parse(JSON.stringify(value == null ? fallback : value));
      } catch {
        return fallback;
      }
    };
    const buildStateComparable = (value) => JSON.stringify(value ?? null);
    const normalizeReaderQuestion = (item = {}) => {
      const id = String(item?.id || '').trim();
      if (!id) return null;
      return {
        id,
        text: String(item?.text || '').trim()
      };
    };
    const normalizeQuestionsPayload = (value) =>
      (Array.isArray(value) ? value : []).map((item) => normalizeReaderQuestion(item)).filter(Boolean);
    const normalizeChatMessage = (item = {}) => {
      if (!item || (item.role !== 'user' && item.role !== 'model')) return null;
      return {
        role: item.role,
        text: String(item.text || '')
      };
    };
    const normalizeChatThread = (item = {}) => {
      const id = String(item?.id || '').trim();
      if (!id) return null;
      return {
        id,
        title: String(item?.title || '新对话'),
        messages: (Array.isArray(item?.messages) ? item.messages : [])
          .map((message) => normalizeChatMessage(message))
          .filter(Boolean),
        createdAt: Number(item?.createdAt || Date.now()) || Date.now(),
        updatedAt: Number(item?.updatedAt || Date.now()) || Date.now()
      };
    };
    const normalizeAiConversationPayload = (value = {}) => {
      const threads = (Array.isArray(value?.threads) ? value.threads : [])
        .map((item) => normalizeChatThread(item))
        .filter(Boolean);
      const activeChatId = String(value?.activeChatId || '').trim();
      return {
        threads,
        activeChatId: activeChatId && threads.some((thread) => thread.id === activeChatId) ? activeChatId : null
      };
    };
    const normalizeVersionedStateEnvelope = (value, normalizePayload) => {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'value')) {
        return null;
      }
      return {
        version: Math.max(1, Number(value?.version || 1) || 1),
        baseVersion: Math.max(0, Number(value?.baseVersion ?? 0) || 0),
        updatedAt: Number(value?.updatedAt || Date.now()) || Date.now(),
        value: normalizePayload(value?.value)
      };
    };
    const buildSyncedVersionedState = (value, normalizePayload, updatedAt, fallbackVersion = 1) => {
      const normalizedValue = normalizePayload(value);
      const version = Math.max(1, Number(fallbackVersion || 1) || 1);
      return {
        version,
        baseVersion: version,
        updatedAt: Number(updatedAt || Date.now()) || Date.now(),
        value: cloneJsonValue(normalizedValue, null)
      };
    };
    let changed = 0;
    rows.forEach((row) => {
      const state = safeJsonParse(row?.state_json, {});
      const source = Array.isArray(state?.annotations) ? state.annotations : [];
      const legacyHighlights = Array.isArray(state?.highlights) ? state.highlights : [];
      const legacyCustomChapters = Array.isArray(state?.customChapters) ? state.customChapters : [];
      if (!source.length && !legacyHighlights.length && !legacyCustomChapters.length) return;
      let touched = false;
      const annotations = source
        .map((item) => {
          const id = String(item?.id || '').trim();
          if (!id) return null;
          const version = Math.max(1, Number(item?.version || 1) || 1);
          const baseVersion = Math.max(0, Number(item?.baseVersion ?? 0) || 0);
          if (baseVersion !== version) touched = true;
          return {
            ...item,
            id,
            version,
            baseVersion: version,
            parentId: item?.parentId == null ? null : String(item.parentId || '').trim(),
            topRatio: item?.topRatio == null ? null : Number(item.topRatio || 0)
          };
        })
        .filter(Boolean);
      legacyHighlights.forEach((item) => {
        const id = String(item?.id || '').trim();
        if (!id) return;
        touched = true;
        annotations.push({
          ...item,
          id,
          version: Math.max(1, Number(item?.version || 1) || 1),
          baseVersion: Math.max(1, Number(item?.version || 1) || 1),
          parentId: item?.parentId == null ? null : String(item.parentId || '').trim(),
          topRatio: item?.topRatio == null ? null : Number(item.topRatio || 0)
        });
      });
      const chapterLookup = new Set(
        annotations
          .filter((item) => item?.isChapterTitle)
          .map((item) => String(item.chapterNodeId || item.chapterId || item.id).trim())
          .filter(Boolean)
      );
      legacyCustomChapters.forEach((chapter, index) => {
        const chapterId = String(chapter?.id || '').trim();
        if (!chapterId || chapterLookup.has(chapterId)) return;
        touched = true;
        annotations.push({
          id: `chapter-${chapterId}`,
          text: String(chapter?.title || '').trim(),
          color: 'rgba(107, 114, 128, 0.35)',
          pageIndex: Number(chapter?.pageIndex || 0),
          topRatio: chapter?.topRatio == null ? null : Number(chapter.topRatio || 0),
          rects: [],
          chapterId,
          parentId: chapter?.parentId == null ? null : String(chapter.parentId || '').trim(),
          isChapterTitle: true,
          chapterNodeId: chapterId,
          translation: '',
          questionIds: [],
          source: 'manual',
          order: typeof chapter?.order === 'number' ? chapter.order : index,
          version: 1,
          baseVersion: 1,
          updatedAt: Number(chapter?.createdAt || Date.now()) || Date.now(),
          isDeleted: false
        });
      });
      const questionsEnvelope = (() => {
        const existing = normalizeVersionedStateEnvelope(state?.questionsState, normalizeQuestionsPayload);
        const hasLegacy = Array.isArray(state?.questions);
        if (!existing && !hasLegacy) return null;
        const next = existing
          ? buildSyncedVersionedState(
              existing.value,
              normalizeQuestionsPayload,
              existing.updatedAt,
              existing.version
            )
          : buildSyncedVersionedState(
              state?.questions,
              normalizeQuestionsPayload,
              state?.updatedAt,
              1
            );
        if (
          !existing ||
          existing.baseVersion !== existing.version ||
          buildStateComparable(existing.value) !== buildStateComparable(next.value) ||
          buildStateComparable(state?.questions) !== buildStateComparable(next.value)
        ) {
          touched = true;
        }
        return next;
      })();
      const mindmapStateV2Envelope = (() => {
        const existing = normalizeVersionedStateEnvelope(
          state?.mindmapStateV2State,
          (value) => cloneJsonValue(value, null)
        );
        const hasLegacy = Object.prototype.hasOwnProperty.call(state || {}, 'mindmapStateV2');
        if (!existing && !hasLegacy) return null;
        const next = existing
          ? buildSyncedVersionedState(
              existing.value,
              (value) => cloneJsonValue(value, null),
              existing.updatedAt,
              existing.version
            )
          : buildSyncedVersionedState(
              state?.mindmapStateV2,
              (value) => cloneJsonValue(value, null),
              state?.updatedAt,
              1
            );
        if (
          !existing ||
          existing.baseVersion !== existing.version ||
          buildStateComparable(existing.value) !== buildStateComparable(next.value) ||
          buildStateComparable(state?.mindmapStateV2) !== buildStateComparable(next.value)
        ) {
          touched = true;
        }
        return next;
      })();
      const aiConversationsEnvelope = (() => {
        const existing = normalizeVersionedStateEnvelope(
          state?.aiConversationsState,
          normalizeAiConversationPayload
        );
        const hasLegacy =
          Array.isArray(state?.aiConversations) ||
          Object.prototype.hasOwnProperty.call(state || {}, 'activeChatId');
        if (!existing && !hasLegacy) return null;
        const next = existing
          ? buildSyncedVersionedState(
              existing.value,
              normalizeAiConversationPayload,
              existing.updatedAt,
              existing.version
            )
          : buildSyncedVersionedState(
              {
                threads: state?.aiConversations,
                activeChatId: state?.activeChatId
              },
              normalizeAiConversationPayload,
              state?.updatedAt,
              1
            );
        const legacyPayloadComparable = buildStateComparable(
          normalizeAiConversationPayload({
            threads: state?.aiConversations,
            activeChatId: state?.activeChatId
          })
        );
        if (
          !existing ||
          existing.baseVersion !== existing.version ||
          buildStateComparable(existing.value) !== buildStateComparable(next.value) ||
          legacyPayloadComparable !== buildStateComparable(next.value)
        ) {
          touched = true;
        }
        return next;
      })();
      if (!touched) return;
      const nextState = {
        ...(state || {}),
        annotations,
        highlights: undefined,
        customChapters: undefined,
        ...(questionsEnvelope
          ? {
              questions: questionsEnvelope.value,
              questionsState: questionsEnvelope
            }
          : {}),
        ...(mindmapStateV2Envelope
          ? {
              mindmapStateV2: mindmapStateV2Envelope.value,
              mindmapStateV2State: mindmapStateV2Envelope
            }
          : {}),
        ...(aiConversationsEnvelope
          ? {
              aiConversations: aiConversationsEnvelope.value.threads,
              activeChatId: aiConversationsEnvelope.value.activeChatId,
              aiConversationsState: aiConversationsEnvelope
            }
          : {})
      };
      update.run(JSON.stringify(nextState), Date.now(), String(row?.paper_id || '').trim());
      changed += 1;
    });
    return changed;
  };

  const ensureLibrary = async () => {
    await loadSettings();
    const paths = getLibraryPaths();
    await fs.mkdir(paths.root, { recursive: true });
    await fs.mkdir(paths.papersDir, { recursive: true });
    await fs.mkdir(paths.statesDir, { recursive: true });
  };

  const ensureLibraryStoreReady = async () => {
    if (libraryStoreReadyPromise) return libraryStoreReadyPromise;
    libraryStoreReadyPromise = (async () => {
      await ensureLibrary();
      ensureLibrarySqliteSchema();
      const paths = getLibraryPaths();
      await migrateExistingLibraryToSqlite(paths);
      const db = getLibraryDb();
      const paperCount = Number(db.prepare('SELECT COUNT(*) AS count FROM papers').get()?.count || 0);
      const stateCount = Number(db.prepare('SELECT COUNT(*) AS count FROM paper_states').get()?.count || 0);
      const folders = getLibraryKv('folders', []);
      const folderCount = Array.isArray(folders) ? folders.length : 0;
      console.log(
        `[library-sqlite] ready: path=${paths.sqlitePath}, papers=${paperCount}, states=${stateCount}, folders=${folderCount}`
      );
      return true;
    })().catch((error) => {
      libraryStoreReadyPromise = null;
      throw error;
    });
    return libraryStoreReadyPromise;
  };

  return {
    getSqliteDriver,
    closeLibraryDb,
    resetLibraryStore,
    getLibraryDb,
    ensureLibrarySqliteSchema,
    getLibraryKv,
    setLibraryKv,
    getSyncPending,
    setSyncPending,
    deletePaperStatesFromSqlite,
    deletePapersFromSqlite,
    mapSqlitePaperRow,
    loadFoldersFromSqlite,
    loadLibraryDataFromSqliteFile,
    saveFoldersToSqlite,
    loadPapersFromSqlite,
    savePapersToSqlite,
    markAllPapersBaseVersionCurrent,
    savePaperStateToSqlite,
    loadPaperStateFromSqlite,
    loadPaperStatesFromSqlite,
    markPaperStateAnnotationsBaseVersionCurrent,
    ensureLibraryStoreReady,
    ensureLibrary
  };
};
