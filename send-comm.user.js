// ==UserScript==
// @id             iitc-plugin-send-comm-local
// @name           IITC plugin: Send COMM to local API (raw)
// @category       Info
// @updateURL      https://github.com/BDIRepo/Send-portals/raw/master/send-comm.meta.js
// @downloadURL    https://github.com/BDIRepo/Send-portals/raw/master/send-comm.user.js
// @version        0.2.12
// @description    Send received COMM raw events ([guid, ts_ms, {plext}]) to FastAPI
// @match          https://intel.ingress.com/*
// @grant          GM_xmlhttpRequest
// @grant          GM_getValue
// @grant          GM_setValue
// @grant          GM_registerMenuCommand
// @grant          unsafeWindow
// @connect        srv42.mikr.us
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    const API_URL = 'http://srv42.mikr.us:20214/gamestat/ingress/comm/batch-raw';
    const DEFAULT_API_TOKEN = '6e66a1835cf948b4d3d8b0867ec5bc863945a88b660fa4591596226eb3d19b6b';
    const TOKEN_KEY = 'send_comm_api_token';
    const BATCH_SIZE = 100;
    const FLUSH_INTERVAL_MS = 3000;
    const QUEUE_WARNING_SIZE = 5000;
    const MAX_SEEN = 10000;
    const BACKOFF_MIN_MS = 3000;
    const BACKOFF_MAX_MS = 60000;
    const LS_QUEUE = 'iitc_comm_exporter_queue_local_v3';
    const LS_SEEN = 'iitc_comm_exporter_seen_local_v3';
    const QUEUE_LOCK = 'iitc_comm_exporter_queue';

    const pending = new Map();
    let queueWarningShown = false;
    let isFlushing = false;
    let backoffMs = BACKOFF_MIN_MS;
    let nextAllowedSendAt = 0;
    let started = false;
    const stats = {
        since: Date.now(), attempts: 0, sent: 0, responses: 0,
        accepted: 0, inserted: 0, already_present: 0, rejected: 0,
        errors: 0, lastResponse: 0, lastError: ''
    };
    let statsView = null;
    let statsDialog = null;
    let statsTimer = null;
    let sessionApiToken = null;

    function getApiToken() {
        if (sessionApiToken !== null) return sessionApiToken;
        try {
            const stored = GM_getValue(TOKEN_KEY, '');
            if (typeof stored === 'string' && stored.trim()) return stored.trim();
        } catch {
            // The public default also works when userscript storage is unavailable.
        }
        return DEFAULT_API_TOKEN;
    }

    function renderStats() {
        if (!statsView) return;
        let queueSize = '?';
        let memorySize = pending.size;
        try {
            const guids = new Set(getQueue().map(item => item[0]));
            memorySize = [...pending.keys()].filter(guid => !guids.has(guid)).length;
            queueSize = guids.size + memorySize;
        } catch {
            // An unreadable queue must not be displayed as empty.
        }
        const token = getApiToken();
        const wait = Math.max(0, Math.ceil((nextAllowedSendAt - Date.now()) / 1000));
        const status = isFlushing ? 'Wysyłanie' :
            typeof token !== 'string' || !token.trim() ? 'Brak tokenu API' :
            wait ? 'Ponowienie za ' + wait + ' s' :
            queueSize === '?' ? 'Błąd odczytu kolejki' :
            queueSize ? 'Oczekiwanie na wysyłkę' : 'Kolejka pusta';
        const values = {
            ...stats,
            since: new Date(stats.since).toLocaleString('pl-PL'),
            queue: queueSize, memory: memorySize, status,
            lastResponse: stats.lastResponse ? new Date(stats.lastResponse).toLocaleString('pl-PL') : 'Brak',
            lastError: stats.lastError || 'Brak'
        };
        for (const [key, value] of Object.entries(values)) {
            const cell = statsView.querySelector('[data-stat="' + key + '"]');
            if (cell) cell.textContent = typeof value === 'number' ? value.toLocaleString('pl-PL') : value;
        }
    }

    function showStats() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (statsDialog) {
            statsDialog.dialog('open');
            statsDialog.dialog('moveToTop');
            renderStats();
            return;
        }
        const view = document.createElement('div');
        view.style.cssText = 'font-size:13px;line-height:1.5;letter-spacing:0;overflow-wrap:anywhere';
        const groups = [
            ['Bieżący stan', [['status', 'Status'], ['queue', 'W kolejce'], ['memory', 'Tylko w pamięci karty']]],
            ['Sumy tej karty (z ponowieniami)', [['since', 'Od uruchomienia'], ['attempts', 'Próby wysyłki paczek'], ['sent', 'Wysłane rekordy'], ['errors', 'Błędy cyklu wysyłki']]],
            ['Sumy odpowiedzi API', [['responses', 'Odpowiedzi JSON (2xx)'], ['accepted', 'Zaakceptowane'], ['inserted', 'Nowe w bazie'], ['already_present', 'Już obecne w bazie'], ['rejected', 'Odrzucone']]],
            ['Ostatnia aktywność', [['lastResponse', 'Odpowiedź API'], ['lastError', 'Ostatni błąd']]]
        ];
        for (const [title, rows] of groups) {
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:10px';
            const caption = document.createElement('caption');
            caption.textContent = title;
            caption.style.cssText = 'text-align:left;font-weight:bold;padding:4px 0;border-bottom:1px solid currentColor';
            table.appendChild(caption);
            for (const [key, label] of rows) {
                const row = document.createElement('tr');
                const heading = document.createElement('th');
                heading.scope = 'row';
                heading.textContent = label;
                heading.style.cssText = 'width:58%;text-align:left;font-weight:normal;vertical-align:top;padding:3px 8px 3px 0';
                const value = document.createElement('td');
                value.dataset.stat = key;
                value.style.cssText = 'text-align:right;vertical-align:top;padding:3px 0;font-variant-numeric:tabular-nums';
                row.appendChild(heading);
                row.appendChild(value);
                table.appendChild(row);
            }
            view.appendChild(table);
        }
        statsDialog = w.dialog({
            id: 'send-comm-stats', title: 'Send COMM: statystyki', html: view,
            width: Math.min(420, Math.max(240, window.innerWidth - 32)),
            height: 'auto',
            closeCallback: () => {
                clearInterval(statsTimer);
                statsTimer = null;
                statsView = null;
                statsDialog = null;
            }
        });
        statsView = view;
        renderStats();
        statsTimer = setInterval(renderStats, 1000);
    }

    function setupStats(w) {
        GM_registerMenuCommand('Send COMM: statystyki', showStats);
        if (w.IITC?.toolbox?.addButton) {
            w.IITC.toolbox.addButton({ id: 'send-comm-stats', label: 'COMM: statystyki', action: showStats });
        } else {
            const toolbox = document.getElementById('toolbox');
            if (toolbox) {
                const link = document.createElement('a');
                link.href = '#';
                link.textContent = 'COMM: statystyki';
                link.addEventListener('click', event => {
                    event.preventDefault();
                    showStats();
                });
                toolbox.appendChild(link);
            }
        }
    }

    function recordApiStats(result, batchSize) {
        stats.responses++;
        stats.lastResponse = Date.now();
        // These are sums of API replies, including replies to retried events.
        for (const key of ['accepted', 'inserted', 'already_present', 'rejected']) {
            const count = result?.[key];
            if (Number.isSafeInteger(count) && count >= 0 && count <= batchSize) stats[key] += count;
        }
        renderStats();
    }

    function readArray(key) {
        const stored = localStorage.getItem(key);
        const value = stored === null ? [] : JSON.parse(stored);
        if (!Array.isArray(value)) throw new Error('Invalid stored array: ' + key);
        return value;
    }

    function getQueue() {
        const queue = readArray(LS_QUEUE);
        if (queue.some(item => !normalizeToRawTriple(item))) {
            throw new Error('Invalid stored queue; original data has been preserved');
        }
        return queue.map(normalizeToRawTriple);
    }

    function setQueue(queue) {
        localStorage.setItem(LS_QUEUE, JSON.stringify(queue));
        if (queue.length > QUEUE_WARNING_SIZE && !queueWarningShown) {
            console.warn('[Send-COMM] Queue exceeds ' + QUEUE_WARNING_SIZE + ' events; no events were discarded');
        }
        queueWarningShown = queue.length > QUEUE_WARNING_SIZE;
    }

    function getSeen() {
        const seen = readArray(LS_SEEN);
        if (seen.some(guid => typeof guid !== 'string')) throw new Error('Invalid stored GUID list');
        return new Set(seen);
    }

    function rememberProcessed(batch) {
        const seen = getSeen();
        for (const [guid] of batch) {
            seen.delete(guid);
            seen.add(guid);
        }
        localStorage.setItem(LS_SEEN, JSON.stringify([...seen].slice(-MAX_SEEN)));
    }

    function withQueueLock(operation) {
        if (typeof navigator !== 'undefined' && navigator.locks) {
            return navigator.locks.request(QUEUE_LOCK, operation);
        }
        return Promise.resolve().then(operation);
    }

    function normalizeToRawTriple(item) {
        let guid;
        let ts;
        let payload;
        if (Array.isArray(item) && item.length === 3) {
            [guid, ts, payload] = item;
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            guid = item.guid || item.id;
            ts = item.time ?? item.timestamp ?? item.ts;
            payload = { plext: item.plext ?? item.data?.plext };
        }
        if (
            typeof guid === 'string' && guid.length > 0 &&
            Number.isSafeInteger(ts) && ts >= 0 &&
            payload && typeof payload === 'object' && !Array.isArray(payload) &&
            payload.plext && typeof payload.plext === 'object' && !Array.isArray(payload.plext)
        ) {
            return [guid, ts, payload];
        }
        return null;
    }

    // Called under QUEUE_LOCK. Failed writes leave incoming events in memory for retry.
    function collectQueue() {
        const queue = getQueue();
        if (!pending.size) return queue;
        const queued = new Set(queue.map(item => item[0]));
        const seen = getSeen();
        let added = 0;
        for (const [guid, raw] of pending) {
            if (queued.has(guid) || seen.has(guid)) {
                pending.delete(guid);
                continue;
            }
            queue.push(raw);
            queued.add(guid);
            added++;
        }
        if (added) {
            try {
                setQueue(queue);
                pending.clear();
                console.log('[Send-COMM] Enqueued ' + added + ' events. Queue size: ' + queue.length);
            } catch (err) {
                console.error('[Send-COMM] Queue write failed. ' + pending.size + ' events remain only in this tab; keep it open.', err);
            }
        }
        return queue;
    }

    async function enqueueRawEvents(candidates) {
        for (const candidate of candidates) {
            const raw = normalizeToRawTriple(candidate);
            if (raw) pending.set(raw[0], raw);
        }
        try {
            await withQueueLock(collectQueue);
        } catch (err) {
            console.error('[Send-COMM] Queue unavailable; incoming events remain in this tab. Keep it open.', err);
        } finally {
            renderStats();
        }
    }

    function isBatchComplete(result, batchSize) {
        if (!result ||
            !Number.isSafeInteger(result.accepted) || result.accepted < 0 ||
            !Number.isSafeInteger(result.rejected) || result.rejected < 0 ||
            result.accepted + result.rejected !== batchSize) return false;
        if (result.rejected === 0) return true;

        const reasons = result.rejected_by_reason;
        // No GUIDs are needed when every event has a final outcome.
        return reasons && typeof reasons === 'object' && !Array.isArray(reasons) &&
            reasons.portal_out_of_allowed_bounds === result.rejected &&
            Object.entries(reasons).every(([reason, count]) =>
                Number.isSafeInteger(count) && count >= 0 &&
                (reason === 'portal_out_of_allowed_bounds' || count === 0));
    }

    function postBatchRaw(batch, token) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const fail = err => {
                if (finished) return;
                finished = true;
                reject(err);
            };
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_URL,
                data: JSON.stringify({
                    source: 'IITC',
                    collected_at: new Date().toISOString(),
                    result: batch
                }),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                timeout: 15000,
                onload: resp => {
                    if (finished) return;
                    if (resp.status < 200 || resp.status >= 300) {
                        fail(new Error('HTTP ' + resp.status));
                        return;
                    }
                    try {
                        const result = JSON.parse(resp.responseText);
                        console.log('[Send-COMM] API response:', result);
                        recordApiStats(result, batch.length);
                        if (!isBatchComplete(result, batch.length)) {
                            throw new Error('API left events without a final outcome; batch retained for retry');
                        }
                        finished = true;
                        resolve(result);
                    } catch (err) {
                        fail(err);
                    }
                },
                ontimeout: () => fail(new Error('Request timeout')),
                onerror: () => fail(new Error('Network error')),
                onabort: () => fail(new Error('Request aborted'))
            });
        });
    }

    async function flushQueue() {
        if (isFlushing || Date.now() < nextAllowedSendAt) return;
        isFlushing = true;
        try {
            const queue = await withQueueLock(collectQueue);
            if (!queue.length) return;
            const token = getApiToken();
            if (typeof token !== 'string' || !token.trim()) return;
            const batch = queue.slice(0, BATCH_SIZE);
            stats.attempts++;
            stats.sent += batch.length;
            renderStats();
            console.log('[Send-COMM] Sending ' + batch.length + ' events');
            const result = await postBatchRaw(batch, token.trim());

            await withQueueLock(() => {
                const processed = new Set(batch.map(item => item[0]));
                const rest = getQueue().filter(item => !processed.has(item[0]));
                setQueue(rest);
                for (const guid of processed) pending.delete(guid);
                // If this write fails, a duplicate is possible, but no unsent event is lost.
                try {
                    rememberProcessed(batch);
                } catch (err) {
                    console.warn('[Send-COMM] Could not persist processed GUIDs; duplicates may be retried', err);
                }
                console.log('[Send-COMM] Completed batch: ' + result.accepted + ' accepted, ' + result.rejected +
                    ' permanently rejected (outside allowed bounds). Remaining: ' + (rest.length + pending.size));
            });
            backoffMs = BACKOFF_MIN_MS;
            nextAllowedSendAt = 0;
        } catch (err) {
            stats.errors++;
            stats.lastError = err.message;
            const delay = backoffMs;
            nextAllowedSendAt = Date.now() + delay;
            backoffMs = Math.min(delay * 2, BACKOFF_MAX_MS);
            console.warn('[Send-COMM] ' + err.message + '. Next attempt in ' + delay / 1000 + 's');
        } finally {
            isFlushing = false;
            renderStats();
        }
    }

    function handleChatHook(data) {
        if (!data) return;
        const candidates = [];
        if (Array.isArray(data)) candidates.push(...data);
        if (Array.isArray(data.raw)) candidates.push(...data.raw);
        if (Array.isArray(data.result)) candidates.push(...data.result);
        return enqueueRawEvents(candidates);
    }

    function setup() {
        if (started) return;
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (typeof w.addHook !== 'function') return;
        started = true;

        GM_registerMenuCommand('Send COMM: ustaw token API', async () => {
            const token = window.prompt('Token API dla Send COMM (puste pole przywraca domyślny):', getApiToken());
            if (token === null) return;
            sessionApiToken = token.trim() || DEFAULT_API_TOKEN;
            nextAllowedSendAt = 0;
            backoffMs = BACKOFF_MIN_MS;
            renderStats();
            try {
                await GM_setValue(TOKEN_KEY, sessionApiToken);
            } catch (err) {
                stats.lastError = 'Nie zapisano tokenu; zmiana działa tylko w tej karcie.';
                console.error('[Send-COMM] Could not save API token; using it in this tab', err);
            } finally {
                renderStats();
                void flushQueue();
            }
        });
        if (API_URL.startsWith('http:')) {
            console.warn('[Send-COMM] API uses unencrypted HTTP. Configure HTTPS on the server before changing API_URL.');
        }
        if (typeof navigator === 'undefined' || !navigator.locks) {
            console.warn('[Send-COMM] Web Locks unavailable; use only one IITC tab to avoid concurrent queue writes.');
        }

        const hooks = [
            'publicChatDataAvailable',
            'factionChatDataAvailable',
            'alertsChatDataAvailable',
            'commDataAvailable'
        ];
        hooks.forEach(hook => w.addHook(hook, handleChatHook));
        setInterval(flushQueue, FLUSH_INTERVAL_MS);
        setupStats(w);
        console.log('[Send-COMM] Started. Hooks:', hooks.join(', '));
    }

    (function bootstrap() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        if (w.iitcLoaded) {
            setup();
        } else if (typeof w.addHook === 'function') {
            w.addHook('iitcLoaded', setup);
        } else {
            setTimeout(bootstrap, 1000);
        }
    })();
})();
