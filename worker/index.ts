/**
 * Y-Nav Cloudflare Worker 入口
 *
 * 功能:
 * 1. 处理 /api/sync 相关请求
 * 2. 其余请求交给 Static Assets 绑定托管静态资源 (SPA)
 *
 * 静态资源由 Cloudflare Static Assets 提供（见 wrangler.toml 的 [assets]）。
 * 命中资源的请求由边缘直接返回，不会调用本 Worker。
 */

// ============================================
// 类型定义
// ============================================

interface KVNamespaceInterface {
    get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string; expiration?: number }> }>;
}

interface Env {
    YNAV_WORKER_KV: KVNamespaceInterface;
    SYNC_PASSWORD?: string;
    VIEW_PASSWORD?: string;
    /** Static Assets 绑定（对应 wrangler.toml 中 [assets] 的 binding） */
    ASSETS: Fetcher;
}

interface SyncMetadata {
    updatedAt: number;
    deviceId: string;
    version: number;
    browser?: string;
    os?: string;
}

interface YNavSyncData {
    links: any[];
    categories: any[];
    searchConfig?: any;
    aiConfig?: any;
    siteSettings?: any;
    privateVault?: string;
    schemaVersion?: number;
    meta: SyncMetadata;
}

// ============================================
// 常量
// ============================================

const SYNC_API_VERSION = 'v1';
const KV_MAIN_DATA_KEY = `ynav:data:${SYNC_API_VERSION}`;
const KV_BACKUP_PREFIX = `ynav:backup:${SYNC_API_VERSION}:`;
// Legacy (pre-versioned) keys for backward compatibility
const KV_LEGACY_MAIN_DATA_KEY = 'ynav:data';
const KV_LEGACY_BACKUP_PREFIX = 'ynav:backup:';
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;

// --- favicon 同源代理 ---
const FAVICON_PATH_PREFIX = '/favicon/';
const FAVICON_UPSTREAM = 'https://www.faviconextractor.com/favicon/';
const FAVICON_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const FAVICON_HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ============================================
// 辅助函数
// ============================================

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Password, X-View-Password',
};

function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        }
    });
}

function isWriteAuthenticated(request: Request, env: Env): boolean {
    if (!env.SYNC_PASSWORD || env.SYNC_PASSWORD.trim() === '') {
        return true;
    }
    const authHeader = request.headers.get('X-Sync-Password');
    return authHeader === env.SYNC_PASSWORD;
}

function getWriteAuthStatus(request: Request, env: Env) {
    const passwordRequired = !!(env.SYNC_PASSWORD && env.SYNC_PASSWORD.trim() !== '');
    const canWrite = !passwordRequired || isWriteAuthenticated(request, env);
    return { passwordRequired, canWrite };
}

function isViewAuthenticated(request: Request, env: Env): boolean {
    if (!env.VIEW_PASSWORD || env.VIEW_PASSWORD.trim() === '') {
        return false;
    }
    const authHeader = request.headers.get('X-View-Password');
    return authHeader === env.VIEW_PASSWORD;
}

function getViewAuthStatus(request: Request, env: Env) {
    const viewPasswordRequired = !!(env.VIEW_PASSWORD && env.VIEW_PASSWORD.trim() !== '');
    const canView = !viewPasswordRequired ? false : isViewAuthenticated(request, env);
    return { viewPasswordRequired, canView };
}

function buildSafeData(data: YNavSyncData, includeHidden: boolean): YNavSyncData {
    if (includeHidden) {
        return {
            links: data.links,
            categories: data.categories,
            searchConfig: data.searchConfig,
            siteSettings: data.siteSettings,
            schemaVersion: data.schemaVersion,
            privateVault: undefined,
            aiConfig: undefined,
            meta: data.meta
        };
    }

    const allCategories = (data.categories || []) as any[];
    // 隐藏需要穿透父子：父分类隐藏时，其子分类同样视为隐藏，
    // 否则访客可以经由子分类拿到本该隐藏的分类与链接。
    const hiddenCategoryIds = new Set(
        allCategories.filter((c: any) => c?.hidden).map((c: any) => c.id)
    );
    const visibleCategories = allCategories.filter((c: any) => {
        if (c?.hidden) return false;
        if (c?.parentId && hiddenCategoryIds.has(c.parentId)) return false;
        return true;
    });
    const visibleCategoryIds = new Set(visibleCategories.map((c: any) => c.id));
    const visibleLinks = (data.links || []).filter((l: any) => {
        if (l?.hidden) return false;
        if (l?.categoryId && !visibleCategoryIds.has(l.categoryId)) return false;
        return true;
    });

    return {
        links: visibleLinks,
        categories: visibleCategories,
        searchConfig: data.searchConfig,
        siteSettings: data.siteSettings,
        schemaVersion: data.schemaVersion,
        privateVault: undefined,
        aiConfig: undefined,
        meta: data.meta
    };
}

