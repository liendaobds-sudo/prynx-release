import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  isGeneratedWorkspaceFile,
  markGeneratedWorkspaceFile,
} from './nativeFileAccess';
import {
  canReuseExistingWorkspaceSource,
  createSavedWorkspaceRevision,
  executeWorkspaceSaveWrite,
  isUnsafeWorkspaceArtifactDestination,
  planWorkspacePdfSave,
  planWorkspaceSaveWrite,
  WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
  type WorkspaceSaveWritePlan,
  type WorkspaceSaveWritePorts,
} from './workspaceFileSave';
import {
  collectArtifactLeaseTokens,
  readArtifactLeaseToken,
  tagArtifactLeaseToken,
} from './artifactLease';

type RuntimeWorkspaceFile = File & {
  path?: string;
  isTempUploadPath?: boolean;
  __nativePathPending?: boolean;
};

function withPath(file: File, path: string): RuntimeWorkspaceFile {
  Object.defineProperty(file, 'path', { value: path, configurable: true });
  return file as RuntimeWorkspaceFile;
}

describe('hợp đồng lưu revision workspace', () => {
  it('file generated vẫn bake thay đổi xoay nhưng không ghi đè path artifact', () => {
    const generated = withPath(
      markGeneratedWorkspaceFile(new File([], 'ket-qua.pdf')),
      'D:\\PrynX\\results\\ket-qua.pdf',
    );

    expect(planWorkspacePdfSave(generated, {
      forceSaveAs: false,
      isTransientPath: false,
      hasRotationEdits: true,
      hasOrderEdits: false,
    })).toEqual({ shouldBake: true, overwritePath: null });
  });

  it('tên file khách chứa token output vẫn là source và được ghi đè', () => {
    const customer = withPath(
      new File([], 'Hop_dong_converted_Edited_part_2026.pdf'),
      'D:\\Khach\\Hop_dong_converted_Edited_part_2026.pdf',
    );

    expect(planWorkspacePdfSave(customer, {
      forceSaveAs: false,
      isTransientPath: false,
      hasRotationEdits: false,
      hasOrderEdits: false,
    })).toEqual({
      shouldBake: false,
      overwritePath: 'D:\\Khach\\Hop_dong_converted_Edited_part_2026.pdf',
    });
  });

  it('rebase generated/temp có lease thành revision nguồn sạch', () => {
    const working = withPath(
      markGeneratedWorkspaceFile(new File(['pdf'], 'Working.pdf', { type: 'application/pdf' })),
      'D:\\PrynX\\temp\\Working.pdf',
    );
    Object.defineProperty(working, 'isTempUploadPath', { value: true, configurable: true });
    Object.defineProperty(working, '__nativePathPending', { value: true, configurable: true });
    tagArtifactLeaseToken(working, 'a'.repeat(64));

    const saved = createSavedWorkspaceRevision(working, 'Tai-lieu.pdf', {
      path: 'D:\\Khach\\Tai-lieu.pdf',
      size: 123,
      pathRebaseOnly: true,
    }) as RuntimeWorkspaceFile & { __pathRebaseOnly?: boolean };

    expect(saved.path).toBe('D:\\Khach\\Tai-lieu.pdf');
    expect(saved.size).toBe(123);
    expect(saved.__pathRebaseOnly).toBe(true);
    expect(isGeneratedWorkspaceFile(saved)).toBe(false);
    expect(saved.isTempUploadPath).toBeUndefined();
    expect(saved.__nativePathPending).toBeUndefined();
    expect(readArtifactLeaseToken(saved)).toBeUndefined();
  });

  it('Save As của source tạo identity mới sạch và không được ghi đè path cũ', () => {
    const source = withPath(new File(['pdf'], 'source.pdf'), 'D:\\Khach\\source.pdf');
    const plan = planWorkspacePdfSave(source, {
      forceSaveAs: true,
      isTransientPath: false,
      hasRotationEdits: false,
      hasOrderEdits: false,
    });
    const saved = createSavedWorkspaceRevision(source, 'source-copy.pdf', {
      path: 'D:\\Khach\\source-copy.pdf',
    }) as RuntimeWorkspaceFile;

    expect(plan.overwritePath).toBeNull();
    expect(saved.path).toBe('D:\\Khach\\source-copy.pdf');
    expect(isGeneratedWorkspaceFile(saved)).toBe(false);
    expect(saved.isTempUploadPath).toBeUndefined();
    expect(saved.__nativePathPending).toBeUndefined();
  });

  it('Save As source sạch chọn lại path cũ được bỏ copy cùng-file', () => {
    const source = withPath(new File([], 'source.pdf'), 'D:\\Khach\\source.pdf');
    const forcedSaveAsPlan = planWorkspacePdfSave(source, {
      forceSaveAs: true,
      isTransientPath: false,
      hasRotationEdits: false,
      hasOrderEdits: false,
    });

    expect(forcedSaveAsPlan.overwritePath).toBeNull();
    expect(canReuseExistingWorkspaceSource(
      source,
      'D:\\Khach\\source.pdf',
      false,
      false,
    )).toBe(true);
  });

  it('generated hoặc temp không được bỏ ghi khi chọn trùng path artifact', () => {
    const generated = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      'D:\\PrynX\\temp\\artifact.pdf',
    );
    const tempSource = withPath(new File([], 'temp.pdf'), 'D:\\PrynX\\temp\\temp.pdf');

    expect(canReuseExistingWorkspaceSource(generated, generated.path!, false, false)).toBe(false);
    expect(canReuseExistingWorkspaceSource(tempSource, tempSource.path!, true, false)).toBe(false);
  });

  it('chặn generated/temp chọn lại artifact path nhưng cho source sạch hoặc path khác', () => {
    const artifactPath = 'D:\\PrynX\\temp\\artifact.pdf';
    const generated = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      artifactPath,
    );
    const tempSource = withPath(new File([], 'temp.pdf'), artifactPath);
    const cleanSource = withPath(new File([], 'source.pdf'), artifactPath);

    expect(isUnsafeWorkspaceArtifactDestination(generated, artifactPath, false)).toBe(true);
    expect(isUnsafeWorkspaceArtifactDestination(tempSource, artifactPath, true)).toBe(true);
    expect(isUnsafeWorkspaceArtifactDestination(cleanSource, artifactPath, false)).toBe(false);
    expect(isUnsafeWorkspaceArtifactDestination(
      generated,
      'D:\\Khach\\artifact.pdf',
      false,
    )).toBe(false);
  });

  it('lệch case ổ đĩa không được tắt chốt chặn artifact', () => {
    // Ca thật: path artifact tạm do sidecar trả về qua `os.path.abspath` nên giữ case
    // của cwd process, còn hộp thoại lưu Tauri trả case theo shell. Chỉ lệch ký tự ổ
    // đĩa là so chuỗi thô đã trả false và ca nguy hiểm quay lại nguyên vẹn.
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], '9f2c8ad1.pdf')),
      'd:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
    );

    expect(isUnsafeWorkspaceArtifactDestination(
      artifact,
      'D:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
      false,
    )).toBe(true);
  });

  it('lệch dấu phân cách, đoạn "." và dấu phân cách cuối vẫn là trùng path artifact', () => {
    const tempSource = withPath(
      new File([], 'Working.pdf'),
      'D:/PrynX/temp/Working.pdf',
    );

    expect(isUnsafeWorkspaceArtifactDestination(
      tempSource,
      'D:\\PrynX\\temp\\.\\Working.pdf',
      true,
    )).toBe(true);
    expect(isUnsafeWorkspaceArtifactDestination(
      tempSource,
      'D:\\PrynX\\Temp\\\\Working.PDF',
      true,
    )).toBe(true);
  });

  it('đoạn ".." được giải trước khi so path artifact', () => {
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      'D:\\PrynX\\temp\\artifact.pdf',
    );

    expect(isUnsafeWorkspaceArtifactDestination(
      artifact,
      'D:\\PrynX\\results\\..\\temp\\artifact.pdf',
      false,
    )).toBe(true);
  });

  it('source sạch chọn lại cùng file khác case vẫn được bỏ copy cùng-file', () => {
    const source = withPath(new File([], 'Hop_dong.pdf'), 'D:\\Khach\\Hop_dong.pdf');

    expect(canReuseExistingWorkspaceSource(
      source,
      'd:/khach/hop_dong.pdf',
      false,
      false,
    )).toBe(true);
  });

  it('path khác file thật không bị chặn oan', () => {
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      'D:\\PrynX\\temp\\artifact.pdf',
    );

    expect(isUnsafeWorkspaceArtifactDestination(
      artifact,
      'D:\\PrynX\\temp\\artifact_2.pdf',
      false,
    )).toBe(false);
    expect(isUnsafeWorkspaceArtifactDestination(
      artifact,
      'E:\\PrynX\\temp\\artifact.pdf',
      false,
    )).toBe(false);
    expect(isUnsafeWorkspaceArtifactDestination(
      artifact,
      '\\\\may-in\\temp\\artifact.pdf',
      false,
    )).toBe(false);
  });
});

