const { createScheduler } = require('../services/scheduler');
const { isWechatAccount, refreshWechatAccountCode } = require('../services/wechat-code');

function createWorkerManager(options) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        store,
        getAccounts,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog,
    } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';
    const startingAccounts = new Set();
    const wxCodeRefreshingAccounts = new Set();

    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        });
        // 与 child_process 保持同形接口
        worker.send = (payload) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account) {
        if (processRef.pkg) {
            // 打包后也走 fork + execPath，确保 IPC 通道可用
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        });
    }

    function createWorkerProcess(account) {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    function getStoredAccount(accountId) {
        try {
            const data = typeof getAccounts === 'function' ? getAccounts() : null;
            const list = Array.isArray(data && data.accounts) ? data.accounts : [];
            return list.find(a => String(a.id) === String(accountId)) || null;
        } catch {
            return null;
        }
    }

    async function refreshWechatCodeForAccount(account, reason, options = {}) {
        if (!isWechatAccount(account)) return account;

        const accountId = String(account.id || '');
        const accountName = account.name || accountId;
        const requireFresh = options.requireFresh === true;

        if (wxCodeRefreshingAccounts.has(accountId)) {
            if (requireFresh) throw new Error('正在刷新 Code，请稍后重试');
            log('系统', `微信账号 ${accountName} 正在刷新 Code，跳过重复请求`, { accountId, accountName, reason });
            return account;
        }

        wxCodeRefreshingAccounts.add(accountId);
        try {
            const result = await refreshWechatAccountCode(account, store, { timeoutMs: options.timeoutMs });
            if (result && result.skipped) {
                const message = result.reason === 'missing_wxid'
                    ? '缺少 wxid，无法自动刷新 Code'
                    : `跳过刷新 Code: ${result.reason}`;
                if (requireFresh) throw new Error(message);
                log('系统', `微信账号 ${accountName} ${message}`, { accountId, accountName, reason });
                return account;
            }

            const updated = (result && result.account) || account;
            log('系统', `微信账号 ${accountName} 已自动刷新 Code`, {
                accountId,
                accountName,
                reason,
                source: result && result.source ? result.source : '',
            });
            addAccountLog(
                'wx_code_refresh',
                `微信账号 ${accountName} 已自动刷新 Code`,
                accountId,
                accountName,
                { reason, source: result && result.source ? result.source : '' },
            );
            return updated;
        } catch (error) {
            const message = error && error.message ? error.message : String(error || 'unknown');
            log('错误', `微信账号 ${accountName} 刷新 Code 失败: ${message}`, { accountId, accountName, reason });
            addAccountLog(
                'wx_code_refresh_failed',
                `微信账号 ${accountName} 刷新 Code 失败`,
                accountId,
                accountName,
                { reason, error: message },
            );
            if (requireFresh || !account.code) throw error;
            return account;
        } finally {
            wxCodeRefreshingAccounts.delete(accountId);
        }
    }

    async function prepareAccountForStart(account, options = {}) {
        if (options.skipRefresh === true) return account;
        return refreshWechatCodeForAccount(account, options.reason || 'start', {
            requireFresh: options.requireFresh === true,
            timeoutMs: options.timeoutMs,
        });
    }

    function spawnWorker(account) {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false; // 已运行

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child = null;
        try {
            child = createWorkerProcess(account);
        } catch (err) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null, // 最新状态快照
            logs: [],
            requests: new Map(), // pending API requests
            reqId: 1,
            name: account.name,
            username: account.username || '', // 保存用户名用于下线提醒
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            wsError: null,
            wxCodeRestarting: false,
        };

        // 发送启动指令
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
            },
        });
        child.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) });

        // 监听消息
        child.on('message', (msg) => {
            handleWorkerMessage(account.id, msg);
        });

        child.on('error', (err) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code, signal) => {
            const current = workers[account.id];
            const displayName = (current && current.name) || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    async function startWorker(account, options = {}) {
        if (!account || !account.id) return false;
        const accountId = String(account.id);
        if (workers[accountId] || startingAccounts.has(accountId)) return true;

        startingAccounts.add(accountId);
        try {
            const latestAccount = getStoredAccount(accountId) || account;
            const preparedAccount = await prepareAccountForStart(latestAccount, {
                reason: options.reason || 'start',
                skipRefresh: options.skipRefresh,
                requireFresh: options.requireFresh,
                timeoutMs: options.timeoutMs,
            });
            return spawnWorker(preparedAccount);
        } catch (error) {
            const message = error && error.message ? error.message : String(error || 'unknown');
            log('错误', `账号 ${account.name || accountId} 启动失败: ${message}`, { accountId, accountName: account.name || accountId });
            addAccountLog('start_failed', `账号 ${account.name || accountId} 启动失败`, accountId, account.name || accountId, { reason: message });
            return false;
        } finally {
            startingAccounts.delete(accountId);
        }
    }

    function stopWorker(accountId) {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        // process.kill will happen in 'exit' handler, or we can force it
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    async function restartWorker(account, options = {}) {
        if (!account) return false;
        const accountId = String(account.id || '');
        let preparedAccount = account;
        try {
            const latestAccount = getStoredAccount(accountId) || account;
            preparedAccount = await prepareAccountForStart(latestAccount, {
                reason: options.reason || 'restart',
                skipRefresh: options.skipRefresh,
                requireFresh: options.requireFresh,
                timeoutMs: options.timeoutMs,
            });
        } catch (error) {
            const message = error && error.message ? error.message : String(error || 'unknown');
            log('错误', `账号 ${account.name || accountId} 重启前准备失败: ${message}`, { accountId, accountName: account.name || accountId });
            addAccountLog('restart_failed', `账号 ${account.name || accountId} 重启前准备失败`, accountId, account.name || accountId, { reason: message });
            return false;
        }

        const worker = workers[accountId];
        if (!worker) return startWorker(preparedAccount, { skipRefresh: true });
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) return startWorker(preparedAccount, { skipRefresh: true });
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(preparedAccount, { skipRefresh: true });
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return true;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
        return true;
    }

    function scheduleWechatCodeRefreshRestart(accountId, message = '') {
        const worker = workers[accountId];
        if (!worker || worker.wxCodeRestarting) return;

        const storedAccount = getStoredAccount(accountId);
        if (!isWechatAccount(storedAccount)) return;

        worker.wxCodeRestarting = true;
        log('系统', `微信账号 ${worker.name} Code 失效，准备自动刷新并重启`, {
            accountId: String(accountId),
            accountName: worker.name,
            message,
        });
        addAccountLog(
            'wx_code_refresh_restart',
            `微信账号 ${worker.name} Code 失效，准备自动刷新并重启`,
            accountId,
            worker.name,
            { reason: 'ws_400', message },
        );

        managerScheduler.setTimeoutTask(`wx_code_refresh_restart_${accountId}`, 1000, async () => {
            try {
                const latestAccount = getStoredAccount(accountId) || storedAccount;
                const preparedAccount = await refreshWechatCodeForAccount(latestAccount, 'ws_400', { requireFresh: true });
                const current = workers[accountId];
                if (current) current.wxCodeRestarting = false;
                await restartWorker(preparedAccount, { skipRefresh: true });
            } catch (error) {
                const current = workers[accountId];
                if (current) current.wxCodeRestarting = false;
                const errorMessage = error && error.message ? error.message : String(error || 'unknown');
                log('错误', `微信账号 ${worker.name} 自动刷新 Code 失败，无法自动重启: ${errorMessage}`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                });
                addAccountLog(
                    'wx_code_refresh_restart_failed',
                    `微信账号 ${worker.name} 自动刷新 Code 失败，无法自动重启`,
                    accountId,
                    worker.name,
                    { reason: 'ws_400', error: errorMessage },
                );
            }
        });
    }

    function handleWorkerMessage(accountId, msg) {
        const worker = workers[accountId];
        if (!worker) return;

        if (msg.type === 'status_sync') {
            // 合并状态
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            // 尝试更新昵称到 store
            if (msg.data && msg.data.status && msg.data.status.name) {
                const newNick = String(msg.data.status.name).trim();
                // 忽略无效昵称
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    // 避免频繁写入，只在内存中无昵称或不一致时更新
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        addOrUpdateAccount({
                            id: accountId,
                            nick: newNick,
                        });
                        // 仅在首次同步或名称变更时记录日志
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs(worker.username);
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        username: worker.username,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 保存日志
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${accountId}]进程报错: ${msg.error}`, { accountId: String(accountId), accountName: worker.name });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
                scheduleWechatCodeRefreshRestart(accountId, message);
            } else if ([401, 403, 501].includes(code)) {
                addAccountLog(
                    `ws_${code}`,
                    `账号 ${worker.name} 连接被拒绝，请重新获取 Code 或检查客户端版本/平台参数`,
                    accountId,
                    worker.name,
                    { code, message },
                );
            }
        } else if (msg.type === 'account_kicked') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(new Error(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                // 同步配置到 worker 进程
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        }
    }

    function callWorkerApi(accountId, method, ...args) {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            // 超时处理
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, 10000, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
