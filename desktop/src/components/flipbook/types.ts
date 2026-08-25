export interface BookPage {
    id: string | number;
    type: 'cover' | 'content' | 'back-cover';
    imageUrl: string;
    pageNumber?: number;
    signatureInfo?: string;
    /** Trang đệm nội bộ không ánh xạ về trang PDF nguồn. */
    _originalIndex?: number;
}

export interface Sheet {
    id: string | number;
    front: BookPage;
    back: BookPage;
}

export interface BookData {
    title?: string;
    pages: BookPage[];
}