/**
 * Gọi plan bước ghi với đủ bốn trường đầu vào; mỗi ca chỉ nêu phần khác biệt của nó.
 * Mặc định là lượt lưu thường: đích không phải artifact phù du và chưa bake gì.
 */
function planWrite(
  file: File,
  destPath: string,
  flags: { isTransientPath?: boolean; didBake?: boolean } = {},
): WorkspaceSaveWritePlan {
  return planWorkspaceSaveWrite({
    file,
    destPath,
    isTransientPath: flags.isTransientPath ?? false,
    didBake: flags.didBake ?? false,
  });
}

describe('hợp đồng plan bước ghi của Save As', () => {
  it('generated hoặc temp chọn trùng path artifact cho ra rejectArtifactDestination', () => {
    const artifactPath = 'D:\\PrynX\\temp\\artifact.pdf';
    const generated = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      artifactPath,
    );
    const tempSource = withPath(new File([], 'Working.pdf'), artifactPath);

    expect(planWrite(generated, artifactPath)).toEqual({ kind: 'rejectArtifactDestination' });
    expect(planWrite(tempSource, artifactPath, { isTransientPath: true }))
      .toEqual({ kind: 'rejectArtifactDestination' });
    // Bake xoay trang / thứ tự trang không phải cửa hậu: đích vẫn là artifact tạm nên
    // vẫn từ chối, chứ không rơi xuống nhánh writeBytes ghi đè chính file làm việc.
    expect(planWrite(generated, artifactPath, { didBake: true }))
      .toEqual({ kind: 'rejectArtifactDestination' });
  });

  it('lệch case ổ đĩa giữa sidecar và hộp thoại shell vẫn cho ra rejectArtifactDestination', () => {
    // Hình dạng thật của ca nguy hiểm: sidecar trả path qua `os.path.abspath` nên giữ
    // case của cwd process (`d:\...`), còn hộp thoại lưu của shell trả `D:\...`.
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], '9f2c8ad1.pdf')),
      'd:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
    );

    expect(planWrite(artifact, 'D:\\pdfcompare\\uploads\\9f2c8ad1.pdf'))
      .toEqual({ kind: 'rejectArtifactDestination' });
  });

  it('lệch dấu phân cách và dấu phân cách nhân đôi vẫn cho ra rejectArtifactDestination', () => {
    const tempSource = withPath(new File([], 'Working.pdf'), 'D:/PrynX/temp/Working.pdf');

    expect(planWrite(tempSource, 'D:\\PrynX\\temp\\Working.pdf', { isTransientPath: true }))
      .toEqual({ kind: 'rejectArtifactDestination' });
    expect(planWrite(tempSource, 'D:\\PrynX\\Temp\\\\Working.PDF', { isTransientPath: true }))
      .toEqual({ kind: 'rejectArtifactDestination' });
  });

  it('đoạn "." và ".." trong đích vẫn cho ra rejectArtifactDestination', () => {
    const artifactPath = 'D:\\PrynX\\temp\\artifact.pdf';
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      artifactPath,
    );

    expect(planWrite(artifact, 'D:\\PrynX\\temp\\.\\artifact.pdf'))
      .toEqual({ kind: 'rejectArtifactDestination' });
    expect(planWrite(artifact, 'D:\\PrynX\\results\\..\\temp\\artifact.pdf'))
      .toEqual({ kind: 'rejectArtifactDestination' });
  });

  it('source sạch chọn lại chính nó và không bake cho ra reuseExistingSource', () => {
    const source = withPath(new File([], 'Hop_dong.pdf'), 'D:\\Khach\\Hop_dong.pdf');

    expect(planWrite(source, 'D:\\Khach\\Hop_dong.pdf')).toEqual({ kind: 'reuseExistingSource' });
    // Cùng một file nhìn qua mặt path khác cũng là reuse, không phải một lượt copy vô ích.
    expect(planWrite(source, 'd:/khach/hop_dong.pdf')).toEqual({ kind: 'reuseExistingSource' });
  });

  it('source sạch chọn lại chính nó nhưng đã bake thì phải ghi bytes', () => {
    const source = withPath(new File([], 'Hop_dong.pdf'), 'D:\\Khach\\Hop_dong.pdf');

    // Không được reuse: bytes trên đĩa không còn là bytes người dùng đang thấy.
    // Cũng không được copyOnDisk vì copy đĩa→đĩa sẽ tự thay chính nó và mất bake.
    expect(planWrite(source, 'D:\\Khach\\Hop_dong.pdf', { didBake: true }))
      .toEqual({ kind: 'writeBytes', destPath: 'D:\\Khach\\Hop_dong.pdf' });
  });

  it('không bake và có path đĩa cho ra copyOnDisk, có bake cho ra writeBytes', () => {
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], '9f2c8ad1.pdf')),
      'D:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
    );

    expect(planWrite(artifact, 'D:\\Khach\\Ket-qua-binh-ban.pdf', { isTransientPath: true }))
      .toEqual({
        kind: 'copyOnDisk',
        sourcePath: 'D:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
        destPath: 'D:\\Khach\\Ket-qua-binh-ban.pdf',
      });
    expect(planWrite(artifact, 'D:\\Khach\\Ket-qua-binh-ban.pdf', {
      isTransientPath: true,
      didBake: true,
    })).toEqual({ kind: 'writeBytes', destPath: 'D:\\Khach\\Ket-qua-binh-ban.pdf' });
  });

  it('không có path đĩa thì luôn ghi bytes dù chưa bake', () => {
    // Working file chỉ nằm trong WebView (chưa có path native): không có nguồn để copy.
    const inMemory = new File(['pdf'], 'Ket-qua.pdf', { type: 'application/pdf' });

    expect(planWrite(inMemory, 'D:\\Khach\\Ket-qua.pdf'))
      .toEqual({ kind: 'writeBytes', destPath: 'D:\\Khach\\Ket-qua.pdf' });
    expect(planWrite(inMemory, 'D:\\Khach\\Ket-qua.pdf', { didBake: true }))
      .toEqual({ kind: 'writeBytes', destPath: 'D:\\Khach\\Ket-qua.pdf' });
  });

  it('path khác file thật cho ra copyOnDisk, không reject oan', () => {
    const artifactPath = 'D:\\PrynX\\temp\\artifact.pdf';
    const artifact = withPath(
      markGeneratedWorkspaceFile(new File([], 'artifact.pdf')),
      artifactPath,
    );

    // Khác tên file trong cùng thư mục.
    expect(planWrite(artifact, 'D:\\PrynX\\temp\\artifact_2.pdf')).toEqual({
      kind: 'copyOnDisk',
      sourcePath: artifactPath,
      destPath: 'D:\\PrynX\\temp\\artifact_2.pdf',
    });
    // Khác ổ đĩa.
    expect(planWrite(artifact, 'E:\\PrynX\\temp\\artifact.pdf')).toEqual({
      kind: 'copyOnDisk',
      sourcePath: artifactPath,
      destPath: 'E:\\PrynX\\temp\\artifact.pdf',
    });
    // Đích là đường UNC của máy in mạng: tiền tố `\\` không được gộp thành path tương đối.
    expect(planWrite(artifact, '\\\\may-in\\temp\\artifact.pdf')).toEqual({
      kind: 'copyOnDisk',
      sourcePath: artifactPath,
      destPath: '\\\\may-in\\temp\\artifact.pdf',
    });
  });
});

