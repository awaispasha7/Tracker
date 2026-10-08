import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../domain/types.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  bearer: string | null;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY = 1_000_000;

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$');
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  /** Returns false if no route matched (caller falls through to static files). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const auth = req.headers.authorization;
        const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
        const out = await r.handler({ req, res, params, query: url.searchParams, body, bearer });
        if (!res.writableEnded && !res.headersSent) sendJson(res, 200, out ?? { ok: true });
      } catch (e) {
        if (e instanceof AppError) {
          sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
        } else {
          console.error(`[http] ${req.method} ${url.pathname}`, e);
          if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong' } });
        }
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} not allowed` } });
      return true;
    }
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AppError(413, 'payload_too_large', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError(400, 'bad_json', 'Request body is not valid JSON');
    }
  }
  return text;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
