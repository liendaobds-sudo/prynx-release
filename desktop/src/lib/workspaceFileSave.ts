import {
  createSavedSourceFile,
  isGeneratedWorkspaceFile,
} from './nativeFileAccess';

type WorkspaceFilePath = File & { path?: string };

export interface WorkspacePdfSavePlanOptions {
  forceSaveAs: boolean;
  isTransientPath: boolean;
  hasRotationEdits: boolean;
  hasOrderEdits: boolean;
}

export interface WorkspacePdfSavePlan {
  shouldBake: boolean;
  overwritePath: string | null;
}

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): chỉnh trang quyết định việc bake; provenance
 * chỉ quyết định có được ghi đè path hiện tại hay phải chọn đích lưu mới.
 */
export function planWorkspacePdfSave(
  file: File,
  options: WorkspacePdfSavePlanOptions,
): WorkspacePdfSavePlan {
  const currentPath = (file as WorkspaceFilePath).path;
  const canOverwriteCurrentPath = (
    !options.forceSaveAs
    && !options.isTransientPath
    && !isGeneratedWorkspaceFile(file)
    && typeof currentPath === 'string'
    && currentPath.length > 0
  );
  return {
    shouldBake: options.hasRotationEdits || options.hasOrderEdits,
    overwritePath: canOverwriteCurrentPath ? currentPath : null,
  };
}

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): dạng chuẩn hoá để so hai path Windows.
 *
 * Vì sao không so chuỗi thô: NTFS không phân biệt hoa/thường và nhận cả hai dấu phân
 * cách, nên chốt chặn artifact so bằng `===` có thể im lặng không nổ đúng lúc cần.
 * Path artifact tạm do sidecar trả về qua `os.path.abspath` (backend/app/api/routes/vdp.py)
 * giữ nguyên case của cwd process, còn hộp thoại lưu Tauri trả case theo shell — chỉ
 * lệch ký tự ổ đĩa là guard đã tắt. Dùng cùng idiom với `is_sensitive_write_path`
 * (desktop/src-tauri/src/lib.rs): hạ hoa/thường sau khi đổi `/` thành `\`.
 */
export function workspacePathCompareKey(path: string): string {
  const unified = path.trim().replace(/\//g, '\\');
  // Giữ tiền tố UNC `\\may-in\...`: gộp mất nó là biến share mạng thành path tương đối.
  const uncPrefix = unified.startsWith('\\\\') ? '\\\\' : '';
  const resolved: string[] = [];
  for (const segment of unified.slice(uncPrefix.length).split('\\')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // `..` không giải được (path tương đối) thì giữ lại, không tự nối vào gốc sai.
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
      else resolved.push('..');
      continue;
    }
    resolved.push(segment);
  }
  return (uncPrefix + resolved.join('\\')).toLowerCase();
}

/** Hai path cùng trỏ một file trên đĩa theo quy ước so sánh của Windows. */
export function isSameWorkspacePath(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const leftKey = workspacePathCompareKey(left);
  return leftKey.length > 0 && leftKey === workspacePathCompareKey(right);
}

/** Chỉ source sạch, nội dung chưa bake mới được coi là đã lưu khi chọn lại cùng path. */
export function canReuseExistingWorkspaceSource(
  file: File,
  selectedPath: string,
  isTransientPath: boolean,
  didBake: boolean,
): boolean {
  return (
    !didBake
    && !isTransientPath
    && !isGeneratedWorkspaceFile(file)
    && isSameWorkspacePath((file as WorkspaceFilePath).path, selectedPath)
  );
}

/** File app-owned không được biến thành đích lưu thật bằng cách chọn lại chính path tạm. */
export function isUnsafeWorkspaceArtifactDestination(
  file: File,
  selectedPath: string,
  isTransientPath: boolean,
): boolean {
  return (
    isSameWorkspacePath((file as WorkspaceFilePath).path, selectedPath)
    && (isGeneratedWorkspaceFile(file) || isTransientPath)
  );
}

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): quyết định của bước ghi trong Save As, dạng
 * union rời rạc — đúng một nhánh cho mỗi lượt lưu.
 *
 * Vì sao là giá trị dữ liệu chứ không phải exception mang chuỗi: nhánh từ chối artifact
 * và lỗi phạm vi ghi từ tầng native là hai loại lỗi khác nhau. Lỗi phạm vi ghi phải mở
 * lại hộp thoại chọn vị trí, còn từ chối artifact thì không. Nếu cả hai cùng đi qua
 * `catch` rồi phân biệt bằng cách so chuỗi thông báo thì chốt chặn phụ thuộc vào việc
 * text tiếng Việt tình cờ không chứa `not allowed` — sửa câu thông báo là mất chốt.
 */
export type WorkspaceSaveWritePlan =
  /** Đích chính là source sạch hiện tại và không có gì để bake: không ghi, chỉ rebase path. */
  | { kind: 'reuseExistingSource' }
  /** Đích trùng file artifact tạm app-owned: không ghi, không công bố revision. */
  | { kind: 'rejectArtifactDestination' }
  /** Copy đĩa→đĩa, không đọc bytes vào WebView (kết quả bình sách/VDP có thể hàng trăm MB). */
  | { kind: 'copyOnDisk'; sourcePath: string; destPath: string }
  /** Ghi bytes đã bake xoay trang / thứ tự trang. */
  | { kind: 'writeBytes'; destPath: string };

export interface WorkspaceSaveWriteInput {
  /** Working file hiện tại, đã đọc lại từ store sau khi commit edit-session. */
  file: File;
  /** Đích người dùng chọn hoặc path ghi đè từ `planWorkspacePdfSave`. */
  destPath: string;
  /** Path là artifact phù du của sidecar hoặc temp upload. */
  isTransientPath: boolean;
  /** Đã bake xoay trang hoặc thứ tự trang vào bytes mới. */
  didBake: boolean;
}

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): hàm thuần chọn đường ghi cho Save As.
 *
 * Thứ tự quyết định cố ý đặt `reject` TRƯỚC `copyOnDisk`: nếu để `copyOnDisk` chạy trước
 * thì lệnh copy đĩa→đĩa tự thay chính artifact tạm rồi trả về thành công, và luồng lưu
 * gắn identity "nguồn sạch" lên nó — provenance bị rửa trắng, vé thuê artifact bị tước,
 * vòng dọn artifact được phép xoá đúng file người dùng vừa tưởng là đã lưu.
 *
 * `reuseExistingSource` đứng đầu vì hai predicate loại trừ nhau theo provenance:
 * chỉ source sạch mới reuse được, chỉ file app-owned mới bị reject.
 */
export function planWorkspaceSaveWrite(
  input: WorkspaceSaveWriteInput,
): WorkspaceSaveWritePlan {
  const { file, destPath, isTransientPath, didBake } = input;
  if (canReuseExistingWorkspaceSource(file, destPath, isTransientPath, didBake)) {
    return { kind: 'reuseExistingSource' };
  }
  if (isUnsafeWorkspaceArtifactDestination(file, destPath, isTransientPath)) {
    return { kind: 'rejectArtifactDestination' };
  }
  const sourcePath = (file as WorkspaceFilePath).path;
  // Không bake và bytes đã nằm trên đĩa → copy đĩa→đĩa. Đọc cả file vào Uint8Array rồi
  // đẩy qua IPC làm vỡ serialize với khối lớn ("RangeError: Invalid array length").
  if (!didBake && typeof sourcePath === 'string' && sourcePath.length > 0) {
    return { kind: 'copyOnDisk', sourcePath, destPath };
  }
  return { kind: 'writeBytes', destPath };
}

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): khoá i18n của thông báo từ chối đích artifact.
 *
 * Vì sao là khoá chứ không phải câu tiếng Việt: `lib/` không có `t()` và không được ghim
 * ngôn ngữ — hardcode text ở đây là chặn đường bản tiếng Anh và làm chuỗi thoát khỏi
 * `desktop/src/i18n/locales/*.json`. Đặt thành hằng số export thay vì chuỗi rời tại
 * `ImpositionTab` để khoá dùng ở call site và khoá được test khẳng định là **một**;
 * sửa tên khoá mà quên đầu kia thì lỗi biên dịch, không phải thông báo trống lúc chạy.
 *
 * Nội dung khoá này cố ý KHÔNG chứa `not allowed` hay `forbidden path` — hai chuỗi mà
 * `ImpositionTab` dùng để nhận diện lỗi phạm vi ghi và mở lại hộp thoại chọn vị trí.
 */