// ------------------------------------------------------------
// Cổng giả cho executor bước ghi
// ------------------------------------------------------------

/**
 * Một lời gọi cổng đã xảy ra, kèm đối số.
 *
 * Vì sao giữ log tuần tự chứ không chỉ đếm riêng từng `vi.fn()`: hợp đồng của nhánh
 * `writeBytes` gồm cả **thứ tự** — đọc bytes trước, ghi sau. Gọi ngược lại thì số lần
 * gọi mỗi cổng vẫn đúng y như cũ, mà file đích đã bị ghi bằng bytes chưa đọc xong.
 */
type WorkspaceSaveWritePortCall =
  | { port: 'copyOnDisk'; sourcePath: string; destPath: string }
  | { port: 'writeBytes'; destPath: string; bytes: Uint8Array }
  | { port: 'readBytes' };

/** Lỗi bơm vào từng cổng để kiểm việc lỗi nổi nguyên trạng ra ngoài. */
interface WorkspaceSaveWritePortFailures {
  copyOnDisk?: Error;
  writeBytes?: Error;
  readBytes?: Error;
}

interface SpyWorkspaceSaveWritePorts {
  ports: WorkspaceSaveWritePorts;
  copyOnDisk: Mock<(sourcePath: string, destPath: string) => Promise<void>>;
  writeBytes: Mock<(destPath: string, bytes: Uint8Array) => Promise<void>>;
  readBytes: Mock<() => Promise<Uint8Array>>;
  calls: WorkspaceSaveWritePortCall[];
}

