import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const KIND = 'local-sidebar-chat';
const key = (main, content) => JSON.stringify([main, content]);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); }, listeners };
}

// Models the documented synchronous native close boundary: handler(sessionId, rawTab)
// runs before layout removal; a thrown handler leaves the entire tab in place.
async function fixture({ rows = new Map(), statuses = new Map(), autoAnswer = true } = {}) {
  const registrations = [], effects = [], calls = [], retained = [], alerts = [], confirmations = [], commits = [];
  const nativeTabs = new Map();
  const timers = new Map();
  let now = Date.now(), nextTimer = 0;
  const mounted = observable('main-a'), inventory = observable([]);
  let plugin, definition, handler, confirm = true, failClose = false, failRename = false, closeGate, openGate, statusGate, failOpen = false;
  let dictionary;
  const t = (name, args = {}) => Object.entries(args).reduce((text, [k, v]) => text.replace(`{${k}}`, v), dictionary?.[name] ?? name);
  const publishTabs = () => inventory.set([...nativeTabs.values()].map(({ main, tab }) => ({ sessionId: main, tabId: tab.id, kind: tab.kind, contentId: tab.contentId })));
  const closeOverlay = () => registrations.find(r => r.options.id === '@local/dsh-sidebar-chat/close-dialog').options.inject();
  const answerClose = async accepted => {
    const overlay = closeOverlay(), request = overlay.hooks.closeDialog.getSnapshot();
    if (!request) return;
    if (!accepted) { overlay.dismissClose(request); return; }
    await request.confirm(); overlay.dismissClose(request);
  };
  const observedDialogs = new Set();
  const nativeClose = (main, tab) => {
    const owned = nativeTabs.get(key(main, tab.id));
    if (!owned || owned.tab.contentId !== tab.contentId) return;
    // The real native handler gets a layout record, NOT useTabInfo/actions/signal.
    try { handler?.(main, { id: tab.id, kind: tab.kind, contentId: tab.contentId, title: tab.title }); }
    catch (error) {
      const dialog = closeOverlay().hooks.closeDialog.getSnapshot();
      if (dialog && !observedDialogs.has(dialog)) {
        observedDialogs.add(dialog); confirmations.push(dialog.key);
        if (autoAnswer) {
          if (!confirm) closeOverlay().dismissClose(dialog);
          else void answerClose(true).catch(reason => alerts.push(String(reason.message || reason)));
        }
      }
      throw error;
    }
    nativeTabs.delete(key(main, tab.id));
    commits.push({ main, id: tab.id, contentId: tab.contentId });
    publishTabs();
    owned.abort.abort();
  };
  const ctx = {
    effect: fn => { const cleanup = fn(); effects.push(cleanup); return cleanup; },
    locale: { register: (_ns, value) => { dictionary = value.en; return () => {}; }, bind: () => t },
    sidebarRightTabs: { register: value => { definition = value; return () => {}; } },
    sidebarRight: {
      mounted, openTabs: inventory,
      registerCloseHandler: (kind, fn) => { assert.equal(kind, KIND); assert.equal(handler, undefined); handler = fn; return () => { handler = undefined; }; },
      close: id => { const owned = nativeTabs.get(key(mounted.getSnapshot(), id)); if (owned) nativeClose(owned.main, owned.tab); },
      openTab: () => assert.fail('Restoration must never duplicate native layout tabs'),
      focus: () => {},
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        if (['sidebar.right.tab.menu.item', 'shell.overlay'].includes(options.name)) {
          assert.equal(typeof options.id, 'string', `Native list slot ${options.name} requires an id`);
          assert.ok(options.id.length > 0);
        }
        registrations.push({ options, component }); return () => {};
      },
    },
    connection: { rpc: { call: async (channel, method, payload, signal) => {
      const request = payload.args.request;
      calls.push({ channel, method, request, signal });
      const active = row => row.state !== 'closing' && (row.expiresAt === undefined || row.expiresAt > now);
      if (method.endsWith('/list')) return { ok: true, value: [...rows.values()].filter(row => row.mainSessionId === request.mainSessionId && active(row)) };
      const identity = key(request.mainSessionId, request.tabId);
      if (method.endsWith('/status')) {
        if (statusGate) await statusGate.promise;
        const row = rows.get(identity);
        return { ok: true, value: statuses.get(identity) ?? (row ? { state: active(row) ? 'active' : 'closing', row } : { state: 'unknown' }) };
      }
      if (method.endsWith('/close')) {
        if (closeGate) await closeGate.promise;
        if (failClose) return { ok: false, error: { message: 'offline' } };
        rows.delete(identity);
        return { ok: true, value: { closed: true, mainSessionId: request.mainSessionId, tabId: request.tabId } };
      }
      if (method.endsWith('/rename')) {
        if (failRename) return { ok: false, error: { message: 'rename offline' } };
        const row = rows.get(identity);
        if (!row) return { ok: false, error: { message: 'unknown sidebar' } };
        const next = { ...row, title: request.title };
        rows.set(identity, next);
        return { ok: true, value: next };
      }
      assert.equal(method, 'sidebarChat/open');
      if (openGate) await openGate.promise;
      if (failOpen) return { ok: false, error: { message: 'expired sidebar' } };
      if (!rows.has(identity)) rows.set(identity, { ...request, sessionId: `side:${identity}`, title: `title:${request.mainSessionId}`, expiresAt: now + 3600000 });
      return { ok: true, value: rows.get(identity) };
    } } },
    sessions: { retain: (sessionId, options) => { const ref = { sessionId, options, release() {} }; retained.push(ref); return ref; } },
  };
  const React = { Fragment: Symbol('fragment'), createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useCallback: fn => fn };
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: entry => { plugin = entry.factory(name => { assert.equal(name, 'react'); return React; }); } },
      confirm: () => assert.fail('System confirmation must not be used'), alert: text => alerts.push(text),
    },
    // Any global DOM inspection/listener or UUID generation is a regression.
    document: new Proxy({}, { get() { assert.fail('Client must not inspect or intercept the document'); } }),
    crypto: new Proxy({}, { get() { assert.fail('Use persisted native contentId, not a fresh UUID'); } }),
    AbortController, AbortSignal, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  plugin.apply(ctx);
  const registration = name => registrations.find(r => r.options.name === name);
  const titleSource = () => registration('sidebar.right.pane.tab.title').options.inject('main-a').hooks.sidebarTitles.getSnapshot();
  const addTab = (main = 'main-a', id = 'tab1', contentId = 'native-content-a', { bind = true } = {}) => {
    const abort = new AbortController();
    const tab = { id, contentId, kind: KIND, title: 'Side conversation', signal: abort.signal, actions: { close: () => nativeClose(main, tab) } };
    nativeTabs.set(key(main, id), { main, tab, abort });
    publishTabs();
    const release = bind ? registration('sidebar.right.pane.tab.title').options.inject(main).bindSide(tab) : () => {};
    return { tab, abort, release, main };
  };
  return {
    closeOverlay, answerClose,
    ctx, calls, retained, rows, alerts, confirmations, commits, definition, nativeTabs, registrations, registration, addTab, nativeClose, titleSource, t, timers,
    advance: async milliseconds => {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
      await tick();
    },
    setConfirm: value => { confirm = value; }, setFailClose: value => { failClose = value; }, setFailRename: value => { failRename = value; },
    setCloseGate: value => { closeGate = value; }, setOpenGate: value => { openGate = value; }, setStatusGate: value => { statusGate = value; }, setFailOpen: value => { failOpen = value; },
    open: held => registration('sidebar.right.pane.tab').options.inject(held.main).openSide(held.tab, new AbortController().signal),
    cleanup: async () => { for (const fn of [...effects].reverse()) await fn?.(); },
  };
}
const callsFor = (f, action) => f.calls.filter(call => call.method === `sidebarChat/${action}`);

