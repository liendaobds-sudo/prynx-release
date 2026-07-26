// ============================================================
// DielineGallery — Landing page to pick box type
// Layout giống printsolutions: Text trên, Ảnh dưới
// ============================================================

import React from 'react';
import { BoxParams } from '../../lib/dieline/types';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface BoxTypeCard {
    type: BoxParams['boxType'];
    name: string;
    desc: string;
    image: string;
}

const BOX_TYPES: BoxTypeCard[] = [
    {
        type: 'rte',
        name: 'Tạo khuôn hộp nắp cài sole',
        desc: 'Reverse Tuck End — khuôn hộp phổ biến',
        image: '/images/dieline/rte.png',
    },
    {
        type: 'slb',
        name: 'Tạo khuôn hộp đáy gài',
        desc: 'Snap-Lock Bottom — đáy tự khoá chắc chắn',
        image: '/images/dieline/slb.png',
    },
    {
        type: 'auto_bottom',
        name: 'Tạo khuôn hộp đáy dán',
        desc: 'Auto-Bottom — đáy dán keo sẵn, tự bung khi dựng',
        image: '/images/dieline/auto_bottom.svg',
    },
    {
        type: 'paper_bag',
        name: 'Tạo khuôn túi giấy',
        desc: 'Tạo khuôn túi giấy nhiều quy cách',
        image: '/images/dieline/paper_bag.png',
    },
    {
        type: 'gable',
        name: 'Tạo khuôn hộp quai xách',
        desc: 'Gable Box — hộp có quai xách tiện lợi',
        image: '/images/dieline/gable.png',
    },
    {
        type: 'cup_sleeve',
        name: 'Bọc Ly',
        desc: 'Cup Sleeve — bao giấy bọc ly cà phê',
        image: '/images/dieline/cup_sleeve.png',
    },
    {
        type: 'pizza',
        name: 'Hộp Pizza',
        desc: 'Hộp pizza nắp lật',
        image: '/images/dieline/pizza.png',
    },
    {
        type: 'envelope',
        name: 'Vẽ khuôn bì thư/bì lì xì',
        desc: 'Tạo khuôn bế bì thư với các kiểu nắp khác nhau',
        image: '/images/dieline/envelope.png',
    },
    {
        type: 'tray',
        name: 'Hộp Diêm / Khay',
        desc: 'hộp khay 4 góc dán, đựng thực phẩm',
        image: '/images/dieline/tray.png',
    },
];

// ─── Gallery Card — Text trên, Ảnh dưới ────────────────────

function GalleryCard({
    card,
    onSelect,
}: {
    card: BoxTypeCard;
    onSelect: (type: BoxParams['boxType']) => void;
}) {
    return (
        <button
            className="dt-gallery-card"
            onClick={() => onSelect(card.type)}
        >
            {/* Header: text + description */}
            <div className="dt-gallery-card-header">
                <h3 className="dt-gallery-card-title">{tv(card.name)}</h3>
                <p className="dt-gallery-card-desc">{tv(card.desc)}</p>
            </div>

            {/* Image preview — fills remaining space */}
            <div className="dt-gallery-card-preview">
                <img
                    src={card.image}
                    alt={tv(card.name)}
                    className="dt-gallery-card-img"
                    draggable={false}
                    loading="lazy"
                />
                {/* Hover overlay gradient */}
                <div className="dt-gallery-card-overlay" />
            </div>
        </button>
    );
}

// ─── Gallery Main ──────────────────────────────────────────

interface DielineGalleryProps {
    onSelect: (type: BoxParams['boxType']) => void;
}

export default function DielineGallery({ onSelect }: DielineGalleryProps) {
  const { t } = useTranslation();
    return (
        <div className="dt-gallery">
            <header className="dt-gallery-header">
                <div className="dt-gallery-header-text">
                    <h1 className="dt-gallery-title">
                        <span className="dt-gallery-title-icon">📦</span>
                        {t('dieline.dielineGallery:khuon_be_bao_bi')}
                    </h1>
                    <p className="dt-gallery-subtitle">
                        {t('dieline.dielineGallery:chon_loai_khuon_bao_bi_de_bat_dau_thiet')}
                    </p>
                </div>
            </header>

            <div className="dt-gallery-grid">
                {BOX_TYPES.map((card) => (
                    <GalleryCard key={card.type} card={card} onSelect={onSelect} />
                ))}
            </div>
        </div>
    );
}
