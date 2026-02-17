// ==UserScript==
// @id             iitc-plugin-send-comm-local
// @name           IITC plugin: Send COMM to local API (raw)
// @category       Info
// @version        0.2.1
// @description    Send ALL COMM raw events ([guid, ts_ms, {plext}]) to local FastAPI via GM_xmlhttpRequest
// @match          https://intel.ingress.com/*
// @grant          GM_xmlhttpRequest
// @grant          unsafeWindow
// @connect        srv42.mikr.us:20214
// @connect        localhost
// ==/UserScript==

(() => {
    'use strict';

    // =========================
    // LOCAL CONFIG
    // =========================
    const API_URL = 'http://srv42.mikr.us:20214/gamestat/ingress/comm/batch-raw';
    const API_TOKEN = 'CHANGE_ME_LONG_RANDOM_TOKEN';

    const BATCH_SIZE = 100;
    const FLUSH_INTERVAL_MS = 3000;

    const MAX_QUEUE = 5000;
    const MAX_SEEN = 10000;

    const BACKOFF_MIN_MS = 3000;
    const BACKOFF_MAX_MS = 60000;

    // =========================
    // STORAGE KEYS
    // =========================
    const LS_QUEUE = 'iitc_comm_exporter_queue_local_v3';
    const LS_SEEN  = 'iitc_comm_exporter_seen_local_v3';

    // =========================
    // HELPERS: localStorage
    // =========================
    const loadLS = (key, fallback) => {
        try {
            const v = localStorage.getItem(key);
            if (!v) return fallback;
            return JSON.parse(v);
        } catch {
            return fallback;
        }
    };

    const saveLS = (key, value) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // ignore
        }
    };

    const getQueue = () => loadLS(LS_QUEUE, []);
    const setQueue = (q) => {
        if (q.length > MAX_QUEUE) q = q.slice(q.length - MAX_QUEUE);
        saveLS(LS_QUEUE, q);
    };

    const getSeen = () => loadLS(LS_SEEN, []);
    const setSeen = (arr) => {
        if (arr.length > MAX_SEEN) arr = arr.slice(arr.length - MAX_SEEN);
        saveLS(LS_SEEN, arr);
    };

    const seenHas = (guid) => getSeen().indexOf(guid) !== -1;
    const seenAdd = (guid) => {
        const s = getSeen();
        if (s.indexOf(guid) === -1) {
            s.push(guid);
            setSeen(s);
        }
    };

    // =========================
    // NORMALIZE: [guid, ts_ms, {plext:{...}}]
    // =========================
    function normalizeToRawTriple(item) {
        // already raw triple
        if (Array.isArray(item) && item.length === 3) {
            const [guid, ts, payload] = item;
            if (
                typeof guid === 'string' &&
                typeof ts === 'number' &&
                payload && typeof payload === 'object' &&
                payload.plext && typeof payload.plext === 'object'
            ) {
                return [guid, ts, payload];
            }
        }

        // object form (depends on IITC build)
        if (item && typeof item === 'object') {
            const guid = item.guid || item.id;
            const ts = item.time || item.timestamp || item.ts;
            let plext = null;

            if (item.plext) plext = item.plext;
            else if (item.data && item.data.plext) plext = item.data.plext;

            if (typeof guid === 'string' && typeof ts === 'number' && plext && typeof plext === 'object') {
                return [guid, ts, { plext }];
            }
        }

        return null;
    }

    // =========================
    // QUEUE
    // =========================
    function enqueueRawEvents(candidates) {
        if (!candidates || !candidates.length) return;

        const queue = getQueue();

        for (const cand of candidates) {
            const raw = normalizeToRawTriple(cand);
            if (!raw) continue;

            const guid = raw[0];
            if (!guid) continue;
            if (seenHas(guid)) continue;

            queue.push(raw);
            seenAdd(guid);
        }

        setQueue(queue);
    }

    // =========================
    // SEND via GM_xmlhttpRequest
    // =========================
    function postBatchRaw(batch, onOk, onErr) {
        const payload = {
            source: 'IITC',
            collected_at: new Date().toISOString(),
            result: batch
        };

        GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            data: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_TOKEN}`
            },
            timeout: 15000,
            onload: (resp) => {
                if (resp.status >= 200 && resp.status < 300) onOk(resp);
                else onErr(new Error(`HTTP ${resp.status}: ${resp.responseText}`));
            },
            ontimeout: () => onErr(new Error('timeout')),
            onerror: (e) => onErr(e)
        });
    }

    let isFlushing = false;
    let backoffMs = BACKOFF_MIN_MS;
    let nextAllowedSendAt = 0;

    function flushQueue() {
        const now = Date.now();
        if (now < nextAllowedSendAt) return;
        if (isFlushing) return;

        const queue = getQueue();
        if (!queue.length) return;

        isFlushing = true;

        const batch = queue.slice(0, BATCH_SIZE);

        postBatchRaw(
            batch,
            () => {
                const rest = queue.slice(batch.length);
                setQueue(rest);

                backoffMs = BACKOFF_MIN_MS;
                nextAllowedSendAt = 0;
                isFlushing = false;
            },
            (err) => {
                console.warn('[Send-COMM] send failed:', err);

                nextAllowedSendAt = Date.now() + backoffMs;
                backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);

                isFlushing = false;
            }
        );
    }

    // =========================
    // IITC HOOKS
    // =========================
    function handleChatHook(data) {
        const candidates = [];
        if (!data) return;

        if (Array.isArray(data)) candidates.push(...data);
        if (data.raw && Array.isArray(data.raw)) candidates.push(...data.raw);
        if (data.result && Array.isArray(data.result)) candidates.push(...data.result);

        enqueueRawEvents(candidates);
    }

    function setup() {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        if (!w.addHook) {
            console.warn('[Send-COMM] IITC addHook not available yet');
            return;
        }

        console.log('[Send-COMM] STARTED. API:', API_URL);

        const hooks = [
            'publicChatDataAvailable',
            'factionChatDataAvailable',
            'alertsChatDataAvailable',
            'chatDataAvailable'
        ];

        hooks.forEach((h) => w.addHook(h, handleChatHook));

        setInterval(flushQueue, FLUSH_INTERVAL_MS);

        console.log('[Send-COMM] hooks attached:', hooks.join(', '));
    }

    // czekamy na iitcLoaded w kontekście IITC
    (function bootstrap() {
        const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        if (w.iitcLoaded) {
            setup();
            return;
        }

        // jeśli IITC jeszcze się ładuje, podepnij się do hooka iitcLoaded
        if (w.addHook) {
            w.addHook('iitcLoaded', setup);
            return;
        }

        // fallback: spróbuj za chwilę
        setTimeout(bootstrap, 1000);
    })();

})();