test('same tab1 and contentId in different main Sessions never collide', async () => {
  const f = await fixture();
  const a = f.addTab('main-a', 'tab1', 'shared-native-content');
  const b = f.addTab('main-b', 'tab1', 'shared-native-content');
  const [first, second] = await Promise.all([f.open(a), f.open(b)]);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal((await f.open(a)).sessionId, first.sessionId);
  assert.equal(callsFor(f, 'open').length, 2);
  assert.equal(f.titleSource().get(key('main-a', a.tab.contentId)).title, 'title:main-a');
  assert.equal(f.titleSource().get(key('main-b', b.tab.contentId)).title, 'title:main-b');
  const rename = f.registration('shell.overlay').options.inject().renameSide;
  await rename('main-b', b.tab, 'B renamed');
  assert.equal(f.titleSource().get(key('main-a', a.tab.contentId)).title, 'title:main-a');
  assert.equal(f.titleSource().get(key('main-b', b.tab.contentId)).title, 'B renamed');
  assert.equal(callsFor(f, 'rename')[0].request.sessionId, second.sessionId);
  assert.equal(f.definition.multiple, true);
  assert.equal(f.definition.keepMounted, true);
  await f.cleanup();
});

test('reload restores exact content identity and titles without opening another native tab', async () => {
  const rows = new Map();
  const first = await fixture({ rows });
  const a = first.addTab();
  const ref = await first.open(a);
  await first.cleanup();
  a.abort.abort();
  assert.equal(callsFor(first, 'close').length, 0);
  const second = await fixture({ rows });
  const restored = second.addTab('main-a', 'tab9', a.tab.contentId);
  await tick();
  assert.equal(callsFor(second, 'open').length, 0, 'unvisited title restoration is read-only');
  assert.equal(second.titleSource().get(key('main-a', a.tab.contentId)).sessionId, ref.sessionId);
  assert.equal((await second.open(restored)).sessionId, ref.sessionId);
  assert.equal(callsFor(second, 'open')[0].request.tabId, a.tab.contentId);
  assert.equal(rows.size, 1);
  await second.cleanup();
});

