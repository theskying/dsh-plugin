import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSidebarContext } from '../context.js';

const text = value => ({ type: 'text', text: value });
const user = (value = 'sidebar question', kind = 'user') => ({ id: 'direct-message', time: 1, role: 'user', source: { kind }, content: [text(value)] });
const enter = () => ({ kind: 'enter', startsRequestSeries: true, customField: 42, messages: [user()] });
const event = (seq, value, role = 'user', kind = role === 'user' ? 'user' : 'model', surfaceOp = 'append') => {
  const message = { id: `message-${seq}`, time: seq, role, source: { kind }, content: [text(value)] };
  return { seq, time: seq, type: `${role}/message`, surfaceOp, data: role === 'user' ? message : { message } };
};
function harness(events = [event(0, 'main question'), event(2, 'main answer', 'assistant')], capturedThroughSeq = 2) {
  const state = { messages: [], events, capturedThroughSeq, reads: [], live: { seq: capturedThroughSeq + 1 } };
  const agent = { id: 'side', session: { deriveMessages: () => state.messages } };
  const services = {
    sessionQuery: { async readSurface(id) {
      state.reads.push(id);
      if (id === 'side') return { session: { id, version: 4 }, events: state.messages.map((message, seq) => ({ type: 'user/message', seq, surfaceOp: 'append', data: message })) };
      return { session: { id, version: 4 }, capturedThroughSeq: state.capturedThroughSeq, events: state.events };
    } },
    agents: { get: id => id === 'main' && state.live ? { session: state.live } : undefined },
    sessionProjections: new Proxy({}, { get() { throw new Error('Must use Session-owned deriveMessages, not a second projection'); } }),
  };
  return { state, agent, services, run: (decision = enter(), signal) => appendSidebarContext(decision, agent, 'main', services, signal) };
}
function appended(result) { return result.messages.at(-1); }
function payload(message) {
  const body = message.content[0].text;
  return JSON.parse(body.slice(body.indexOf('<sidebar-main-reference>\n') + '<sidebar-main-reference>\n'.length, body.indexOf('\n</sidebar-main-reference>')));
}
function commit(fixture, result) { fixture.state.messages.push(appended(result)); }
function assertContract(message) {
  // Golden keys follow the installed resolver's createUserMessage producer:
  // dsh-session-reference/lib/index.js:640-658 (0.2.1-rc.2).
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(message.role, 'user');
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source']);
  assert.equal(message.source.kind, 'session-reference');
  assert.equal(message.source.form, 'recall');
  assert.equal(message.source.version, 1);
  const ref = message.source.references[0];
  assert.deepEqual(Object.keys(ref).sort(), ['sessionId', 'label', 'capturedFormatVersion', 'capturedThroughSeq', 'compacted', 'originalMessages', 'retainedMessages', 'omittedMessages', 'omittedBytes', 'truncated', 'inputIndex'].sort());
  assert.equal(ref.sessionId, 'main');
  for (const key of ['capturedFormatVersion', 'originalMessages', 'retainedMessages', 'omittedMessages', 'omittedBytes', 'inputIndex']) assert.ok(Number.isSafeInteger(ref[key]) && ref[key] >= 0, key);
  for (const key of ['compacted', 'truncated']) assert.equal(typeof ref[key], 'boolean');
  assert.ok(ref.capturedThroughSeq === null || Number.isSafeInteger(ref.capturedThroughSeq));
  assert.ok(Object.isFrozen(message));
  assert.ok(Object.isFrozen(ref));
  assert.ok(Object.isFrozen(message.content[0]));
  assert.ok(message.content[0].text.length <= 12_000);
  assert.ok(Buffer.byteLength(message.content[0].text, 'utf8') <= 16 * 1024);
  assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
}

test('initial snapshot is a valid immutable reference and preserves admission fields', async () => {
  const fixture = harness();
  const decision = enter();
  const result = await fixture.run(decision);
  assert.equal(result.startsRequestSeries, true);
  assert.equal(result.customField, 42);
  assert.equal(result.messages[0], decision.messages[0]);
  assert.equal(decision.messages.length, 1);
  assert.deepEqual(fixture.state.reads, ['main']);
  assertContract(appended(result));
  assert.deepEqual(payload(appended(result)).conversation.map(row => [row.seq, row.text]), [[0, 'main question'], [2, 'main answer']]);
  assert.equal(payload(appended(result)).mode, 'initial');
});

test('rejects and non-direct steps perform no reads or mutations', async () => {
  const fixture = harness();
  for (const decision of [{ kind: 'reject' }, { kind: 'enter', messages: [user('injected', 'tool')] }, { kind: 'enter', messages: [] }]) assert.equal(await fixture.run(decision), decision);
  assert.deepEqual(fixture.state.reads, []);
});

