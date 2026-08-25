// Contract dùng chung giữa TextCompareTab và Web Worker so sánh văn bản.
export type TextDiffMode = 'word' | 'line';

export interface TextDiffRequest {
    a: string;
    b: string;
    mode: TextDiffMode;
    ignoreSpaces: boolean;
}

export interface DiffPart {
    value: string;
    added: boolean;
    removed: boolean;
}

export type TextDiffWorkerResponse =
    | { ok: true; parts: DiffPart[] }
    | { ok: false; error: string };