test('list hydration handles late title mounts and never guesses old random associations', async () => {
  const rows = new Map([
    [key('main-a', 'content-b'), { mainSessionId: 'main-a', tabId: 'content-b', sessionId: 'side-b', title: 'B' }],
    [key('main-a', 'tab-old-random'), { mainSessionId: 'main-a', tabId: 'tab-old-random', sessionId: 'legacy-side', title: 'Legacy' }],
  ]);
  const f = await fixture({ rows });
  const a = f.addTab();
  await tick();
  f.addTab('main-a', 'tab2', 'content-b');
  await tick();
  assert.equal(callsFor(f, 'list').length, 1);
  assert.equal(f.titleSource().get(key('main-a', 'content-b')).title, 'B');
  assert.equal(f.titleSource().has(key('main-a', a.tab.contentId)), false);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(callsFor(f, 'close')[0].request.sessionId, undefined);
  assert.equal(rows.has(key('main-a', 'tab-old-random')), true);
  assert.equal(callsFor(f, 'open').length, 0);
  await f.cleanup();
});

test('native close cancellation preserves both visited and unvisited tabs without RPC deletion', async () => {
  const f = await fixture();
  const a = f.addTab();
  const b = f.addTab('main-a', 'tab2', 'content-b');
  await f.open(a);
  f.setConfirm(false);
  for (const held of [a, b]) assert.throws(() => f.nativeClose(held.main, held.tab), /closing/);
  await tick();
  assert.equal(f.confirmations.length, 2);
  assert.equal(callsFor(f, 'close').length, 0);
  assert.equal(f.nativeTabs.size, 2);
  assert.equal(f.rows.size, 1);
  await f.cleanup();
});

test('close acknowledgement removes only the original Session even after foreground switches', async () => {
  const f = await fixture();
  const a = f.addTab();
  const b = f.addTab('main-b', 'tab1', 'native-content-b');
  await Promise.all([f.open(a), f.open(b)]);
  const gate = deferred(); f.setCloseGate(gate);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(f.confirmations.length, 1, 'repeat gestures cannot launch duplicate deletes');
  assert.equal(f.nativeTabs.size, 2, 'RPC has not acknowledged, so native layout must retain the tab');
  f.ctx.sidebarRight.mounted.set('main-b');
  gate.resolve(); await tick();
  assert.equal(f.nativeTabs.has(key('main-a', 'tab1')), false);
  assert.equal(f.nativeTabs.has(key('main-b', 'tab1')), true);
  assert.equal(callsFor(f, 'close').length, 1);
  assert.equal(callsFor(f, 'close')[0].request.tabId, a.tab.contentId);
  assert.equal(f.titleSource().has(key('main-a', a.tab.contentId)), false, 'successful close releases the title cache');
  assert.equal(f.confirmations.length, 1, 'acknowledged native re-entry does not reconfirm');
  await f.cleanup();
});