/** Bytes "đã bake"; giữ tham chiếu để khẳng định `writeBytes` nhận đúng cái `readBytes` trả. */
const BAKED_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

function makeSpyPorts(
  failures: WorkspaceSaveWritePortFailures = {},
): SpyWorkspaceSaveWritePorts {
  const calls: WorkspaceSaveWritePortCall[] = [];
  const copyOnDisk = vi.fn(async (sourcePath: string, destPath: string): Promise<void> => {
    calls.push({ port: 'copyOnDisk', sourcePath, destPath });
    if (failures.copyOnDisk) throw failures.copyOnDisk;
  });
  const writeBytes = vi.fn(async (destPath: string, bytes: Uint8Array): Promise<void> => {
    calls.push({ port: 'writeBytes', destPath, bytes });
    if (failures.writeBytes) throw failures.writeBytes;
  });
  const readBytes = vi.fn(async (): Promise<Uint8Array> => {
    calls.push({ port: 'readBytes' });
    if (failures.readBytes) throw failures.readBytes;
    return BAKED_BYTES;
  });
  return {
    ports: { copyOnDisk, writeBytes, readBytes },
    copyOnDisk,
    writeBytes,
    readBytes,
    calls,
  };
}

/** Hợp đồng "không tác dụng phụ" phát biểu dưới dạng đếm được: không cổng nào bị chạm. */
function expectNoPortTouched(spy: SpyWorkspaceSaveWritePorts): void {
  expect(spy.copyOnDisk).toHaveBeenCalledTimes(0);
  expect(spy.writeBytes).toHaveBeenCalledTimes(0);
  expect(spy.readBytes).toHaveBeenCalledTimes(0);
  expect(spy.calls).toEqual([]);
}

const ARTIFACT_PATH = 'D:\\pdfcompare\\uploads\\9f2c8ad1.pdf';
const CUSTOMER_DEST = 'D:\\Khach\\Ket-qua-binh-ban.pdf';

