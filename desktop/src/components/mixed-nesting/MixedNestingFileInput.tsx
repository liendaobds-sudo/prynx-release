/**
 * Nhận file khuôn bế cho "Bình lồng ghép tự do" — phase P13.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §10, §15, §16.4.
 *
 * Năm ràng buộc, mỗi cái có test trong `MixedNestingFileInput.test.tsx`:
 *
 * 1. **Chỉ nhận PDF.** Đuôi khác bị từ chối ngay tại chỗ, kèm tên file để người dùng biết
 *    cái nào sai.
 * 2. **Chỉ nhận cho ĐÚNG tab.** Drop zone là DOM cục bộ của component; không có
 *    `window.addEventListener` nào. Vì vậy tab nền và tab đã đóng không thể nhận file, và
 *    Home, routing PDF mặc định, Combine, Convert, N-Up, Diecut giữ nguyên hành vi —
 *    `tabNavigation.ts` và `useIncomingFileDispatcher.ts` **không bị sửa**.
 * 3. **Tab không active thì không nhận.** Kéo file vào một tab đang ẩn là tai nạn, không
 *    phải ý định.
 * 4. **`ambiguous` thì bắt buộc người dùng chọn.** Vẽ từng đường bế ứng viên bằng chính
 *    polygon (không cần ảnh raster) rồi để họ bấm.
 * 5. **Ứng viên bị loại vẫn hiện, kèm lý do.** Im lặng bỏ là cách để một file sai đi tiếp.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MixedNestingApiError,
  acceptSourcePageBox,
  createSource,
  selectSourceCandidate,
} from '../../lib/mixed-nesting/api';
import { CANDIDATE_REJECTED_TEXT } from '../../lib/mixed-nesting/resultText';
import type { ContourCandidate, SourceRecord } from '../../lib/mixed-nesting/types';

export interface MixedNestingFileInputProps {
  tabId?: string;
  isActive?: boolean;
  disabled?: boolean;
  /**
   * Khuôn bế nhận từ nơi khác: công cụ Bù xén / Tạo đường cắt chuyển sang, hoặc payload
   * lúc mở thẻ. Nạp **đúng một lần** cho mỗi đối tượng `File` — so theo identity chứ không
   * theo tên, vì hai lần chạy Bù xén cho ra hai file trùng tên nhưng khác nội dung.
   */
  initialFile?: File;
  /** Gọi khi nguồn đã ở trạng thái `ready` và có đường bế được chọn. */
  onSourceReady: (source: SourceRecord, candidate: ContourCandidate) => void;
}

/** Chỉ nhận PDF. Kiểm bằng đuôi tên vì đó là thứ người dùng thấy và sửa được. */
function isPdfFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.pdf');
}

/** Vẽ một đường bế ứng viên. Dùng chính polygon nên không cần raster hoá gì. */
function CandidateThumb({ candidate }: { candidate: ContourCandidate }) {
  const { t } = useTranslation();
  const width = Math.max(candidate.widthMm, 1);
  const height = Math.max(candidate.heightMm, 1);
  const path = (ring: readonly [number, number][]) =>
    ring.length === 0 ? '' : `M ${ring.map(([x, y]) => `${x} ${height - y}`).join(' L ')} Z`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-14 w-14"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t('mixedNesting.mixedNestingFileInput:duong_be_w_x_h_mm', {
        w: Math.round(width),
        h: Math.round(height),
      })}
    >
      <path
        d={[path(candidate.outer), ...candidate.holes.map(path)].filter(Boolean).join(' ')}
        fillRule="evenodd"
        fill={candidate.rejectedReason ? '#fecaca' : '#bfdbfe'}
        stroke={candidate.rejectedReason ? '#dc2626' : '#1e293b'}
        strokeWidth={Math.max(width, height) / 100}
      />
    </svg>
  );
}

