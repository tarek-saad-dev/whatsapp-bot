'use strict';

/**
 * These functions run inside WhatsApp Web via Selenium executeScript.
 * They must stay self-contained (no closures over Node modules).
 */

function scrapeChatRows() {
    const roots = document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]');
    const rows = [];
    for (const item of roots) {
        const titleEl = item.querySelector('span[title]');
        const title = titleEl ? titleEl.getAttribute('title') : '';
        const ariaLabels = Array.from(item.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label'))
            .filter(Boolean);
        rows.push({ title, ariaLabels });
    }
    return rows;
}

function clickChatRowByTitle(title) {
    const titleEl = Array.from(document.querySelectorAll('#pane-side span[title]'))
        .find((el) => el.getAttribute('title') === title);
    if (!titleEl) return false;
    const row = titleEl.closest('[role="listitem"]')
        || titleEl.closest('[role="row"]')
        || titleEl.closest('[role="gridcell"]')
        || titleEl;
    row.click();
    return true;
}

function scrapeOpenConversation() {
    const header = document.querySelector('#main header span[title]');
    const chatTitle = header ? header.getAttribute('title') : '';

    const selectorList = [
        '#main div[data-id]',
        '#main [data-id]',
        '#main div.message-in',
        '#main div.message-out',
    ];
    let nodes = [];
    for (const selector of selectorList) {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > nodes.length) nodes = found;
    }

    const messages = [];
    for (let index = 0; index < nodes.length; index += 1) {
        const el = nodes[index];
        const id = el.getAttribute('data-id') || '';
        const className = String(el.className || '');
        const textEl = el.querySelector(
            'span.selectable-text.copyable-text, span.selectable-text, .copyable-text span',
        );
        const text = textEl ? String(textEl.innerText || '').trim() : '';
        const prePlainHost = el.closest('[data-pre-plain-text]') || el.querySelector('[data-pre-plain-text]');
        const prePlainText = prePlainHost
            ? String(prePlainHost.getAttribute('data-pre-plain-text') || '').trim()
            : '';
        const hasMedia = Boolean(
            el.querySelector('img, video, audio, [data-icon="audio-play"], [data-icon="status-image"]'),
        );
        if (!id && !text && !hasMedia) continue;
        messages.push({
            id,
            className,
            text,
            prePlainText,
            hasMedia,
            domIndex: index,
        });
    }
    return { chatTitle, messages };
}

/**
 * MutationObserver on chat list rows — pushes events when preview/unread changes.
 */
