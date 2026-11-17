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

/** True when the request carries the trial token (Bearer or token scheme). */
function isAuthed(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  const header = req.headers.authorization ?? '';
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match !== null && match[1] === SHOP_TOKEN;
}

/** The path of a request URL, or '/' when it does not parse. */
function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Read the request body fully, up to MAX_BODY_BYTES (an error past it). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const requestIds = new Counter();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${requestIds.next()}`;
      const { path, query } = pathOf(req);
      const method = req.method ?? 'GET';
      const segments = path.split('/').filter((segment) => segment !== '');
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const isGitRoute = segments.length >= 2 && segments[1].endsWith('.git');
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

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
          await handleGraphql(req, res, ctx);
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          await handleMcp(req, res, ctx);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, ctx);
          return;
        }
        if (isGitRoute) {
          await handleGit(req, res, ctx);
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
    })();
  });
}
