// Shared request context and response helpers for the four surfaces.
//
// Every reply the forge sends carries a non-empty `X-GitHub-Request-Id`
// (the protocol group asserts it on REST replies, including 401s and 404s),
// and every REST/GraphQL/MCP reply is `application/json`, never HTML.
// The git surfaces answer with their own smart-HTTP content types. These
// helpers are the one place that discipline lives; surfaces call them
// instead of writing headers themselves.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** What a surface handler receives for one request. */
export interface HandlerCtx {
  readonly store: Store;
  /** The HTTP method, e.g. `GET`. */
  readonly method: string;
  /** The request pathname, without the query string. */
  readonly path: string;
  /** The parsed query string. */
  readonly query: URLSearchParams;
  /** The path split on `/`, with empty segments dropped. */
  readonly segments: string[];
  /** The raw request body (empty for GETs). */
  readonly body: Buffer;
  /**
   * The parsed JSON body, when the request carried one and it parsed;
   * `undefined` when there was no body. When the body was present but
   * unparsable, `bodyJsonError` is true and this is undefined.
   */
  readonly json: unknown;
  /** True when a body was present but did not parse as JSON. */
  readonly bodyJsonError: boolean;
  /** This request's id (`req-<n>`), for the X-GitHub-Request-Id header. */
  readonly requestId: string;
}

/** A surface handler: answers the request, always ending the response. */
export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void> | void;

export const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Answer with a JSON body. `extraHeaders` go beside the JSON ones and the
 * request-id header (which is always present).
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

/** Answer an error as GitHub does: a JSON body with a string `message`. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  requestId: string,
): void {
  sendJson(res, status, { message }, requestId);
}

/** The 204 answer for a successful DELETE: no body, request id present. */
export function sendNoContent(res: ServerResponse, requestId: string): void {
  res.writeHead(204, { 'x-github-request-id': requestId });
  res.end();
}

/**
 * Parse a request body as JSON. Returns the value, or `error: true` when
 * the body is present but unparsable (an empty body parses to undefined
 * with no error). Surfaces use this instead of inlining JSON.parse so a
 * malformed body is a 400 in exactly one place.
 */
export function parseJsonBody(body: Buffer): { json: unknown; error: boolean } {
  if (body.length === 0) return { json: undefined, error: false };
  try {
    return { json: JSON.parse(body.toString('utf8')), error: false };
  } catch {
    return { json: undefined, error: true };
  }
}
