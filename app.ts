// The forge's HTTP server: routing, auth, and the JSON discipline.
//
// Cross-cutting rules (the protocol group owns them):
// - Every reply carries a non-empty `X-GitHub-Request-Id` (`req-<n>`).
// - Every REST/GraphQL/MCP reply is `application/json`, never HTML,
//   including 401s, 404s and 400s; error bodies are `{message: string}`.
// - Unknown routes answer 404 JSON; a malformed JSON body answers 400.
// - Auth is `Authorization: Bearer <token>` or `token <token>`, compared
//   by exact string equality with MAKEFUN_SHOP_TOKEN; a request without
//   it is 401 (except /healthz and the public API root/meta, as the
//   starter ships them).
// - A repository belongs to the viewer login only; any other owner is
//   foreign and answers 404, never 403 (enforced in the surfaces).
//
// Routing: /healthz → boot probe; /api/v3[/] and /api/v3/meta → public;
// /api/v3/* → REST; /api/graphql → GraphQL; /mcp → MCP;
// /{owner}/{repo}.git/* → git smart HTTP. Every handler is wrapped so a
// throw becomes a 500 JSON and the process keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Counter } from './src/determinism.ts';
import { VIEWER } from './src/scenario.ts';
import { Store, ApiError } from './src/store.ts';
import { sendError, sendJson, parseJsonBody, type HandlerCtx } from './src/context.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** The largest request body accepted (packs are a few hundred KiB at most). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token the entry's endpoints take, from the trial environment. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/**
 * True when the request carries the trial token (Bearer or token scheme).
 * The `Authorization: Bearer <token>` / `token <token>` check, written with
 * string operations instead of a regex: the scheme is the text before the
 * first space or tab (matched case-insensitively), the token is the rest
 * after any further spaces or tabs, compared by exact string equality.
 * (Header values reach us with leading/trailing whitespace already
 * trimmed by the HTTP parser; the trim keeps the old behaviour for any
 * exotic value that still carries some.)
 */
function isAuthed(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  const header = (req.headers.authorization ?? '').trim();
  let split = header.indexOf(' ');
  const tab = header.indexOf('\t');
  if (tab !== -1 && (split === -1 || tab < split)) split = tab;
  if (split <= 0) return false;
  const scheme = header.slice(0, split).toLowerCase();
  if (scheme !== 'bearer' && scheme !== 'token') return false;
  let start = split + 1;
  while (start < header.length && (header[start] === ' ' || header[start] === '\t')) start += 1;
  return start < header.length && header.slice(start) === SHOP_TOKEN;
}

/**
 * The path of a request URL, or '/' when it does not parse.
 *
 * Fast path: an origin-form target (what every client sends) with no dot
 * segments, backslashes, encoded dots or control characters splits by hand
 * into the same pathname `new URL` would return, without constructing a
 * URL. Anything unusual falls back to `new URL`, so absolute-form targets,
 * dot-segment resolution, backslash handling and malformed URLs behave
 * exactly as before.
 */
