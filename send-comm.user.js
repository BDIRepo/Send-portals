// ==UserScript==
// @id             iitc-plugin-Send-comm
// @name           IITC plugin: Send comm
// @category       Info
// @version        0.1.0
// @namespace      X
// @updateURL      https://github.com/BDIRepo/Send-portals/raw/master/send-portals.meta.js
// @downloadURL    https://github.com/BDIRepo/Send-portals/raw/master/send-portals.user.js
// @description    Send portals to external database.
// @include        https://*.ingress.com/intel*
// @include        http://*.ingress.com/intel*
// @match          https://*.ingress.com/intel*
// @match          http://*.ingress.com/intel*
// @include        https://*.ingress.com/mission/*
// @include        http://*.ingress.com/mission/*
// @match          https://*.ingress.com/mission/*
// @match          http://*.ingress.com/mission/*
// @grant          none
// ==/UserScript==

// ==UserScript==
// @name         IITC COMM -> Local API exporter (raw)
// @namespace    iitc-comm-exporter-local
// @version      0.3.0
// @description  Collect ALL COMM entries and send raw [guid, ts_ms, {plext}] batches to local FastAPI
// @match        https://intel.ingress.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
    'use strict';

    // =========================
    // LOCAL CONFIG
    // =========================
    const API_URL = 'http://127.0.0.1:8000/ingress/comm/batch-raw';
    const API_TOKEN = 'CHANGE_ME_LONG_RANDOM_TOKEN'; // musi być zgodne z API_TOKEN po stronie serwera

    const BATCH_SIZE = 100;
    const FLUSH_INTERVAL_MS = 3000;

    // Ochrona localStorage
    const MAX_QUEUE = 5000;
    const MAX_SEEN = 10000;

    // Backoff gdy serwer nie działa
    const BACKOFF_MIN_MS = 3000;
    const BACKOFF_MAX_MS = 60000;

    // =========================
    // STORAGE
    // =========================
    const LS_QUEUE = 'iitc_comm_exporter_queue_local_v3';
    const LS_SEEN = 'iitc_comm_exporter_seen_local_v3';

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
            // jeśli localStorage pełny - i tak tniemy kolejkę limitami
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
    // NORMALIZE to [guid, ts_ms, {plext:{...}}]
    // =========================
    function normalizeToRawTriple(item) {
        // najczęstsze: już jest [guid, ts_ms, {plext:...}]
        if (Array.isArray(item) && item.length === 3) {
            const [guid, ts, payload] = item;
            if (
                typeof guid === 'string' &&
                typeof ts === 'number' &&
                payload && typeof payload === 'object' &&
                payload.plext && typeof payload.plext === 'object'
            ) {
                // ts w IITC jest zwykle ms (number). Zostawiamy jak jest.
                return [guid, ts, payload];
            }
        }

        // wariant obiektowy (zależny od wersji IITC)
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
    // SEND
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
                // sukces -> zdejmujemy wysłane
                const rest = queue.slice(batch.length);
                setQueue(rest);

                // reset backoff
                backoffMs = BACKOFF_MIN_MS;
                nextAllowedSendAt = 0;

                isFlushing = false;
            },
            (err) => {
                // błąd -> zostawiamy w kolejce; zwiększamy odstęp prób
                console.warn('[IITC COMM exporter local] send failed:', err);

                nextAllowedSendAt = Date.now() + backoffMs;
                backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);

                isFlushing = false;
            }
        );
    }

    // =========================
    // IITC HOOKS (ALL COMM)
    // =========================
    function handleChatHook(data) {
        const candidates = [];

        if (!data) return;

        // różne kształty w zależności od hooka
        if (Array.isArray(data)) candidates.push(...data);
        if (data.raw && Array.isArray(data.raw)) candidates.push(...data.raw);
        if (data.result && Array.isArray(data.result)) candidates.push(...data.result);

        enqueueRawEvents(candidates);
    }

    function setup() {
        if (!window.addHook) {
            console.warn('[IITC COMM exporter local] addHook not available');
            return;
        }

        // bierzemy wszystko:
        const hooks = [
            'publicChatDataAvailable',
            'factionChatDataAvailable',
            'alertsChatDataAvailable',
            'chatDataAvailable'
        ];

        hooks.forEach((h) => window.addHook(h, handleChatHook));

        setInterval(flushQueue, FLUSH_INTERVAL_MS);

        console.log('[IITC COMM exporter local] loaded. API:', API_URL, 'hooks:', hooks.join(', '));
    }

    // =========================
    // IITC WRAPPER
    // =========================
    function wrapper() {
        if (window.iitcLoaded) setup();
        else window.addHook('iitcLoaded', setup);
    }

    const script = document.createElement('script');
    script.appendChild(document.createTextNode('(' + wrapper + ')();'));
    (document.body || document.head || document.documentElement).appendChild(script);
})();