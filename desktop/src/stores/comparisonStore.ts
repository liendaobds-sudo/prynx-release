/**
 * Zustand store for comparison state management.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PageMatchingMode = 'auto' | 'sequential' | 'imposition';

export interface UploadedFile {
  id: string;
  filename: string;
  original_name: string;
  file_size: number;
  page_count: number | null;
  localFile?: File;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  severity: string;
  description: string;
  page?: number;
  nx?: number;
  ny?: number;
  b_page?: number;
}

export interface PageResult {
  page_number: number;
  status: string;
  similarity_score: number;
  diff_count: number;
  diff_regions: DiffRegion[];
  highlighted_image_url: string | null;
  gif_image_url?: string | null;
  is_imposition_mode?: boolean;
  matched_b_page?: number | null;
}

interface ComparisonState {
  // Files
  fileA: UploadedFile | null;
  fileB: UploadedFile | null;
  setFileA: (file: UploadedFile | null) => void;
  setFileB: (file: UploadedFile | null) => void;

  // Job
  jobId: string | null;
  jobStatus: string;
  setJobId: (id: string | null) => void;
  setJobStatus: (status: string) => void;

  // Progress
  progress: number;
  currentPage: number;
  totalPages: number;
  progressMessage: string;
  setProgress: (p: number, current?: number, total?: number, msg?: string) => void;

  // Results
  results: PageResult[];
  summary: Record<string, unknown> | null;
  setResults: (results: PageResult[], summary?: Record<string, unknown>) => void;

  // Settings
  comparisonMode: string;
  pageMatchingMode: PageMatchingMode;
  isPackagingMode: boolean;
  llmMode: string;
  cloudApiKey: string;
  tolerance: string;
  dpi: number;
  setComparisonMode: (mode: string) => void;
  setPageMatchingMode: (mode: PageMatchingMode) => void;
  setIsPackagingMode: (val: boolean) => void;
  setLlmMode: (mode: string) => void;
  setCloudApiKey: (key: string) => void;
  setTolerance: (t: string) => void;
  setDpi: (d: number) => void;

  // Reset
  reset: () => void;
}

export const useComparisonStore = create<ComparisonState>()(
  persist(
    (set) => ({
      fileA: null,
      fileB: null,
      setFileA: (file) => set({ fileA: file, results: [], summary: null, jobId: null, jobStatus: 'idle', progress: 0, currentPage: 0, totalPages: 0 }),
      setFileB: (file) => set({ fileB: file, results: [], summary: null, jobId: null, jobStatus: 'idle', progress: 0, currentPage: 0, totalPages: 0 }),

      jobId: null,
      jobStatus: 'idle',
      setJobId: (id) => set({ jobId: id }),
      setJobStatus: (status) => set({ jobStatus: status }),

      progress: 0,
      currentPage: 0,
      totalPages: 0,
      progressMessage: '',
      setProgress: (p, current, total, msg) =>
        set((state) => ({
          progress: p,
          currentPage: current ?? state.currentPage,
          totalPages: total ?? state.totalPages,
          progressMessage: msg ?? state.progressMessage,
        })),

      results: [],
      summary: null,
      setResults: (results, summary) => set({ results, summary: summary ?? null }),

      comparisonMode: 'full',
      pageMatchingMode: 'auto',
      isPackagingMode: false,
      llmMode: 'off',
      cloudApiKey: '',
      tolerance: 'NORMAL',
      dpi: 300,
      setComparisonMode: (mode) => set({ comparisonMode: mode }),
      setPageMatchingMode: (mode) => set({ pageMatchingMode: mode }),
      setIsPackagingMode: (val) => set({ isPackagingMode: val }),
      setLlmMode: (mode) => set({ llmMode: mode }),
      setCloudApiKey: (key) => set({ cloudApiKey: key }),
      setTolerance: (t) => set({ tolerance: t }),
      setDpi: (d) => set({ dpi: d }),

      reset: () =>
        set({
          fileA: null,
          fileB: null,
          jobId: null,
          jobStatus: 'idle',
          progress: 0,
          currentPage: 0,
          totalPages: 0,
          progressMessage: '',
          results: [],
          summary: null,
          comparisonMode: 'full',
          pageMatchingMode: 'auto',
          isPackagingMode: false,
        }),
    }),
    {
      name: 'pdf-compare-settings',
      partialize: (state) => ({
        comparisonMode: state.comparisonMode,
        pageMatchingMode: state.pageMatchingMode,
        isPackagingMode: state.isPackagingMode,
        llmMode: state.llmMode,
        cloudApiKey: state.cloudApiKey,
        tolerance: state.tolerance,
        dpi: state.dpi,
      }),
    }
  )
);
