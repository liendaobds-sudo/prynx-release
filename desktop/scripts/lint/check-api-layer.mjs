#!/usr/bin/env node
/**
 * Ratchet ranh giới tầng API — KIENTRUC (audit 2026-07-29 §A.2b).
 *
 * `prynx-architecture` quy định frontend gọi backend qua `lib/api.ts`. Thực tế 26 file
 * trong `src/components/` tự dựng URL bằng `getApiUrl()` rồi `fetch` — tức nửa số lời gọi
 * backend không đi qua lớp API. Hệ quả: đổi endpoint phải sửa rải rác, và không có nơi nào
 * áp chung được retry / xử lý lỗi / auth.
 *
 * Vì sao ratchet mà không sửa hết ngay: chuyển 26 file nghĩa là thêm ~40 hàm vào `api.ts`
 * và chạm 26 component trong một lô — churn lớn, rủi ro không tương xứng với lợi ích tức
 * thời. Ratchet chặn việc THÊM MỚI, để con số chỉ có thể giảm. Mỗi lần ai dọn một file thì
 * hạ `maxFiles` xuống trong cùng PR.
 *
 * Cùng khuôn với `check-budget.mjs` (ratchet lint đã có của dự án).
 *
 * Chạy: node scripts/lint/check-api-layer.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url));
const componentsRoot = path.join(desktopRoot, 'src', 'components');

// Trần = số file tại thời điểm audit 2026-07-29. CHỈ được hạ, không được nâng.
const BUDGET = {
  maxFiles: 26,
  // Danh sách hiện tại — giữ để khi test đỏ biết ngay file nào là MỚI (không nằm trong đây).
  known: [
    'AcrobatViewer.tsx',
    'AiQcTab.tsx',
    'ImpositionTab.tsx',
    'OutputPreviewTab.tsx',
    'SoftProofPanel.tsx',
    'acrobat/LayerPanel.tsx',
    'imposition-tools/ImposerDashboard.tsx',
    'imposition-tools/cut-export/api.ts',
    'imposition-tools/sections/GridPreview.tsx',
    'preprocess-tools/BgRemoverTool.tsx',
    'preprocess-tools/ConvertColorsTool.tsx',
    'preprocess-tools/EncryptTool.tsx',
    'preprocess-tools/FontToolsTool.tsx',
    'preprocess-tools/HairlinesTool.tsx',
    'preprocess-tools/InkManagerTool.tsx',
    'preprocess-tools/MetadataTool.tsx',
    'preprocess-tools/OcrTool.tsx',
    'preprocess-tools/OfficeConvertTool.tsx',
    'preprocess-tools/OptimizeTool.tsx',
    'preprocess-tools/PreflightTool.tsx',
    'preprocess-tools/SavePdfxTool.tsx',
    'preprocess-tools/StickerTool.tsx',
    'preprocess-tools/TrapPresetsTool.tsx',
    'preprocess-tools/UpscaleTool.tsx',
    'workspace/CropDialog.tsx',
    'workspace/LivePageFrame.tsx',
  ],
};

/** Bỏ qua test — test được phép stub tầng transport. */
const isSource = (name) =>
  (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (isSource(entry.name)) {
      yield full;
    }
  }
}

const offenders = [];
for await (const file of walk(componentsRoot)) {
  const text = await readFile(file, 'utf8');
  if (text.includes('getApiUrl()')) {
    offenders.push(path.relative(componentsRoot, file).split(path.sep).join('/'));
  }
}
offenders.sort();

const known = new Set(BUDGET.known);
const added = offenders.filter((f) => !known.has(f));
const cleaned = BUDGET.known.filter((f) => !offenders.includes(f));

console.log(`component gọi backend trực tiếp: ${offenders.length} (trần ${BUDGET.maxFiles})`);

const problems = [];
if (offenders.length > BUDGET.maxFiles) {
  problems.push(`số file ${offenders.length} > trần ${BUDGET.maxFiles}`);
}
if (added.length) {
  problems.push(
    `file MỚI tự gọi backend (phải đi qua src/lib/api.ts):\n    - ${added.join('\n    - ')}`,
  );
}

if (problems.length) {
  console.error(
    '\nRanh giới tầng API bị vi phạm (KIENTRUC audit 2026-07-29 §A.2b):\n- ' +
      problems.join('\n- ') +
      '\n\nThêm hàm vào src/lib/api.ts rồi gọi từ component, đừng dựng URL trong component.' +
      '\nCần ngoại lệ thì phải ghi lý do trong PR và thêm tên file vào BUDGET.known.\n',
  );
  process.exit(1);
}

if (cleaned.length) {
  console.error(
    `\n${cleaned.length} file đã dọn xong nhưng trần chưa hạ:\n    - ${cleaned.join('\n    - ')}\n` +
      `Hạ maxFiles xuống ${offenders.length} và bỏ chúng khỏi BUDGET.known trong cùng PR — ` +
      `nếu không ratchet mất tác dụng.\n`,
  );
  process.exit(1);
}

console.log('Ranh giới tầng API: không có file mới vi phạm.');