const isBackupKeyValid = (backupKey: string) => (
    backupKey.startsWith(KV_BACKUP_PREFIX) || backupKey.startsWith(KV_LEGACY_BACKUP_PREFIX)
);

const getBackupTimestamp = (backupKey: string) => {
    if (backupKey.startsWith(KV_BACKUP_PREFIX)) return backupKey.replace(KV_BACKUP_PREFIX, '');
    if (backupKey.startsWith(KV_LEGACY_BACKUP_PREFIX)) return backupKey.replace(KV_LEGACY_BACKUP_PREFIX, '');
    return backupKey;
};

const getBackupApiVersion = (backupKey: string) => (
    backupKey.startsWith(KV_BACKUP_PREFIX) ? SYNC_API_VERSION : 'legacy'
);

async function loadCurrentData(env: Env): Promise<YNavSyncData | null> {
    const v1 = await env.YNAV_WORKER_KV.get(KV_MAIN_DATA_KEY, 'json') as YNavSyncData | null;
    if (v1) return v1;
    const legacy = await env.YNAV_WORKER_KV.get(KV_LEGACY_MAIN_DATA_KEY, 'json') as YNavSyncData | null;
    return legacy;
}

// ============================================
// API 处理函数
// ============================================

async function handleApiSync(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // CORS 预检
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        if (request.method === 'GET') {
            if (action === 'whoami') {
                const auth = getWriteAuthStatus(request, env);
                const view = getViewAuthStatus(request, env);
                return jsonResponse({
                    success: true,
                    apiVersion: SYNC_API_VERSION,
                    ...auth,
                    viewPasswordRequired: view.viewPasswordRequired,
                    canView: auth.canWrite ? true : view.canView
                });
            }
            if (action === 'backups') {
                if (!isWriteAuthenticated(request, env)) {
                    return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Unauthorized' }, 401);
                }
                return await handleListBackups(env);
            }
            return await handleGet(request, env);
        }

        if (request.method === 'POST') {
            if (!isWriteAuthenticated(request, env)) {
                return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Unauthorized' }, 401);
            }
            if (action === 'backup') {
                return await handleBackup(request, env);
            }
            if (action === 'restore') {
                return await handleRestore(request, env);
            }
            return await handlePost(request, env);
        }

        if (request.method === 'DELETE') {
            if (!isWriteAuthenticated(request, env)) {
                return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Unauthorized' }, 401);
            }
            if (action === 'backup') {
                return await handleDeleteBackup(request, env);
            }
            return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Method not allowed' }, 405);
        }

        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Method not allowed' }, 405);
    } catch (error: any) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: error.message || '服务器错误' }, 500);
    }
}

async function handleGet(request: Request, env: Env): Promise<Response> {
    const data = await loadCurrentData(env);
    if (!data) {
        return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data: null, message: '云端暂无数据' });
    }
    const auth = getWriteAuthStatus(request, env);
    const siteMode = (data as any)?.siteSettings?.siteMode;
    const isWebmaster = siteMode === 'webmaster';
    const view = getViewAuthStatus(request, env);

    if (!isWebmaster) {
        if (!auth.canWrite) {
            return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: 'Unauthorized' }, 401);
        }
        return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data });
    }

    if (auth.canWrite) {
        return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data });
    }

    if (view.canView) {
        return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data: buildSafeData(data, true) });
    }

    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data: buildSafeData(data, false) });
}

async function handlePost(request: Request, env: Env): Promise<Response> {
    const body = await request.json() as { data: YNavSyncData; expectedVersion?: number };

    if (!body.data) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '缺少 data 字段' }, 400);
    }

    const existingData = await loadCurrentData(env);

    // 版本冲突检测
    if (existingData && body.expectedVersion !== undefined) {
        if (existingData.meta.version !== body.expectedVersion) {
            return jsonResponse({
                success: false,
                apiVersion: SYNC_API_VERSION,
                conflict: true,
                data: existingData,
                error: '版本冲突，云端数据已被其他设备更新'
            }, 409);
        }
    }

    const newVersion = existingData ? existingData.meta.version + 1 : 1;
    const dataToSave: YNavSyncData = {
        ...body.data,
        meta: {
            ...body.data.meta,
            updatedAt: Date.now(),
            version: newVersion
        }
    };

    await env.YNAV_WORKER_KV.put(KV_MAIN_DATA_KEY, JSON.stringify(dataToSave));
    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data: dataToSave, message: '同步成功' });
}