test('async close failure keeps the tab and binding; explicit retry is required', async () => {
  const f = await fixture();
  const a = f.addTab(); await f.open(a);
  f.setFailClose(true);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(f.nativeTabs.size, 1);
  assert.equal(f.rows.size, 1);
  assert.match(f.alerts[0], /offline/);
  f.setFailClose(false);
  await f.answerClose(true); // Retry from the still-open application dialog.
  await tick();
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.rows.size, 0);
  assert.equal(callsFor(f, 'close').length, 2);
  assert.deepEqual(callsFor(f, 'close')[0].request, callsFor(f, 'close')[1].request);
  assert.equal(f.confirmations.length, 1, 'failure retains the existing confirmation dialog');
  await f.cleanup();
});

test('unvisited tabs can close without open/retain, even before their title binds', async () => {
  const f = await fixture();
  const a = f.addTab('main-a', 'tab1', 'unvisited-content', { bind: false });
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(callsFor(f, 'open').length, 0);
  assert.equal(f.retained.length, 0);
  assert.equal(callsFor(f, 'close')[0].request.tabId, 'unvisited-content');
  await f.cleanup();
});

test('missing background binding never falls back to foreground tab with same native id', async () => {
  const f = await fixture();
  const a = f.addTab('main-a', 'tab1', 'content-a', { bind: false });
  f.addTab('main-b', 'tab1', 'content-b', { bind: false });
  const gate = deferred(); f.setCloseGate(gate);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick(); f.ctx.sidebarRight.mounted.set('main-b');
  gate.resolve(); await tick();
  assert.equal(f.commits.length, 0);
  f.ctx.sidebarRight.mounted.set('main-a');
  assert.doesNotThrow(() => f.nativeClose(a.main, a.tab));
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].main, 'main-a');
  assert.equal(f.confirmations.length, 1);
  await f.cleanup();
});

test('occurrence abort, React title remount, collapse and unload never mean destructive close', async () => {
  const f = await fixture();
  const a = f.addTab(); const ref = await f.open(a);
  a.release();
  const releaseAgain = f.registration('sidebar.right.pane.tab.title').options.inject(a.main).bindSide(a.tab);
  assert.equal((await f.open(a)).sessionId, ref.sessionId);
  f.ctx.sidebarRight.mounted.set(undefined);
  a.abort.abort(); releaseAgain();
  assert.equal(callsFor(f, 'close').length, 0);
  await f.cleanup();
  assert.equal(f.ctx.sidebarRight.openTabs.listeners.size, 0);
  assert.equal(f.titleSource().size, 0);
  assert.equal(callsFor(f, 'close').length, 0);
  assert.equal(f.rows.size, 1);
});

test('closing during open waits for its result and never retains a late closed Session', async () => {
  const f = await fixture();
  const a = f.addTab(); const gate = deferred(); f.setOpenGate(gate);
  const opening = f.open(a);
  const rejected = assert.rejects(opening, /closing|abort/i);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(callsFor(f, 'close').length, 0);
  gate.resolve(); await rejected; await tick();
  assert.equal(callsFor(f, 'close').length, 1);
  assert.equal(f.retained.length, 0);
  assert.equal(f.nativeTabs.size, 0);
  await f.cleanup();
});

test('unload while a close RPC is pending does not later remove a native tab', async () => {
  const f = await fixture(); const a = f.addTab();
  const gate = deferred(); f.setCloseGate(gate);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick(); await f.cleanup();
  gate.resolve(); await tick();
  assert.equal(f.commits.length, 0);
  assert.equal(f.alerts.length, 0);
  assert.equal(f.titleSource().size, 0);
});

test('expired open stays an explicit error rather than assigning a new identity', async () => {
  const f = await fixture(); const a = f.addTab(); f.setFailOpen(true);
  await assert.rejects(f.open(a), /expired/);
  await assert.rejects(f.open(a), /expired/);
  assert.equal(callsFor(f, 'open').length, 2);
  assert.equal(callsFor(f, 'open')[0].request.tabId, a.tab.contentId);
  assert.deepEqual(callsFor(f, 'open')[0].request, callsFor(f, 'open')[1].request);
  assert.equal(f.retained.length, 0);
  assert.equal(f.nativeTabs.size, 1);
  await f.cleanup();
});

