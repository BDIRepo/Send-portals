const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../send-comm.user.js'), 'utf8');
const QUEUE = 'iitc_comm_exporter_queue_local_v3';
const SEEN = 'iitc_comm_exporter_seen_local_v3';
const TOKEN = 'send_comm_api_token';
const DEFAULT_TOKEN = '6e66a1835cf948b4d3d8b0867ec5bc863945a88b660fa4591596226eb3d19b6b';
const event = guid => [guid, 1234567890, { plext: { text: 'test' } }];
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.textContent = '';
    }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, callback) { this[name] = callback; }
    querySelector(selector) {
        const key = selector.match(/^\[data-stat="(\w+)"\]$/)?.[1];
        if (this.dataset.stat === key) return this;
        for (const child of this.children) {
            const match = child.querySelector(selector);
            if (match) return match;
        }
        return null;
    }
}

function sharedStorage() {
    const values = new Map();
    const failures = new Set();
    let tail = Promise.resolve();
    return {
        values,
        failures,
        storage: {
            getItem: key => values.get(key) ?? null,
            setItem(key, value) {
                if (failures.has(key)) throw new Error('Storage quota exceeded');
                values.set(key, value);
            }
        },
        locks: {
            request(name, operation) {
                assert.equal(name, 'iitc_comm_exporter_queue');
                const result = tail.then(operation);
                tail = result.catch(() => {});
                return result;
            }
        }
    };
}

function harness({ shared = sharedStorage(), token = 'test-token', loaded = true, locks = true, getToken, setToken } = {}) {
    const hooks = new Map();
    const requests = [];
    const intervals = [];
    const logs = [];
    const menus = new Map();
    const dialogs = [];
    const toolbox = new Element('div');
    const activeTimers = new Set();
    const settings = new Map([[TOKEN, token]]);
    let now = 100000;
    let requestError;
    let promptResult = null;
    const page = {
        iitcLoaded: loaded,
        dialog(options) {
            dialogs.push(options);
            return { dialog() {} };
        },
        addHook(name, callback) {
            if (!hooks.has(name)) hooks.set(name, []);
            hooks.get(name).push(callback);
        }
    };
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    vm.runInNewContext(source, {
        console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })])),
        Date: Clock,
        localStorage: shared.storage,
        navigator: locks ? { locks: shared.locks } : {},
        unsafeWindow: page,
        window: { prompt: () => promptResult, innerWidth: 1280 },
        document: {
            createElement: tag => new Element(tag),
            getElementById: id => id === 'toolbox' ? toolbox : null
        },
        setInterval(callback) {
            intervals.push(callback);
            activeTimers.add(callback);
            return callback;
        },
        clearInterval: callback => activeTimers.delete(callback),
        setTimeout: () => { throw new Error('Unexpected bootstrap retry'); },
        GM_getValue: getToken ?? ((key, fallback) => settings.get(key) ?? fallback),
        GM_setValue: setToken ?? ((key, value) => settings.set(key, value)),
        GM_registerMenuCommand: (name, callback) => menus.set(name, callback),
        GM_xmlhttpRequest(request) {
            if (requestError) throw requestError;
            requests.push(request);
        }
    });
    return {
        shared, hooks, requests, intervals, logs, menus, settings, dialogs, toolbox, activeTimers,
        openStats: () => menus.get('Send COMM: statystyki')(),
        stat: key => dialogs.at(-1).html.querySelector('[data-stat="' + key + '"]').textContent,
        add: items => hooks.get('publicChatDataAvailable')[0]({ raw: items }),
        flush: () => intervals[0](),
        queue: () => JSON.parse(shared.values.get(QUEUE) ?? '[]'),
        seen: () => JSON.parse(shared.values.get(SEEN) ?? '[]'),
        advance: ms => { now += ms; },
        failRequest: error => { requestError = error; },
        prompt: value => { promptResult = value; },
        respond(result, status = 200, index = requests.length - 1) {
            requests[index].onload({ status, responseText: JSON.stringify(result) });
        }
    };
}

test('preserves events added while a batch is in flight', async () => {
    const h = harness();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    await h.add([event('B')]);
    h.respond({ accepted: 1, rejected: 0, inserted: 1 });
    await sending;
    assert.deepEqual(h.queue().map(row => row[0]), ['B']);
    assert.deepEqual(h.seen(), ['A']);
    await h.add([event('A'), event('B')]);
    assert.equal(h.queue().length, 1);
});