async function handleBackup(request: Request, env: Env): Promise<Response> {
    const body = await request.json() as { data: YNavSyncData };
    if (!body.data) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '缺少 data 字段' }, 400);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
    const backupKey = `${KV_BACKUP_PREFIX}${timestamp}`;

    await env.YNAV_WORKER_KV.put(backupKey, JSON.stringify(body.data), {
        expirationTtl: BACKUP_TTL_SECONDS
    });

    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, backupKey, message: `备份成功: ${backupKey}` });
}

async function handleRestore(request: Request, env: Env): Promise<Response> {
    const body = await request.json() as { backupKey?: string; deviceId?: string };
    const backupKey = body.backupKey;

    if (!backupKey || !isBackupKeyValid(backupKey)) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '无效的备份 key' }, 400);
    }

    const backupData = await env.YNAV_WORKER_KV.get(backupKey, 'json') as YNavSyncData | null;
    if (!backupData) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '备份不存在或已过期' }, 404);
    }

    const existingData = await loadCurrentData(env);
    const now = Date.now();
    let rollbackKey: string | null = null;

    // 创建回滚点
    if (existingData) {
        const rollbackTimestamp = new Date(now).toISOString().replace(/[:.]/g, '-').split('.')[0];
        rollbackKey = `${KV_BACKUP_PREFIX}rollback-${rollbackTimestamp}`;
        await env.YNAV_WORKER_KV.put(rollbackKey, JSON.stringify({
            ...existingData,
            meta: { ...existingData.meta, updatedAt: now, deviceId: body.deviceId || existingData.meta.deviceId }
        }), { expirationTtl: BACKUP_TTL_SECONDS });
    }

    const newVersion = (existingData?.meta?.version ?? 0) + 1;
    const restoredData: YNavSyncData = {
        ...backupData,
        meta: {
            ...(backupData.meta || {}),
            updatedAt: now,
            deviceId: body.deviceId || backupData.meta?.deviceId || 'unknown',
            version: newVersion
        }
    };

    await env.YNAV_WORKER_KV.put(KV_MAIN_DATA_KEY, JSON.stringify(restoredData));
    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, data: restoredData, rollbackKey });
}

async function handleListBackups(env: Env): Promise<Response> {
    const [v1List, legacyList] = await Promise.all([
        env.YNAV_WORKER_KV.list({ prefix: KV_BACKUP_PREFIX }),
        env.YNAV_WORKER_KV.list({ prefix: KV_LEGACY_BACKUP_PREFIX })
    ]);
    const legacyOnlyKeys = legacyList.keys.filter(k => !k.name.startsWith(KV_BACKUP_PREFIX));
    const keys = [...v1List.keys, ...legacyOnlyKeys];

    const backups = await Promise.all(keys.map(async (key) => {
        let meta: SyncMetadata | null = null;
        let schemaVersion: number | undefined;
        try {
            const data = await env.YNAV_WORKER_KV.get(key.name, 'json') as YNavSyncData | null;
            meta = data?.meta || null;
            schemaVersion = data?.schemaVersion;
        } catch {
            meta = null;
        }
        return {
            key: key.name,
            apiVersion: getBackupApiVersion(key.name),
            timestamp: getBackupTimestamp(key.name),
            expiration: key.expiration,
            deviceId: meta?.deviceId,
            updatedAt: meta?.updatedAt,
            version: meta?.version,
            browser: meta?.browser,
            os: meta?.os,
            schemaVersion
        };
    }));

    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, backups });
}

async function handleDeleteBackup(request: Request, env: Env): Promise<Response> {
    const body = await request.json() as { backupKey?: string };
    const backupKey = body.backupKey;
    if (!backupKey || !isBackupKeyValid(backupKey)) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '无效的备份 key' }, 400);
    }
    const existing = await env.YNAV_WORKER_KV.get(backupKey, 'json');
    if (!existing) {
        return jsonResponse({ success: false, apiVersion: SYNC_API_VERSION, error: '备份不存在或已过期' }, 404);
    }
    await env.YNAV_WORKER_KV.delete(backupKey);
    return jsonResponse({ success: true, apiVersion: SYNC_API_VERSION, message: '备份已删除' });
}

// ============================================
// favicon 同源代理
// ============================================

