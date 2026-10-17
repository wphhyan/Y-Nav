import React from 'react';
import { LinkItem } from '../../types';
import { EyeOff, Settings } from 'lucide-react';
import { getIconToneClass, getIconToneStyle } from '../../utils/iconTone';
import LazyIcon from './LazyIcon';

interface LinkCardProps {
    link: LinkItem;
    siteCardStyle: 'detailed' | 'simple';
    isBatchEditMode: boolean;
    isSelected: boolean;
    readOnly?: boolean;
    onSelect: (id: string) => void;
    onContextMenu: (e: React.MouseEvent, link: LinkItem) => void;
    onEdit: (link: LinkItem) => void;
}

const LinkCard: React.FC<LinkCardProps> = ({
    link,
    siteCardStyle,
    isBatchEditMode,
    isSelected,
    readOnly = false,
    onSelect,
    onContextMenu,
    onEdit
}) => {
    const isDetailedView = siteCardStyle === 'detailed';

    const cardClasses = `
        group relative transition-all duration-300 rounded-2xl
        border bg-white dark:bg-slate-900/40 backdrop-blur-sm
        ${isBatchEditMode
            ? 'cursor-pointer border-slate-200 dark:border-white/10'
            : 'hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/10 shadow-sm shadow-slate-200/50 dark:shadow-none cursor-pointer'
        }
        ${isSelected
            ? 'border-rose-500 ring-2 ring-rose-500/20 bg-rose-50 dark:bg-rose-900/10'
            : 'border-slate-200/60 dark:border-white/5 hover:border-accent/40 dark:hover:border-accent/40'
        }
        ${isDetailedView ? 'p-5' : 'p-3.5'}
    `;

    const customToneStyle = getIconToneStyle(link.iconTone);
    const colorClass = customToneStyle ? '' : getIconToneClass(link.icon, link.url, link.title);

    const iconContainerClasses = `
        flex items-center justify-center shrink-0 rounded-xl overflow-hidden shadow-sm transition-transform duration-300 group-hover:scale-105
        ${colorClass}
        ${isDetailedView
            ? 'w-12 h-12 border border-black/5 dark:border-white/5'
            : 'w-9 h-9 border border-black/5 dark:border-white/5'
        }
    `;

    const titleClasses = `
        font-medium truncate transition-colors
        ${isDetailedView
            ? 'text-base text-slate-800 dark:text-slate-100 group-hover:text-accent'
            : 'text-sm text-slate-700 dark:text-slate-200 group-hover:text-accent'
        }
    `;

    const descriptionClasses = `
        leading-relaxed line-clamp-2 mt-1.5
        ${isDetailedView
            ? 'text-sm text-slate-500 dark:text-slate-400'
            : 'text-xs text-slate-500 dark:text-slate-400'
        }
    `;

    const renderContent = () => (
        <>
            {/* Icon + Title Row */}
            <div className="flex items-center gap-3">
                <div className={iconContainerClasses} style={customToneStyle}>
                    <LazyIcon
                        src={link.icon}
                        fallback={link.title.charAt(0)}
                        sizeClassName={isDetailedView ? 'w-6 h-6' : 'w-5 h-5'}
                    />
                </div>
                <h3 className={titleClasses} title={link.title}>
                    {link.title}
                </h3>
            </div>

            {/* Description */}
            {isDetailedView && link.description && (
                <p className={descriptionClasses}>
                    {link.description}
                </p>
            )}
        </>
    );

    return (
        <div
            className={cardClasses}
            onClick={() => isBatchEditMode && onSelect(link.id)}
            onContextMenu={(e) => onContextMenu(e, link)}
        >
            {isBatchEditMode ? (
                <div className={`flex ${isDetailedView ? 'flex-col' : 'items-center'} min-w-0`}>
                    {renderContent()}
                </div>
            ) : (
                <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex ${isDetailedView ? 'flex-col' : 'items-center'} min-w-0`}
                    title={isDetailedView ? link.url : (link.description || link.url)}
                >
                    {renderContent()}
                </a>
            )}

            {/* Simple view tooltip */}
            {!isDetailedView && link.description && !isBatchEditMode && (
                <div className="absolute left-1/2 -translate-x-1/2 -top-10 w-max max-w-[200px] bg-slate-900 text-white text-xs px-3 py-1.5 rounded-lg opacity-0 invisible group-hover:visible group-hover:opacity-100 transition-all z-20 pointer-events-none shadow-lg">
                    {link.description}
                    <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-slate-900"></div>
                </div>
            )}

            {/* Hover Actions */}
            {!isBatchEditMode && !readOnly && (
                <div className={`
                    absolute opacity-0 group-hover:opacity-100 transition-all duration-200
                    ${isDetailedView ? 'top-3 right-3' : 'top-1/2 -translate-y-1/2 right-2'}
                `}>
                    <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(link); }}
                        className="p-1.5 text-slate-400 hover:text-accent bg-white/90 dark:bg-slate-800/90 backdrop-blur rounded-lg shadow-sm border border-slate-200/50 dark:border-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
                        title="编辑"
                    >
                        <Settings size={14} />
                    </button>
                </div>
            )}

            {/* Hidden marker */}
            {!isBatchEditMode && link.hidden && (
                <div className="absolute bottom-2 right-2 px-2 py-1 rounded-lg text-[10px] font-semibold bg-slate-900/5 dark:bg-white/10 text-slate-600 dark:text-slate-200 border border-slate-200/60 dark:border-white/10 flex items-center gap-1">
                    <EyeOff size={12} />
                    隐藏
                </div>
            )}

            {/* Selection indicator for batch mode */}
            {isBatchEditMode && (
                <div className={`absolute top-2 right-2 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${isSelected
                    ? 'bg-rose-500 border-rose-500 text-white'
                    : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800'
                    }`}>
                    {isSelected && (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                    )}
                </div>
            )}
        </div>
    );
};

export default LinkCard;