test('committed cursor skips unchanged live main without read; only new seq enters subsequent prompt', async () => {
  const fixture = harness();
  commit(fixture, await fixture.run());
  const second = enter();
  assert.equal(await fixture.run(second), second);
  assert.deepEqual(fixture.state.reads, ['main']);
  fixture.state.events.push(event(5, 'new answer', 'assistant'));
  fixture.state.capturedThroughSeq = 6;
  fixture.state.live.seq = 7;
  const next = payload(appended(await fixture.run()));
  assert.equal(next.mode, 'incremental');
  assert.equal(next.afterSeq, 2);
  assert.deepEqual(next.conversation.map(row => row.seq), [5]);
  assert.deepEqual(fixture.state.reads, ['main', 'main']);
});

test('uncommitted preparation never advances cursor; retry after cancellation still gets context', async () => {
  const fixture = harness();
  const first = appended(await fixture.run());
  const second = appended(await fixture.run());
  assert.equal(payload(first).mode, 'initial');
  assert.deepEqual(payload(second), payload(first));
  assert.notEqual(first.id, second.id);
  const controller = new AbortController();
  fixture.services.sessionQuery.readSurface = async () => { controller.abort(); return { session: { id: 'main', version: 4 }, capturedThroughSeq: 2, events: fixture.state.events }; };
  await assert.rejects(fixture.run(enter(), controller.signal), { name: 'AbortError' });
  assert.equal(fixture.state.messages.length, 0);
  const retry = harness();
  assert.equal(payload(appended(await retry.run())).mode, 'initial');
});