test('deduplicates a batch and overlapping hooks before confirmation', async () => {
    const h = harness();
    await Promise.all([h.add([event('A'), event('A')]), h.hooks.get('commDataAvailable')[0]({ result: [event('A')] })]);
    assert.equal(h.queue().length, 1);
    assert.deepEqual(h.seen(), []);
});

test('preserves legacy queued events even if they were already marked seen', async () => {
    const h = harness();
    h.shared.values.set(QUEUE, JSON.stringify([event('A')]));
    h.shared.values.set(SEEN, JSON.stringify(['A']));
    const sending = h.flush();
    await settle();
    assert.equal(JSON.parse(h.requests[0].data).result[0][0], 'A');
    h.respond({ accepted: 1, rejected: 0, already_present: 1 });
    await sending;
    assert.deepEqual(h.queue(), []);
});

for (const result of [{ accepted: 0, rejected: 1 }, { accepted: 1, rejected: 1 }, {}, null]) {
    test('retains unconfirmed response ' + JSON.stringify(result), async () => {
        const h = harness();
        await h.add([event('A')]);
        const sending = h.flush();
        await settle();
        h.respond(result);
        await sending;
        assert.equal(h.queue().length, 1);
        assert.deepEqual(h.seen(), []);
    });
}

test('retains a partially accepted batch', async () => {
    const h = harness();
    await h.add([event('A'), event('B')]);
    const sending = h.flush();
    await settle();
    h.respond({ accepted: 1, rejected: 1 });
    await sending;
    assert.equal(h.queue().length, 2);
});

test('completes the 72 accepted / 28 out-of-bounds batch and sends the next events', async () => {
    const h = harness();
    h.openStats();
    const batch = Array.from({ length: 100 }, (_, i) => event('id-' + i));
    await h.add(batch);
    const sending = h.flush();
    await settle();
    await h.add([event('next')]);
    h.respond({
        accepted: 72, rejected: 28, inserted: 0, already_present: 72,
        rejected_by_reason: { portal_out_of_allowed_bounds: 28 }
    });
    await sending;
    assert.deepEqual(h.queue().map(row => row[0]), ['next']);
    assert.equal(h.seen().length, 100);
    assert.equal(h.stat('accepted'), '72');
    assert.equal(h.stat('rejected'), '28');
    assert.equal(h.stat('errors'), '0');
    await h.add(batch);
    assert.equal(h.queue().length, 1);
    const next = h.flush();
    await settle();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(JSON.parse(h.requests[1].data).result, [event('next')]);
    h.respond({ accepted: 1, rejected: 0 });
    await next;
    assert.deepEqual(h.queue(), []);
});

test('completes a batch entirely rejected as out of bounds', async () => {
    const h = harness();
    await h.add([event('outside')]);
    const sending = h.flush();
    await settle();
    h.respond({
        accepted: 0, rejected: 1,
        rejected_by_reason: { portal_out_of_allowed_bounds: 1, other_reason: 0 }
    });
    await sending;
    assert.deepEqual(h.queue(), []);
    await h.add([event('outside')]);
    assert.deepEqual(h.queue(), []);
    await h.flush();
    assert.equal(h.requests.length, 1);
});

for (const result of [
    { accepted: 0, rejected: 2, rejected_by_reason: { portal_out_of_allowed_bounds: 1, temporary_error: 1 } },
    { accepted: 1, rejected: 1, rejected_by_reason: { temporary_error: 1 } },
    { accepted: 1, rejected: 1, rejected_by_reason: { portal_out_of_allowed_bounds: 0 } },
    { accepted: 1, rejected: 1, rejected_by_reason: { portal_out_of_allowed_bounds: 1, temporary_error: 1 } },
    { accepted: 1, rejected: 1, rejected_by_reason: { portal_out_of_allowed_bounds: '1' } },
    { accepted: 0, rejected: 1, rejected_by_reason: { portal_out_of_allowed_bounds: 1 } },
    { accepted: -1, rejected: 3, rejected_by_reason: { portal_out_of_allowed_bounds: 3 } }
]) {
    test('retains ambiguous or inconsistent rejection response: ' + JSON.stringify(result), async () => {
        const h = harness();
        await h.add([event('A'), event('B')]);
        const sending = h.flush();
        await settle();
        h.respond(result);
        await sending;
        assert.equal(h.queue().length, 2);
        assert.deepEqual(h.seen(), []);
    });
}

