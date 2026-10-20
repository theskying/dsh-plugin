window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-chat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-sidebar-chat';
    const KIND = 'local-sidebar-chat';
    const CHILD = 'local.sidebar-chat.conversation';
    const NS = 'localSidebarChat';
    // DSH 0.2.1-rc.2 renders Branch inside its native action row, without an action Slot.
    // Keep the native row intact; this presentation rule applies only within our own panel.
    const panelCss = '[data-local-sidebar-chat] button[aria-label="在新对话中分支"], [data-local-sidebar-chat] button[aria-label="Branch into a new conversation"] { display: none; }';
    const rootStyle = { display: 'flex', flexDirection: 'column', flex: '1 1 0', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' };
    // The native scrollport measures these two variables, including input/dock resize.
    // Keep a full message area even before conversation.session has anything to render.
    const messagesStyle = {
      display: 'flex', flexDirection: 'column', flex: '1 0 auto', minWidth: 0,
      minHeight: 'max(0px, calc(var(--dsh-conversation-viewport-height, 0px) - var(--dsh-composer-height, 0px)))',
    };
    const errorStyle = { padding: 20, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 };
    const retryStyle = {
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
      padding: '6px 12px', font: 'inherit', cursor: 'pointer',
    };

    // Original artwork shared with this bundle's icon, not a private UI import.
    function SidebarGlyph({ size = 22, className }) {
      return h('svg', { viewBox: '0 0 64 64', width: size, height: size, className, 'aria-hidden': true },
        h('rect', { x: 8, y: 10, width: 48, height: 42, rx: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 3 }),
        h('path', { d: 'M37 16v30M16 22h14M16 29h14M16 36h9M44 23h5M44 30h5M44 37h5M13 46v10l13-7', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function FixedChatView({ renderSlot }) {
      return h('div', { style: messagesStyle, 'data-local-sidebar-messages': '' },
        renderSlot('conversation.session', { view: 'chat' }));
    }

    // This entry is rendered below the explicit side-Session Provider.
    const emptyStyle = { position: 'absolute', left: 24, right: 24, top: 0, bottom: 168, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', pointerEvents: 'none', color: 'var(--dsw-alias-label-secondary)' };
    function SideConversation({ useSession, renderFactorySlot }) {
      const loading = useSession(session => session.openState === 'loading');
      const blank = useSession(session => session.blank && !session.running && session.openState !== 'loading');
      return h('div', { style: { position: 'relative', display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 } },
        blank ? h('div', { style: emptyStyle },
          h('div', { style: { width: 28, height: 28, border: '1.5px solid currentColor', borderRadius: 999, display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-tertiary)' } }, '+'),
          h('strong', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 16, fontWeight: 600 } }, '侧边栏对话'),
          h('p', { style: { maxWidth: 280, margin: 0, fontSize: 13, lineHeight: '20px' } }, '临时对话，关闭后无法恢复，最多保留 12 小时。')) : null,
        renderFactorySlot('conversation.content', {
          variant: 'embedded', phase: loading ? 'settling' : 'active', hero: false,
        }, { slots: { views: FixedChatView } }));
    }

    // Native tab ids are session-local; contentId is persisted by the native layout.
    const identity = (mainSessionId, contentId) => JSON.stringify([mainSessionId, contentId]);
    function createTabSessions(ctx, t, closeDialog) {
      const records = new Map();
      const lists = new Map();
      const listeners = new Set();
      const lifetime = new AbortController();
      let titles = new Map();
      let disposed = false;
      const publish = () => { for (const listener of listeners) listener(); };
      const rpc = async (action, request) => {
        const result = await ctx.connection.rpc.call('/api', `sidebarChat/${action}`, { args: { request } }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]));
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      const recordFor = (mainSessionId, tab) => {
        if (disposed) throw new Error(t('unavailable'));
        if (!mainSessionId || typeof tab.contentId !== 'string' || !tab.contentId) throw new Error(t('invalidResponse'));
        const key = identity(mainSessionId, tab.contentId);
        let record = records.get(key);
        if (!record) {
          record = { key, request: { mainSessionId, tabId: tab.contentId }, row: null, pending: null, closing: null, closed: false, closeError: null, timer: null, expiresAt: null, bindings: new Set() };
          records.set(key, record);
        }
        return record;
      };
      const accept = (record, row) => {
        if (!row || row.mainSessionId !== record.request.mainSessionId || row.tabId !== record.request.tabId || typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId === row.mainSessionId) throw new Error(t('invalidResponse'));
        if (!disposed && !record.closed && records.get(record.key) === record) {
          record.row = row;
          scheduleExpiry(record, row.expiresAt);
          titles = new Map(titles).set(record.key, row);
          publish();
        }
        return row;
      };
      const requestFor = record => ({ ...record.request, ...(record.row ? { sessionId: record.row.sessionId } : {}) });
      const hydrate = mainSessionId => {
        if (lists.has(mainSessionId)) return lists.get(mainSessionId);
        const pending = rpc('list', { mainSessionId }).then(rows => {
          if (!Array.isArray(rows)) throw new Error(t('invalidResponse'));
          return rows;
        }).catch(error => { lists.delete(mainSessionId); throw error; });
        lists.set(mainSessionId, pending);
        return pending;
      };
      const clearExpiry = record => {
        if (record.timer !== null) clearTimeout(record.timer);
        record.timer = null;
      };
      const nativeTab = record => ctx.sidebarRight.openTabs.getSnapshot().find(item => item.sessionId === record.request.mainSessionId && item.contentId === record.request.tabId && item.kind === KIND);
      function armExpiry(record, delay) {
        clearExpiry(record);
        record.timer = setTimeout(() => {
          record.timer = null;
          if (disposed || record.closed) return;
          const tab = nativeTab(record);
          if (tab) void startClose(record, { id: tab.tabId, contentId: tab.contentId }, true);
        }, delay);
      }
      function scheduleExpiry(record, expiresAt) {
        if (!Number.isFinite(expiresAt) || record.closed || (record.timer !== null && record.expiresAt === expiresAt)) return;
        record.expiresAt = expiresAt;
        armExpiry(record, Math.max(0, expiresAt - Date.now()));
      }
      const prune = () => {
        const present = new Set(ctx.sidebarRight.openTabs.getSnapshot().filter(tab => tab.kind === KIND).map(tab => identity(tab.sessionId, tab.contentId)));
        let changed = false;
        for (const [key, record] of records) {
          if (present.has(key) || record.closing) continue;
          records.delete(key);
          closeDialog.dismissKey(key);
          clearExpiry(record);
          for (const release of [...record.bindings]) release();
          if (titles.has(key)) { titles = new Map(titles); titles.delete(key); changed = true; }
        }
        if (changed) publish();
      };
      function startClose(record, tab, expired = false) {
        if (record.closing) return record.closing;
        const alreadyReported = record.closeError !== null;
        record.closing = Promise.resolve().then(async () => {
          // Serialize with an in-flight open without creating an unvisited Session.
          await record.pending?.catch(() => {});
          if (disposed) return;
          const { mainSessionId } = record.request;
          const result = await rpc('close', requestFor(record));
          if (result?.closed !== true || result.mainSessionId !== mainSessionId || result.tabId !== tab.contentId) throw new Error(t('invalidResponse'));
          record.closed = true;
          record.closeError = null;
          clearExpiry(record);
          if (disposed) return;
          const targets = ctx.sidebarRight.openTabs.getSnapshot().filter(item => item.sessionId === mainSessionId && item.contentId === tab.contentId && item.kind === KIND && (expired || item.tabId === tab.id));
          for (const target of targets) {
            const binding = [...record.bindings].find(item => item.tab.id === target.tabId && !item.tab.signal.aborted);
            if (binding) binding.tab.actions.close();
            else if (ctx.sidebarRight.mounted.getSnapshot() === mainSessionId) ctx.sidebarRight.close(target.tabId);
          }
          // An unmounted background occurrence has no public bound action. Keep its
          // acknowledgement until it binds or closes again; never target another Session.
        }).catch(error => {
          record.closeError = error;
          if (!disposed) {
            if (expired && !alreadyReported) window.alert(t('closeFailed', { reason: error instanceof Error ? error.message : String(error) }));
            if (!record.closed && (expired || (Number.isFinite(record.expiresAt) && record.expiresAt <= Date.now())) && nativeTab(record)) armExpiry(record, 60000);
          }
        }).finally(() => { record.closing = null; if (!disposed) prune(); });
        return record.closing;
      }
      const unsubscribe = ctx.sidebarRight.openTabs.subscribe(prune);
      return {
        // Titles mount even for unvisited bodies. Capture session-bound actions, not foreground close.
        bind(mainSessionId, tab) {
          const record = recordFor(mainSessionId, tab);
          const release = () => { record.bindings.delete(release); tab.signal.removeEventListener('abort', release); };
          release.tab = tab;
          record.bindings.add(release);
          if (tab.signal.aborted) release();
          else tab.signal.addEventListener('abort', release, { once: true });
          if (record.closed) {
            void Promise.resolve().then(() => {
              if (!disposed && record.bindings.has(release) && !tab.signal.aborted) tab.actions.close();
            }).catch(error => { if (!disposed) window.alert(String(error?.message || error)); });
          }
          void hydrate(mainSessionId).then(async rows => {
            // Exact matches only: older random tab associations cannot be reconstructed.
            if (disposed || record.row || record.closed || record.closing || records.get(record.key) !== record || !nativeTab(record)) return;
            const row = rows.find(item => item.mainSessionId === mainSessionId && item.tabId === tab.contentId);
            if (row) { accept(record, row); return; }
            const status = await rpc('status', record.request);
            if (disposed || record.closed || record.closing || records.get(record.key) !== record || !nativeTab(record)) return;
            if (status?.state === 'active') {
              if (!record.row) accept(record, status.row);
            } else if (status?.state === 'creating' || status?.row?.state === 'creating') {
              // The body owns the in-flight open. Creation must never trigger
              // automatic cleanup, including replies from an older Host.
              return;
            } else if (status?.state === 'closing' || status?.state === 'closed') {
              if (status.row) accept(record, status.row);
              void startClose(record, tab, true);
            }
            // 'unknown' preserves legacy associations; absence is not proof of expiry.
          }).catch(() => {}); // A title read never creates a Session.
          return release;
        },
        async open(mainSessionId, tab, signal) {
          signal.throwIfAborted();
          tab.signal.throwIfAborted();
          const record = recordFor(mainSessionId, tab);
          if (record.closed || record.closing) throw new Error(t('closePending'));
          if (!record.pending) record.pending = rpc('open', record.request).then(row => accept(record, row)).catch(error => { record.pending = null; throw error; });
          const row = await record.pending;
          signal.throwIfAborted();
          tab.signal.throwIfAborted();
          if (disposed || record.closed || record.closing) throw new Error(t('closePending'));
          return ctx.sessions.retain(row.sessionId, { source: 'sidebarChat', signal });
        },
        beforeClose(mainSessionId, tab) {
          const record = recordFor(mainSessionId, tab);
          if (record.closed) return; // One already-confirmed, acknowledged close may now commit.
          if (record.closing) throw new Error(t('closePending'));
          closeDialog.open({
            key: record.key,
            confirm: async () => {
              if (disposed || records.get(record.key) !== record || !nativeTab(record)) throw new Error(t('unavailable'));
              await startClose(record, tab);
              if (record.closeError) throw record.closeError;
            },
          });
          // The native handler is synchronous; the app dialog keeps the tab in
          // place until the user confirms and the Host acknowledges cleanup.
          throw new Error(t('closePending'));
        },
        async rename(mainSessionId, tab, title) {
          const record = recordFor(mainSessionId, tab);
          if (record.closed || record.closing) throw new Error(t('closePending'));
          await record.pending;
          if (disposed || record.closed || record.closing) throw new Error(t('closePending'));
          return accept(record, await rpc('rename', { ...requestFor(record), title }));
        },
        titles: { getSnapshot: () => titles, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
        dispose() {
          disposed = true;
          lifetime.abort();
          unsubscribe();
          for (const record of records.values()) {
            clearExpiry(record);
            for (const release of [...record.bindings]) release();
          }
          records.clear(); lists.clear(); titles = new Map(); listeners.clear();
        },
      };
    }

    function SideTitle({ sessionId, useTabInfo, useSidebarTitles, bindSide, t }) {
      const { tab } = useTabInfo();
      const title = useSidebarTitles(titles => titles.get(identity(sessionId, tab.contentId))?.title) || t('shortTitle');
      React.useLayoutEffect(() => bindSide(tab), [bindSide, tab.id, tab.contentId, tab.signal, tab.actions]);
      return h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title);
    }

    function createCloseDialog() {
      const listeners = new Set();
      let current = null;
      const publish = () => { for (const listener of listeners) listener(); };
      return {
        source: { getSnapshot: () => current, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
        open(request) { if (current) return; current = request; publish(); },
        close(request) { if (current === request) { current = null; publish(); } },
        dismissKey(key) { if (current?.key === key) { current = null; publish(); } },
        dispose() { current = null; publish(); listeners.clear(); },
      };
    }

    function CloseOverlay({ useCloseDialog, dismissClose, t }) {
      const request = useCloseDialog(value => value);
      return request ? h(CloseDialog, { key: request.key, request, dismissClose, t }) : null;
    }

    function CloseDialog({ request, dismissClose, t }) {
      const dialog = React.useRef(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const inFlight = React.useRef(false);
      const alive = React.useRef(true);
      const titleId = React.useId();
      const detailId = React.useId();
      React.useLayoutEffect(() => {
        alive.current = true;
        const element = dialog.current;
        element.showModal();
        return () => { alive.current = false; element.close(); };
      }, []);
      const cancel = () => { if (!inFlight.current) dismissClose(request); };
      const confirm = async () => {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setError('');
        try { await request.confirm(); if (alive.current) dismissClose(request); }
        catch (reason) { if (alive.current) setError(t('closeFailed', { reason: reason instanceof Error ? reason.message : String(reason) })); }
        finally { inFlight.current = false; if (alive.current) setBusy(false); }
      };
      return h(React.Fragment, null,
        h('style', null, '.local-sidebar-close-dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}.local-sidebar-close-dialog button:disabled{opacity:.55;cursor:wait}'),
        h('dialog', { ref: dialog, className: 'local-sidebar-close-dialog', 'aria-labelledby': titleId, 'aria-describedby': detailId, 'aria-modal': true, 'aria-busy': busy,
          style: { pointerEvents: 'auto', width: 360, maxWidth: 'calc(100vw - 48px)', boxSizing: 'border-box', padding: 24, borderRadius: 16, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
          onCancel: event => { event.preventDefault(); cancel(); },
        },
        h('h2', { id: titleId, style: { margin: '0 0 12px', fontSize: 18, fontWeight: 600 } }, t('closeTitle')),
        h('p', { id: detailId, style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 14, lineHeight: 1.6 } }, t('closeDescription')),
        error ? h('p', { role: 'alert', style: { margin: '12px 0 0', color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 } },
          h('button', { type: 'button', autoFocus: true, disabled: busy, style: { ...retryStyle, padding: '8px 16px' }, onClick: cancel }, t('cancel')),
          h('button', { type: 'button', disabled: busy, style: { ...retryStyle, padding: '8px 16px', color: 'var(--dsw-alias-state-error-primary)', borderColor: 'var(--dsw-alias-state-error-primary)' }, onClick: confirm }, t(busy ? 'closeWorking' : 'closeDelete')))));
    }

    function createRenameDialog() {
      const listeners = new Set();
      let current = null;
      const publish = () => { for (const listener of listeners) listener(); };
      return {
        source: { getSnapshot: () => current, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
        open(request) { current = request; publish(); },
        close(request) { if (current === request) { current = null; publish(); } },
        dispose() { current = null; publish(); listeners.clear(); },
      };
    }

    function RenameMenuItem({ sessionId, tab, dismiss, useSidebarTitles, showRename, t }) {
      const title = useSidebarTitles(titles => titles.get(identity(sessionId, tab.contentId))?.title) || t('shortTitle');
      if (tab.kind !== KIND) return null;
      return h(React.Fragment, null,
        h('style', null, '.local-sidebar-menu-item{display:block;width:100%;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:8px 12px;font:inherit;text-align:left;cursor:pointer}.local-sidebar-menu-item:hover,.local-sidebar-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}'),
        h('button', { type: 'button', role: 'menuitem', className: 'local-sidebar-menu-item', onClick: () => {
          dismiss();
          showRename({ mainSessionId: sessionId, tab, title });
        } }, t('rename')));
    }

    function RenameOverlay({ useRenameDialog, closeRename, renameSide, t }) {
      const request = useRenameDialog(value => value);
      return request ? h(RenameDialog, { key: identity(request.mainSessionId, request.tab.contentId), request, closeRename, renameSide, t }) : null;
    }

    // The verified root shell.overlay owns this native HTML dialog. showModal supplies
    // focus containment, inert background and Escape; no document capture or private UI imports.
    function RenameDialog({ request, closeRename, renameSide, t }) {
      const dialog = React.useRef(null);
      const [draft, setDraft] = React.useState(request.title);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      React.useLayoutEffect(() => {
        const element = dialog.current;
        element.showModal();
        return () => element.close();
      }, []);
      const close = () => { if (!busy) closeRename(request); };
      return h('dialog', { ref: dialog, 'aria-label': t('rename'), 'aria-modal': true, style: { width: 280, maxWidth: 'calc(100vw - 48px)', padding: 20, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }, onCancel: event => { event.preventDefault(); close(); } },
        h('form', { style: { display: 'grid', gap: 12 }, onSubmit: event => {
          event.preventDefault();
          if (busy) return;
          setBusy(true); setError('');
          renameSide(request.mainSessionId, request.tab, draft).then(() => closeRename(request), reason => {
            setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false);
          });
        } },
        h('strong', null, t('rename')),
        h('input', { value: draft, autoFocus: true, disabled: busy, maxLength: 80, 'aria-label': t('rename'), onChange: event => setDraft(event.target.value), style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 8, background: 'transparent', color: 'inherit' } }),
        error ? h('span', { role: 'alert', style: { fontSize: 12 } }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h('button', { type: 'button', disabled: busy, style: retryStyle, onClick: close }, t('cancel')),
          h('button', { type: 'submit', disabled: busy || !draft.trim(), style: retryStyle }, t('save')))));
    }

    // View ownership only: Session data still comes from the native Controller.
    function createEditorOwners() {
      const candidates = new Map();
      const listeners = new Set();
      let snapshot = new Map();
      const publish = () => {
        const next = new Map([...candidates].map(([id, entries]) => [id, entries.values().next().value]));
        if (next.size === snapshot.size && [...next].every(([id, owner]) => snapshot.get(id) === owner)) return;
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      return {
        source: {
          getSnapshot: () => snapshot,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        },
        claim(sessionId, owner) {
          let entries = candidates.get(sessionId);
          if (!entries) { entries = new Map(); candidates.set(sessionId, entries); }
          entries.set(owner.token, owner);
          publish();
          return () => {
            entries.delete(owner.token);
            if (entries.size === 0) candidates.delete(sessionId);
            publish();
          };
        },
        dispose() { candidates.clear(); publish(); listeners.clear(); },
      };
    }

    function EditorHost({ reference, mainSessionId, tabId, SessionProvider, renderSlot, useSessionRetainInfo, useEditorOwners, claimEditor, focusEditor, t }) {
      const token = React.useRef(Symbol('sidebar-editor')).current;
      const [focusError, setFocusError] = React.useState(false);
      const owner = useEditorOwners(owners => owners.get(reference.sessionId));
      const inMain = useSessionRetainInfo(reference.sessionId, info => (info?.retainedBy?.mainView ?? 0) > 0);
      React.useLayoutEffect(() => claimEditor(reference.sessionId, { token, mainSessionId, tabId }), [reference, token, mainSessionId, tabId, claimEditor]);
      React.useEffect(() => { setFocusError(false); }, [owner, inMain]);
      if (inMain) return h('p', { style: errorStyle, role: 'status' }, t('inMain'));
      if (owner === undefined) return null;
      if (owner.token !== token) return h('div', { style: errorStyle },
        h('p', { role: focusError ? 'alert' : 'status' }, t(focusError ? 'focusUnavailable' : 'inOtherPane')),
        h('button', { type: 'button', style: retryStyle, onClick: () => {
          try { setFocusError(!focusEditor(owner)); } catch { setFocusError(true); }
        } }, t('focus')));
      return h(SessionProvider, { session: reference }, renderSlot(CHILD, {}));
    }

    function SidebarTab(props) {
      const { sessionId, useTabInfo, openSide, t } = props;
      const { tab } = useTabInfo();
      const [state, setState] = React.useState({ reference: null, error: null });
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        let reference;
        if (tab.signal.aborted) controller.abort();
        else tab.signal.addEventListener('abort', abort, { once: true });
        setState({ reference: null, error: null });
        if (!controller.signal.aborted) {
          openSide(tab, controller.signal).then(async held => {
            reference = held;
            if (controller.signal.aborted) { held.release(); return; }
            const binding = await held.ready;
            if (controller.signal.aborted) return;
            if (binding.session.getSnapshot().openState === 'error') throw new Error(t('historyFailed'));
            setState({ reference: held, error: null });
          }).catch(error => {
            reference?.release();
            if (!controller.signal.aborted) setState({ reference: null, error: error instanceof Error ? error.message : String(error) });
          });
        }
        return () => {
          controller.abort();
          tab.signal.removeEventListener('abort', abort);
          reference?.release();
        };
      }, [sessionId, tab.signal, openSide, attempt]);

      return h('div', { style: rootStyle, 'data-local-sidebar-chat': '', 'aria-busy': state.reference === null && state.error === null },
        h('style', null, panelCss),
        state.error !== null
          ? h('div', { style: errorStyle },
              h('p', { role: 'alert' }, t('openFailed', { reason: state.error })),
              h('button', { type: 'button', style: retryStyle, onClick: () => setAttempt(value => value + 1) }, t('retry')))
          : state.reference === null ? null
          : h(EditorHost, { ...props, reference: state.reference, mainSessionId: sessionId, tabId: tab.id }));
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            title: '侧边栏对话', openFailed: '无法打开侧边栏对话：{reason}', historyFailed: '无法读取会话记录。',
            invalidResponse: '返回的侧边栏会话身份无效。', retry: '重试', inMain: '已在主区打开。',
            inOtherPane: '已在另一侧栏打开。', focus: '前往', focusUnavailable: '原侧栏当前不可用。',
            shortTitle: '侧边栏', rename: '重命名', cancel: '取消', save: '保存', unavailable: '侧栏当前不可用。',
            closeTitle: '关闭侧边栏对话？', closeDescription: '关闭后无法恢复，也无法再引用。', closeDelete: '关闭并删除', closeWorking: '正在删除…',
            closePending: '正在关闭侧栏。', closeCancelled: '已取消关闭。', closeFailed: '关闭失败，侧栏已保留，请重试：{reason}',
          },
          en: {
            title: 'Side conversation', openFailed: 'Could not open side conversation: {reason}', historyFailed: 'Could not read the conversation history.',
            invalidResponse: 'The returned side-conversation identity is invalid.', retry: 'Retry', inMain: 'Already open in the main conversation area.',
            inOtherPane: 'Already open in another sidebar pane.', focus: 'Go to conversation', focusUnavailable: 'The original sidebar pane is unavailable.',
            shortTitle: 'Sidebar', rename: 'Rename', cancel: 'Cancel', save: 'Save', unavailable: 'Sidebar is unavailable.',
            closeTitle: 'Close side conversation?', closeDescription: 'It cannot be restored or referenced after closing.', closeDelete: 'Close and delete', closeWorking: 'Deleting…',
            closePending: 'The sidebar is closing.', closeCancelled: 'Close cancelled.', closeFailed: 'Could not close; the tab was kept. Retry: {reason}',
          },
        }));
        const t = ctx.locale.bind(NS);
        const editors = createEditorOwners();
        const closeDialog = createCloseDialog();
        const tabSessions = createTabSessions(ctx, t, closeDialog);
        const renameDialog = createRenameDialog();
        ctx.effect(() => () => closeDialog.dispose());
        ctx.effect(() => () => tabSessions.dispose());
        ctx.effect(() => () => renameDialog.dispose());
        ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (mainSessionId, tab) => tabSessions.beforeClose(mainSessionId, tab)));
        ctx.effect(() => () => editors.dispose());
        const claimEditor = (sessionId, owner) => editors.claim(sessionId, owner);
        const focusEditor = owner => {
          if (ctx.sidebarRight.mounted.getSnapshot() !== owner.mainSessionId ||
              !ctx.sidebarRight.openTabs.getSnapshot().some(tab => tab.sessionId === owner.mainSessionId && tab.tabId === owner.tabId)) return false;
          ctx.sidebarRight.focus(owner.tabId);
          return true;
        };
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID, kind: KIND, keepMounted: true, multiple: true,
          title: () => t('title'),
          guide: [{ id: 'open', order: 70, title: () => t('title'), icon: SidebarGlyph }],
        }));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: ID, locale: NS,
          children: { [CHILD]: { kind: 'single', scope: 'session' } },
          inject: mainSessionId => ({
            hooks: { editorOwners: editors.source },
            claimEditor, focusEditor,
            openSide: (tab, signal) => tabSessions.open(mainSessionId, tab, signal),
          }),
        }, SidebarTab));
        ctx.slots.inject(CHILD, () => ctx.slots.register({ name: CHILD }, SideConversation));
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: ID, locale: NS,
          inject: mainSessionId => ({
            hooks: { sidebarTitles: tabSessions.titles },
            bindSide: tab => tabSessions.bind(mainSessionId, tab),
          }),
        }, SideTitle));
        ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
          name: 'sidebar.right.tab.menu.item', id: `${ID}/rename`, locale: NS,
          inject: () => ({ hooks: { sidebarTitles: tabSessions.titles }, showRename: request => renameDialog.open(request) }),
        }, RenameMenuItem));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: `${ID}/rename-dialog`, locale: NS,
          inject: () => ({
            hooks: { renameDialog: renameDialog.source },
            closeRename: request => renameDialog.close(request),
            renameSide: (mainSessionId, tab, title) => tabSessions.rename(mainSessionId, tab, title),
          }),
        }, RenameOverlay));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: `${ID}/close-dialog`, locale: NS,
          inject: () => ({ hooks: { closeDialog: closeDialog.source }, dismissClose: request => closeDialog.close(request) }),
        }, CloseOverlay));

      },
    };
  },
});
