// MCP surface: POST /mcp — JSON-RPC 2.0 over Streamable HTTP, the
// server/discover handshake (revision 2026-07-28) with the legacy
// initialize fallback, tools/list and the six tools. Implemented in the MCP
// step (PLAN §i step 8) against checks-mcp.ts: the checks there are the spec.
//
// Protocol notes (mcp-client.ts is the other side of this contract):
// - Modern era: `server/discover` declares the revision in
//   `_meta['io.modelcontextprotocol/protocolVersion']` and the
//   `MCP-Protocol-Version` header. The answer carries serverInfo in BOTH
//   the loose field and `_meta['io.modelcontextprotocol/serverInfo']`
//   (the client reads _meta first). A revision we do not support answers
//   JSON-RPC -32022 with `data.supported` listing the supported revisions.
// - Legacy era: `initialize` echoes the revision the client declared and
//   `notifications/initialized` (no id) answers HTTP 202 with an empty
//   body. No `Mcp-Session-Id` is ever issued: the handlers are stateless.
// - `tools/list` returns one frozen array, built once at module load, so
//   two calls answer byte-identical JSON.
// - Tool results carry BOTH `content` text (JSON.stringify of the result)
//   and `structuredContent` (the same data). Tool failures answer
//   `isError: true` with HTTP 200; an unknown tool answers JSON-RPC
//   -32602, never HTTP 500. A body that is not JSON answers HTTP 400
//   with JSON-RPC -32700 — see the app.ts carve-out note in the report:
//   app.ts currently answers 400 `{message}` before dispatching, so this
//   handler's -32700 branch only runs once /mcp is exempted there.
// - Determinism: no clock, no randomness, no per-request state. Two
//   concurrent calls keep their own ids because every value here is
//   derived from the request itself (the frozen tools array is read-only).

import { sendJson, sendError, type Handler } from './context.ts';
import { ApiError, type Store } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';

/** The revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25']);

/** The server identity every handshake answers with. */
const SERVER_INFO = Object.freeze({ name: 'forge', version: '1.0.0' });

/** `YYYY-MM-DD`: the spelling a protocol revision uses. */
function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** A plain record (an object that is not an array and not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- tools/list

/** One tool definition, exactly as tools/list answers it. */
interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required: readonly string[];
  };
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): McpToolDef {
  const frozenProps: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [key, schema] of Object.entries(properties)) frozenProps[key] = Object.freeze({ ...schema });
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze(frozenProps),
      required: Object.freeze([...required]),
    }),
  });
}

/**
 * The six tools, built ONCE at module load and frozen: tools/list returns
 * this same array object on every call, so two calls answer byte-identical
 * JSON (the tools-list-idempotent check). `required` holds ONLY the
 * documented arguments — a required property the suite cannot fill fails
 * its check, so no extra required entries.
 */
const TOOLS: readonly McpToolDef[] = Object.freeze([
  toolDef(
    'create_repo',
    'Create a repository owned by the viewer.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  toolDef(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue.' },
    },
    ['owner', 'repo', 'title'],
  ),
  toolDef(
    'list_issues',
    'List the issues of a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by issue state.' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  toolDef(
    'merge_pull_request',
    'Squash-merge a pull request into the default branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

/** Canonical tool names, in tools/list order. */
const CANONICAL_NAMES = TOOLS.map((tool) => tool.name);

/** The obvious aliases the suite also matches (checks-mcp.ts MCP_TOOL_ALIASES). */
const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['create_repository', 'repo_create', 'repos_create', 'repository_create']),
  get_repo: Object.freeze(['get_repository', 'repo_get', 'repos_get', 'repository_get']),
  create_issue: Object.freeze(['issue_create', 'issues_create']),
  list_issues: Object.freeze(['issues_list', 'issue_list']),
  create_pull_request: Object.freeze(['pull_request_create', 'pulls_create', 'create_pr', 'pr_create']),
  merge_pull_request: Object.freeze(['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']),
});

/** A tool name normalized for matching: lowercase, non-alphanumerics removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a requested tool name to its canonical name: an exact
 * canonical/alias match first, then a server prefix matched as a suffix,
 * case-insensitively (e.g. `github__create_issue`). Null when nothing
 * matches — the caller answers JSON-RPC -32602.
 */