test('retains HTTP 2xx responses containing invalid JSON', async () => {
    const h = harness();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    h.requests[0].onload({ status: 200, responseText: '<html>proxy</html>' });
    await sending;
    assert.equal(h.queue().length, 1);
});

test('retries memory-only events after queue storage recovers without another hook', async () => {
    const h = harness();
    h.shared.failures.add(QUEUE);
    await h.add([event('A')]);
    assert.deepEqual(h.queue(), []);
    assert.deepEqual(h.seen(), []);
    h.shared.failures.delete(QUEUE);
    const sending = h.flush();
    await settle();
    assert.equal(h.queue().length, 1);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    assert.deepEqual(h.seen(), ['A']);
});

test('can send memory-only events while queue storage is full', async () => {
    const h = harness();
    h.shared.failures.add(QUEUE);
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    assert.equal(JSON.parse(h.requests[0].data).result[0][0], 'A');
    h.shared.failures.delete(QUEUE);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    assert.deepEqual(h.seen(), ['A']);
    assert.deepEqual(h.queue(), []);
});

test('failed acknowledgement persistence leaves batch available for retry', async () => {
    const h = harness();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    h.shared.failures.add(QUEUE);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    assert.equal(h.queue().length, 1);
    assert.deepEqual(h.seen(), []);
    h.shared.failures.delete(QUEUE);
    h.advance(3000);
    const retry = h.flush();
    await settle();
    h.respond({ accepted: 1, rejected: 0, already_present: 1 });
    await retry;
    assert.deepEqual(h.queue(), []);
});

test('queue threshold does not discard unsent events', async () => {
    const h = harness();
    h.shared.values.set(QUEUE, JSON.stringify(Array.from({ length: 5000 }, (_, i) => event('old-' + i))));
    await h.add([event('new')]);
    assert.equal(h.queue().length, 5001);
    assert.equal(h.queue()[0][0], 'old-0');
    assert.ok(h.logs.some(log => log.level === 'warn' && log.args[0].includes('no events were discarded')));
});

test('corrupt storage is preserved and pending events recover after repair', async () => {
    const h = harness();
    h.shared.values.set(QUEUE, '{broken');
    await h.add([event('A')]);
    await h.flush();
    assert.equal(h.shared.values.get(QUEUE), '{broken');
    assert.equal(h.requests.length, 0);
    h.shared.values.set(QUEUE, '[]');
    h.advance(3000);
    const sending = h.flush();
    await settle();
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    assert.deepEqual(h.seen(), ['A']);
});

for (const failure of ['ontimeout', 'onerror', 'onabort', 'http', 'throw']) {
    test('recovers from ' + failure + ' with backoff and no stuck sender', async () => {
        const h = harness();
        await h.add([event('A')]);
        if (failure === 'throw') h.failRequest(new Error('Request setup failed'));
        const sending = h.flush();
        await settle();
        if (failure === 'http') h.respond({}, 503);
        else if (failure !== 'throw') h.requests[0][failure]();
        await sending;
        const count = h.requests.length;
        h.failRequest(undefined);
        h.advance(2999);
        await h.flush();
        assert.equal(h.requests.length, count);
        h.advance(1);
        const retry = h.flush();
        await settle();
        assert.equal(h.requests.length, count + 1);
        h.respond({ accepted: 1, rejected: 0 });
        await retry;
        assert.deepEqual(h.queue(), []);
    });
}

test('coordinates concurrent additions and responses across two tabs', async () => {
    const shared = sharedStorage();
    const a = harness({ shared });
    const b = harness({ shared });
    await Promise.all([a.add([event('A')]), b.add([event('B')])]);
    const first = a.flush();
    const second = b.flush();
    await settle();
    await b.add([event('C')]);
    a.respond({ accepted: 2, rejected: 0 });
    await first;
    b.respond({ accepted: 2, rejected: 0 });
    await second;
    assert.deepEqual(a.queue().map(row => row[0]), ['C']);
});

test('retains batches of at most 100 and prevents overlapping sends in a tab', async () => {
    const h = harness();
    await h.add(Array.from({ length: 101 }, (_, i) => event('id-' + i)));
    const sending = h.flush();
    await settle();
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(JSON.parse(h.requests[0].data).result.length, 100);
    h.respond({ accepted: 100, rejected: 0 });
    await sending;
    assert.equal(h.queue().length, 1);
});