export const WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY =
  'tabs.imposition:khong_the_luu_de_len_file_lam_viec_tam';

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): cổng ra đĩa của bước ghi, tiêm từ ngoài.
 *
 * Vì sao tiêm chứ không `import` Tauri trong lib: hợp đồng quan trọng nhất của chốt chặn
 * là "nhánh từ chối không chạm đĩa". Chỉ khẳng định được điều đó khi test đếm được số
 * lần gọi từng cổng, mà `invoke` thật thì không đếm được nếu không mount cả tab.
 */
export interface WorkspaceSaveWritePorts {
  /** Copy đĩa→đĩa qua lệnh native, không nạp bytes vào WebView. */
  copyOnDisk: (sourcePath: string, destPath: string) => Promise<void>;
  /** Ghi nguyên tử bytes đã bake ra đích. */
  writeBytes: (destPath: string, bytes: Uint8Array) => Promise<void>;
  /** Đọc bytes của working file. Chỉ nhánh `writeBytes` được phép gọi. */
  readBytes: () => Promise<Uint8Array>;
}

/**
 * Kết quả của bước ghi, dạng union rời rạc để call site không phải suy từ exception.
 *
 * `rejected` là kết quả **bình thường** của hàm, không phải throw: nhờ vậy nó không bao
 * giờ đi qua `catch` của lỗi phạm vi ghi và không thể kích hoạt nhánh mở lại hộp thoại.
 */
