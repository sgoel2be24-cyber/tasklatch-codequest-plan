import { get, all, run } from './db.ts';
import { nowIso } from '../../packages/contracts/canonical.ts';

export function loadSession(id: string) {
  const s = get('SELECT * FROM sessions WHERE id=?', id);
  if (!s) return null;
  return { ...s, request: JSON.parse(s.request), scope: JSON.parse(s.scope), plan: JSON.parse(s.plan), outcome: s.outcome ? JSON.parse(s.outcome) : null };
}

export function setWorker(sessionId: string, workerId: string, f: { status?: string; activity?: string; current_url?: string | null; last_screenshot?: string | null }) {
  const cur = get('SELECT * FROM workers WHERE session_id=? AND worker_id=?', sessionId, workerId);
  if (!cur) return;
  run('UPDATE workers SET status=?, activity=?, current_url=?, last_screenshot=?, updated_at=? WHERE session_id=? AND worker_id=?',
    f.status ?? cur.status, f.activity ?? cur.activity, f.current_url !== undefined ? f.current_url : cur.current_url,
    f.last_screenshot !== undefined && f.last_screenshot !== null ? f.last_screenshot : cur.last_screenshot, nowIso(), sessionId, workerId);
}

export function setTask(taskId: string, status: string, detail?: string) {
  run('UPDATE tasks SET status=?, detail=COALESCE(?, detail), updated_at=? WHERE id=?', status, detail ?? null, nowIso(), taskId);
}

export function tasksFor(sessionId: string) {
  return all('SELECT * FROM tasks WHERE session_id=? ORDER BY ord', sessionId).map(t => ({ ...t, source_ids: t.source_ids ? JSON.parse(t.source_ids) : [] }));
}
