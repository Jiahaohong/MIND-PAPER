module.exports = function createSqliteModule(deps = {}) {
  const {
    path,
    fs,
    fsNative,
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
  let syncQueueSuppressedDepth = 0;

  const SYNC_ENTITY_TYPES = new Set(['folders', 'papers', 'paper_state', 'pdf']);
  const SYNC_ACTIONS = new Set(['upsert', 'delete']);

  const safeJsonParse = (value, fallback) => {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const buildPaperStateStorageComparable = (state) => {
    const source = state && typeof state === 'object' ? state : {};
    return JSON.stringify({
      ...source,
      updatedAt: 0
    });
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

      CREATE TABLE IF NOT EXISTS sync_queue (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS sync_delete_log (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY(entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_papers_sort_order ON papers(sort_order);
      CREATE INDEX IF NOT EXISTS idx_papers_folder_id ON papers(folder_id);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_updated_at ON sync_queue(updated_at);
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

  const shouldTrackSyncQueue = (options = {}) =>
    !syncQueueSuppressedDepth && !Boolean(options?.skipSyncQueue);

  const normalizeSyncEntityType = (value) => {
    const normalized = String(value || '').trim();
    if (!SYNC_ENTITY_TYPES.has(normalized)) {
      throw new Error(`不支持的同步实体类型: ${normalized || '(empty)'}`);
    }
    return normalized;
  };

  const normalizeSyncAction = (value) => {
    const normalized = String(value || '').trim();
    if (!SYNC_ACTIONS.has(normalized)) {
      throw new Error(`不支持的同步动作: ${normalized || '(empty)'}`);
    }
    return normalized;
  };

  const recordSyncChange = (change = {}, options = {}) => {
    if (!shouldTrackSyncQueue(options)) return;
    const entityType = normalizeSyncEntityType(change.entityType);
    const entityId = String(change.entityId || '').trim();
    const action = normalizeSyncAction(change.action || 'upsert');
    if (!entityId) {
      throw new Error(`同步实体缺少 id: ${entityType}`);
    }
    const payload =
      change.payload && typeof change.payload === 'object' && !Array.isArray(change.payload)
        ? change.payload
        : {};
    const payloadJson = JSON.stringify(payload);
    const updatedAt = Number(change.updatedAt || Date.now());
    const db = getLibraryDb();
    db.prepare(
      `
        INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          action = excluded.action,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `
    ).run(entityType, entityId, action, payloadJson, updatedAt);

    if (action === 'delete') {
      db.prepare(
        `
          INSERT INTO sync_delete_log (entity_type, entity_id, deleted_at)
          VALUES (?, ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            deleted_at = excluded.deleted_at
        `
      ).run(entityType, entityId, updatedAt);
    } else {
      db.prepare('DELETE FROM sync_delete_log WHERE entity_type = ? AND entity_id = ?').run(
        entityType,
        entityId
      );
    }
  };

  const loadSyncQueueEntries = () => {
    const db = getLibraryDb();
    return db
      .prepare('SELECT entity_type, entity_id, action, payload_json, updated_at FROM sync_queue ORDER BY updated_at ASC')
      .all()
      .map((row) => ({
        entityType: String(row?.entity_type || '').trim(),
        entityId: String(row?.entity_id || '').trim(),
        action: String(row?.action || '').trim(),
        payload: safeJsonParse(row?.payload_json, {}),
        updatedAt: Number(row?.updated_at || 0)
      }))
      .filter((item) => item.entityType && item.entityId && item.action);
  };

  const clearSyncQueueEntries = (entries = null) => {
    const db = getLibraryDb();
    if (!entries) {
      db.prepare('DELETE FROM sync_queue').run();
      return;
    }
    const normalized = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        entityType: String(entry?.entityType || '').trim(),
        entityId: String(entry?.entityId || '').trim()
      }))
      .filter((entry) => entry.entityType && entry.entityId);
    if (!normalized.length) return;
    const remove = db.prepare('DELETE FROM sync_queue WHERE entity_type = ? AND entity_id = ?');
    const tx = db.transaction((items) => {
      items.forEach((item) => remove.run(item.entityType, item.entityId));
    });
    tx(normalized);
  };

  const getSyncQueueSize = () => {
    const db = getLibraryDb();
    return Number(db.prepare('SELECT COUNT(*) AS count FROM sync_queue').get()?.count || 0);
  };

  const withSyncQueueSuppressed = async (task) => {
    syncQueueSuppressedDepth += 1;
    try {
      return await task();
    } finally {
      syncQueueSuppressedDepth = Math.max(0, syncQueueSuppressedDepth - 1);
    }
  };

  const deletePaperStatesFromSqlite = (paperIds = []) => {
    const ids = Array.isArray(paperIds) ? paperIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return;
    const db = getLibraryDb();
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM paper_states WHERE paper_id IN (${placeholders})`).run(...ids);
  };

  const deletePapersFromSqlite = (paperIds = [], options = {}) => {
    const ids = Array.isArray(paperIds) ? paperIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (!ids.length) return [];
    deletePaperStatesFromSqlite(ids);
    const db = getLibraryDb();
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...ids);
    recordSyncChange(
      {
        entityType: 'papers',
        entityId: 'library',
        action: 'upsert',
        payload: { papers: buildCurrentPapersSnapshot() }
      },
      options
    );
    ids.forEach((paperId) => {
      recordSyncChange(
        {
          entityType: 'paper_state',
          entityId: paperId,
          action: 'delete',
          payload: { paperId }
        },
        options
      );
      recordSyncChange(
        {
          entityType: 'pdf',
          entityId: paperId,
          action: 'delete',
          payload: { paperId }
        },
        options
      );
    });
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

  const saveFoldersToSqlite = async (folders, options = {}) => {
    const payload = Array.isArray(folders) ? folders : [];
    const changed = JSON.stringify(loadFoldersFromSqlite ? await loadFoldersFromSqlite() : []) !== JSON.stringify(payload);
    if (!changed) {
      return {
        folders: payload,
        changed: false
      };
    }
    setLibraryKv('folders', payload);
    recordSyncChange(
      {
        entityType: 'folders',
        entityId: 'library',
        action: 'upsert',
        payload: { folders: payload }
      },
      options
    );
    return {
      folders: payload,
      changed: true
    };
  };

  const loadPapersFromSqlite = async () => {
    const db = getLibraryDb();
    const paths = getLibraryPaths();
    const rows = db.prepare('SELECT * FROM papers ORDER BY sort_order ASC, uploaded_at ASC, id ASC').all();
    return rows.map((row) => mapSqlitePaperRow(row, paths));
  };

  const buildCurrentPapersSnapshot = () => {
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

    let changed = removedPaperIds.length > 0;
    const writeTransaction = db.transaction((items) => {
      items.forEach(({ order, paper }) => {
        const existing = existingById.get(String(paper?.id || '').trim());
        const nextComparable = buildPaperStorageComparable(paper);
        const unchanged = existing && existing.comparable === nextComparable;
        if (!unchanged || !existing || Number(existing?.row?.sort_order ?? existing?.mapped?.sortOrder ?? order) !== order) {
          changed = true;
        }
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

    if (changed) {
      recordSyncChange(
        {
          entityType: 'papers',
          entityId: 'library',
          action: 'upsert',
          payload: { papers: persistedPapers }
        },
        options
      );
      removedPaperIds.forEach((paperId) => {
        recordSyncChange(
          {
            entityType: 'paper_state',
            entityId: paperId,
            action: 'delete',
            payload: { paperId }
          },
          options
        );
        recordSyncChange(
          {
            entityType: 'pdf',
            entityId: paperId,
            action: 'delete',
            payload: { paperId }
          },
          options
        );
      });
    }

    return {
      papers: persistedPapers,
      changed
    };
  };

  const savePaperStateToSqlite = async (paperId, state, options = {}) => {
    const normalizedPaperId = String(paperId || '').trim();
    if (!normalizedPaperId) return { ok: false, error: '缺少paperId' };
    const db = getLibraryDb();
    const nextStateJson = JSON.stringify(state || {});
    const existing = db.prepare('SELECT state_json FROM paper_states WHERE paper_id = ?').get(normalizedPaperId);
    if (
      buildPaperStateStorageComparable(safeJsonParse(existing?.state_json, {})) ===
      buildPaperStateStorageComparable(state || {})
    ) {
      return { ok: true, changed: false };
    }
    db.prepare(
      `
        INSERT INTO paper_states (paper_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `
    ).run(normalizedPaperId, nextStateJson, Date.now());
    recordSyncChange(
      {
        entityType: 'paper_state',
        entityId: normalizedPaperId,
        action: 'upsert',
        payload: {
          paperId: normalizedPaperId,
          state: state || {}
        }
      },
      options
    );
    return { ok: true, changed: true };
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
    recordSyncChange,
    loadSyncQueueEntries,
    clearSyncQueueEntries,
    getSyncQueueSize,
    withSyncQueueSuppressed,
    deletePaperStatesFromSqlite,
    deletePapersFromSqlite,
    mapSqlitePaperRow,
    loadFoldersFromSqlite,
    loadLibraryDataFromSqliteFile,
    saveFoldersToSqlite,
    loadPapersFromSqlite,
    savePapersToSqlite,
    savePaperStateToSqlite,
    loadPaperStateFromSqlite,
    loadPaperStatesFromSqlite,
    ensureLibraryStoreReady,
    ensureLibrary
  };
};
