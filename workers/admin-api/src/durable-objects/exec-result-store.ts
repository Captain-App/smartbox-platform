/**
 * ExecResultStore Durable Object
 * 
 * Persists exec command results using the DO SQLite storage API.
 * Uses sql.exec() — the only SQL method available on DO SqlStorage.
 */

interface ExecResult {
  execId: string;
  userId: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

const EXEC_RESULT_TTL_HOURS = 24;
const EXEC_MAX_RESULTS_PER_USER = 100;

import { DurableObject } from 'cloudflare:workers';

export class ExecResultStore extends DurableObject {
  private sql: SqlStorage;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS exec_results (
        exec_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT DEFAULT '',
        stderr TEXT DEFAULT '',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_er_user ON exec_results(user_id, created_at DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_er_status ON exec_results(status, created_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_er_expires ON exec_results(expires_at)`);
    this.initialized = true;
  }

  async create(execId: string, userId: string, command: string, metadata?: Record<string, unknown>): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (EXEC_RESULT_TTL_HOURS * 3600);
    const startedAt = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO exec_results (exec_id, user_id, command, status, started_at, metadata, expires_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      execId, userId, command, startedAt, metadata ? JSON.stringify(metadata) : null, expiresAt
    );

    this.cleanupUserResults(userId);
  }

  async update(execId: string, updates: Partial<ExecResult>): Promise<void> {
    const fieldMap: Record<string, string> = {
      status: 'status',
      exitCode: 'exit_code',
      stdout: 'stdout',
      stderr: 'stderr',
      completedAt: 'completed_at',
      error: 'error',
    };

    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${dbField} = ?`);
        const value = updates[key as keyof ExecResult];
        values.push(value === undefined ? null : value as string | number);
      }
    }

    if (sets.length === 0) return;

    values.push(execId);
    this.sql.exec(`UPDATE exec_results SET ${sets.join(', ')} WHERE exec_id = ?`, ...values);
  }

  async get(execId: string): Promise<ExecResult | null> {
    const rows = this.sql.exec(
      `SELECT exec_id, user_id, command, status, exit_code, stdout, stderr,
              started_at, completed_at, error, metadata
       FROM exec_results WHERE exec_id = ?`, execId
    ).toArray();

    if (rows.length === 0) return null;
    return this.rowToResult(rows[0]);
  }

  async list(userId?: string, limit = 50): Promise<ExecResult[]> {
    const rows = userId
      ? this.sql.exec(
          `SELECT exec_id, user_id, command, status, exit_code, stdout, stderr,
                  started_at, completed_at, error, metadata
           FROM exec_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, userId, limit
        ).toArray()
      : this.sql.exec(
          `SELECT exec_id, user_id, command, status, exit_code, stdout, stderr,
                  started_at, completed_at, error, metadata
           FROM exec_results ORDER BY created_at DESC LIMIT ?`, limit
        ).toArray();

    return rows.map(r => this.rowToResult(r));
  }

  async cleanup(olderThanHours = EXEC_RESULT_TTL_HOURS): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - (olderThanHours * 3600);
    const cursor = this.sql.exec(`DELETE FROM exec_results WHERE expires_at < ? OR created_at < ?`, cutoff, cutoff);
    return cursor.rowsWritten;
  }

  private cleanupUserResults(userId: string): void {
    const countRow = this.sql.exec(`SELECT COUNT(*) as count FROM exec_results WHERE user_id = ?`, userId).one() as { count: number };
    if (countRow.count <= EXEC_MAX_RESULTS_PER_USER) return;

    this.sql.exec(
      `DELETE FROM exec_results WHERE exec_id IN (
         SELECT exec_id FROM exec_results WHERE user_id = ?
         ORDER BY created_at DESC LIMIT -1 OFFSET ?
       )`, userId, EXEC_MAX_RESULTS_PER_USER
    );
  }

  async getStats() {
    const total = (this.sql.exec(`SELECT COUNT(*) as c FROM exec_results`).one() as { c: number }).c;
    const running = (this.sql.exec(`SELECT COUNT(*) as c FROM exec_results WHERE status = 'running'`).one() as { c: number }).c;
    const completed = (this.sql.exec(`SELECT COUNT(*) as c FROM exec_results WHERE status = 'completed'`).one() as { c: number }).c;
    const errored = (this.sql.exec(`SELECT COUNT(*) as c FROM exec_results WHERE status = 'error'`).one() as { c: number }).c;
    const users = (this.sql.exec(`SELECT COUNT(DISTINCT user_id) as c FROM exec_results`).one() as { c: number }).c;

    return { totalResults: total, runningCount: running, completedCount: completed, errorCount: errored, uniqueUsers: users };
  }

  private rowToResult(row: Record<string, unknown>): ExecResult {
    return {
      execId: row.exec_id as string,
      userId: row.user_id as string,
      command: row.command as string,
      status: row.status as ExecResult['status'],
      exitCode: row.exit_code != null ? row.exit_code as number : undefined,
      stdout: (row.stdout as string) || '',
      stderr: (row.stderr as string) || '',
      startedAt: row.started_at as string,
      completedAt: row.completed_at ? row.completed_at as string : undefined,
      error: row.error ? row.error as string : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (path === '/create' && request.method === 'POST') {
        const body = await request.json() as { execId: string; userId: string; command: string; metadata?: Record<string, unknown> };
        await this.create(body.execId, body.userId, body.command, body.metadata);
        return json({ success: true });
      }

      if (path === '/update' && request.method === 'POST') {
        const body = await request.json() as { execId: string; updates: Partial<ExecResult> };
        await this.update(body.execId, body.updates);
        return json({ success: true });
      }

      if (path.startsWith('/get/') && request.method === 'GET') {
        const execId = path.slice(5);
        const result = await this.get(execId);
        return result ? json(result) : json({ error: 'Not found' }, 404);
      }

      if (path === '/list' && request.method === 'GET') {
        const userId = url.searchParams.get('userId') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        return json(await this.list(userId, limit));
      }

      if (path === '/cleanup' && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as { hours?: number };
        return json({ deleted: await this.cleanup(body.hours) });
      }

      if (path === '/stats' && request.method === 'GET') {
        return json(await this.getStats());
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }
}