test('native menu rename is kind-scoped; overlay retains captured identity and failures preserve title', async () => {
  const f = await fixture(); const a = f.addTab(); await f.open(a);
  const menu = f.registration('sidebar.right.tab.menu.item');
  const injected = menu.options.inject();
  const props = { ...injected, sessionId: a.main, tab: a.tab, dismiss: () => {}, t: f.t, useSidebarTitles: select => select(injected.hooks.sidebarTitles.getSnapshot()) };
  assert.equal(menu.component({ ...props, tab: { ...a.tab, kind: 'terminal' } }), null);
  let dismissed = false;
  const tree = menu.component({ ...props, dismiss: () => { dismissed = true; } });
  tree.props.children.find(child => child.type === 'button').props.onClick();
  assert.equal(dismissed, true);
  const overlay = f.registration('shell.overlay').options.inject();
  const request = overlay.hooks.renameDialog.getSnapshot();
  assert.equal(request.mainSessionId, 'main-a');
  assert.equal(request.tab.contentId, a.tab.contentId);
  f.ctx.sidebarRight.mounted.set('main-b');
  f.setFailRename(true);
  await assert.rejects(overlay.renameSide(request.mainSessionId, request.tab, 'new'), /rename offline/);
  assert.equal(f.titleSource().get(key(a.main, a.tab.contentId)).title, 'title:main-a');
  assert.equal(overlay.hooks.renameDialog.getSnapshot(), request);
  overlay.closeRename(request);
  assert.equal(overlay.hooks.renameDialog.getSnapshot(), null);
  assert.equal(callsFor(f, 'close').length, 0);
  await f.cleanup();
});

test('expiry uses one timer per content identity, skips confirmation and closes the original Session', async () => {
  const f = await fixture();
  const a = f.addTab(); await f.open(a);
  const b = f.addTab('main-b', 'tab1', 'content-b');
  f.rows.set(key(b.main, b.tab.contentId), { mainSessionId: b.main, tabId: b.tab.contentId, sessionId: 'side-b', title: 'B', expiresAt: Date.now() + 7200000 });
  await f.open(b);
  await f.open(a); // React remount must not stack expiry timers.
  assert.equal(f.timers.size, 2);
  f.ctx.sidebarRight.mounted.set('main-b');
  await f.advance(3600000);
  assert.equal(f.confirmations.length, 0);
  assert.equal(callsFor(f, 'close').length, 1);
  assert.equal(callsFor(f, 'close')[0].request.mainSessionId, 'main-a');
  assert.equal(f.nativeTabs.has(key('main-a', 'tab1')), false);
  assert.equal(f.nativeTabs.has(key('main-b', 'tab1')), true);
  assert.equal(f.timers.size, 1);
  await f.cleanup();
  assert.equal(f.timers.size, 0);
});

test('unvisited restored tab expires from read-only list metadata without opening a Session', async () => {
  const rows = new Map([[key('main-a', 'content'), { mainSessionId: 'main-a', tabId: 'content', sessionId: 'side', title: 'restored', expiresAt: Date.now() + 1000 }]]);
  const f = await fixture({ rows }); f.addTab('main-a', 'tab1', 'content');
  await tick();
  assert.equal(f.timers.size, 1);
  await f.advance(2000);
  assert.equal(callsFor(f, 'open').length, 0);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.timers.size, 0);
  await f.cleanup();
});

test('expiry failure keeps tab and one 60-second retry; only the first failure alerts', async () => {
  const f = await fixture(); const a = f.addTab(); await f.open(a);
  f.setFailClose(true);
  await f.advance(3600000);
  assert.equal(f.nativeTabs.size, 1);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.timers.size, 1);
  await f.advance(59999);
  assert.equal(callsFor(f, 'close').length, 1);
  await f.advance(1);
  assert.equal(callsFor(f, 'close').length, 2);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.timers.size, 1);
  f.setFailClose(false);
  await f.advance(60000);
  assert.equal(callsFor(f, 'close').length, 3);
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.confirmations.length, 0);
  await f.cleanup();
});

test('expiry retry stops on unload or native membership removal', async () => {
  for (const unload of [true, false]) {
    const f = await fixture(); const a = f.addTab(); await f.open(a);
    f.setFailClose(true); await f.advance(3600000);
    assert.equal(f.timers.size, 1);
    if (unload) await f.cleanup();
    else { f.nativeTabs.delete(key(a.main, a.tab.id)); f.ctx.sidebarRight.openTabs.set([]); }
    assert.equal(f.timers.size, 0);
    await f.advance(60000);
    assert.equal(callsFor(f, 'close').length, 1);
    if (!unload) await f.cleanup();
  }
});

