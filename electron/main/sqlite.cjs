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
      references: Array.isArray(paper?.references) ? paper.references : [],
      referenceStats: paper?.referenceStats || null,
      filePath: String(paper?.filePath || '').trim()
    });

  const savePapersToSqlite = async (papers, paths) => {
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
        version, summary, abstract, content, keywords_json, publisher, doi, references_json,
        reference_stats_json, file_path, updated_at
      ) VALUES (
        @id, @sort_order, @title, @author, @date, @added_date, @uploaded_at, @folder_id, @previous_folder_id,
        @version,
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
        const version = unchanged
          ? Number(existing.row?.version || existing.mapped?.version || 1)
          : Number(existing?.row?.version || existing?.mapped?.version || 0) + 1;
        const updatedAt = unchanged
          ? Number(existing.row?.updated_at || existing.mapped?.updatedAt || Date.now())
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
    savePaperStateToSqlite,
    loadPaperStateFromSqlite,
    loadPaperStatesFromSqlite,
    ensureLibraryStoreReady,
    ensureLibrary
  };
};
