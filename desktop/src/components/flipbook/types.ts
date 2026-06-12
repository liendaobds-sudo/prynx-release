export interface BookPage {
    id: string | number;
    type: 'cover' | 'content' | 'back-cover';
    imageUrl: string;
    pageNumber?: number;
    signatureInfo?: string;
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
