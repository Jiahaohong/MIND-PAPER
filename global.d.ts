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
      settingsGet?: () => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      }>;
      settingsSet?: (payload: {
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      }) => Promise<{
        translationEngine?: 'cnki' | 'openai';
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      }>;
      library?: {
        getFolders?: () => Promise<any>;
        saveFolders?: (payload: any) => Promise<{ ok: boolean }>;
        getPapers?: () => Promise<any>;
        savePapers?: (payload: any) => Promise<{ ok: boolean }>;
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
      };
    };
  }
}
