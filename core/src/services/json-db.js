const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

function ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readTextFile(filePath, fallback = '') {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return fallback;
    }
}

function readJsonFile(filePath, fallbackFactory = () => ({})) {
    const fallback = typeof fallbackFactory === 'function' ? fallbackFactory() : (fallbackFactory || {});
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJsonFileAtomic(filePath, data, space = 2) {
    const json = JSON.stringify(data, null, space);
    writeTextFileAtomic(filePath, json);
}

function isRetryableWindowsFsError(error) {
    return error && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}

function sleepSync(ms) {
    if (!ms) return;
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // Small synchronous backoff for Windows file locking.
    }
}

function writeTextFileAtomic(filePath, text = '') {
    ensureParentDir(filePath);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = String(text);

    try {
        fs.writeFileSync(tmpPath, content, 'utf8');
        const delays = [0, 25, 75, 150, 300];
        let lastError = null;

        for (const delay of delays) {
            sleepSync(delay);
            try {
                fs.renameSync(tmpPath, filePath);
                return;
            } catch (error) {
                lastError = error;
                if (!isRetryableWindowsFsError(error)) throw error;
            }
        }

        if (process.platform === 'win32' && isRetryableWindowsFsError(lastError)) {
            fs.writeFileSync(filePath, content, 'utf8');
            return;
        }

        throw lastError;
    } finally {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore cleanup errors
        }
    }
}

module.exports = {
    readTextFile,
    readJsonFile,
    writeTextFileAtomic,
    writeJsonFileAtomic,
};
