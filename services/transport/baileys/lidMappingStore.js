'use strict';

const fs = require('fs');
const path = require('path');
const { jidToLegacy, phoneFromJid } = require('./baileysMessageAdapter');

const DEFAULT_MAP_FILE = path.join(process.cwd(), 'data', 'lid-phone-map.json');

function createLidMappingStore({ mapFile = DEFAULT_MAP_FILE } = {}) {
    const records = new Map();

    function ensureDir() {
        fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    }

    function load() {
        ensureDir();
        if (!fs.existsSync(mapFile)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
            records.clear();
            for (const [lid, entry] of Object.entries(parsed.mappings || {})) {
                if (entry && entry.pnJid) records.set(lid, entry);
            }
        } catch (_) {
            // keep in-memory state empty on corrupt file
        }
    }

    function persist() {
        ensureDir();
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            mappings: Object.fromEntries(records.entries()),
        };
        const tmp = `${mapFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, mapFile);
    }

    function remember(lidJid, pnJid, source) {
        const lid = String(lidJid || '').trim();
        const pn = String(pnJid || '').trim();
        if (!lid.endsWith('@lid')) return false;
        if (!pn.endsWith('@s.whatsapp.net') && !pn.endsWith('@c.us')) return false;

        const phone = phoneFromJid(pn);
        if (!phone) return false;

        const existing = records.get(lid);
        const entry = {
            pnJid: pn.endsWith('@s.whatsapp.net') ? pn : `${pn.split('@')[0]}@s.whatsapp.net`,
            legacyJid: jidToLegacy(pn),
            phone,
            source: String(source || 'unknown'),
            updatedAt: new Date().toISOString(),
        };

        if (existing
            && existing.pnJid === entry.pnJid
            && existing.phone === entry.phone
            && existing.source === entry.source) {
            return false;
        }

        records.set(lid, entry);
        persist();
        return true;
    }

    function resolvePn(lidJid) {
        const entry = records.get(String(lidJid || '').trim());
        return entry ? entry.pnJid : null;
    }

    function resolvePhone(lidJid) {
        const entry = records.get(String(lidJid || '').trim());
        return entry ? entry.phone : null;
    }

    function list() {
        return Array.from(records.entries()).map(([lid, entry]) => ({ lid, ...entry }));
    }

    function size() {
        return records.size;
    }

    load();

    return {
        mapFile,
        load,
        persist,
        remember,
        resolvePn,
        resolvePhone,
        list,
        size,
    };
}

module.exports = {
    createLidMappingStore,
};
