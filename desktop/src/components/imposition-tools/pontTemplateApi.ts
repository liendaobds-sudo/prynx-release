/**
 * pontTemplateApi.ts — API client trích xuất thông số boong định vị từ file mẫu PDF/SVG.
 */

import { authenticatedFetch, getApiUrl } from '../../lib/api';
import type { PontConfig } from './types';

export interface InspectPontTemplateResponse {
    success: boolean;
    filename: string;
    suggestedName: string;
    sheet: {
        widthMm: number;
        heightMm: number;
    };
    detected: {
        marksFound: number;
        corners: string[];
        shape?: 'circle' | 'l_corner' | 'l_inverted';
        size?: number;
        thickness?: number;
        marginLeft?: number;
        marginRight?: number;
        marginTop?: number;
        marginBottom?: number;
    };
    config: PontConfig;
    message: string;
}

export async function inspectPontTemplate(fileOrPath: File | string): Promise<InspectPontTemplateResponse> {
    const formData = new FormData();
    if (typeof fileOrPath === 'string') {
        formData.append('path', fileOrPath);
    } else {
        formData.append('file', fileOrPath);
    }

    const res = await authenticatedFetch(`${getApiUrl()}/imposition/inspect-pont-template`, {
        method: 'POST',
        body: formData,
    });

    if (!res.ok) {
        let errDetail = 'Không thể phân tích file mẫu.';
        try {
            const errJson = (await res.json()) as { detail?: string | unknown };
            if (errJson && errJson.detail) {
                errDetail = typeof errJson.detail === 'string' ? errJson.detail : JSON.stringify(errJson.detail);
            }
        } catch {
            // Không parse được json, giữ thông báo mặc định
        }
        throw new Error(errDetail);
    }

    return (await res.json()) as InspectPontTemplateResponse;
}