/** Working file là artifact tạm của sidecar: vừa generated vừa nằm trên path phù du. */
function makeArtifactWorkingFile(): RuntimeWorkspaceFile {
  const file = withPath(
    markGeneratedWorkspaceFile(new File(['pdf'], '9f2c8ad1.pdf', { type: 'application/pdf' })),
    ARTIFACT_PATH,
  );
  Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true });
  return file;
}

describe('hợp đồng executor bước ghi của Save As', () => {
  it('plan từ chối không chạm cổng nào và trả rejected kèm khoá i18n đã export', async () => {
    // Đi qua `planWorkspaceSaveWrite` chứ không dựng plan bằng tay: hợp đồng cần chứng
    // minh là chuỗi thật (đích trùng artifact → plan reject → executor không chạm đĩa),
    // không phải chỉ một nhánh `switch` xử lý đúng giá trị đưa sẵn.
    const destVariants = [
      ARTIFACT_PATH,
      // Sidecar trả path qua `os.path.abspath` (giữ case cwd), hộp thoại shell trả `D:\`.
      'd:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
      'D:/pdfcompare/uploads/9f2c8ad1.pdf',
      'D:\\pdfcompare\\results\\..\\uploads\\.\\9f2c8ad1.pdf',
    ];

    for (const destPath of destVariants) {
      const plan = planWorkspaceSaveWrite({
        file: makeArtifactWorkingFile(),
        destPath,
        isTransientPath: true,
        didBake: false,
      });
      // Chống kiểm rỗng: nếu plan không còn là reject thì phần dưới không kiểm gì cả.
      expect(plan).toEqual({ kind: 'rejectArtifactDestination' });

      const spy = makeSpyPorts();
      const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

      expect(outcome).toEqual({
        kind: 'rejected',
        messageKey: WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
      });
      // Kể cả `readBytes` cũng bằng 0: kết quả bình bản/VDP có thể hàng trăm MB, đọc
      // vào WebView rồi mới từ chối vừa vô ích vừa là rủi ro "Invalid array length".
      expectNoPortTouched(spy);
    }
  });

  it('khoá thông báo từ chối không chứa chuỗi nhận diện lỗi phạm vi ghi', () => {
    // Requirement 4.2. `ImpositionTab.tsx:3544` nhận diện lỗi phạm vi ghi bằng
    // `writeErrorText.includes('forbidden path') || writeErrorText.includes('not allowed')`
    // rồi mở lại hộp thoại chọn vị trí. Từ chối artifact không phải lỗi quyền nên tuyệt
    // đối không được kích hoạt nhánh đó. Sau khi tách plan thì đây là lớp phòng thủ thứ
    // hai — nhánh reject là giá trị dữ liệu, không bao giờ đi qua `catch` — nhưng vẫn
    // khoá lại để một lần đổi tên khoá sau này không âm thầm mở lại cửa.
    const key = WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY.toLowerCase();

    expect(key).not.toContain('not allowed');
    expect(key).not.toContain('forbidden path');
    // Là khoá i18n có namespace, không phải câu tiếng Việt hardcode trong `lib/`.
    expect(WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY).toContain(':');
  });

  it('plan reuseExistingSource không chạm cổng nào và trả reused', async () => {
    const source = withPath(new File(['pdf'], 'Hop_dong.pdf'), 'D:\\Khach\\Hop_dong.pdf');
    const plan = planWorkspaceSaveWrite({
      file: source,
      destPath: 'd:/khach/hop_dong.pdf',
      isTransientPath: false,
      didBake: false,
    });
    expect(plan).toEqual({ kind: 'reuseExistingSource' });

    const spy = makeSpyPorts();
    const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

    // `reused` khác `rejected` ở hệ quả: được phép rebase path và coi là đã lưu.
    expect(outcome).toEqual({ kind: 'reused' });
    expectNoPortTouched(spy);
  });

  it('plan copyOnDisk chỉ gọi copyOnDisk, đúng cặp nguồn/đích', async () => {
    const plan = planWorkspaceSaveWrite({
      file: makeArtifactWorkingFile(),
      destPath: CUSTOMER_DEST,
      isTransientPath: true,
      didBake: false,
    });
    expect(plan).toEqual({
      kind: 'copyOnDisk',
      sourcePath: ARTIFACT_PATH,
      destPath: CUSTOMER_DEST,
    });

    const spy = makeSpyPorts();
    const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

    expect(outcome).toEqual({ kind: 'written' });
    expect(spy.copyOnDisk).toHaveBeenCalledTimes(1);
    expect(spy.copyOnDisk).toHaveBeenCalledWith(ARTIFACT_PATH, CUSTOMER_DEST);
    // `readBytes` bằng 0 là lý do tồn tại của nhánh này: copy đĩa→đĩa để kết quả lớn
    // không phải đi qua IPC.
    expect(spy.readBytes).toHaveBeenCalledTimes(0);
    expect(spy.writeBytes).toHaveBeenCalledTimes(0);
  });

  it('plan writeBytes gọi readBytes trước rồi writeBytes với đúng bytes đã đọc', async () => {
    const plan = planWorkspaceSaveWrite({
      file: makeArtifactWorkingFile(),
      destPath: CUSTOMER_DEST,
      isTransientPath: true,
      didBake: true,
    });
    expect(plan).toEqual({ kind: 'writeBytes', destPath: CUSTOMER_DEST });

    const spy = makeSpyPorts();
    const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

    expect(outcome).toEqual({ kind: 'written' });
    expect(spy.readBytes).toHaveBeenCalledTimes(1);
    expect(spy.writeBytes).toHaveBeenCalledTimes(1);
    expect(spy.copyOnDisk).toHaveBeenCalledTimes(0);
    // Thứ tự: đọc xong mới ghi. Ghi trước đọc thì đích bị cắt cụt trước khi có bytes.
    expect(spy.calls.map((call) => call.port)).toEqual(['readBytes', 'writeBytes']);
    const [writtenDestPath, writtenBytes] = spy.writeBytes.mock.calls[0];
    expect(writtenDestPath).toBe(CUSTOMER_DEST);
    // `toBe` chứ không `toEqual`: bytes phải là chính tham chiếu `readBytes` trả về.
    // Clone kết quả bình bản hàng trăm MB làm gấp đôi RAM đỉnh của WebView.
    expect(writtenBytes).toBe(BAKED_BYTES);
  });

  it('lỗi từ cổng copyOnDisk nổi nguyên trạng ra ngoài, không bị nuốt thành rejected', async () => {
    // Vì sao đây là hợp đồng chứ không phải chi tiết: lỗi phạm vi ghi do tầng native
    // sinh phải tới được `catch` của call site để mở lại hộp thoại chọn vị trí. Bọc nó
    // thành `{ kind: 'rejected' }` là biến lỗi quyền thành lỗi nghiệp vụ, và người dùng
    // mất luôn đường lưu sang chỗ khác.
    const nativeError = new Error('Access to this location is not allowed');
    const spy = makeSpyPorts({ copyOnDisk: nativeError });
    const plan: WorkspaceSaveWritePlan = {
      kind: 'copyOnDisk',
      sourcePath: ARTIFACT_PATH,
      destPath: CUSTOMER_DEST,
    };

    // `toBe` chứ không `toThrow`: phải là đúng đối tượng lỗi đó, không bị bọc lại —
    // bọc lại là mất chuỗi mà nhánh fallback dùng để nhận diện.
    await expect(executeWorkspaceSaveWrite(plan, spy.ports)).rejects.toBe(nativeError);
    expect(spy.copyOnDisk).toHaveBeenCalledTimes(1);
  });

  it('lỗi từ cổng writeBytes nổi nguyên trạng ra ngoài, không bị nuốt thành rejected', async () => {
    const nativeError = new Error('forbidden path');
    const spy = makeSpyPorts({ writeBytes: nativeError });
    const plan: WorkspaceSaveWritePlan = { kind: 'writeBytes', destPath: CUSTOMER_DEST };

    await expect(executeWorkspaceSaveWrite(plan, spy.ports)).rejects.toBe(nativeError);
    expect(spy.readBytes).toHaveBeenCalledTimes(1);
    expect(spy.writeBytes).toHaveBeenCalledTimes(1);
  });

  it('lỗi khi đọc bytes làm dừng trước khi ghi, đích không bị chạm', async () => {
    // Đọc thất bại mà vẫn gọi `writeBytes` thì đích bị ghi bằng bytes rỗng hoặc cắt cụt
    // — mất dữ liệu ngay tại đích người dùng vừa chọn.
    const readError = new Error('Lỗi đọc bytes working file');
    const spy = makeSpyPorts({ readBytes: readError });
    const plan: WorkspaceSaveWritePlan = { kind: 'writeBytes', destPath: CUSTOMER_DEST };

    await expect(executeWorkspaceSaveWrite(plan, spy.ports)).rejects.toBe(readError);
    expect(spy.readBytes).toHaveBeenCalledTimes(1);
    expect(spy.writeBytes).toHaveBeenCalledTimes(0);
  });
});