test('uses the public default and allows overriding it through the menu', async () => {
    const h = harness({ token: '' });
    h.openStats();
    assert.equal(h.stat('status'), 'Kolejka pusta');
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + DEFAULT_TOKEN);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    await h.add([event('B')]);
    h.prompt('  configured-token  ');
    await h.menus.get('Send COMM: ustaw token API')();
    await settle();
    assert.equal(h.settings.get(TOKEN), 'configured-token');
    assert.equal(h.requests[1].headers.Authorization, 'Bearer configured-token');
    h.respond({ accepted: 1, rejected: 0 });
    await settle();
    assert.deepEqual(h.queue(), []);
});

test('normalizes object timestamps including zero and rejects invalid events', async () => {
    const h = harness();
    await h.add([
        { id: 'zero', time: 0, data: { plext: {} } },
        ['', 1, { plext: {} }], ['nan', NaN, { plext: {} }],
        ['array', 1, { plext: [] }], ['negative', -1, { plext: {} }]
    ]);
    assert.deepEqual(h.queue(), [['zero', 0, { plext: {} }]]);
});

test('initializes only once after repeated IITC loaded callbacks', () => {
    const h = harness({ loaded: false });
    const setup = h.hooks.get('iitcLoaded')[0];
    setup();
    setup();
    assert.equal(h.intervals.length, 1);
    assert.equal(h.hooks.get('commDataAvailable').length, 1);
    assert.equal(h.hooks.has('chatDataAvailable'), false);
});

test('single-tab fallback works without Web Locks', async () => {
    const h = harness({ locks: false });
    await h.add([event('A')]);
    assert.equal(h.queue().length, 1);
    assert.ok(h.logs.some(log => log.args[0].includes('use only one IITC tab')));
});

test('metadata matches the installable userscript header', () => {
    const meta = fs.readFileSync(path.join(__dirname, '../send-comm.meta.js'), 'utf8').trim();
    assert.equal(meta, source.slice(0, source.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length).trim());
});

test('statistics sum multiple batches and survive closing and reopening the dialog', async () => {
    const h = harness();
    h.openStats();
    assert.equal(h.stat('sent'), '0');
    for (const [guid, inserted, already] of [['A', 1, 0], ['B', 0, 1]]) {
        await h.add([event(guid)]);
        assert.equal(h.stat('queue'), '1');
        const sending = h.flush();
        await settle();
        assert.equal(h.stat('status'), 'Wysyłanie');
        h.respond({ accepted: 1, rejected: 0, inserted, already_present: already });
        await sending;
    }
    assert.equal(h.stat('attempts'), '2');
    assert.equal(h.stat('sent'), '2');
    assert.equal(h.stat('accepted'), '2');
    assert.equal(h.stat('inserted'), '1');
    assert.equal(h.stat('already_present'), '1');
    assert.equal(h.stat('queue'), '0');
    assert.equal(h.stat('errors'), '0');
    h.dialogs[0].closeCallback();
    assert.equal(h.activeTimers.size, 1);
    h.openStats();
    assert.equal(h.stat('accepted'), '2');
    assert.equal(h.activeTimers.size, 2);
    h.openStats();
    assert.equal(h.dialogs.length, 2);
    assert.equal(h.activeTimers.size, 2);
});

test('statistics count partial responses and retries as response totals', async () => {
    const h = harness();
    h.openStats();
    await h.add([event('A'), event('B')]);
    const sending = h.flush();
    await settle();
    h.respond({ accepted: 1, inserted: 1, rejected: 1 });
    await sending;
    assert.equal(h.stat('accepted'), '1');
    assert.equal(h.stat('rejected'), '1');
    assert.equal(h.stat('queue'), '2');
    assert.equal(h.stat('errors'), '1');
    assert.equal(h.stat('status'), 'Ponowienie za 3 s');
    h.advance(3000);
    const retry = h.flush();
    await settle();
    h.respond({ accepted: 2, inserted: 1, already_present: 1, rejected: 0 });
    await retry;
    assert.equal(h.stat('sent'), '4');
    assert.equal(h.stat('accepted'), '3');
    assert.equal(h.stat('inserted'), '2');
    assert.equal(h.stat('already_present'), '1');
    assert.equal(h.stat('rejected'), '1');
});