function installInboxTrigger() {
    const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
    const DEBOUNCE_MS = 80;

    if (window.__waInboxTrigger) {
        return window.__waInboxTrigger.status();
    }

    const queue = [];
    const state = new Map();
    let installed = false;
    let debounceTimer = null;
    const dirtyRows = new Set();

    function toAsciiDigits(value) {
        return String(value || '').replace(/[٠-٩]/g, (digit) => {
            const index = ARABIC_INDIC.indexOf(digit);
            return index >= 0 ? String(index) : digit;
        });
    }

    function isTypingPreview(text) {
        const normalized = String(text || '').trim();
        if (!normalized) return true;
        if (/^(يكتب(\.\.\.)?|typing(\.\.\.)?|recording(\.\.\.)?)$/i.test(normalized)) return true;
        if (/^(يكتب|typing|recording)/i.test(normalized) && /\.{2,}$/.test(normalized)) return true;
        return false;
    }

    function parseUnread(labels) {
        for (const label of labels || []) {
            const text = String(label || '').trim();
            if (!text) continue;
            if (!(/unread/i.test(text) || /غير مقروء/.test(text))) continue;
            const ascii = toAsciiDigits(text);
            const match = ascii.match(/(\d+)/);
            if (match) {
                const count = Number(match[1]);
                return Number.isFinite(count) && count > 0 ? count : 1;
            }
            return 1;
        }
        return 0;
    }

    function previewFromRow(item, title) {
        const lines = String(item.innerText || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length >= 2) {
            const candidate = lines.find((line, index) => (
                index > 0
                && line !== title
                && !/^\d{1,2}:\d{2}/.test(line)
                && !isTypingPreview(line)
            ));
            if (candidate) return candidate;
        }
        const spans = item.querySelectorAll('span[dir="auto"], span[dir="ltr"], span[dir="rtl"]');
        for (const span of spans) {
            const text = String(span.innerText || '').trim();
            if (text && text !== title && !/^\d{1,2}:\d{2}/.test(text) && !isTypingPreview(text)) {
                return text;
            }
        }
        return '';
    }

    function scanRow(item) {
        const titleEl = item.querySelector('span[title]');
        const title = titleEl ? String(titleEl.getAttribute('title') || '').trim() : '';
        if (!title || title === 'واتساب') return null;

        const ariaLabels = Array.from(item.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label'))
            .filter(Boolean);
        const unreadCount = parseUnread(ariaLabels);
        const previewText = previewFromRow(item, title);
        return { chatTitle: title, previewText, unreadCount };
    }

    function pushEvent(row) {
        if (!row.previewText || isTypingPreview(row.previewText)) return;
        queue.push({
            type: 'incoming_preview',
            chatTitle: row.chatTitle,
            previewText: row.previewText,
            unreadCount: row.unreadCount,
            triggeredAt: new Date().toISOString(),
        });
    }

    function processRow(item, { seedOnly }) {
        const row = scanRow(item);
        if (!row) return;

        const prev = state.get(row.chatTitle);
        if (!prev) {
            state.set(row.chatTitle, {
                preview: row.previewText,
                unread: row.unreadCount,
                lastEmitted: '',
            });
            return;
        }

        const previewChanged = Boolean(row.previewText && row.previewText !== prev.preview);
        const unreadIncreased = row.unreadCount > prev.unread;
        const alreadyEmitted = row.previewText && row.previewText === prev.lastEmitted;

        state.set(row.chatTitle, {
            preview: row.previewText || prev.preview,
            unread: row.unreadCount,
            lastEmitted: prev.lastEmitted,
        });

        if (seedOnly) return;
        if (
            row.unreadCount > 0
            && previewChanged
            && !alreadyEmitted
            && !isTypingPreview(row.previewText)
        ) {
            pushEvent(row);
            state.set(row.chatTitle, {
                preview: row.previewText,
                unread: row.unreadCount,
                lastEmitted: row.previewText,
            });
        } else if (unreadIncreased && row.previewText && !alreadyEmitted && !isTypingPreview(row.previewText)) {
            pushEvent(row);
            state.set(row.chatTitle, {
                preview: row.previewText,
                unread: row.unreadCount,
                lastEmitted: row.previewText,
            });
        }
    }

    function flushDirty({ seedOnly }) {
        if (dirtyRows.size === 0) return;
        for (const item of dirtyRows) {
            try {
                if (item && item.isConnected) processRow(item, { seedOnly });
            } catch (_) { /* row removed */ }
        }
        dirtyRows.clear();
    }

    function scanAll({ seedOnly }) {
        const items = document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]');
        for (const item of items) {
            processRow(item, { seedOnly });
        }
    }

    function markDirty(node) {
        const row = node.closest('[role="listitem"], [role="row"]');
        if (row) dirtyRows.add(row);
    }

    scanAll({ seedOnly: true });

    const pane = document.querySelector('#pane-side');
    if (pane) {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.target) markDirty(mutation.target);
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) markDirty(node);
                    }
                }
            }
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => flushDirty({ seedOnly: false }), DEBOUNCE_MS);
        });
        observer.observe(pane, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        installed = true;
    }

    window.__waInboxTrigger = {
        drain() {
            return queue.splice(0, queue.length);
        },
        status() {
            return {
                installed,
                queued: queue.length,
                trackedChats: state.size,
            };
        },
    };

    return window.__waInboxTrigger.status();
}

function drainInboxEvents() {
    if (!window.__waInboxTrigger) {
        return { events: [], status: { installed: false, queued: 0, trackedChats: 0 } };
    }
    return {
        events: window.__waInboxTrigger.drain(),
        status: window.__waInboxTrigger.status(),
    };
}

function getInboxTriggerStatus() {
    if (!window.__waInboxTrigger) {
        return { installed: false, queued: 0, trackedChats: 0 };
    }
    return window.__waInboxTrigger.status();
}

module.exports = {
    scrapeChatRows,
    clickChatRowByTitle,
    scrapeOpenConversation,
    installInboxTrigger,
    drainInboxEvents,
    getInboxTriggerStatus,
};
