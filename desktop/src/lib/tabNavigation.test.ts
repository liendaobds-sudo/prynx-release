import { describe, expect, it } from 'vitest';
import {
    buildResultTabPayload,
    buildSourceTabOptions,
    partitionIncomingFiles,
    planIncomingFiles,
    registerActiveTabFeature,
    resolveActiveDedicatedReceiver,
    resolveActiveImageBatchReceiver,
} from './tabNavigation';
import {
    createSavedSourceFile,
    isGeneratedWorkspaceFile,
    markGeneratedWorkspaceFile,
} from './nativeFileAccess';

describe('điều hướng đa tab', () => {
    const tabs = [
        { id: 'pdf', type: 'imposition', payload: { file: 'a.pdf' } },
        { id: 'tach-nen', type: 'imposition', payload: { focusFeature: 'bgremover' } },
        { id: 'phong-to', type: 'imposition', payload: { focusFeature: 'upscale' } },
        { id: 'logo', type: 'imposition', payload: { focusFeature: 'logo_rebuild' } },
        { id: 'tai-lieu', type: 'imposition', payload: { focusFeature: 'document_cleanup' } },
    ];

    it('không gửi file vào công cụ chuyên dụng đang nằm ở tab nền', () => {
        expect(resolveActiveDedicatedReceiver(tabs, 'pdf', 'bgremover')).toBeNull();
    });

    it('chỉ gửi file vào đúng tab chuyên dụng đang active', () => {
        expect(resolveActiveDedicatedReceiver(tabs, 'tach-nen', 'bgremover')).toBe('tach-nen');
    });

    it('định tuyến ảnh native vào đúng tab Upscale đang active', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'phong-to')).toEqual({
            tabId: 'phong-to',
            feature: 'upscale',
            eventName: 'prynx-upscale-add-files',
        });
    });

    it('không để tab công cụ ảnh ở nền hút file kéo-thả', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'pdf')).toBeNull();
    });

    it('giữ nguyên tuyến kéo-thả của Tách nền', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'tach-nen')).toEqual({
            tabId: 'tach-nen',
            feature: 'bgremover',
            eventName: 'prynx-bgremover-add-files',
        });
    });

    it('định tuyến ảnh native vào đúng tab Logo đang active', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'logo')).toEqual({
            tabId: 'logo',
            feature: 'logo_rebuild',
            eventName: 'prynx-logo-rebuild-add-files',
        });
    });

    it('định tuyến ảnh native vào đúng công cụ Nắn thẻ – Làm trắng scan', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'tai-lieu')).toEqual({
            tabId: 'tai-lieu',
            feature: 'document_cleanup',
            eventName: 'prynx-document-cleanup-add-files',
        });
    });

    it('chỉ chọn tab Logo active khi có nhiều workspace Logo đang mounted', () => {
        const multiLogoTabs = [
            { id: 'logo-a', type: 'imposition', payload: { file: 'a.pdf' } },
            { id: 'logo-b', type: 'imposition', payload: { file: 'b.pdf' } },
        ];
        const unregisterA = registerActiveTabFeature('logo-a', 'logo_rebuild');
        const unregisterB = registerActiveTabFeature('logo-b', 'logo_rebuild');
        try {
            expect(resolveActiveImageBatchReceiver(multiLogoTabs, 'logo-b')).toEqual({
                tabId: 'logo-b',
                feature: 'logo_rebuild',
                eventName: 'prynx-logo-rebuild-add-files',
            });
        } finally {
            unregisterB();
            unregisterA();
        }
    });

    it('dung cong cu dang hien thi thay vi intent cu luc mo tab', () => {
        const genericTabs = [
            { id: 'pdf-runtime', type: 'imposition', payload: { file: 'a.pdf' } },
        ];
        const unregister = registerActiveTabFeature('pdf-runtime', 'upscale');
        try {
            expect(resolveActiveImageBatchReceiver(genericTabs, 'pdf-runtime')).toEqual({
                tabId: 'pdf-runtime',
                feature: 'upscale',
                eventName: 'prynx-upscale-add-files',
            });
        } finally {
            unregister();
        }
    });

    it('khong roi ve intent Upscale cu sau khi da chuyen sang cong cu khac', () => {
        const unregister = registerActiveTabFeature('phong-to', 'pages');
        try {
            expect(resolveActiveImageBatchReceiver(tabs, 'phong-to')).toBeNull();
        } finally {
            unregister();

        }
    });

    it('tách tất cả PDF để shell mở mỗi file thành một tab mới', () => {
        const files = [
            { name: '01_bia.PDF' },
            { name: 'du_lieu.xlsx' },
            { name: 'anh.png' },
            { name: '02_ruot.pdf' },
        ];

        expect(partitionIncomingFiles(files)).toEqual({
            pdfFiles: [files[0], files[3]],
            officeFiles: [files[1]],
            otherFiles: [files[2]],
        });
    });

    it('PDF không rơi vào nhóm công cụ ảnh dù đang thả cùng ảnh', () => {
        const result = partitionIncomingFiles([
            { name: 'tai_lieu.pdf' },
            { name: 'preview.jpg' },
        ]);
        expect(result.pdfFiles.map(file => file.name)).toEqual(['tai_lieu.pdf']);
        expect(result.otherFiles.map(file => file.name)).toEqual(['preview.jpg']);
    });

    it('khong dinh tuyen vao registry stale cua tab da dong', () => {
        const unregister = registerActiveTabFeature('tab-da-dong', 'upscale');
        try {
            expect(resolveActiveImageBatchReceiver(tabs, 'tab-da-dong')).toBeNull();
        } finally {
            unregister();
        }
    });

    it('tab kết quả gắn provenance generated, không phụ thuộc tên file', () => {
        const plainName = new File([], 'bao-gia-khach-hang.pdf');
        const payload = buildResultTabPayload(plainName);

        expect(payload).toEqual({ file: plainName });
        expect(isGeneratedWorkspaceFile(payload.file)).toBe(true);
    });

    it('tab kết quả không tự kế thừa chế độ khóa của tab cha', () => {
        const result = new File([], 'result.pdf');
        expect(buildResultTabPayload(result, { lockedMode: 'nup' })).toEqual({
            file: result,
            lockedMode: 'nup',
        });
    });

    it('source escape giữ file khách sạch và không để lộ khóa routing vào payload', () => {
        const customerFile = new File([], 'Hop_dong_converted_Edited_part_2026.pdf');
        const payload = buildResultTabPayload(
            customerFile,
            buildSourceTabOptions({ initialFeature: 'view' }),
        );

        expect(payload).toEqual({ file: customerFile, initialFeature: 'view' });
        expect(isGeneratedWorkspaceFile(customerFile)).toBe(false);
        expect(payload).not.toHaveProperty('__prynxOpenExistingSource');
    });

    it('source escape không tẩy provenance generated đã có trên file', () => {
        const generated = markGeneratedWorkspaceFile(new File([], 'ket-qua.pdf'));
        buildResultTabPayload(generated, buildSourceTabOptions());
        expect(isGeneratedWorkspaceFile(generated)).toBe(true);
    });

    it('tab kết quả chấp nhận marker generated non-configurable từ producer cũ', () => {
        const legacyGenerated = new File([], 'VDP_legacy.pdf');
        Object.defineProperty(legacyGenerated, 'isGenerated', { value: true });

        expect(() => buildResultTabPayload(legacyGenerated)).not.toThrow();
        expect(isGeneratedWorkspaceFile(legacyGenerated)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(legacyGenerated, 'isGenerated')).toMatchObject({
            value: true,
            configurable: false,
        });
    });

    it('identity nguồn mới sau lưu không kế thừa marker runtime cũ', () => {
        const generated = markGeneratedWorkspaceFile(new File(['pdf'], 'working.pdf', {
            type: 'application/pdf',
        }));
        Object.defineProperty(generated, 'isTempUploadPath', { value: true, configurable: true });
        Object.defineProperty(generated, '__nativePathPending', { value: true, configurable: true });

        const saved = createSavedSourceFile([generated], 'hop-dong.pdf', {
            type: 'application/pdf',
            path: 'D:\\Tai-lieu\\hop-dong.pdf',
        }) as File & {
            path?: string;
            isTempUploadPath?: boolean;
            __nativePathPending?: boolean;
        };

        expect(saved.path).toBe('D:\\Tai-lieu\\hop-dong.pdf');
        expect(isGeneratedWorkspaceFile(saved)).toBe(false);
        expect(saved.isTempUploadPath).toBeUndefined();
        expect(saved.__nativePathPending).toBeUndefined();
    });
    it('intent Combine giữ nguyên toàn bộ PDF và ảnh trong một batch', () => {
        const files = [
            { name: '01_bia.pdf' },
            { name: '02_ruot.PDF' },
            { name: '03_minh-hoa.png' },
        ];

        expect(planIncomingFiles(files, 'combine')).toEqual({
            mode: 'combine',
            files,
        });
    });

    it('không có intent Combine vẫn giữ quy tắc mở PDF kiểu Acrobat', () => {
        const files = [
            { name: 'tai-lieu.pdf' },
            { name: 'anh.jpg' },
        ];

        expect(planIncomingFiles(files, '')).toEqual({
            mode: 'default',
            pdfFiles: [files[0]],
            officeFiles: [],
            otherFiles: [files[1]],
        });
    });

});