// ------------------------------------------------------------
// Bất biến provenance quanh biên lưu (Requirements 2.3, 2.4, 2.5)
// ------------------------------------------------------------

/** Token vé thuê hợp lệ theo `ARTIFACT_LEASE_TOKEN_PATTERN` (/^[0-9a-f]{64}$/). */
const ARTIFACT_LEASE_TOKEN = 'b7'.repeat(32);
/** Vé của một revision cũ còn nằm trong history của tab. */
const HISTORY_LEASE_TOKEN = 'c3'.repeat(32);

/**
 * Working file artifact mang **đủ bốn** dấu vết mà revision nguồn sạch phải tước bỏ:
 * provenance generated, cờ path upload tạm, cờ chờ path native, và vé thuê artifact.
 *
 * Dựng đủ bốn thứ trong một fixture để hai chiều của Requirement 2 được kiểm trên cùng
 * một đầu vào: đường từ chối phải giữ nguyên cả bốn, đường ghi thành công phải tước hết
 * cả bốn. Fixture chỉ mang một hai thứ thì một dấu vết bị bỏ sót vẫn báo xanh.
 */
function makeFullyTaggedArtifactWorkingFile(): RuntimeWorkspaceFile {
  const file = makeArtifactWorkingFile();
  Object.defineProperty(file, '__nativePathPending', { value: true, configurable: true });
  tagArtifactLeaseToken(file, ARTIFACT_LEASE_TOKEN);
  return file;
}

