// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VdpProofPreview from './VdpProofPreview';

const preview = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/api', () => ({ previewVdpRecord: preview.call }));

describe('VdpProofPreview', () => {
    it('gọi đúng API preview production và hiển thị ảnh PNG trả về', async () => {
        preview.call.mockResolvedValueOnce({
            image_png_base64: 'aW1hZ2U=', record_index: 2, clamped: false,
            empty_source: false, width: 10, height: 20, message: '', field_errors: [],
        });
        render(<VdpProofPreview
            fields={[{ id: 'f1' }]}
            requestedIndex={2}
            templateFile={new File(['pdf'], 'template.pdf', { type: 'application/pdf' })}
            rows={[{ Name: 'Lan' }]}
        />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Xem preview production/i })); });
        await waitFor(() => expect(screen.getByAltText('VDP production preview')).toBeTruthy());
        expect(preview.call).toHaveBeenCalledWith(expect.objectContaining({ requestedIndex: 2, rows: [{ Name: 'Lan' }] }));
    });
});