test('expired background acknowledgement commits when its title binds again', async () => {
  const f = await fixture(); const a = f.addTab(); await f.open(a);
  a.release();
  f.ctx.sidebarRight.mounted.set('main-b');
  await f.advance(3600000);
  assert.equal(f.nativeTabs.size, 1);
  f.registration('sidebar.right.pane.tab.title').options.inject(a.main).bindSide(a.tab);
  await tick();
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.confirmations.length, 0);
  await f.cleanup();
});

test('status distinguishes closed or closing restored tabs from unknown legacy identities', async () => {
  for (const state of ['closed', 'closing', 'unknown']) {
    const row = { mainSessionId: 'main-a', tabId: 'content', sessionId: 'side', title: 'old', expiresAt: Date.now() - 1000 };
    const rows = state === 'closing' ? new Map([[key('main-a', 'content'), row]]) : new Map();
    const statuses = new Map([[key('main-a', 'content'), { state, ...(state === 'closing' ? { row } : {}) }]]);
    const f = await fixture({ rows, statuses });
    f.addTab('main-a', 'tab1', 'content');
    await tick();
    assert.equal(callsFor(f, 'status').length, 1);
    assert.equal(callsFor(f, 'status')[0].request.tabId, 'content');
    assert.equal(callsFor(f, 'open').length, 0);
    assert.equal(f.retained.length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.nativeTabs.size, state === 'unknown' ? 1 : 0);
    assert.equal(callsFor(f, 'close').length, state === 'unknown' ? 0 : 1);
    assert.equal(f.timers.size, 0);
    await f.cleanup();
  }
});

test('creating status during in-flight open never closes the new tab', async () => {
  for (const state of ['creating', 'closing']) {
    // Also guard against an older Host mapping creating rows to closing.
    const row = { mainSessionId:'main-a', tabId:'content', sessionId:'side-new', title:'new', state:'creating', expiresAt:Date.now()+3600000 };
    const f = await fixture({statuses:new Map([[key('main-a','content'),{state,row}]])});
    const gate=deferred(); f.setOpenGate(gate);
    const a=f.addTab('main-a','tab1','content');
    const opening=f.open(a);
    await tick();
    assert.equal(callsFor(f,'status').length,1);
    assert.equal(callsFor(f,'close').length,0);
    assert.equal(f.nativeTabs.size,1);
    gate.resolve(); await opening; await tick();
    assert.equal(callsFor(f,'close').length,0);
    assert.equal(f.nativeTabs.size,1);
    assert.equal(f.confirmations.length,0);
    await f.cleanup();
  }
});

test('status active row fills a stale list without creating a Session', async () => {
  const row = { mainSessionId: 'main-a', tabId: 'content', sessionId: 'side', title: 'Recovered title', expiresAt: Date.now() + 3600000 };
  const f = await fixture({ statuses: new Map([[key('main-a', 'content'), { state: 'active', row }]]) });
  f.addTab('main-a', 'tab1', 'content');
  await tick();
  assert.equal(f.titleSource().get(key('main-a', 'content')).title, 'Recovered title');
  assert.equal(f.timers.size, 1);
  assert.equal(callsFor(f, 'open').length, 0);
  assert.equal(callsFor(f, 'close').length, 0);
  await f.cleanup();
});

test('closed status cleanup failure preserves the tab and retries even without an expiry row', async () => {
  const f = await fixture({ statuses: new Map([[key('main-a', 'content'), { state: 'closed' }]]) });
  f.setFailClose(true); f.addTab('main-a', 'tab1', 'content');
  await tick();
  assert.equal(f.nativeTabs.size, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.alerts.length, 1);
  await f.advance(60000);
  assert.equal(f.alerts.length, 1);
  f.setFailClose(false);
  await f.advance(60000);
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.confirmations.length, 0);
  await f.cleanup();
});

test('late status response cannot clean up after unload or native membership removal', async () => {
  for (const unload of [true, false]) {
    const f = await fixture({ statuses: new Map([[key('main-a', 'content'), { state: 'closed' }]]) });
    const gate = deferred(); f.setStatusGate(gate);
    const a = f.addTab('main-a', 'tab1', 'content');
    await tick();
    assert.equal(callsFor(f, 'status').length, 1);
    if (unload) await f.cleanup();
    else { f.nativeTabs.delete(key(a.main, a.tab.id)); f.ctx.sidebarRight.openTabs.set([]); }
    gate.resolve(); await tick();
    assert.equal(callsFor(f, 'close').length, 0);
    assert.equal(f.timers.size, 0);
    if (!unload) await f.cleanup();
  }
});