test('pending read cancellation rejects promptly without waiting or publishing', async () => {
  const fixture = harness();
  let resolve;
  fixture.services.sessionQuery.readSurface = () => new Promise(done => { resolve = done; });
  const controller = new AbortController();
  const pending = fixture.run(enter(), controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve({ session: { id: 'main', version: 4 }, capturedThroughSeq: 2, events: fixture.state.events });
  assert.equal(fixture.state.messages.length, 0);
});

test('current-surface fallback recognizes native committed reference and excludes unrelated sessions', async () => {
  const fixture = harness();
  commit(fixture, await fixture.run());
  delete fixture.agent.session.deriveMessages;
  const next = enter();
  assert.equal(await fixture.run(next), next);
  assert.deepEqual(fixture.state.reads, ['main', 'side']);
  fixture.state.messages = [{ ...fixture.state.messages[0], source: { ...fixture.state.messages[0].source, references: [{ ...fixture.state.messages[0].source.references[0], sessionId: 'other' }] } }];
  assert.equal(payload(appended(await fixture.run())).mode, 'initial');
});

test('main compaction and generic positional replacements produce bounded refresh, not a stale delta', async () => {
  for (const kind of ['compact-checkpoint', 'user']) {
    const fixture = harness();
    commit(fixture, await fixture.run());
    fixture.state.events = [event(8, 'current summary', 'user', kind, { op: 'replace', startSeq: 0, endSeq: 2 }), event(9, 'fresh answer', 'assistant')];
    fixture.state.capturedThroughSeq = 9;
    fixture.state.live.seq = 10;
    const message = appended(await fixture.run());
    assertContract(message);
    assert.equal(payload(message).mode, 'refresh');
    assert.equal(payload(message).afterSeq, null);
    assert.deepEqual(payload(message).conversation.map(row => row.seq), [8, 9]);
    assert.equal(message.source.references[0].compacted, kind === 'compact-checkpoint');
  }
});

test('side compaction losing committed reference rehydrates bounded snapshot', async () => {
  const fixture = harness();
  commit(fixture, await fixture.run());
  fixture.state.messages = [user('side summary', 'compact-checkpoint')];
  assert.equal(payload(appended(await fixture.run())).mode, 'initial');
  assert.deepEqual(fixture.state.reads, ['main', 'main']);
});

test('shrunk main log does not trust an old higher watermark', async () => {
  const fixture = harness();
  commit(fixture, await fixture.run());
  fixture.state.events = [event(0, 'recovered main')];
  fixture.state.capturedThroughSeq = 0;
  fixture.state.live.seq = 1;
  const next = payload(appended(await fixture.run()));
  assert.equal(next.mode, 'refresh');
  assert.equal(next.conversation[0].text, 'recovered main');
});

test('non-live main requires surface read and still deduplicates committed context', async () => {
  const fixture = harness();
  commit(fixture, await fixture.run());
  fixture.state.live = undefined;
  const decision = enter();
  assert.equal(await fixture.run(decision), decision);
  assert.deepEqual(fixture.state.reads, ['main', 'main']);
});

test('only direct text and checkpoint text are copied, never tools/reasoning/nested references', async () => {
  const events = [event(0, 'user text'), event(1, 'assistant text', 'assistant'), event(2, 'injected reference secret', 'user', 'session-reference'), event(3, 'checkpoint text', 'user', 'compact-checkpoint'), event(4, 'system secret', 'system', 'system-prompt')];
  events[0].data.content.push({ type: 'image', attachment: { name: 'image secret' } });
  events[1].data.message.content.push({ type: 'reasoning', text: 'reasoning secret' }, { type: 'tool-call', arguments: 'tool secret' });
  events.push({ type: 'tool/result', seq: 5, data: { message: { content: [text('result secret')] } } });
  const fixture = harness(events, 5);
  const message = appended(await fixture.run());
  assert.deepEqual(payload(message).conversation.map(row => row.text), ['user text', 'assistant text', 'checkpoint text']);
  assert.doesNotMatch(message.content[0].text, /secret/);
});

test('hard char and UTF8 caps include envelope, escaped strings and omission metadata', async () => {
  for (const sample of ['x', '中', '😀', '<\n"\\']) {
    const fixture = harness(Array.from({ length: 60 }, (_, seq) => event(seq, sample.repeat(10_000))), 59);
    const message = appended(await fixture.run());
    assertContract(message);
    const data = payload(message);
    assert.ok(data.omissions.bytes > 0);
    assert.ok(data.omissions.messages > 0);
    assert.equal(data.omissions.seqs[0], 0);
    assert.ok(data.omissions.unlistedSeqCount > 0);
    assert.equal(data.conversation.at(-1).seq, 59);
    assert.ok(data.conversation.some(row => row.omittedBytes > 0));
    assert.ok(data.conversation.every(row => !row.text.includes('\uFFFD')));
    assert.equal(message.content[0].text.match(/<\/sidebar-main-reference>/g).length, 1);
  }
});

test('native same-decision reference prevents duplication but never poisons next admission', async () => {
  const fixture = harness();
  const reference = appended(await fixture.run());
  const decision = { ...enter(), messages: [user(), reference] };
  assert.equal(await fixture.run(decision), decision);
  assert.equal(fixture.state.reads.length, 1);
  assert.equal(payload(appended(await fixture.run())).mode, 'initial');
});

test('empty main emits one valid zero-content cursor and then skips unchanged session', async () => {
  const fixture = harness([], null);
  fixture.state.live.seq = 0;
  const result = await fixture.run();
  assertContract(appended(result));
  assert.deepEqual(payload(appended(result)).conversation, []);
  commit(fixture, result);
  const decision = enter();
  assert.equal(await fixture.run(decision), decision);
});

test('100000 short messages retain exact global omission statistics with bounded candidates', async () => {
  const count = 100_000;
  const fixture = harness(Array.from({ length: count }, (_, seq) => event(seq, 'x')), count - 1);
  const message = appended(await fixture.run());
  assertContract(message);
  const data = payload(message);
  const retained = data.conversation.length;
  assert.ok(retained > 0 && retained < 400);
  assert.equal(data.conversation.at(-1).seq, count - 1);
  assert.equal(data.omissions.messages, count - retained);
  assert.equal(data.omissions.bytes, count - retained);
  assert.equal(data.omissions.firstSeq, 0);
  assert.equal(data.omissions.lastSeq, count - retained - 1);
  assert.deepEqual(data.omissions.seqs, Array.from({ length: 24 }, (_, seq) => seq));
  assert.equal(data.omissions.unlistedSeqCount, count - retained - 24);
});

test('bounded candidates keep old checkpoint and correct omissions in non-seq surface order', async () => {
  const events = Array.from({ length: 2000 }, (_, seq) => event(seq, 'x'));
  events[0] = event(3000, 'summary', 'user', 'compact-checkpoint', { op: 'replace', startSeq: 0, endSeq: 0 });
  const fixture = harness(events, 3000);
  const message = appended(await fixture.run());
  assertContract(message);
  const data = payload(message);
  assert.equal(data.conversation[0].seq, 3000);
  assert.equal(data.conversation[0].checkpoint, true);
  assert.equal(data.conversation.at(-1).seq, 1999);
  assert.equal(data.omissions.firstSeq, 1);
  assert.deepEqual(data.omissions.seqs, Array.from({ length: 24 }, (_, seq) => seq + 1));
  assert.equal(data.omissions.messages, events.length - data.conversation.length);
});

test('pre-aborted admission, read failure and mismatched identity publish nothing', async () => {
  const fixture = harness();
  await assert.rejects(fixture.run(enter(), AbortSignal.abort()), { name: 'AbortError' });
  assert.deepEqual(fixture.state.reads, []);
  fixture.services.sessionQuery.readSurface = async () => { throw new Error('read failed'); };
  await assert.rejects(fixture.run(), /read failed/);
  fixture.services.sessionQuery.readSurface = async () => ({ session: { id: 'wrong', version: 4 }, capturedThroughSeq: 0, events: [] });
  await assert.rejects(fixture.run(), /identity mismatch/);
  assert.equal(fixture.state.messages.length, 0);
});