/**
 * GET /favicon/<host>
 *
 * 卡片图标原先直接引用 faviconextractor.com 的跨域地址：实测每个图标
 * TLS 0.65~0.81s、TTFB 1.26~1.44s、约 6.5KB，首页十几个图标会拖出数秒长尾
 * （173 条数据里最多单页 25 个图标）。
 *
 * 这里改为同源代理 + 边缘缓存：
 * - 浏览器复用主站连接，不再为图标额外握手；
 * - 同一域名全网只回源一次，之后由边缘直接返回。
 */
async function handleFavicon(request: Request, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = decodeURIComponent(url.pathname.slice(FAVICON_PATH_PREFIX.length))
        .replace(/\/+$/, '')
        .toLowerCase();

    // 严格校验 hostname，避免这个入口变成任意 URL 代理
    if (!host || host.length > 253 || !FAVICON_HOSTNAME_PATTERN.test(host)) {
        return notFoundFavicon();
    }

    // 缓存键去掉查询串，避免 ?v=xxx 之类的参数击穿缓存
    const cacheKey = new Request(`${url.origin}${FAVICON_PATH_PREFIX}${host}`, { method: 'GET' });
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream: Response;
    try {
        upstream = await fetch(`${FAVICON_UPSTREAM}${encodeURIComponent(host)}?larger=true`, {
            headers: { 'Accept': 'image/*' }
        });
    } catch {
        return notFoundFavicon();
    }

    if (!upstream.ok || !upstream.body) {
        return notFoundFavicon();
    }

    const response = new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'image/x-icon',
            'Cache-Control': `public, max-age=${FAVICON_CACHE_TTL_SECONDS}, immutable`
        }
    });

    try {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } catch {
        // 写缓存失败不影响本次响应
    }

    return response;
}

/** 取不到图标时返回 404（前端会回退成首字母占位），且不缓存失败结果 */
function notFoundFavicon(): Response {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

// --- 静态资源 / SPA 回退 ---
/** 这些前缀下的路径缺失时必须老实返回 404，绝不能回退成 index.html */
const NO_FALLBACK_PREFIXES = ['/assets/', '/favicon/', '/api/'];

/**
 * 处理静态资源请求。
 *
 * wrangler.toml 里的 `not_found_handling = "none"`，所以未命中的路径会走到这里。
 *
 * 为什么不用平台内置的 `"single-page-application"` 兜底：
 * 它会让 `/assets/xxx.js`（已下线的旧哈希、或写错的路径）**返回 index.html 且是 200**，
 * 而 `public/_headers` 给 `/assets/*` 设了 `immutable`，于是这个 HTML 会被浏览器缓存一年，
 * 表现为"站点坏了且刷不回来"。这里把回退收进 Worker，就能对资源路径返回真正的 404，
 * 前端下次刷新即可自愈。
 *
 * 回退条件（三者同时满足才回退）：
 * 1. 方法为 GET / HEAD（导航请求）；
 * 2. Accept 里带 text/html（说明是浏览器地址栏/页面跳转，而不是 fetch、图片、脚本）；
 * 3. 路径不属于 NO_FALLBACK_PREFIXES。
 */
async function serveStatic(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) {
        return response;
    }

    const url = new URL(request.url);
    const isNavigation = request.method === 'GET' || request.method === 'HEAD';
    const acceptsHtml = (request.headers.get('Accept') || '').includes('text/html');
    const isFallbackAllowedPath = !NO_FALLBACK_PREFIXES.some(prefix => url.pathname.startsWith(prefix));

    if (!isNavigation || !acceptsHtml || !isFallbackAllowedPath) {
        // 缺失的资源：返回真正的 404，并强制不缓存。
        // （_headers 给 /assets/* 设了 immutable，这里必须显式覆盖掉）
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: 404, headers });
    }

    // SPA 深链接：回退到 index.html
    const indexResponse = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: 'GET' }));
    if (request.method === 'HEAD') {
        return new Response(null, { status: indexResponse.status, headers: indexResponse.headers });
    }
    return indexResponse;
}

// ============================================
// 主入口
// ============================================

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // API 路由
        if (url.pathname.startsWith('/api/sync') || url.pathname.startsWith('/api/v1/sync')) {
            return handleApiSync(request, env);
        }

        // favicon 同源代理（边缘缓存 30 天）
        if (url.pathname.startsWith(FAVICON_PATH_PREFIX)) {
            return handleFavicon(request, ctx);
        }

        // 静态资源（命中直接返回；未命中按需回退 index.html 或 404）
        return serveStatic(request, env);
    }
};
