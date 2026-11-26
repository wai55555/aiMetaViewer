const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../..');
const backgroundSource = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');
const start = backgroundSource.indexOf('class PersistentLRUCache');
const end = backgroundSource.indexOf('// 永続キャッシュインスタンス', start);
if (start < 0 || end < 0) throw new Error('PersistentLRUCache source not found');

function createCache(limit = 4) {
    const store = new Map();
    const storage = {
        async get(keys) {
            if (keys === null || keys === undefined) return Object.fromEntries(store);
            if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
            if (Array.isArray(keys)) {
                const result = {};
                for (const key of keys) if (store.has(key)) result[key] = store.get(key);
                return result;
            }
            const result = {};
            for (const key of Object.keys(keys)) result[key] = store.has(key) ? store.get(key) : keys[key];
            return result;
        },
        async set(items) {
            for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        },
        async clear() {
            store.clear();
        },
        async getKeys() {
            return Array.from(store.keys());
        },
    };
    const context = vm.createContext({
        console,
        TextEncoder,
        Map,
        Object,
        Array,
        Set,
        JSON,
        Number,
        String,
        Promise,
        Error,
        Date,
        setTimeout: () => 0,
        clearTimeout: () => {},
        CACHE_ENTRY_MARKER: 'aiMetaViewerCacheEntry',
        PNG_SCANNER_CACHE_VERSION: 'png-scanner-v3',
        PARSER_CACHE_VERSION: 'parser-v2',
        debugLog: () => {},
        browserAPI: { storage: { local: storage } },
    });
    vm.runInContext(backgroundSource.slice(start, end), context, { filename: 'cache.js' });
    const PersistentLRUCache = vm.runInContext('PersistentLRUCache', context);
    return {
        store,
        storage,
        cache: new PersistentLRUCache(limit),
    };
}

test('cache clear removes only meta_cache_ keys and the index', async () => {
    const { store, cache } = createCache();
    store.set('meta_cache_a', { value: 1 });
    store.set('meta_cache_b', { value: 2 });
    store.set('meta_cache_index', [['a', { t: 1, s: 1 }]]);
    store.set('unrelated_setting', { keep: true });
    store.set('meta_cache_backup', { keep: false });

    await cache.clear();
    assert.equal(store.has('meta_cache_a'), false);
    assert.equal(store.has('meta_cache_b'), false);
    assert.equal(store.has('meta_cache_index'), false);
    assert.equal(store.has('meta_cache_backup'), false);
    assert.equal(store.has('unrelated_setting'), true);
    assert.deepEqual(store.get('unrelated_setting'), { keep: true });
});

test('cache clear falls back to get(null) when getKeys is unavailable', async () => {
    const { store, storage, cache } = createCache();
    store.set('meta_cache_a', { value: 1 });
    store.set('meta_cache_index', []);
    store.set('keep_me', true);
    storage.getKeys = undefined;
    let clearCalled = false;
    storage.clear = async () => { clearCalled = true; };

    await cache.clear();
    assert.equal(clearCalled, false);
    assert.equal(store.has('meta_cache_a'), false);
    assert.equal(store.has('meta_cache_index'), false);
    assert.equal(store.has('keep_me'), true);
});

test('cache eviction follows Map insertion order and preserves FIFO result', async () => {
    const { store, cache } = createCache(3);
    await cache.set('oldest', { value: 'oldest' });
    await cache.set('middle', { value: 'middle' });
    await cache.set('newest', { value: 'newest' });
    await cache.set('added', { value: 'added' });

    assert.equal(store.has('meta_cache_oldest'), false);
    assert.equal(store.has('meta_cache_middle'), true);
    assert.equal(store.has('meta_cache_newest'), true);
    assert.equal(store.has('meta_cache_added'), true);
    assert.deepEqual(Array.from(cache.index.keys()), ['middle', 'newest', 'added']);
});

test('cache get refreshes insertion order without changing FIFO eviction semantics', async () => {
    const { cache } = createCache(3);
    await cache.set('oldest', { value: 'oldest' });
    await cache.set('middle', { value: 'middle' });
    await cache.set('newest', { value: 'newest' });
    await cache.get('oldest');
    await cache.set('added', { value: 'added' });
    assert.deepEqual(Array.from(cache.index.keys()), ['newest', 'oldest', 'added']);
});
