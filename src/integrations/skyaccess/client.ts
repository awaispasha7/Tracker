// SkyAccess MCP client: https://mcp.skyaccess.com/mcp
//
// SkyAccess publishes its empty-leg marketplace as a public MCP server (Streamable HTTP,
// stateless, no auth). This is a minimal JSON-RPC client for it, with no SDK dependency:
//   - every request is a standalone POST (the server issues no session id);
//   - replies are read as plain JSON or as a single SSE `message` event, whichever comes back;
//   - tool results are read from `structuredContent` when present, else from JSON in the text
//     content, else kept as text;
//   - 429 / JSON-RPC -32029 becomes a `rate_limited` error carrying the reset time, so callers
//     can tell travelers to retry instead of failing silently.
//
// Limits the server enforces per client IP: 30 tool calls / minute, 10 request_booking / hour.

import type { FetchLike } from '../aviapages/client.ts';

export const SKYACCESS_ENDPOINT = 'https://mcp.skyaccess.com/mcp';
export const PROTOCOL_VERSION = '2025-06-18';

export type SkyAccessTool = 'search_empty_legs' | 'get_flight' | 'booking_handoff' | 'get_charter_estimate' | 'request_booking';

export interface SkyAccessConfig {
  endpoint: string;
  timeoutMs: number;
  /** Sent as clientInfo and User-Agent so SkyAccess can identify the integration. */
  clientName: string;
  clientVersion: string;
}

export const DEFAULT_SKYACCESS: SkyAccessConfig = {
  endpoint: SKYACCESS_ENDPOINT,
  timeoutMs: 20_000,
  clientName: 'emptyleg-tracker',
  clientVersion: '0.1.0',
};

export class SkyAccessError extends Error {
  code: 'rate_limited' | 'tool_error' | 'protocol' | 'http' | 'timeout' | 'network';
  status: number | null;
  /** Seconds until the rate-limit window resets (rate_limited only). */
  retryAfterS: number | null;
  constructor(code: SkyAccessError['code'], message: string, status: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

export interface ToolResult {
  /** Parsed structured payload, when the tool returned one (structuredContent or JSON text). */
  data: unknown;
  /** Concatenated text content, always present for display / fallback. */
  text: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  annotations?: Record<string, unknown>;
}

interface JsonRpcReply {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS_TTL_MS = 60 * 60_000;

export class SkyAccessClient {
  readonly config: SkyAccessConfig;
  private fetchImpl: FetchLike;
  private now: () => number;
  private nextId = 1;
  private toolsCache: { at: number; tools: ToolInfo[] } | null = null;

  constructor(deps: { config?: Partial<SkyAccessConfig>; fetch: FetchLike; now?: () => number }) {
    this.config = { ...DEFAULT_SKYACCESS, ...deps.config };
    this.fetchImpl = deps.fetch;
    this.now = deps.now ?? Date.now;
  }

  /** The server's tool list, cached for an hour (it is not rate limited, but rarely changes). */
  async listTools(force = false): Promise<ToolInfo[]> {
    if (!force && this.toolsCache && this.now() - this.toolsCache.at < TOOLS_TTL_MS) return this.toolsCache.tools;
    const result = await this.rpc('tools/list', {});
    const tools = Array.isArray(result.tools) ? (result.tools as ToolInfo[]) : [];
    this.toolsCache = { at: this.now(), tools };
    return tools;
  }

  async tool(name: string): Promise<ToolInfo | undefined> {
    return (await this.listTools()).find((t) => t.name === name);
  }

  /** Handshake, used by the connectivity check. Stateless server, so tool calls don't need it. */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: unknown; instructions?: string }> {
    const r = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.config.clientName, version: this.config.clientVersion },
    });
    return { protocolVersion: String(r.protocolVersion ?? ''), serverInfo: r.serverInfo ?? null, instructions: r.instructions as string | undefined };
  }

  async callTool(name: SkyAccessTool, args: Record<string, unknown>): Promise<ToolResult> {
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const result = await this.rpc('tools/call', { name, arguments: clean });
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((c: { type?: string }) => c?.type === 'text')
      .map((c: { text?: string }) => String(c.text ?? ''))
      .join('\n')
      .trim();
    if (result.isError === true) throw new SkyAccessError('tool_error', text || `SkyAccess ${name} failed`);
    return { data: result.structuredContent ?? parseJson(text), text };
  }

  // ---------- transport ----------

  private async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'user-agent': `${this.config.clientName}/${this.config.clientVersion}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      throw new SkyAccessError(aborted ? 'timeout' : 'network', aborted ? 'SkyAccess did not respond in time' : `Could not reach SkyAccess: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text();
    const reply = readReply(body, res.headers.get('content-type') ?? '', id);
    if (res.status === 429 || reply?.error?.code === -32029) {
      const reset = Number(res.headers.get('ratelimit-reset') ?? res.headers.get('retry-after'));
      throw new SkyAccessError('rate_limited', reply?.error?.message ?? 'SkyAccess rate limit reached', 429, Number.isFinite(reset) && reset > 0 ? reset : null);
    }
    if (res.status >= 400 && !reply) throw new SkyAccessError('http', `SkyAccess returned HTTP ${res.status}`, res.status);
    if (!reply) throw new SkyAccessError('protocol', 'SkyAccess returned no readable JSON-RPC reply', res.status);
    if (reply.error) throw new SkyAccessError('protocol', `SkyAccess: ${reply.error.message}`, res.status);
    return reply.result ?? {};
  }
}

/** Accepts a plain JSON body (object or batch) or an SSE stream of `data:` lines. */
export function readReply(body: string, contentType: string, id: number): JsonRpcReply | null {
  const payloads: unknown[] = [];
  if (contentType.includes('text/event-stream') || /^\s*(event|data):/m.test(body) && !body.trimStart().startsWith('{')) {
    let data: string[] = [];
    const flush = () => {
      if (data.length) payloads.push(parseJson(data.join('\n')));
      data = [];
    };
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line.trim()) flush();
    }
    flush();
  } else {
    payloads.push(parseJson(body));
  }
  const all = payloads.flatMap((p) => (Array.isArray(p) ? p : [p])).filter((p): p is JsonRpcReply => !!p && typeof p === 'object');
  return all.find((p) => p.id === id) ?? all.find((p) => p.error && p.id == null) ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
