import { authenticatedFetch, getApiUrl } from '../api';
import type { BoxParams, DielineModel } from './types';
import type { NestingConfig, NestingResult } from './nestingTypes';

export interface DielineGenerateRequest {
    params: BoxParams;
    nestingConfig: NestingConfig;
    changedKey?: keyof BoxParams;
}

export interface DielineGenerateResponse {
    params: BoxParams;
    dieline: DielineModel;
    nestingResult: NestingResult | null;
    sleeveNestingResult: NestingResult | null;
    wasClamped: boolean;
}

export async function generateDielineRemote(
    request: DielineGenerateRequest,
    signal?: AbortSignal,
): Promise<DielineGenerateResponse> {
    const response = await authenticatedFetch(`${getApiUrl()}/dieline/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
    });
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = await response.json();
            detail = body?.detail || detail;
        } catch { /* response is not JSON */ }
        throw new Error(detail);
    }
    return response.json() as Promise<DielineGenerateResponse>;
}
