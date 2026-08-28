'use strict';

/**
 * Local end-to-end inbox smoke: inject inbound/outbound DOM nodes via Selenium,
 * verify capture through the running gateway on :3000.
 */
require('dotenv').config();

const http = require('http');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { clickChatRowByTitle } = require('../services/inbox/pageScripts');

const GATEWAY = process.env.SMOKE_GATEWAY_URL || 'http://127.0.0.1:3000';
const CDP_HOST = process.env.CHROME_DEBUG_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222);
const POLL_MS = 250;
const CAPTURE_TIMEOUT_MS = 15000;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, json: JSON.parse(body || '{}') });
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

async function attachDriver() {
    const options = new chrome.Options();
    options.debuggerAddress(`${CDP_HOST}:${CDP_PORT}`);
    return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function waitForGatewayReady() {
    const start = Date.now();
    while (Date.now() - start < 120000) {
        try {
            const { json } = await fetchJson(`${GATEWAY}/api/whatsapp/status`);
            if (
                json.chromeConnected
                && json.whatsappTabFound
                && json.whatsappReady
                && json.inbox
                && json.inbox.listening
                && json.inbox.triggerInstalled
            ) {
                return json;
            }
        } catch (_) {
            // retry
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Gateway not ready within 120s');
}

async function waitForCapture(smokeText, beforeCount) {
    const start = Date.now();
    while (Date.now() - start < CAPTURE_TIMEOUT_MS) {
        const { json } = await fetchJson(`${GATEWAY}/api/whatsapp/inbox?limit=50`);
        const messages = json.messages || [];
        const hit = messages.find((m) => String(m.text || '').includes(smokeText));
        if (hit) {
            return {
                latencyMs: Date.now() - start,
                message: hit,
                inbox: json,
                beforeCount,
                afterCount: messages.length,
            };
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`Capture timeout for ${smokeText}`);
}

async function switchToWhatsAppTab(driver) {
    const handles = await driver.getAllWindowHandles();
    for (const handle of handles) {
        await driver.switchTo().window(handle);
        const url = await driver.getCurrentUrl();
        if (String(url).includes('web.whatsapp.com')) {
            return url;
        }
    }
    throw new Error('No web.whatsapp.com tab in attached Chrome');
}

async function ensureOpenChat(driver, chatTitle = 'Tarek Saad') {
    const hasMain = await driver.executeScript(() => Boolean(document.querySelector('#main')));
    if (hasMain) return { ok: true, alreadyOpen: true };

    await driver.manage().window().setRect({ width: 1400, height: 900 });
    await driver.executeScript(clickChatRowByTitle, chatTitle);

    try {
        const titleEl = await driver.wait(
            until.elementLocated(By.css(`#pane-side span[title="${chatTitle}"]`)),
            5000,
        );
        await titleEl.click();
    } catch (error) {
        return { ok: false, reason: 'selenium_click_failed', error: error.message };
    }

    try {
        await driver.wait(until.elementLocated(By.css('#main')), 8000);
        return { ok: true, clicked: true, chatTitle };
    } catch (error) {
        return { ok: false, reason: 'main_not_visible_after_click', error: error.message };
    }
}

async function injectMessage(driver, { smokeText, direction, remoteJid }) {
    return driver.executeScript((text, dir, jid) => {
        const prefix = dir === 'inbound' ? 'false' : 'true';
        const dataId = `${prefix}_${jid}_SMOKE${Date.now()}`;
        const className = dir === 'inbound'
            ? 'message-in focusable-list-item'
            : 'message-out focusable-list-item';
        const main = document.querySelector('#main');
        if (!main) return { ok: false, reason: 'no_main_open_chat' };
        const host = main.querySelector('[data-tab="8"]')
            || main.querySelector('div[role="application"]')
            || main.querySelector('div.copyable-area')
            || main;
        const div = document.createElement('div');
        div.className = className;
        div.setAttribute('data-id', dataId);
        const span = document.createElement('span');
        span.className = 'selectable-text copyable-text';
        span.innerText = text;
        div.appendChild(span);
        host.appendChild(div);
        return { ok: true, smokeText: text, dataId, injectedAt: Date.now() };
    }, smokeText, direction, remoteJid);
}

async function main() {
    console.log('[smoke] waiting for gateway...');
    const status = await waitForGatewayReady();
    console.log('[smoke] gateway ready', {
        whatsappReady: status.whatsappReady,
        triggerInstalled: status.inbox.triggerInstalled,
        openChatObserver: status.inbox.openChatObserverInstalled,
        lastPollAt: status.inbox.lastPollAt,
    });

    const driver = await attachDriver();
    try {
        const waUrl = await switchToWhatsAppTab(driver);
        console.log('[smoke] whatsapp tab', waUrl);

        const openChat = await ensureOpenChat(driver);
        console.log('[smoke] open chat', openChat);
        if (!openChat.ok) {
            throw new Error(`Could not open chat: ${JSON.stringify(openChat)}`);
        }

        const remoteJid = '201557994946@c.us';
        const smokeText = `LOCAL-INBOX-SMOKE-${Date.now()}`;
        const injectAt = Date.now();

        const injectResult = await injectMessage(driver, {
            smokeText,
            direction: 'inbound',
            remoteJid,
        });
        console.log('[smoke] inbound inject', injectResult);

        if (!injectResult || !injectResult.ok) {
            throw new Error(`Inject failed: ${JSON.stringify(injectResult)}`);
        }

        const captured = await waitForCapture(smokeText, 0);
        const domToCaptureMs = Date.now() - injectAt;
        console.log('[smoke] inbound captured', {
            providerMessageId: captured.message.providerMessageId,
            direction: captured.message.direction,
            phone: captured.message.phone,
            chatTitle: captured.message.chatTitle,
            text: captured.message.text,
            pollLatencyMs: captured.latencyMs,
            domToCaptureMs,
        });

        if (captured.message.direction !== 'inbound') {
            throw new Error(`Expected inbound, got ${captured.message.direction}`);
        }

        const outboundText = `LOCAL-OUTBOUND-IGNORE-${Date.now()}`;
        await injectMessage(driver, {
            smokeText: outboundText,
            direction: 'outbound',
            remoteJid,
        });
        await new Promise((r) => setTimeout(r, 4000));
        const { json: inboxAfter } = await fetchJson(`${GATEWAY}/api/whatsapp/inbox?limit=50`);
        const outboundHit = (inboxAfter.messages || []).find(
            (m) => String(m.text || '').includes(outboundText),
        );
        if (outboundHit) {
            throw new Error('Outbound message was incorrectly captured as inbound');
        }
        console.log('[smoke] outbound correctly ignored');

        console.log('\n[smoke] PASS');
        console.log(JSON.stringify({
            inbound: {
                text: smokeText,
                providerMessageId: captured.message.providerMessageId,
                phone: captured.message.phone,
                chatTitle: captured.message.chatTitle,
                pollLatencyMs: captured.latencyMs,
                domToCaptureMs,
            },
            outboundIgnored: true,
        }, null, 2));
    } finally {
        // Detach only — do not quit() or the bot Chrome session can be torn down.
    }
}

main().catch((err) => {
    console.error('[smoke] FAIL', err.message);
    process.exit(1);
});
