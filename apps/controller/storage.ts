import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from '../../packages/contracts/runtime.ts';
import { sha256, newId, nowIso } from '../../packages/contracts/canonical.ts';
import { run, get } from './db.ts';

export const SESSIONS_DIR = path.join(RUNTIME_DIR, 'sessions');

export function sessionDir(sessionId: string): string {
  if (!/^ses_[0-9a-f]{12}$/.test(sessionId)) throw new Error('invalid session id');
  return path.join(SESSIONS_DIR, sessionId);
}

/** Each actor gets its own writable area inside the session. */
export function actorDir(sessionId: string, actor: string): string {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(actor)) throw new Error('invalid actor');
  const d = path.join(sessionDir(sessionId), 'files', actor);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function replayDir(sessionId: string): string {
  const d = path.join(sessionDir(sessionId), 'replay');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Resolve a path requested by an agent and check containment after normalisation.
 * Rejects traversal, absolute paths outside the root, and symlinks at any level.
 */
export function containedPath(root: string, requested: string): { ok: true; path: string } | { ok: false; reason: string } {
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const target = path.resolve(rootReal, requested);
  const rel = path.relative(rootReal, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'path_outside_workspace' };
  let cur = rootReal;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) return { ok: false, reason: 'symlink_rejected' };
  }
  return { ok: true, path: target };
}

/** Save an artifact under a controller-generated name and record its hash. */
export function saveArtifact(sessionId: string, owner: string, kind: string, label: string, fileName: string,
  content: string | Buffer, mediaType: string, committed = false) {
  const dir = actorDir(sessionId, owner);
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, content);
  const id = newId('art');
  const rel = path.relative(sessionDir(sessionId), full);
  run('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)', id, sessionId, owner, kind, label, rel, mediaType,
    sha256(content), committed ? 1 : 0, nowIso());
  return { id, rel_path: rel, sha256: sha256(content) };
}

export function readArtifact(sessionId: string, artifactId: string) {
  const a = get('SELECT * FROM artifacts WHERE id=? AND session_id=?', artifactId, sessionId);
  if (!a) return null;
  const c = containedPath(sessionDir(sessionId), a.rel_path);
  if (!c.ok) return null;
  if (!fs.existsSync(c.path)) return { meta: a, content: Buffer.alloc(0), intact: false, missing: true };
  const content = fs.readFileSync(c.path);
  return { meta: a, content, intact: sha256(content) === a.sha256, missing: false };
}

export function latestArtifact(sessionId: string, kind: string) {
  return get('SELECT * FROM artifacts WHERE session_id=? AND kind=? ORDER BY created_at DESC, rowid DESC LIMIT 1', sessionId, kind);
}
