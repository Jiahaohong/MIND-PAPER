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
      settingsGet?: () => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        libraryPath?: string;
      }>;
      settingsSet?: (payload: {
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        libraryPath?: string;
      }) => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        parsePdfWithAI?: boolean;
        libraryPath?: string;
      }>;
      vector?: {
        status?: () => Promise<{
          ok: boolean;
          qdrantUrl?: string;
          qdrantStoragePath?: string;
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
      };
    };
  }
}