export default function MixedNestingFileInput({
  tabId,
  isActive = true,
  disabled,
  initialFile,
  onSourceReady,
}: MixedNestingFileInputProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const finish = useCallback(
    (record: SourceRecord) => {
      setSource(record);
      const chosen = record.selectedCandidateId
        ? record.candidates.find((item) => item.candidateId === record.selectedCandidateId)
        : undefined;
      if (record.status === 'ready' && chosen) {
        onSourceReady(record, chosen);
      }
    },
    [onSourceReady],
  );

  const handleFiles = useCallback(
    async (files: readonly File[]) => {
      // Tab không active không nhận file: kéo vào tab đang ẩn là tai nạn.
      if (!isActive || disabled) return;
      const pdfs = files.filter(isPdfFile);
      const bad = files.filter((file) => !isPdfFile(file));
      if (bad.length > 0) {
        // Nêu TÊN file bị bỏ: "chỉ nhận PDF" chung chung không cho người dùng biết cái nào sai.
        setError(
          t('mixedNesting.mixedNestingFileInput:chi_nhan_pdf_bo_qua_ten', {
            names: bad.map((file) => file.name).join(', '),
          }),
        );
      } else {
        setError('');
      }
      if (pdfs.length === 0) return;

      setBusy(true);
      try {
        // Mỗi lần chỉ nhận MỘT khuôn: trạng thái `ambiguous` cần người dùng chọn, và xếp
        // hàng nhiều file sẽ làm họ mất dấu file nào đang hỏi.
        const record = await createSource(pdfs[0]);
        finish(record);
        if (pdfs.length > 1) {
          setError(
            t('mixedNesting.mixedNestingFileInput:da_nhan_ten_hay_them_tung_file', {
              name: pdfs[0].name,
            }),
          );
        }
      } catch (exception) {
        const message =
          exception instanceof MixedNestingApiError || exception instanceof Error
            ? exception.message
            : String(exception);
        setError(message);
        setSource(null);
      } finally {
        setBusy(false);
      }
    },
    [disabled, finish, isActive, t],
  );

  // Khuôn chuyển từ công cụ khác: nạp một lần, ngay khi thẻ được xem. So identity của
  // `File` chứ không so tên — hai lần Bù xén cho ra hai file cùng tên khác nội dung.
  const importedInitialRef = useRef<File | null>(null);
  useEffect(() => {
    if (!initialFile || !isActive || disabled) return;
    if (importedInitialRef.current === initialFile) return;
    importedInitialRef.current = initialFile;
    void handleFiles([initialFile]);
  }, [disabled, handleFiles, initialFile, isActive]);

  const chooseCandidate = useCallback(
    async (candidateId: string) => {
      if (!source) return;
      setBusy(true);
      try {
        finish(await selectSourceCandidate(source.sourceId, candidateId));
        setError('');
      } catch (exception) {
        setError(exception instanceof Error ? exception.message : String(exception));
      } finally {
        setBusy(false);
      }
    },
    [finish, source],
  );

  // Tên KHÔNG được bắt đầu bằng "use": eslint sẽ coi là custom hook và chặn việc gọi
  // trong callback (`react-hooks/rules-of-hooks`).
  const choosePageBox = useCallback(
    async (pageNumber: number) => {
      if (!source) return;
      setBusy(true);
      try {
        finish(await acceptSourcePageBox(source.sourceId, pageNumber));
        setError('');
      } catch (exception) {
        setError(exception instanceof Error ? exception.message : String(exception));
      } finally {
        setBusy(false);
      }
    },
    [finish, source],
  );

  const usable = source?.candidates.filter((item) => !item.rejectedReason) ?? [];
  const rejected = source?.candidates.filter((item) => item.rejectedReason) ?? [];

  return (
    <section className="space-y-3" data-testid="mn-file-input" data-tab-id={tabId}>
      <div
        // Drop zone là DOM CỤC BỘ. Cố ý không dùng listener toàn cục: nhờ vậy tab nền và
        // tab đã đóng không thể nhận file, và routing PDF của app không bị đổi.
        onDragOver={(event) => {
          if (!isActive || disabled) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void handleFiles([...(event.dataTransfer?.files ?? [])]);
        }}
        className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10'
            : 'border-slate-300 dark:border-white/10 hover:border-indigo-400'
        }`}
        data-drag-over={dragOver ? 'true' : 'false'}
      >
        <p className="text-[11px] text-slate-600 dark:text-zinc-400">
          {t('mixedNesting.mixedNestingFileInput:keo_file_pdf_khuon_be_vao_day')}
        </p>
        <button
          type="button"
          className="mt-2 h-8 w-full rounded bg-indigo-600 px-3 text-[13px] font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
          disabled={disabled || busy || !isActive}
          onClick={() => inputRef.current?.click()}
        >
          {busy
            ? t('mixedNesting.mixedNestingFileInput:dang_doc_khuon')
            : t('mixedNesting.mixedNestingFileInput:chon_file_pdf')}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          aria-label={t('mixedNesting.mixedNestingFileInput:chon_file_pdf_khuon_be')}
          onChange={(event) => {
            void handleFiles([...(event.target.files ?? [])]);
            // Xoá value để chọn lại đúng file đó vẫn bắn onChange.
            event.target.value = '';
          }}
        />
        <p className="mt-1.5 text-[10px] leading-snug text-slate-400 dark:text-zinc-500">
          {t('mixedNesting.mixedNestingFileInput:duong_be_lay_tu_net_vector')}
        </p>
      </div>

      {error && (
        <p
          className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
          role="alert"
          data-testid="mn-file-error"
        >
          {error}
        </p>
      )}

      {source?.status === 'ambiguous' && (
        <div className="space-y-2" data-testid="mn-candidate-picker">
          <p className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide">
            {t('mixedNesting.mixedNestingFileInput:file_co_n_duong_be_kin_hay_chon', {
              n: usable.length,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {usable.map((candidate) => (
              <button
                key={candidate.candidateId}
                type="button"
                disabled={busy}
                className="flex flex-col items-center rounded-lg border border-slate-200 bg-white p-2 transition-colors hover:border-indigo-500 dark:border-white/10 dark:bg-zinc-900"
                data-candidate-id={candidate.candidateId}
                onClick={() => void chooseCandidate(candidate.candidateId)}
              >
                <CandidateThumb candidate={candidate} />
                <span className="mt-1 text-[11px] text-slate-600 dark:text-zinc-300 tabular-nums">
                  {Math.round(candidate.widthMm)} × {Math.round(candidate.heightMm)} mm
                </span>
                <span className="text-[10px] text-slate-400 dark:text-zinc-500">
                  {t('mixedNesting.mixedNestingFileInput:trang_n', { n: candidate.pageNumber })}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {source?.status === 'no_contour' && (
        <div className="space-y-2" data-testid="mn-no-contour">
          <p className="text-[11px] text-slate-600 dark:text-zinc-400">
            {t('mixedNesting.mixedNestingFileInput:khong_thay_duong_be_kin_dung_kho_trang')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {source.pages.map((page) => (
              <button
                key={page.pageNumber}
                type="button"
                disabled={busy}
                className="h-7 rounded border border-slate-300 px-2 text-[11px] tabular-nums transition-colors hover:border-indigo-500 dark:border-white/20"
                data-page-number={page.pageNumber}
                onClick={() => void choosePageBox(page.pageNumber)}
              >
                {t('mixedNesting.mixedNestingFileInput:trang_n_w_x_h_mm', {
                  n: page.pageNumber,
                  w: Math.round(page.widthMm),
                  h: Math.round(page.heightMm),
                })}
              </button>
            ))}
          </div>
        </div>
      )}

      {rejected.length > 0 && (
        <details
          className="text-[11px] text-slate-500 dark:text-zinc-400"
          data-testid="mn-rejected"
        >
          <summary className="cursor-pointer">
            {t('mixedNesting.mixedNestingFileInput:n_duong_bi_loai_xem_ly_do', { n: rejected.length })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {rejected.map((candidate) => (
              <li key={candidate.candidateId}>
                {t('mixedNesting.mixedNestingFileInput:trang_n', { n: candidate.pageNumber })}:{' '}
                {CANDIDATE_REJECTED_TEXT[candidate.rejectedReason!]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