interface WorkspaceProvenanceSnapshot {
  isGenerated: boolean;
  isTempUploadPath?: boolean;
  nativePathPending?: boolean;
  leaseToken?: string;
  path?: string;
  name: string;
  size: number;
}

/**
 * Ảnh chụp toàn bộ provenance của một `File` để so trước/sau bằng một `toEqual`.
 *
 * Vì sao chụp thành object thay vì bốn `expect` rời: so cả object thì một dấu vết mới
 * được thêm vào runtime mà quên khoá ở đây sẽ lộ ra ngay khi ai đó cập nhật fixture,
 * chứ không im lặng nằm ngoài phạm vi kiểm.
 */
function readProvenance(file: File): WorkspaceProvenanceSnapshot {
  const runtime = file as RuntimeWorkspaceFile;
  return {
    isGenerated: isGeneratedWorkspaceFile(file),
    isTempUploadPath: runtime.isTempUploadPath,
    nativePathPending: runtime.__nativePathPending,
    leaseToken: readArtifactLeaseToken(file),
    path: runtime.path,
    name: file.name,
    size: file.size,
  };
}

describe('bất biến provenance quanh biên lưu Save As', () => {
  it('từ chối giữ nguyên provenance, cờ chờ path native và vé thuê của working file', async () => {
    const working = makeFullyTaggedArtifactWorkingFile();
    const before = readProvenance(working);
    // Chống kiểm rỗng: nếu fixture không mang đủ bốn dấu vết thì phần dưới không khoá
    // được gì — "giữ nguyên" một thứ vốn không có là mệnh đề luôn đúng.
    expect(before).toEqual({
      isGenerated: true,
      isTempUploadPath: true,
      nativePathPending: true,
      leaseToken: ARTIFACT_LEASE_TOKEN,
      path: ARTIFACT_PATH,
      name: '9f2c8ad1.pdf',
      size: 3,
    });

    const plan = planWorkspaceSaveWrite({
      file: working,
      destPath: ARTIFACT_PATH,
      isTransientPath: true,
      didBake: false,
    });
    expect(plan).toEqual({ kind: 'rejectArtifactDestination' });

    const spy = makeSpyPorts();
    const outcome = await executeWorkspaceSaveWrite(plan, spy.ports);

    expect(outcome).toEqual({
      kind: 'rejected',
      messageKey: WORKSPACE_SAVE_ARTIFACT_DESTINATION_MESSAGE_KEY,
    });
    expectNoPortTouched(spy);
    // Requirement 2.3 và 2.4: working file không bị rebase thành identity nguồn sạch.
    // `toEqual` trên cả ảnh chụp nên cũng khoá luôn `path`, `name` và `size` — một lượt
    // từ chối không được đổi bất cứ thứ gì trên object đang là nguồn của tab.
    expect(readProvenance(working)).toEqual(before);
  });

  it('sau khi từ chối, tập token gửi cho owner lease vẫn chứa vé của artifact', async () => {
    // Vì sao đây là đường mất dữ liệu chứ không phải lỗi nhãn. Chuỗi thật đã truy vết:
    // token nằm trên `File` (`artifactLease.ts:14` `readArtifactLeaseToken`)
    //   → `collectArtifactLeaseTokens([file, ...history, ...])` (`ImpositionTab.tsx:1350`)
    //   → `owner.sync(artifactLeaseTokens)` (`ImpositionTab.tsx:1394`)
    //   → `POST /artifacts/claim|renew|release` (`artifactLease.ts:44`).
    // `createSavedWorkspaceRevision` tước token. Nên nếu nhánh từ chối lại công bố
    // revision, token rơi khỏi tập trên, owner release nó, và vòng dọn artifact phía
    // backend được phép xoá **đúng file người dùng vừa tưởng là đã lưu**.
    const working = makeFullyTaggedArtifactWorkingFile();
    const history = [tagArtifactLeaseToken(
      new File([], 'buoc-truoc.pdf'),
      HISTORY_LEASE_TOKEN,
    )];
    const tokensBefore = collectArtifactLeaseTokens([working, ...history]);
    expect(tokensBefore).toEqual([ARTIFACT_LEASE_TOKEN, HISTORY_LEASE_TOKEN]);

    const plan = planWorkspaceSaveWrite({
      file: working,
      // Mặt path lệch case như sidecar trả về: chốt chặn phải nổ, không được lọt xuống copy.
      destPath: 'd:\\pdfcompare\\uploads\\9f2c8ad1.pdf',
      isTransientPath: true,
      didBake: false,
    });
    expect(plan).toEqual({ kind: 'rejectArtifactDestination' });

    const spy = makeSpyPorts();
    expect((await executeWorkspaceSaveWrite(plan, spy.ports)).kind).toBe('rejected');
    expectNoPortTouched(spy);

    // Đúng tập token cũ, đúng thứ tự: lần `owner.sync` kế tiếp không thấy khác biệt nào
    // nên không phát sinh lệnh release cho artifact đang dùng.
    expect(collectArtifactLeaseTokens([working, ...history])).toEqual(tokensBefore);
  });

  it('ghi thành công rồi công bố revision mới là nơi tước provenance và vé thuê', async () => {
    const working = makeFullyTaggedArtifactWorkingFile();
    const plan = planWorkspaceSaveWrite({
      file: working,
      destPath: CUSTOMER_DEST,
      isTransientPath: true,
      didBake: false,
    });
    expect(plan).toEqual({
      kind: 'copyOnDisk',
      sourcePath: ARTIFACT_PATH,
      destPath: CUSTOMER_DEST,
    });

    const spy = makeSpyPorts();
    expect(await executeWorkspaceSaveWrite(plan, spy.ports)).toEqual({ kind: 'written' });
    expect(spy.copyOnDisk).toHaveBeenCalledTimes(1);

    const revision = createSavedWorkspaceRevision(working, 'Ket-qua-binh-ban.pdf', {
      path: CUSTOMER_DEST,
      size: working.size,
      pathRebaseOnly: true,
    });

    // Requirement 2.5: cả bốn dấu vết đều mất trên revision công bố.
    expect(readProvenance(revision)).toEqual({
      isGenerated: false,
      isTempUploadPath: undefined,
      nativePathPending: undefined,
      leaseToken: undefined,
      path: CUSTOMER_DEST,
      name: 'Ket-qua-binh-ban.pdf',
      size: 3,
    });
    // Việc tước vé ở đây là **đúng**: bytes đã nằm ở đích của khách nên artifact tạm
    // không còn cần giữ. Đây cũng chính là hệ quả mà nhánh từ chối không được phép gây
    // ra — cùng một hàm, khác chỗ gọi, khác hẳn hậu quả.
    expect(collectArtifactLeaseTokens([revision])).toEqual([]);
    // `executeWorkspaceSaveWrite` không tự công bố revision nên object working cũ vẫn
    // nguyên vé. Nhờ vậy artifact còn trong history của tab vẫn được owner giữ.
    expect(readArtifactLeaseToken(working)).toBe(ARTIFACT_LEASE_TOKEN);
  });

  it('cùng working file, chỉ khác đích: artifact thì giữ nguyên, đích khách thì sạch', async () => {
    // Cặp đối chiếu là phần khoá được tính **có điều kiện** của Requirement 2: provenance
    // sạch không phải hệ quả của việc bấm Save As, mà chỉ của một lượt ghi thành công.
    const rejectedWorking = makeFullyTaggedArtifactWorkingFile();
    const writtenWorking = makeFullyTaggedArtifactWorkingFile();
    const baseline = readProvenance(rejectedWorking);
    expect(readProvenance(writtenWorking)).toEqual(baseline);

    const spyRejected = makeSpyPorts();
    const rejectedOutcome = await executeWorkspaceSaveWrite(
      planWorkspaceSaveWrite({
        file: rejectedWorking,
        destPath: ARTIFACT_PATH,
        isTransientPath: true,
        didBake: false,
      }),
      spyRejected.ports,
    );

    const spyWritten = makeSpyPorts();
    const writtenOutcome = await executeWorkspaceSaveWrite(
      planWorkspaceSaveWrite({
        file: writtenWorking,
        destPath: CUSTOMER_DEST,
        isTransientPath: true,
        didBake: false,
      }),
      spyWritten.ports,
    );

    expect(rejectedOutcome.kind).toBe('rejected');
    expect(writtenOutcome.kind).toBe('written');
    // Nhánh từ chối: không công bố gì, nên working file vẫn là chính nó với đủ bốn dấu vết.
    expect(readProvenance(rejectedWorking)).toEqual(baseline);
    // Nhánh ghi thành công: chỉ khi đó call site mới được tạo revision, và revision sạch.
    const revision = createSavedWorkspaceRevision(writtenWorking, 'Ket-qua-binh-ban.pdf', {
      path: CUSTOMER_DEST,
      pathRebaseOnly: true,
    });
    expect(isGeneratedWorkspaceFile(revision)).toBe(false);
    expect(readArtifactLeaseToken(revision)).toBeUndefined();
    // Working file của nhánh ghi cũng không bị hàm nào mutate: chỉ có object mới là sạch.
    expect(readProvenance(writtenWorking)).toEqual(baseline);
  });
});