export type WorkspaceSaveWriteOutcome =
  /** Đã ghi ra đích (copy đĩa→đĩa hoặc ghi bytes). Được phép công bố revision sạch. */
  | { kind: 'written' }
  /** Không cần ghi vì đích chính là source sạch hiện tại. Được phép rebase path. */
  | { kind: 'reused' }
  /** Từ chối vì đích trùng artifact tạm app-owned. KHÔNG được công bố revision. */
  | { kind: 'rejected'; messageKey: string };

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): thực thi plan bước ghi của Save As.
 *
 * Không đụng state React, không import Tauri: mọi tác dụng phụ đi qua `ports`.
 *
 * Hai bất biến mà hàm này giữ:
 *
 * 1. Nhánh `rejectArtifactDestination` không gọi cổng nào, kể cả `readBytes`. Đọc bytes
 *    rồi mới từ chối vừa vô ích (kết quả bình sách/VDP có thể hàng trăm MB, đọc vào
 *    WebView là rủi ro "RangeError: Invalid array length") vừa làm hợp đồng "không chạm
 *    đĩa khi từ chối" không kiểm được. Vì thế `readBytes` là cổng lười, gọi tại nhánh
 *    cần nó chứ không nhận `bytes` sẵn qua tham số.
 * 2. Lỗi từ cổng được để nổi nguyên trạng, không bọc `try/catch`. Lỗi phạm vi ghi do
 *    tầng native sinh phải tới được `catch` của call site để mở lại hộp thoại chọn vị
 *    trí; nuốt nó thành `rejected` là biến lỗi quyền thành lỗi nghiệp vụ và người dùng
 *    mất luôn đường lưu sang chỗ khác.
 */
export async function executeWorkspaceSaveWrite(
  plan: WorkspaceSaveWritePlan,
  ports: WorkspaceSaveWritePorts,
): Promise<WorkspaceSaveWriteOutcome> {
  switch (plan.kind) {
    case 'reuseExistingSource':
      return { kind: 'reused' };
    case 'rejectArtifactDestination':
      return {
        kind: 'rejected',
        messageKey: WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
      };
    case 'copyOnDisk':
      await ports.copyOnDisk(plan.sourcePath, plan.destPath);
      return { kind: 'written' };
    case 'writeBytes': {
      const bytes = await ports.readBytes();
      await ports.writeBytes(plan.destPath, bytes);
      return { kind: 'written' };
    }
    default: {
      // Bảo đảm exhaustiveness ở compile-time: thêm nhánh plan mới mà quên xử lý ở đây
      // thì đỏ lúc biên dịch, chứ không âm thầm rơi xuống đường ghi mặc định.
      const _exhaustive: never = plan;
      throw new Error(
        `executeWorkspaceSaveWrite: nhánh plan chưa xử lý: ${String(_exhaustive)}`,
      );
    }
  }
}

export interface SavedWorkspaceRevisionOptions {
  path?: string;
  size?: number;
  pathRebaseOnly?: boolean;
}

/**
 * Identity sau lưu là file nguồn mới: không giữ provenance generated/temp/pending
 * hoặc lease của artifact làm việc. Khi có path, bytes được đọc từ path thay vì giữ
 * thêm một bản PDF lớn trong WebView.
 */
export function createSavedWorkspaceRevision(
  source: Blob,
  name: string,
  options: SavedWorkspaceRevisionOptions = {},
): File {
  const file = createSavedSourceFile(options.path ? [] : [source], name, {
    type: 'application/pdf',
    path: options.path,
    size: options.path ? (options.size ?? source.size) : undefined,
  });
  if (options.pathRebaseOnly) {
    Object.defineProperty(file, '__pathRebaseOnly', {
      value: true,
      configurable: true,
    });
  }
  return file;
}
