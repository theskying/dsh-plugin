import { lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

export const SIDEBAR_TTL_MS = 12 * 60 * 60 * 1000;
const PERMISSION_EVENTS = ['permission/preset', 'approval/policy', 'sandbox/mode'];

export function sidebarTitle(existing, mainTitle) {
  const suffix = mainTitle?.trim() ? `-${mainTitle.trim()}` : '';
  const used = new Set(existing.map(row => row.ordinal).filter(Number.isSafeInteger));
  let ordinal = 1;
  while (used.has(ordinal)) ordinal++;
  return { ordinal, title: `侧边栏${ordinal}${suffix}`.slice(0, 80) };
}

export function latestPermissionEvents(events = []) {
  return PERMISSION_EVENTS.flatMap(type => {
    const event = events.findLast(event => event.type === type);
    return event ? [event] : [];
  });
}

export function encodeSegment(raw) {
  if (!raw) throw new Error('Empty storage identity.');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

// Version-scoped JSONL maintenance adapter, matching DSH 0.2.1-rc.2's UTF-16 path encoding.
export function projectKey(cwd) {
  if (!cwd) return '_no-cwd';
  let readable = '', separator = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separator) readable += '-';
      separator = true;
    } else {
      readable += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
      separator = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

async function directoryOrAbsent(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing non-directory or symbolic link: ${path}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Explicit backend maintenance, not a portable DSH deletion API. Caller must own and release the Agent first. */
export async function deleteSidebarLog(persistence, row, { sessions, agents } = {}) {
  const id = row.sessionId;
  if (!/^sidebar-[0-9a-f-]{36}$/.test(id)) throw new Error('Refusing an unrecognized sidebar session identity.');
  if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.root !== 'string' || typeof persistence.stat !== 'function') {
    throw new Error('当前持久化后端不支持已验证的侧栏删除；清理登记已保留。');
  }
  if (sessions?.get(id) || agents?.get(id)) throw new Error('会话仍在内存中，不能删除日志。');
  const snapshot = await persistence.stat(id);
  const header = snapshot?.header;
  if (header && (header.id !== id || (row.cwd && header.cwd !== row.cwd))) throw new Error('Sidebar storage identity mismatch.');
  const cwd = header?.cwd ?? row.cwd;
  if (!cwd) throw new Error('缺少会话原始目录，拒绝猜测删除路径。');
  const root = await realpath(resolve(persistence.root));
  const project = join(root, projectKey(cwd));
  const target = join(project, encodeSegment(id));
  if (dirname(dirname(target)) !== root) throw new Error('Invalid sidebar storage target.');
  if (!await directoryOrAbsent(project)) {
    if (snapshot) throw new Error('Stored sidebar has no expected project directory.');
    return;
  }
  if (!await directoryOrAbsent(target)) {
    if (snapshot) throw new Error('Stored sidebar has no expected session directory.');
    return;
  }
  if (await realpath(project) !== project || await realpath(target) !== target) throw new Error('Sidebar path changed while resolving.');
  // Claim the backend writer lease to refuse another process/owner, without appending any events.
  const lease = snapshot ? await persistence.open(id, 'write') : undefined;
  try {
    if (sessions?.get(id) || agents?.get(id)) throw new Error('Sidebar was reactivated during cleanup.');
    await rm(target, { recursive: true, force: false });
  } finally { await lease?.close(); }
  if (await persistence.stat(id)) throw new Error('Sidebar log remains visible after cleanup.');
}
