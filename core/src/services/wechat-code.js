const fetch = require('node-fetch');

const DEFAULT_APP_ID = 'wx5306c5978fdb76e4';
const DEFAULT_TIMEOUT_MS = 10000;

function cleanString(value) {
    return String(value || '').trim();
}

function joinUrl(base, suffix) {
    return `${cleanString(base).replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
}

function getNested(obj, paths) {
    for (const path of paths) {
        const value = String(path).split('.').reduce((cur, key) => {
            if (!cur || typeof cur !== 'object') return undefined;
            return cur[key];
        }, obj);
        if (value !== undefined && value !== null && cleanString(value)) return cleanString(value);
    }
    return '';
}

function isFarmCode(value) {
    const code = cleanString(value);
    return !!code && !/^-?\d+$/.test(code);
}

function extractFarmCode(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const code = getNested(payload, [
        'data.code',
        'data.Code',
        'Data.code',
        'Data.Code',
        'Data.js_code',
        'Data.JsCode',
    ]);
    if (isFarmCode(code)) return code;

    const topLevelCode = getNested(payload, ['farmCode', 'FarmCode']);
    if (isFarmCode(topLevelCode)) return topLevelCode;

    const genericCode = getNested(payload, ['code', 'Code']);
    if (isFarmCode(genericCode)) return genericCode;

    return '';
}

function extractErrorMessage(payload, fallback = '获取微信小程序 code 失败') {
    if (!payload || typeof payload !== 'object') return fallback;
    return cleanString(getNested(payload, [
        'msg',
        'message',
        'Message',
        'error',
        'Error',
        'Data.jsapiBaseresponse.errmsg',
        'Data.JsapiBaseresponse.Errmsg',
        'data.msg',
    ])) || fallback;
}

async function postJson(url, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
            signal: controller.signal,
        });
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (error) {
            const preview = cleanString(text).slice(0, 120);
            throw new Error(`invalid json response from ${url}: ${error.message}; body=${preview}`);
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${url}: ${extractErrorMessage(data, response.statusText)}`);
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

function buildActionUrl(apiUrl, apiKey) {
    const params = new URLSearchParams({ action: 'jslogin' });
    if (apiKey) params.set('api_key', apiKey);
    const separator = String(apiUrl).includes('?') ? '&' : '?';
    return `${apiUrl}${separator}${params.toString()}`;
}

function buildRefreshRequests(config, wxid) {
    const apiUrl = cleanString(config.proxyApiUrl || config.apiBase);
    const apiKey = cleanString(config.apiKey);
    const appId = cleanString(config.appId) || DEFAULT_APP_ID;
    if (!apiUrl) return [];

    const directRequest = {
        type: 'wechat-ipad',
        url: joinUrl(apiUrl, 'Wxapp/JSLogin'),
        body: { Wxid: wxid, Appid: appId },
    };
    const actionRequest = {
        type: 'action-api',
        url: buildActionUrl(apiUrl, apiKey),
        body: { wxid, appid: appId, Wxid: wxid, Appid: appId },
    };

    return apiKey ? [actionRequest, directRequest] : [directRequest];
}

async function fetchWechatFarmCode({ wxid, config, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const safeWxid = cleanString(wxid);
    if (!safeWxid) {
        throw new Error('缺少 wxid，无法刷新微信小程序 code');
    }

    const requests = buildRefreshRequests(config || {}, safeWxid);
    if (!requests.length) {
        throw new Error('微信扫码接口地址未配置');
    }

    const errors = [];
    for (const request of requests) {
        try {
            const data = await postJson(request.url, request.body, timeoutMs);
            const code = extractFarmCode(data);
            if (code) {
                return {
                    code,
                    source: request.type,
                    raw: data,
                };
            }
            errors.push(`${request.type}: ${extractErrorMessage(data)}`);
        } catch (error) {
            errors.push(`${request.type}: ${error.message}`);
        }
    }

    throw new Error(errors.join(' | ') || '未获取到微信小程序 code');
}

function isWechatAccount(account) {
    if (!account || typeof account !== 'object') return false;
    const platform = cleanString(account.platform).toLowerCase();
    const loginType = cleanString(account.loginType).toLowerCase();
    return platform === 'wx' || loginType === 'wx_qr' || !!cleanString(account.wxid);
}

async function refreshWechatAccountCode(account, store, options = {}) {
    if (!isWechatAccount(account)) {
        return { skipped: true, reason: 'not_wechat_account', account };
    }

    const wxid = cleanString(account.wxid || account.Wxid || account.userName);
    if (!wxid) {
        return { skipped: true, reason: 'missing_wxid', account };
    }

    const wxConfig = store && typeof store.getGlobalWxConfig === 'function'
        ? store.getGlobalWxConfig()
        : {};
    if (wxConfig && wxConfig.enabled === false) {
        return { skipped: true, reason: 'wx_config_disabled', account };
    }

    const result = await fetchWechatFarmCode({
        wxid,
        config: wxConfig || {},
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const updatedAt = Date.now();
    const patch = {
        id: String(account.id || ''),
        code: result.code,
        platform: 'wx',
        loginType: account.loginType || 'wx_qr',
        wxid,
        codeUpdatedAt: updatedAt,
        codeRefreshSource: result.source,
    };

    let updatedAccount = { ...account, ...patch };
    if (store && typeof store.addOrUpdateAccount === 'function' && patch.id) {
        const data = store.addOrUpdateAccount(patch);
        const list = Array.isArray(data && data.accounts) ? data.accounts : [];
        updatedAccount = list.find(item => String(item.id) === patch.id) || updatedAccount;
    }

    return {
        skipped: false,
        refreshed: true,
        account: updatedAccount,
        code: result.code,
        source: result.source,
        updatedAt,
    };
}

module.exports = {
    fetchWechatFarmCode,
    refreshWechatAccountCode,
    isWechatAccount,
};