function resolveToolName(requested: string): string | null {
  const wanted = normalizeName(requested);
  if (wanted === '') return null;
  for (const canonical of CANONICAL_NAMES) {
    const candidates = [canonical, ...(TOOL_ALIASES[canonical] ?? [])];
    for (const candidate of candidates) {
      if (normalizeName(candidate) === wanted) return canonical;
    }
  }
  for (const canonical of CANONICAL_NAMES) {
    const candidates = [canonical, ...(TOOL_ALIASES[canonical] ?? [])];
    for (const candidate of candidates) {
      const suffix = normalizeName(candidate);
      if (wanted.length > suffix.length && wanted.endsWith(suffix)) return canonical;
    }
  }
  return null;
}

// ---------------------------------------------------------------- arguments

/** The first defined, non-null string among `keys` (in order), or undefined. */
function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The first integer among `keys` (a number, or a signed string of digits), or undefined. */
function firstInteger(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

/** The first boolean among `keys` (`true`/`false`, or the strings 'true'/'false'), or undefined. */
function firstBoolean(args: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/**
 * The owner + repo a call addresses. The suite maps its documented
 * arguments onto the schema's property names, so the canonical names are
 * normally present; the synonyms below cover direct callers. A `full_name`
 * of `owner/repo` fills whichever of owner/repo is missing, and a repo
 * value of `owner/repo` splits the same way.
 */
function ownerRepoOf(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = firstString(args, [
    'owner', 'owner_login', 'org', 'organization', 'organisation', 'user',
    'user_login', 'login', 'account', 'namespace', 'owner_name',
  ]);
  let repo = firstString(args, [
    'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name',
  ]);
  const fullName = firstString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if ((!owner || !repo) && fullName !== undefined && fullName.includes('/')) {
    const [fullOwner, fullRepo] = fullName.split('/', 2);
    if (owner === undefined && fullOwner !== '') owner = fullOwner;
    if (repo === undefined && fullRepo !== '') repo = fullRepo;
  }
  if (repo !== undefined && repo.includes('/') && owner === undefined) {
    const [splitOwner, splitRepo] = repo.split('/', 2);
    owner = splitOwner;
    repo = splitRepo;
  }
  return { owner, repo };
}

// ---------------------------------------------------------------- tool results

/** A successful tool result: text AND structuredContent, the same data in both. */
function toolOk(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** A tool execution error: HTTP 200, `isError: true`, the message as text. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The repository fields the create_repo/get_repo tools answer with. */
function repoResult(store: Store, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(name);
  if (!repo) return null;
  const view = store.repoView(repo);
  return {
    id: view.id,
    name: view.name,
    full_name: view.full_name,
    private: view.private,
    default_branch: view.default_branch,
  };
}

// ---------------------------------------------------------------- tools/call

type ToolOutcome = Record<string, unknown>;

/** create_repo: the viewer owns every repository; a foreign owner is an error. */
function callCreateRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const name = firstString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === undefined) return toolError('Missing required argument: name');
  const owner = firstString(args, ['owner', 'owner_login', 'org', 'organization']);
  if (owner !== undefined && owner !== VIEWER_LOGIN) {
    return toolError(`repository owner "${owner}" does not exist`);
  }
  const description = firstString(args, ['description', 'about', 'summary']);
  const isPrivate = firstBoolean(args, ['private', 'is_private']);
  try {
    store.createRepo(name, {
      ...(description !== undefined ? { description } : {}),
      ...(isPrivate !== undefined ? { isPrivate } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) return toolError(err.message);
    throw err;
  }
  return toolOk(repoResult(store, name));
}

/** get_repo: the same object REST answers with (rest-parity: stable ids). */
function callGetRepo(store: Store, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = ownerRepoOf(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repo === undefined) return toolError('Missing required argument: repo');
  if (owner !== VIEWER_LOGIN) return toolError(`repository ${owner}/${repo} does not exist`);
  const result = repoResult(store, repo);
  if (result === null) return toolError(`repository ${owner}/${repo} does not exist`);
  return toolOk(result);
}

/** create_issue: the same store helper as POST /issues. */
function callCreateIssue(store: Store, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = ownerRepoOf(args);
  const title = firstString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repo === undefined) return toolError('Missing required argument: repo');
  if (title === undefined) return toolError('Missing required argument: title');
  if (owner !== VIEWER_LOGIN) return toolError(`repository ${owner}/${repo} does not exist`);
  const found = store.getRepo(repo);
  if (!found) return toolError(`repository ${owner}/${repo} does not exist`);
  const body = firstString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const labels = Array.isArray(args.labels)
    ? args.labels.filter((entry): entry is string => typeof entry === 'string')
    : typeof args.labels === 'string'
      ? args.labels.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
      : [];
  try {
    const issue = store.createIssue(found, title, body, labels);
    return toolOk({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
  } catch (err) {
    if (err instanceof ApiError) return toolError(err.message);
    throw err;
  }
}

/** list_issues: the same issues REST lists, filtered by state (default open). */
function callListIssues(store: Store, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = ownerRepoOf(args);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repo === undefined) return toolError('Missing required argument: repo');
  if (owner !== VIEWER_LOGIN) return toolError(`repository ${owner}/${repo} does not exist`);
  const found = store.getRepo(repo);
  if (!found) return toolError(`repository ${owner}/${repo} does not exist`);
  const state = (firstString(args, ['state', 'status']) ?? 'open').trim().toLowerCase();
  const issues = store
    .listIssues(found)
    .filter((issue) => state === 'all' || issue.state === state)
    .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
  return toolOk({ issues });
}

/** create_pull_request: the same store helper as POST /pulls. */
function callCreatePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = ownerRepoOf(args);
  const title = firstString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  const head = firstString(args, [
    'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head',
    'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch',
  ]);
  const base = firstString(args, [
    'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base',
    'target', 'target_ref', 'target_branch', 'into', 'into_branch',
  ]);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repo === undefined) return toolError('Missing required argument: repo');
  if (title === undefined) return toolError('Missing required argument: title');
  if (head === undefined) return toolError('Missing required argument: head');
  if (base === undefined) return toolError('Missing required argument: base');
  if (owner !== VIEWER_LOGIN) return toolError(`repository ${owner}/${repo} does not exist`);
  const found = store.getRepo(repo);
  if (!found) return toolError(`repository ${owner}/${repo} does not exist`);
  const body = firstString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  try {
    const pull = store.createPull(found, head, base, title, body);
    const view = store.pullView(pull);
    return toolOk({
      id: view.id,
      number: view.number,
      title: view.title,
      state: view.state,
      head: view.head,
      base: view.base,
    });
  } catch (err) {
    if (err instanceof ApiError) return toolError(err.message);
    throw err;
  }
}

/** merge_pull_request: the same squash merge as PUT /pulls/{n}/merge. */
function callMergePullRequest(store: Store, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo } = ownerRepoOf(args);
  const pullNumber = firstInteger(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (owner === undefined) return toolError('Missing required argument: owner');
  if (repo === undefined) return toolError('Missing required argument: repo');
  if (pullNumber === undefined) return toolError('Missing required argument: pull_number');
  if (owner !== VIEWER_LOGIN) return toolError(`repository ${owner}/${repo} does not exist`);
  const found = store.getRepo(repo);
  if (!found) return toolError(`repository ${owner}/${repo} does not exist`);
  try {
    const { sha } = store.mergePull(found, pullNumber);
    return toolOk({ sha, merged: true, number: pullNumber });
  } catch (err) {
    if (err instanceof ApiError) return toolError(err.message);
    throw err;
  }
}

/** Dispatch one tools/call by canonical tool name. Never throws for a tool failure. */
function callTool(store: Store, canonical: string, args: Record<string, unknown>): ToolOutcome {
  switch (canonical) {
    case 'create_repo':
      return callCreateRepo(store, args);
    case 'get_repo':
      return callGetRepo(store, args);
    case 'create_issue':
      return callCreateIssue(store, args);
    case 'list_issues':
      return callListIssues(store, args);
    case 'create_pull_request':
      return callCreatePullRequest(store, args);
    case 'merge_pull_request':
      return callMergePullRequest(store, args);
    default:
      return toolError(`Unknown tool: ${canonical}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

/** Answer one JSON-RPC result (HTTP 200, `application/json`). */
function sendResult(res: Parameters<Handler>[1], id: unknown, result: unknown, requestId: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, requestId);
}

/** Answer one JSON-RPC error (HTTP 200, except the parse error's 400). */
function sendRpcError(
  res: Parameters<Handler>[1],
  id: unknown,
  code: number,
  message: string,
  requestId: string,
  data?: unknown,
  status = 200,
): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, status, { jsonrpc: '2.0', id, error }, requestId);
}

/**
 * The revision a discover/initialize declares. Precedence matters: the
 * legacy client sends `initialize` with `params.protocolVersion` set to
 * the revision it offers (e.g. 2025-11-25) while `_meta` still carries
 * the preferred revision (2026-07-28) — the params field is the declared
 * one, so it wins. `server/discover` carries no params.protocolVersion,
 * so it falls through to `_meta`, then the header.
 */
function declaredRevision(
  req: Parameters<Handler>[0],
  params: Record<string, unknown>,
): string | undefined {
  if (typeof params.protocolVersion === 'string' && params.protocolVersion !== '') {
    return params.protocolVersion;
  }
  const meta = isRecord(params._meta) ? params._meta : {};
  const fromMeta = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
  if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta;
  const header = req.headers['mcp-protocol-version'];
  if (typeof header === 'string' && header !== '') return header;
  return undefined;
}

/** POST /mcp: one JSON-RPC 2.0 request (or notification) per POST. */
export const handleMcp: Handler = (req, res, ctx) => {
  // A notification (no id) answers HTTP 202 with an empty body; only
  // notifications/initialized is used, but any notification is answered
  // the same way. This branch also covers a DELETE (session close).
  if (ctx.method === 'DELETE') {
    res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    res.end();
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed', ctx.requestId);
    return;
  }

  // A body that is not JSON: HTTP 400 with JSON-RPC -32700. NOTE: app.ts
  // answers 400 `{message}` before dispatching (its isJsonRoute branch),
  // so this branch only runs once /mcp is exempted there — see the report.
  if (ctx.bodyJsonError) {
    sendRpcError(res, null, -32700, 'Parse error', ctx.requestId, undefined, 400);
    return;
  }
  if (ctx.json === undefined) {
    sendRpcError(res, null, -32700, 'Parse error', ctx.requestId, undefined, 400);
    return;
  }
  if (!isRecord(ctx.json)) {
    sendRpcError(res, null, -32600, 'Invalid Request', ctx.requestId, undefined, 400);
    return;
  }

  const body = ctx.json;
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  const id = hasId ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // A notification carries no id: HTTP 202, empty body, no result.
  if (!hasId) {
    res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    res.end();
    return;
  }

  try {
    switch (method) {
      case 'server/discover': {
        // Modern era: the declared revision must be one we support.
        const declared = declaredRevision(req, params);
        if (declared !== undefined && !SUPPORTED_VERSIONS.includes(declared)) {
          sendRpcError(res, id, -32022, `Unsupported protocol version: ${declared}`, ctx.requestId, {
            supported: [...SUPPORTED_VERSIONS],
          });
          return;
        }
        sendResult(res, id, {
          resultType: 'DiscoverResult',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          instructions: 'A GitHub-compatible git forge.',
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }, ctx.requestId);
        return;
      }
      case 'initialize': {
        // Legacy era: echo the revision the client declared (any valid
        // YYYY-MM-DD revision; default 2025-11-25 when none was declared).
        const declared = declaredRevision(req, params);
        const protocolVersion = declared !== undefined && isRevision(declared) ? declared : '2025-11-25';
        sendResult(res, id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }, ctx.requestId);
        return;
      }
      case 'tools/list': {
        // The same frozen array every time: byte-identical answers.
        sendResult(res, id, { tools: TOOLS }, ctx.requestId);
        return;
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const canonical = name === '' ? null : resolveToolName(name);
        if (canonical === null) {
          sendRpcError(res, id, -32602, `Unknown tool: ${name === '' ? '(missing name)' : name}`, ctx.requestId);
          return;
        }
        let args: Record<string, unknown> = {};
        if (isRecord(params.arguments)) {
          args = params.arguments;
        } else if (typeof params.arguments === 'string' && params.arguments.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(params.arguments);
            if (isRecord(parsed)) args = parsed;
          } catch {
            // A non-JSON arguments string is treated as no arguments.
          }
        }
        let outcome: ToolOutcome;
        try {
          outcome = callTool(ctx.store, canonical, args);
        } catch (err) {
          // A tool must never become an HTTP 500: report it as isError.
          outcome = toolError(err instanceof Error ? err.message : 'Tool call failed');
        }
        sendResult(res, id, outcome, ctx.requestId);
        return;
      }
      case 'notifications/initialized': {
        // A request-shaped initialized (with an id): an empty result.
        sendResult(res, id, {}, ctx.requestId);
        return;
      }
      default: {
        sendRpcError(res, id, -32601, `Method not found: ${method === '' ? '(missing method)' : method}`, ctx.requestId);
        return;
      }
    }
  } catch (err) {
    // The handler must never take the process down; an unexpected failure
    // is a JSON-RPC internal error, not an HTTP 500.
    if (!res.writableEnded) {
      sendRpcError(res, id, -32603, err instanceof Error ? err.message : 'Internal error', ctx.requestId);
    }
  }
};
