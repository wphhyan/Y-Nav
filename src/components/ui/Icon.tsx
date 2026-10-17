import React from 'react';
import {
    BookOpen,
    Bookmark,
    Bot,
    Brain,
    Cloud,
    Code,
    Cpu,
    Database,
    FileText,
    Folder,
    Globe,
    Home,
    Lightbulb,
    Link,
    Lock,
    MessageCircle,
    Music,
    Pin,
    Rocket,
    Send,
    Server,
    ShoppingCart,
    Star,
    Tag,
    Terminal,
    Truck,
    Users
} from 'lucide-react';
import { loadLucideIcons, isRenderableIcon, type LucideIcon } from '../../utils/lucideLoader';

interface IconProps {
    name: string;
    size?: number;
    className?: string;
}

/**
 * 首屏常用图标（内联进入口包）。
 *
 * 覆盖应用自身在首屏用到的图标 + 分类图标里常见的那些。
 * 完整 lucide 图标库有 863KB，此前被 `import * as LucideIcons` 整包拽进
 * 入口关键路径；现在只有落到下面"冷门名字"的图标才会异步加载完整库。
 */
const eagerIcons: Record<string, LucideIcon> = {
    BookOpen,
    Bookmark,
    Bot,
    Brain,
    Cloud,
    Code,
    Cpu,
    Database,
    FileText,
    Folder,
    Globe,
    Home,
    Lightbulb,
    Link,
    Lock,
    MessageCircle,
    Music,
    Pin,
    Rocket,
    Send,
    Server,
    ShoppingCart,
    Star,
    Tag,
    Terminal,
    Truck,
    Users
};

/**
 * lucide 图标名的形状：PascalCase。
 *
 * `Category.icon` 的类型注释是"Lucide 图标名或 emoji"，历史数据/导入数据里也可能
 * 出现小写或其它脏字符串。这些名字永远不可能命中 lucide，必须直接兜底 ——
 * 否则每渲染一次就会白拉一次 154KB 的完整图标库。
 */
const LUCIDE_NAME_SHAPE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * 已知在 lucide 中不存在的名字。
 *
 * lucide 移除了大部分品牌图标，但 `IconSelector` 的常用列表和用户的历史数据里
 * 仍可能留着这类名字（例如用户数据里的 `Firefox`）。这批名字形状合法、但永远
 * 命中不了，必须直接兜底：否则每渲染一次就会触发一次完整图标库
 * （154KB gzip）的下载，反而比改动前更慢。
 */
const unavailableIcons = new Set([
    'Firefox', 'Safari', 'Edge',
    'Wechat', 'Weibo', 'Bilibili', 'Telegram', 'Whatsapp', 'Discord',
    'Reddit', 'Medium', 'Notion', 'Behance', 'Dropbox', 'Spotify',
    'Netflix', 'Steam', 'Paypal', 'Alipay', 'Taobao', 'Jd', 'Zhihu',
    'Tiktok', 'Vercel', 'Cloudflare', 'Openai', 'Docker', 'Kubernetes',
    'Linux', 'Windows'
]);

/** 冷门但有效的图标：异步取完整库，取到之前先用 Link 兜底（与原行为一致） */
const DeferredIcon: React.FC<{ name: string; size: number; className?: string }> = ({ name, size, className }) => {
    const [icons, setIcons] = React.useState<Record<string, LucideIcon> | null>(null);

    React.useEffect(() => {
        let alive = true;
        loadLucideIcons()
            .then((mod) => {
                if (alive) setIcons(mod);
            })
            .catch(() => {
                // 加载失败时保持兜底图标
            });
        return () => {
            alive = false;
        };
    }, []);

    const Deferred = icons && isRenderableIcon(icons[name]) ? icons[name] : null;

    if (!Deferred) {
        return <Link size={size} className={className} />;
    }
    return <Deferred size={size} className={className} />;
};

const Icon: React.FC<IconProps> = ({ name, size = 20, className }) => {
    const Eager = eagerIcons[name];
    if (Eager) {
        return <Eager size={size} className={className} />;
    }

    if (unavailableIcons.has(name) || !LUCIDE_NAME_SHAPE.test(name)) {
        return <Link size={size} className={className} />;
    }

    return <DeferredIcon name={name} size={size} className={className} />;
};

export default Icon;