function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  if (raw.startsWith('/')) {
    const hash = raw.indexOf('#');
    const clean = hash === -1 ? raw : raw.slice(0, hash);
    if (
      clean.indexOf('\t') === -1 &&
      clean.indexOf('\n') === -1 &&
      clean.indexOf('\r') === -1 &&
      !clean.startsWith('//') &&
      !clean.includes('/./') &&
      !clean.includes('/../') &&
      !clean.endsWith('/.') &&
      !clean.endsWith('/..') &&
      !clean.includes('\\') &&
      clean.indexOf('%2E') === -1 &&
      clean.indexOf('%2e') === -1
    ) {
      const q = clean.indexOf('?');
      if (q === -1) return { path: clean, query: new URLSearchParams() };
      return { path: clean.slice(0, q), query: new URLSearchParams(clean.slice(q + 1)) };
    }
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/**
 * Read the request body fully, up to MAX_BODY_BYTES, then call `done` with
 * it — or with the error, past the limit or on a stream error. A callback,
 * not a promise: the request path stays off the promise machinery (one
 * fewer microtask turn per request). A single chunk is handed over as-is
 * instead of copied through Buffer.concat.
 */
function readBody(req: IncomingMessage, done: (body: Buffer, err?: Error) => void): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      settled = true;
      done(Buffer.alloc(0), new Error('request body is too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    done(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total));
  });
  req.on('error', (err) => {
    if (settled) return;
    settled = true;
    done(Buffer.alloc(0), err);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const requestIds = new Counter();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${requestIds.next()}`;
    const { path, query } = pathOf(req);
    const method = req.method ?? 'GET';
    const segments = path.split('/').filter((segment) => segment !== '');
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

    // The env's boot check calls this twice: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    // The dispatch runs synchronously once the body (if any) is in: the
    // request path stays off the promise machinery — no async wrapper, no
    // await — and every surface handler is synchronous, so one try/catch
    // still covers the whole dispatch. A body that could not be read is a
    // 500, as the old await's catch was.
    if (!needsBody) {
      dispatch(Buffer.alloc(0));
      return;
    }
    readBody(req, (body, err) => {
      if (err) {
        if (!res.writableEnded) {
          try {
            sendError(res, 500, err.message, requestId);
          } catch {
            // The socket is already gone; nothing left to do.
          }
        }
        return;
      }
      dispatch(body);
    });

    function dispatch(body: Buffer): void {
      try {
        const isGitRoute = segments.length >= 2 && segments[1].endsWith('.git');

        // The git surfaces take a binary body; the rest take JSON. A body
        // that is present but does not parse as JSON is a 400 on the JSON
        // routes (the protocol group's malformed-body check); on any other
        // route the body is the surface's to judge.
        let json: unknown;
        let bodyJsonError = false;
        if (!isGitRoute && body.length > 0) {
          const parsed = parseJsonBody(body);
          json = parsed.json;
          bodyJsonError = parsed.error;
        }

        const ctx: HandlerCtx = {
          store,
          method,
          path,
          query,
          segments,
          body,
          json,
          bodyJsonError,
          requestId,
        };

        // The public API root and meta, as the starter ships them.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(
            res,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            requestId,
            { 'x-oauth-scopes': 'repo, read:org' },
          );
          return;
        }
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, { installed_version: '1.0.0' }, requestId);
          return;
        }

        // Everything else needs the trial token.
        if (!isAuthed(req)) {
          sendError(res, 401, 'Requires authentication', requestId);
          return;
        }

        // The viewer endpoint: the login the token names.
        if (method === 'GET' && path === '/api/v3/user') {
          sendJson(
            res,
            200,
            { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email },
            requestId,
          );
          return;
        }

        // A malformed JSON body is a 400 on the JSON routes only; an
        // unknown route with a bad body is still a 404 (see below).
        // /mcp is exempted: the MCP handler answers a malformed body
        // itself with JSON-RPC -32700 (the parse-error check), so the
        // 400-before-dispatch here must not swallow it.
        const isJsonRoute =
          path === '/api/graphql' ||
          path.startsWith('/api/graphql/') ||
          path === '/api/v3' ||
          path.startsWith('/api/v3/');
        if (isJsonRoute && bodyJsonError) {
          sendError(res, 400, 'Problems parsing JSON', requestId);
          return;
        }

        if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          handleGraphql(req, res, ctx);
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          handleMcp(req, res, ctx);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handleRest(req, res, ctx);
          return;
        }
        if (isGitRoute) {
          handleGit(req, res, ctx);
          return;
        }

        sendError(res, 404, 'Not Found', requestId);
      } catch (err) {
        // A handler must never take the process down: answer the ApiError's
        // own status (a 4xx the store raised), or 500 JSON, and keep
        // serving (the repo-survives-errors check depends on it).
        if (!res.writableEnded) {
          try {
            if (err instanceof ApiError) {
              sendError(res, err.status, err.message, requestId);
            } else {
              sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error', requestId);
            }
          } catch {
            // The socket is already gone; nothing left to do.
          }
        }
      }
    }
  });
}
