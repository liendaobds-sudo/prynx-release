// useNumberingJobStore.ts
// PA1 — "Numbering Job" dùng CHUNG xuyên-tab cho cặp công cụ Mẹc Số (ruột) ⇄ Mẹc Bìa.
// Mục tiêu: ruột và bìa LUÔN khớp dải số. Một nguồn chân lý duy nhất cho cấu hình dải;
// khi bật "liên kết", cả hai tab đọc/ghi cùng store nên không thể lệch tham số.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
    NumberingJob, InnerMode, Distribution, SortMethod,
} from '@/lib/coverNumberingEngine';

/** Phần dải số DÙNG CHUNG (giao của cấu hình ruột & bìa). */
export interface SharedJob {
    startNum: number;
    endNum: number;
    padding: number;
    bookletCount: number;
    bookletOffset: number;
    innerMode: InnerMode;
    distribution: Distribution;
    sortMethod: SortMethod;
}

export const DEFAULT_SHARED_JOB: SharedJob = {
    startNum: 1, endNum: 1000, padding: 4,
    bookletCount: 20, bookletOffset: 1,
    innerMode: 'continuous', distribution: 'stack', sortMethod: 'rows',
};

interface NumberingJobState {
    /** Bật liên kết = cả hai tab đọc/ghi cùng job. */
    linked: boolean;
    job: SharedJob;
    setLinked: (v: boolean) => void;
    setJob: (patch: Partial<SharedJob>) => void;
    resetJob: () => void;
}

export const useNumberingJobStore = create<NumberingJobState>()(
    persist(
        (set) => ({
            linked: false,
            job: { ...DEFAULT_SHARED_JOB },
            setLinked: (v) => set({ linked: v }),
            setJob: (patch) => set((s) => ({ job: { ...s.job, ...patch } })),
            resetJob: () => set({ job: { ...DEFAULT_SHARED_JOB } }),
        }),
        { name: 'prynx-numbering-job' },
    ),
);

/**
 * So khớp tham số dải giữa job cục bộ (vd của bìa) và job dùng chung (của ruột).
 * Trả danh sách field LỆCH để cảnh báo người dùng (rỗng = khớp hoàn toàn).
 * Pure → test được; dùng cho banner "cảnh báo lệch" của PA1.
 */
export function jobMismatch(local: Pick<NumberingJob, keyof SharedJob>, shared: SharedJob): (keyof SharedJob)[] {
    const keys: (keyof SharedJob)[] = [
        'startNum', 'endNum', 'padding', 'bookletCount', 'bookletOffset',
        'innerMode', 'distribution', 'sortMethod',
    ];
    return keys.filter((k) => local[k] !== shared[k]);
}
