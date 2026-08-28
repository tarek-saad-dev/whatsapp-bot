'use strict';

const http = require('http');

function fetchDebugJson(path, { host = '127.0.0.1', port = 9222, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://${host}:${port}${path}`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`CDP ${path} HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`CDP ${path} timed out after ${timeoutMs}ms`));
        });
    });
}

function isWhatsAppPageTarget(target) {
    return Boolean(
        target
        && target.type === 'page'
        && String(target.url || '').includes('web.whatsapp.com'),
    );
}

async function listPageTargets(options = {}) {
    try {
        const list = await fetchDebugJson('/json/list', options);
        if (!Array.isArray(list)) return [];
        return list.filter(isWhatsAppPageTarget);
    } catch (_) {
        return [];
    }
}

async function waitForWhatsAppPageTarget({
    timeoutMs = 90000,
    pollMs = 1000,
    ...options
} = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pages = await listPageTargets(options);
        if (pages.length > 0) return pages[0];
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
}

async function isDebugPortActive(host = '127.0.0.1', port = 9222, timeoutMs = 3000) {
    try {
        await fetchDebugJson('/json/version', { host, port, timeoutMs });
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    fetchDebugJson,
    isWhatsAppPageTarget,
    listPageTargets,
    waitForWhatsAppPageTarget,
    isDebugPortActive,
};
