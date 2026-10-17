/**
 * 图标地址处理
 *
 * 站点原先直接引用第三方 favicon 服务 (faviconextractor.com)，
 * 每个图标都是一次独立的跨域请求：在本机实测 TLS 0.65~0.81s、TTFB 1.26~1.44s，
 * 首页 18 个图标会排队拖出 3.5 秒的长尾。
 *
 * 这里统一把第三方地址改写成同源路径 /favicon/<host>，
 * 由 Worker 代理并做 30 天边缘缓存（见 worker/index.ts 的 handleFavicon）：
 * 浏览器的连接复用主站，同一域名全网只需回源一次。
 */

/** 需要被改写为同源代理的第三方 favicon 服务域名 */
const FAVICON_SERVICE_HOSTS = new Set([
    'www.faviconextractor.com',
    'faviconextractor.com',
]);

/** 同源代理前缀，需与 worker 的 /favicon/<host> 路由保持一致 */
export const FAVICON_PROXY_PREFIX = '/favicon/';

const FAVICON_PATH_PATTERN = /^\/favicon\/([^/?#]+)/i;

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** 从 URL 或裸域名中取出 hostname，取不到返回空串 */
export const extractHostname = (input: string): string => {
    if (!input) return '';
    try {
        const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
        return new URL(withScheme).hostname;
    } catch {
        return '';
    }
};

/** 生成同源 favicon 代理地址 */
export const buildFaviconProxyUrl = (hostname: string): string => {
    const normalized = (hostname || '').trim().toLowerCase();
    if (!normalized || !HOSTNAME_PATTERN.test(normalized)) return '';
    return `${FAVICON_PROXY_PREFIX}${normalized}`;
};

/** 从链接地址直接生成同源 favicon 代理地址 */
export const buildFaviconProxyUrlFromLink = (link: string): string =>
    buildFaviconProxyUrl(extractHostname(link));

/**
 * 判断图标是否来自 favicon 服务（含历史数据里的第三方旧地址与新的同源代理地址）。
 * 用于「本地缓存图标优先于远程图标」的判断。
 */
export const isFaviconServiceUrl = (icon?: string): boolean => {
    if (!icon) return false;
    if (icon.startsWith(FAVICON_PROXY_PREFIX)) return true;
    try {
        return FAVICON_SERVICE_HOSTS.has(new URL(icon).hostname);
    } catch {
        return false;
    }
};

/**
 * 把图标地址规范化为可直接渲染的地址：
 * - 第三方 favicon 服务 → 同源 /favicon/<host>（走边缘缓存）
 * - data: / blob: / 本地路径 / 用户自定义地址 → 原样返回
 * - lucide 图标名等非 URL 字符串 → 原样返回（由调用方处理）
 */
export const resolveIconUrl = (icon?: string): string => {
    if (!icon) return '';
    if (icon.startsWith(FAVICON_PROXY_PREFIX)) return icon;
    if (icon.startsWith('data:') || icon.startsWith('blob:')) return icon;
    try {
        const url = new URL(icon);
        if (!FAVICON_SERVICE_HOSTS.has(url.hostname)) return icon;
        const match = FAVICON_PATH_PATTERN.exec(url.pathname);
        if (!match) return icon;
        const hostname = decodeURIComponent(match[1]).toLowerCase();
        if (!HOSTNAME_PATTERN.test(hostname)) return icon;
        return `${FAVICON_PROXY_PREFIX}${hostname}`;
    } catch {
        // 非 URL（lucide 图标名、emoji 等）
        return icon;
    }
};
