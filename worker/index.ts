/**
 * Y-Nav Cloudflare Worker 入口
 * 
 * 功能:
 * 1. 托管静态资源 (SPA)
 * 2. 处理 /api/sync 相关请求
 * 
 * 此文件整合了 Workers Sites 和 API 逻辑
 */

import { getAssetFromKV, NotFoundError, MethodNotAllowedError } from '@cloudflare/kv-asset-handler';
// @ts-ignore - 这是 Workers Sites 自动生成的 manifest
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

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
    __STATIC_CONTENT: KVNamespace;
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
// 静态资源处理
// ============================================

async function handleStaticAssets(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
        return await getAssetFromKV(
            {
                request,
                waitUntil: ctx.waitUntil.bind(ctx),
            },
            {
                ASSET_NAMESPACE: env.__STATIC_CONTENT,
                ASSET_MANIFEST: assetManifest,
            }
        );
    } catch (e) {
        if (e instanceof NotFoundError) {
            // SPA fallback: 返回 index.html
            const notFoundRequest = new Request(new URL('/index.html', request.url).toString(), request);
            return await getAssetFromKV(
                {
                    request: notFoundRequest,
                    waitUntil: ctx.waitUntil.bind(ctx),
                },
                {
                    ASSET_NAMESPACE: env.__STATIC_CONTENT,
                    ASSET_MANIFEST: assetManifest,
                }
            );
        } else if (e instanceof MethodNotAllowedError) {
            return new Response('Method Not Allowed', { status: 405 });
        }
        return new Response('Internal Error', { status: 500 });
    }
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

        // 静态资源
        return handleStaticAssets(request, env, ctx);
    }
};
