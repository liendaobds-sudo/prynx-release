import { lazy, Suspense } from 'react';

const DualPDFViewerInner = lazy(() => import('./DualPDFViewerInner'));

export interface DiffRegionData {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  severity: string;
  page: number;
  b_page?: number;
}

import type { FocusedRegion } from './DualPDFViewerInner';

interface DualPDFViewerProps {
  leftPdfUrl: string;
  rightPdfUrl: string;
  diffRegions: DiffRegionData[];
  scrollToPage?: number;
  focusedRegion?: FocusedRegion | null;
}

export default function DualPDFViewer(props: DualPDFViewerProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="w-10 h-10 border-3 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-400">Đang tải PDF viewer...</p>
          </div>
        </div>
      }
    >
      <DualPDFViewerInner {...props} />
    </Suspense>
  );
}