test('statistics update while closed and ignore repeated or late response callbacks', async () => {
    const h = harness();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    h.respond({ accepted: 1, inserted: 1, rejected: 0 });
    h.respond({ accepted: 1, inserted: 1, rejected: 0 });
    await sending;
    h.openStats();
    assert.equal(h.stat('responses'), '1');
    assert.equal(h.stat('inserted'), '1');
    await h.add([event('B')]);
    const next = h.flush();
    await settle();
    h.requests.at(-1).ontimeout();
    h.respond({ accepted: 1, inserted: 1, rejected: 0 });
    await next;
    assert.equal(h.stat('responses'), '1');
    assert.equal(h.stat('inserted'), '1');
    assert.equal(h.stat('errors'), '1');
});

test('statistics show memory-only queue while using default credentials', async () => {
    const h = harness({ token: '' });
    h.openStats();
    assert.equal(h.stat('status'), 'Kolejka pusta');
    h.shared.failures.add(QUEUE);
    await h.add([event('A')]);
    assert.equal(h.stat('queue'), '1');
    assert.equal(h.stat('memory'), '1');
    h.shared.failures.delete(QUEUE);
    const sending = h.flush();
    await settle();
    assert.equal(h.stat('queue'), '1');
    assert.equal(h.stat('memory'), '0');
    assert.equal(h.stat('attempts'), '1');
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
});

for (const token of [null, '', '   ', 123]) {
    test('falls back to public token for missing or invalid setting: ' + JSON.stringify(token), async () => {
        const h = harness({ token });
        h.openStats();
        await h.add([event('A')]);
        const sending = h.flush();
        await settle();
        assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + DEFAULT_TOKEN);
        h.respond({ accepted: 1, rejected: 0 });
        await sending;
        assert.equal(h.stat('status'), 'Kolejka pusta');
    });
}

test('uses default credentials when reading settings throws', async () => {
    const h = harness({ getToken() { throw new Error('Storage unavailable'); } });
    h.openStats();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + DEFAULT_TOKEN);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
    assert.equal(h.stat('status'), 'Kolejka pusta');
});

test('menu token is used immediately even if asynchronous persistence fails', async () => {
    const h = harness({ setToken: async () => { throw new Error('Write failed'); } });
    h.openStats();
    await h.add([event('A')]);
    h.prompt('  session-token  ');
    await h.menus.get('Send COMM: ustaw token API')();
    await settle();
    assert.equal(h.requests[0].headers.Authorization, 'Bearer session-token');
    assert.match(h.stat('lastError'), /tylko w tej karcie/);
    h.respond({ accepted: 1, rejected: 0 });
    await settle();
    assert.equal(h.stat('status'), 'Kolejka pusta');
});

test('empty menu input restores the default while cancelling preserves the override', async () => {
    const h = harness({ token: 'custom-token' });
    await h.menus.get('Send COMM: ustaw token API')();
    assert.equal(h.settings.get(TOKEN), 'custom-token');
    h.prompt('   ');
    await h.menus.get('Send COMM: ustaw token API')();
    await settle();
    assert.equal(h.settings.get(TOKEN), DEFAULT_TOKEN);
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    assert.equal(h.requests[0].headers.Authorization, 'Bearer ' + DEFAULT_TOKEN);
    h.respond({ accepted: 1, rejected: 0 });
    await sending;
});

test('statistics remain finite when the API returns invalid counters', async () => {
    const h = harness();
    h.openStats();
    await h.add([event('A')]);
    const sending = h.flush();
    await settle();
    h.respond({ accepted: '1', rejected: -1, inserted: 999, already_present: null });
    await sending;
    for (const key of ['accepted', 'rejected', 'inserted', 'already_present']) assert.equal(h.stat(key), '0');
    assert.equal(h.stat('responses'), '1');
});

test('toolbox link opens statistics and unknown queue size is not reported as zero', () => {
    const h = harness();
    let prevented = false;
    h.toolbox.children[0].click({ preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(h.dialogs[0].id, 'send-comm-stats');
    h.shared.values.set(QUEUE, 'invalid');
    h.intervals[1]();
    assert.equal(h.stat('queue'), '?');
    assert.equal(h.stat('status'), 'Błąd odczytu kolejki');
});
