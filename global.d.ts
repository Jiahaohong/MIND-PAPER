export {};

declare global {
  interface Window {
    electron?: {
      platform?: string;
    };
    electronAPI?: {
      translateText?: (payload: { text: string }) => Promise<{
        ok: boolean;
        content?: string;
        error?: string;
        engine?: string;
      }>;
      askAI?: (payload: {
        prompt: string;
        messages?: Array<{ role: 'user' | 'model'; text: string }>;
      }) => Promise<{
        ok: boolean;
        content?: string;
        error?: string;
      }>;
      searchPaperOpenSource?: (title: string) => Promise<{
        source: 'OpenAlex' | 'Semantic Scholar';
        title?: string;
        authors?: string[];
        publication_date?: string;
        venue?: string;
        doi?: string | null;
      } | null>;
      searchPaperReferences?: (payload: { doi: string; title?: string }) => Promise<{
        ok: boolean;
        doi: string;
        total_openalex: number;
        total_semanticscholar: number;
        intersection_count: number;
        union_count?: number;
        references: Array<{
          refId: string;
          title: string;
          order?: number;
          source: 'api' | 'local' | 'merged';
          matchedPaperId?: string;
          matchedTitle?: string;
          matchScore?: number;
        }>;
        error?: string;
      }>;
      getEmbedding?: (payload:
        | string
        | {
            input?: string | string[];
            text?: string | string[];
            model?: string;
            dimensions?: number;
          }) => Promise<{
        success: boolean;
        model?: string;
        dimensions?: number;
        embedding?: number[];
        embeddings?: number[][];
        error?: string;
      }>;
      logSummaryRewrite?: (payload: {
        paperId?: string;
        source?: string;
        abstract?: string;
        summary?: string;
      }) => Promise<{ ok: boolean }>;
      logProgress?: (payload: {
        stage: string;
        paperId?: string;
      }) => Promise<{ ok: boolean }>;
      debugLog?: (payload: {
        tag?: string;
        message?: string;
        event?: string;
        paperId?: string;
        payload?: any;
      }) => Promise<{ ok: boolean }>;
      settingsGet?: () => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        idleAutoSyncEnabled?: boolean;
        idleAutoSyncMinutes?: number;
        libraryPath?: string;
        webdavServer?: string;
        webdavUsername?: string;
        webdavRemotePath?: string;
        webdavHasPassword?: boolean;
      }>;
      settingsSet?: (payload: {
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        idleAutoSyncEnabled?: boolean;
        idleAutoSyncMinutes?: number;
        libraryPath?: string;
        webdavServer?: string;
        webdavUsername?: string;
        webdavRemotePath?: string;
      }) => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        idleAutoSyncEnabled?: boolean;
        idleAutoSyncMinutes?: number;
        libraryPath?: string;
        webdavServer?: string;
        webdavUsername?: string;
        webdavRemotePath?: string;
        webdavHasPassword?: boolean;
      }>;
      webdav?: {
        test?: (payload: {
          server?: string;
          username?: string;
          password?: string;
          remotePath?: string;
        }) => Promise<{
          success: boolean;
          reachable?: boolean;
          writable?: boolean;
          validPath?: boolean;
          message?: string;
        }>;
        save?: (payload: {
          server?: string;
          username?: string;
          password?: string;
          remotePath?: string;
        }) => Promise<{
          success: boolean;
          webdavServer?: string;
          webdavUsername?: string;
          webdavRemotePath?: string;
          webdavHasPassword?: boolean;
        }>;
        clearLock?: () => Promise<{
          success: boolean;
          cleared?: boolean;
          message?: string;
        }>;
        sync?: (payload?: {
          mode?: 'auto' | 'upload' | 'download';
        }) => Promise<{
          success: boolean;
          mode?: 'upload' | 'download';
          skipped?: boolean;
          locked?: boolean;
          owner?: string;
          sqliteBytes?: number;
          uploadedPdfCount?: number;
          uploadedPdfBytes?: number;
          downloadedPdfCount?: number;
          downloadedPdfBytes?: number;
          appliedChangeCount?: number;
          pulledRemote?: boolean;
          remotePath?: string;
          server?: string;
          error?: string;
        }>;
      };
      vector?: {
        status?: () => Promise<{
          ok: boolean;
          qdrantUrl?: string;
          qdrantStoragePath?: string;
          metadataDbPath?: string;
          collection?: string;
          vectorFields?: string[];
          vectorDim?: number;
          pointCount?: number;
          summaryVectorCollection?: string;
          summaryVectorCount?: number;
          error?: string;
        }>;
        getPaperStatuses?: (payload: {
          paperIds: string[];
        }) => Promise<{
          ok: boolean;
          vectorizedPaperIds?: string[];
          error?: string;
        }>;
        debugQdrantStartup?: () => Promise<{
          ok: boolean;
          qdrantUrl?: string;
          collections?: string[];
          error?: string;
        }>;
        debugDumpQdrant?: () => Promise<{
          ok: boolean;
          qdrantUrl?: string;
          collections?: Array<{
            name: string;
            pointsCount: number;
            vectorNames: string[];
            samplePoints: Array<{ id: string; payloadKeys: string[] }>;
          }>;
          error?: string;
        }>;
        searchPapers?: (payload: {
          query: string;
          limit?: number;
          model?: string;
        }) => Promise<{
          ok: boolean;
          results?: Array<{
            id: string;
            paperId: string;
            score: number;
            payload?: Record<string, unknown>;
          }>;
          error?: string;
        }>;
      };
      library?: {
        getFolders?: () => Promise<any>;
        saveFolders?: (payload: any) => Promise<{ ok: boolean }>;
        getPapers?: () => Promise<any>;
        savePapers?: (payload: any) => Promise<{ ok: boolean }>;
        saveSnapshot?: (payload: { folders: any[]; papers: any[] }) => Promise<{ ok: boolean }>;
        savePdf?: (payload: { paperId: string; data: ArrayBuffer }) => Promise<{
          ok: boolean;
          filePath?: string;
          error?: string;
        }>;
        readPdf?: (payload: { paperId?: string; filePath?: string }) => Promise<{
          ok: boolean;
          data?: ArrayBuffer | Uint8Array;
          error?: string;
        }>;
        getPaperState?: (paperId: string) => Promise<any>;
        savePaperState?: (paperId: string, state: any) => Promise<{ ok: boolean }>;
        deletePaper?: (payload: { paperId: string; filePath?: string }) => Promise<{ ok: boolean; error?: string }>;
        deletePapers?: (payload: { items: Array<{ id: string; filePath?: string }> }) => Promise<{ ok: boolean; error?: string }>;
        matchReferences?: (payload: {
          paperId?: string;
          references: Array<{
            refId: string;
            title: string;
            order?: number;
            source: 'api' | 'local' | 'merged';
          }>;
        }) => Promise<{
          ok: boolean;
          references?: Array<{
            refId: string;
            title: string;
            order?: number;
            source: 'api' | 'local' | 'merged';
            matchedPaperId?: string;
            matchedTitle?: string;
            matchScore?: number;
          }>;
          error?: string;
        }>;
      };
    };
  }
}