test('status cleanup remains bound to its original main when another main has the same tab1', async () => {
  const f = await fixture({ statuses: new Map([[key('main-a', 'content'), { state: 'closed' }]]) });
  const gate = deferred(); f.setStatusGate(gate);
  f.addTab('main-a', 'tab1', 'content');
  f.addTab('main-b', 'tab1', 'content');
  await tick();
  f.ctx.sidebarRight.mounted.set('main-b');
  gate.resolve(); await tick();
  assert.equal(f.nativeTabs.has(key('main-a', 'tab1')), false);
  assert.equal(f.nativeTabs.has(key('main-b', 'tab1')), true);
  assert.equal(f.confirmations.length, 0);
  await f.cleanup();
});

test('missing stable identity and mismatched close acknowledgement cannot silently remove tabs', async () => {
  const f = await fixture(); const a = f.addTab();
  const open = f.registration('sidebar.right.pane.tab').options.inject(a.main).openSide;
  await assert.rejects(open({ ...a.tab, contentId: undefined }, new AbortController().signal), /identity is invalid/);
  assert.equal(callsFor(f, 'open').length, 0);
  const original = f.ctx.connection.rpc.call;
  f.ctx.connection.rpc.call = async (...args) => {
    const response = await original(...args);
    if (args[1] === 'sidebarChat/close') response.value.tabId = 'different-content';
    return response;
  };
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  await tick();
  assert.equal(f.commits.length, 0);
  assert.equal(f.nativeTabs.size, 1);
  assert.match(f.alerts[0], /identity is invalid/);
  await f.cleanup();
});

test('application dialog waits for explicit approval; cancellation performs no deletion', async () => {
  const f = await fixture({ autoAnswer: false });
  const a = f.addTab(); await f.open(a);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  const pending = f.closeOverlay().hooks.closeDialog.getSnapshot();
  assert.ok(pending);
  await tick();
  assert.equal(callsFor(f, 'close').length, 0);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  assert.equal(f.closeOverlay().hooks.closeDialog.getSnapshot(), pending, 'repeat gesture does not replace the dialog');
  await f.answerClose(false);
  assert.equal(f.closeOverlay().hooks.closeDialog.getSnapshot(), null);
  assert.equal(f.nativeTabs.size, 1);
  assert.equal(callsFor(f, 'close').length, 0);
  await f.cleanup();
});

test('application confirmation failure stays open and retries without a system alert', async () => {
  const f = await fixture({ autoAnswer: false });
  const a = f.addTab(); await f.open(a);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  const request = f.closeOverlay().hooks.closeDialog.getSnapshot();
  f.setFailClose(true);
  await assert.rejects(f.answerClose(true), /offline/);
  assert.equal(f.closeOverlay().hooks.closeDialog.getSnapshot(), request);
  assert.equal(f.nativeTabs.size, 1);
  assert.equal(f.alerts.length, 0);
  f.setFailClose(false);
  await f.answerClose(true);
  assert.equal(f.nativeTabs.size, 0);
  assert.equal(f.closeOverlay().hooks.closeDialog.getSnapshot(), null);
  await f.cleanup();
});

test('unload cancels pending application confirmation without deleting data', async () => {
  const f = await fixture({ autoAnswer: false });
  const a = f.addTab(); await f.open(a);
  assert.throws(() => f.nativeClose(a.main, a.tab), /closing/);
  const request = f.closeOverlay().hooks.closeDialog.getSnapshot();
  await f.cleanup();
  assert.equal(f.closeOverlay().hooks.closeDialog.getSnapshot(), null);
  await assert.rejects(request.confirm(), /unavailable/);
  assert.equal(callsFor(f, 'close').length, 0);
});

test('no full-page DOM interception, restoration queue, generated identity, or abort-driven deletion', () => {
  assert.doesNotMatch(source, /document\.|restoreQueue|randomUUID|closeUi|window\.confirm/);
  assert.match(source, /local-sidebar-close-dialog::backdrop/);
  assert.match(source, /clearTimeout\(record\.timer\)/);
  assert.match(source, /registerCloseHandler\(KIND/);
  assert.match(source, /sidebar\.right\.tab\.menu\.item/);
  assert.match(source, /shell\.overlay/);
  assert.match(source, /element\.showModal\(\)/);
  assert.match(source, /tabId: tab\.contentId/);
});
