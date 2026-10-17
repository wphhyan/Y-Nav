import type { LucideIcon } from 'lucide-react';

export type { LucideIcon };

let cachedIcons: Record<string, LucideIcon> | null = null;
let pendingLoad: Promise<Record<string, LucideIcon>> | null = null;

/**
 * 判断某个导出值是否是可渲染的图标组件。
 *
 * `lucide-react` 的命名空间里除了图标还有 `createLucideIcon`、`icons` 等
 * 非组件导出，直接当组件用会抛错，所以这里做一次过滤。
 */
export const isRenderableIcon = (value: unknown): value is LucideIcon => {
    if (typeof value === 'function') return true;
    return typeof value === 'object' && value !== null && '$$typeof' in (value as Record<string, unknown>);
};

/**
 * 按需加载完整的 lucide 图标库（只在真正遇到"冷门图标名"时才调用）。
 *
 * 完整图标库约 863KB（gzip 158KB）。此前 `Icon.tsx` 用 `import * as LucideIcons`
 * 静态引用它，导致整个库被塞进入口关键路径：首屏必须先下载并解析它才能渲染。
 * 现在只有不在首屏常用表里的图标名才会触发这里，且是异步进行，不再阻塞首屏。
 */
export const loadLucideIcons = (): Promise<Record<string, LucideIcon>> => {
    if (cachedIcons) return Promise.resolve(cachedIcons);
    if (!pendingLoad) {
        pendingLoad = import('lucide-react').then((mod) => {
            const icons: Record<string, LucideIcon> = {};
            for (const [key, value] of Object.entries(mod)) {
                if (isRenderableIcon(value)) icons[key] = value;
            }
            cachedIcons = icons;
            return icons;
        });
    }
    return pendingLoad;
};
