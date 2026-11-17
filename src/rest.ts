// REST v3 surface: /api/v3/* — repositories, branches, commits, contents,
// issues, labels, comments, pull requests and merges.
//
// Thin adapter over the store (src/store.ts): every route resolves the
// viewer-owned repository first (a foreign owner is a 404, never a 403),
// then calls the store helper that owns the rule — duplicate names,
// stale content SHAs, the three-way merge-conflict test — and answers
// with the store's view objects, so REST, GraphQL and MCP all read back
// the same ids, numbers and SHAs.
//
// Determinism: no wall clock, no randomness here. Timestamps and ids come
// from the store's logical clock and counters; commit author dates come
// from the stored commit object itself.

import { sendJson, sendNoContent, type Handler, type HandlerCtx } from './context.ts';
import { formatIso } from './determinism.ts';
import { EMPTY_TREE_OID, isObjectId, parseCommit, parseIdent } from './git-objects.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { ApiError, type Repo } from './store.ts';

/** The request body as a plain object; a missing or non-object body is {}. */
function bodyOf(ctx: HandlerCtx): Record<string, unknown> {
  const json = ctx.json;
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return {};
}

/** A body field as a string, or undefined when it is absent or not a string. */
function bodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/** A body field as a boolean, or undefined when it is absent or not a boolean. */
function bodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** The path segments, percent-decoded (the client encodes each segment). */
function decodedSegments(ctx: HandlerCtx): string[] {
  return ctx.segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/**
 * The viewer-owned repository for a /repos/{owner}/{name} route.
 * A foreign owner is a 404, never a 403; an unknown name is a 404.
 */
function requireRepo(ctx: HandlerCtx, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw new ApiError(404, `repository ${owner}/${name} does not exist`);
  const repo = ctx.store.getRepo(name);
  if (!repo) throw new ApiError(404, `repository ${owner}/${name} does not exist`);
  return repo;
}

/** `?per_page=` (default 30) and `?page=` (default 1), clamped to >= 1. */
function pagination(ctx: HandlerCtx): { perPage: number; page: number } {
  const perPageRaw = Number(ctx.query.get('per_page'));
  const pageRaw = Number(ctx.query.get('page'));
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? perPageRaw : 30;
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/**
 * Slice one page out of a list. The caller answers with the slice and
 * adds a Link rel="next" header when more pages remain.
 */
function pageOf<T>(list: readonly T[], perPage: number, page: number): { items: T[]; hasMore: boolean } {
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  return { items, hasMore: start + perPage < list.length };
}

/**
 * The absolute URL of the next page, built from the request's own host
 * and path (the pagination check follows the Link only when it stays on
 * the entry's origin, so a relative URL would fail it).
 */
function nextPageUrl(req: Parameters<Handler>[0], ctx: HandlerCtx, perPage: number, page: number): string {
  const host = req.headers.host;
  const target = `${ctx.path}?per_page=${perPage}&page=${page + 1}`;
  return host ? `http://${host}${target}` : target;
}

/** Answer a paginated list, with a Link rel="next" header while more remain. */
function sendPage<T>(
  req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  list: readonly T[],
): void {
  const { perPage, page } = pagination(ctx);
  const { items, hasMore } = pageOf(list, perPage, page);
  const extra = hasMore
    ? { link: `<${nextPageUrl(req, ctx, perPage, page)}>; rel="next"` }
    : {};
  sendJson(res, 200, items, ctx.requestId, extra);
}

/** The `state` filter for issue/pull lists: open (default), closed or all. */
function stateFilter(ctx: HandlerCtx): 'open' | 'closed' | 'all' {
  const state = ctx.query.get('state');
  if (state === undefined || state === null || state === '') return 'open';
  if (state === 'open' || state === 'closed' || state === 'all') return state;
  throw new ApiError(422, `invalid state "${state}"`);
}

/** The tip commit oid a ref name (branch name or raw oid) resolves to. */
function resolveRefTip(ctx: HandlerCtx, repo: Repo, ref: string): string | undefined {
  const byBranch = ctx.store.getRef(repo, `refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (isObjectId(ref)) {
    const resolved = ctx.store.resolveToCommit(repo, ref);
    if (resolved) return resolved;
  }
  return undefined;
}

/** The tree oid of a commit, or undefined when the commit is not stored. */
function commitTree(ctx: HandlerCtx, repo: Repo, commitOid: string): string | undefined {
  const object = ctx.store.getObject(repo, commitOid);
  if (!object || object.type !== 'commit') return undefined;
  return parseCommit(object.data).tree;
}

/** One commit list item: sha, message (no trailing newline) and author. */
function commitView(ctx: HandlerCtx, repo: Repo, sha: string): Record<string, unknown> | undefined {
  const object = ctx.store.getObject(repo, sha);
  if (!object || object.type !== 'commit') return undefined;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message.replace(/\n+$/, ''),
      author: { name: author.name, email: author.email, date: formatIso(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: formatIso(committer.timestamp) },
    },
  };
}

/** Split text into lines; a trailing newline does not make an empty line. */
function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A multiset line diff: lines present more often in `next` are additions,
 * lines present more often in `prev` are deletions. Added files count
 * every line; removed files count every old line.
 */
function lineDiff(
  oldText: string | null,
  newText: string | null,
): { additions: number; deletions: number } {
  if (oldText === null && newText === null) return { additions: 0, deletions: 0 };
  if (oldText === null) {
    const count = textLines(newText ?? '').length;
    return { additions: count === 0 ? 1 : count, deletions: 0 };
  }
  if (newText === null) return { additions: 0, deletions: textLines(oldText).length };
  const oldCounts = new Map<string, number>();
  for (const line of textLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of textLines(newText)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  const lines = new Set([...oldCounts.keys(), ...newCounts.keys()]);
  for (const line of lines) {
    const diff = (newCounts.get(line) ?? 0) - (oldCounts.get(line) ?? 0);
    if (diff > 0) additions += diff;
    else deletions -= diff;
  }
  return { additions, deletions };
}

/** The blob text at an oid, or null when there is no blob there. */
function blobText(ctx: HandlerCtx, repo: Repo, oid: string | null): string | null {
  if (oid === null) return null;
  const object = ctx.store.getObject(repo, oid);
  if (!object || object.type !== 'blob') return null;
  return object.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// /user/repos

function createUserRepo(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
): void {
  const body = bodyOf(ctx);
  const name = bodyString(body, 'name');
  const repo = ctx.store.createRepo(name ?? '', {
    description: bodyString(body, 'description'),
    isPrivate: bodyBoolean(body, 'private'),
  });
  sendJson(res, 201, ctx.store.repoView(repo), ctx.requestId);
}

function listUserRepos(
  req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
): void {
  const repos = ctx.store.listRepos();
  // sendPage slices and answers; the views keep insertion (creation) order.
  const { perPage, page } = pagination(ctx);
  const { items, hasMore } = pageOf(repos, perPage, page);
  const extra = hasMore
    ? { link: `<${nextPageUrl(req, ctx, perPage, page)}>; rel="next"` }
    : {};
  sendJson(res, 200, items.map((repo) => ctx.store.repoView(repo)), ctx.requestId, extra);
}

// ---------------------------------------------------------------------------
// /repos/{owner}/{name}

function getRepo(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  sendJson(res, 200, ctx.store.repoView(repo), ctx.requestId);
}

function patchRepo(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const body = bodyOf(ctx);
  const description = bodyString(body, 'description');
  if (description !== undefined) repo.description = description;
  const isPrivate = bodyBoolean(body, 'private');
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  repo.updatedAt = ctx.store.clock.nowIso();
  sendJson(res, 200, ctx.store.repoView(repo), ctx.requestId);
}

function deleteRepo(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  ctx.store.deleteRepo(repo.name);
  sendNoContent(res, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Branches and refs

function listBranches(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const branches = ctx.store
    .listRefs(repo)
    .filter((ref) => ref.name.startsWith('refs/heads/'))
    .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
  sendJson(res, 200, branches, ctx.requestId);
}

function getBranch(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  branch: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const sha = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (!sha) throw new ApiError(404, `branch "${branch}" does not exist`);
  sendJson(res, 200, { name: branch, commit: { sha } }, ctx.requestId);
}

function createRef(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const body = bodyOf(ctx);
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (!ref || !ref.startsWith('refs/')) throw new ApiError(422, 'ref is required and must start with refs/');
  if (!sha || !isObjectId(sha)) throw new ApiError(422, `unknown object "${sha ?? ''}"`);
  if (ctx.store.getRef(repo, ref)) throw new ApiError(422, `reference ${ref} already exists`);
  if (!ctx.store.getObject(repo, sha)) throw new ApiError(422, `unknown object "${sha}"`);
  ctx.store.setRef(repo, ref, sha);
  sendJson(res, 201, { ref, object: { sha } }, ctx.requestId);
}

function getRef(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  branch: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = `refs/heads/${branch}`;
  const sha = ctx.store.getRef(repo, ref);
  if (!sha) throw new ApiError(404, `reference ${ref} does not exist`);
  sendJson(res, 200, { ref, object: { sha } }, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Commits

function listCommits(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRefTip(ctx, repo, ref);
  if (!tip) {
    // An unborn repository has no default tip yet: an empty history, not
    // an error. An explicitly requested ref that does not resolve is a 404.
    if (ctx.query.get('sha') === null) {
      sendJson(res, 200, [], ctx.requestId);
      return;
    }
    throw new ApiError(404, `reference "${ref}" does not exist`);
  }
  const commits = ctx.store
    .walkHistory(repo, tip)
    .map((sha) => commitView(ctx, repo, sha))
    .filter((view): view is Record<string, unknown> => view !== undefined);
  sendJson(res, 200, commits, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Contents

/** The directory entries under a tree path: files and subdirectories. */
function directoryEntries(
  ctx: HandlerCtx,
  repo: Repo,
  treeOid: string,
  path: string,
): Array<Record<string, unknown>> | undefined {
  const entries = ctx.store.listTree(repo, treeOid, path);
  if (!entries) return undefined;
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
  }));
}

function getContents(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  path: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const branch = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (!tip) throw new ApiError(404, `reference "${branch}" does not exist`);
  const tree = commitTree(ctx, repo, tip);
  if (!tree) throw new ApiError(404, `reference "${branch}" does not exist`);
  if (path === '') {
    const entries = directoryEntries(ctx, repo, tree, '');
    if (!entries) throw new ApiError(404, 'the repository is empty');
    sendJson(res, 200, entries, ctx.requestId);
    return;
  }
  const entry = ctx.store.getTreeEntry(repo, tree, path);
  if (!entry) throw new ApiError(404, `path "${path}" does not exist`);
  if (entry.mode === '40000') {
    const entries = directoryEntries(ctx, repo, tree, path);
    if (!entries) throw new ApiError(404, `path "${path}" does not exist`);
    sendJson(res, 200, entries, ctx.requestId);
    return;
  }
  const object = ctx.store.getObject(repo, entry.oid);
  if (!object || object.type !== 'blob') throw new ApiError(404, `path "${path}" does not exist`);
  sendJson(
    res,
    200,
    {
      type: 'file',
      encoding: 'base64',
      content: object.data.toString('base64'),
      size: object.data.length,
      sha: entry.oid,
      name: path.split('/').pop() ?? path,
      path,
    },
    ctx.requestId,
  );
}

function putContents(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  path: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  if (path === '') throw new ApiError(422, 'a file path is required');
  const body = bodyOf(ctx);
  const message = bodyString(body, 'message') ?? `Update ${path}`;
  const contentB64 = bodyString(body, 'content');
  if (contentB64 === undefined) throw new ApiError(422, 'content is required');
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const branchRef = `refs/heads/${branch}`;
  // The branch tip, or the default tip when the branch does not exist yet
  // (the branch is then created from the default tip); an unborn repo has
  // neither, and the first PUT creates the branch with no parent.
  const tip =
    ctx.store.getRef(repo, branchRef) ?? ctx.store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  const baseTree = tip ? (commitTree(ctx, repo, tip) ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
  const current = tip ? ctx.store.getTreeEntry(repo, baseTree, path) : undefined;
  const isUpdate = current !== undefined && current.mode !== '40000';
  if (isUpdate) {
    const sha = bodyString(body, 'sha');
    if (sha !== undefined && sha !== current.oid) {
      throw new ApiError(409, `sha ${sha} does not match the current blob ${current.oid}`);
    }
  }
  const blobOid = ctx.store.putObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
  const newTree = ctx.store.updatePath(repo, baseTree, path, blobOid);
  const commitSha = ctx.store.createCommit(repo, {
    tree: newTree,
    parents: tip ? [tip] : [],
    message,
  });
  ctx.store.setRef(repo, branchRef, commitSha);
  sendJson(
    res,
    isUpdate ? 200 : 201,
    {
      content: {
        sha: blobOid,
        encoding: 'base64',
        name: path.split('/').pop() ?? path,
        path,
      },
      commit: { sha: commitSha },
    },
    ctx.requestId,
  );
}

function deleteContents(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  path: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  if (path === '') throw new ApiError(404, 'a file path is required');
  const body = bodyOf(ctx);
  const message = bodyString(body, 'message') ?? `Delete ${path}`;
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const tip = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (!tip) throw new ApiError(404, `reference "${branch}" does not exist`);
  const tree = commitTree(ctx, repo, tip);
  if (!tree) throw new ApiError(404, `reference "${branch}" does not exist`);
  const entry = ctx.store.getTreeEntry(repo, tree, path);
  if (!entry || entry.mode === '40000') throw new ApiError(404, `path "${path}" does not exist`);
  const newTree = ctx.store.updatePath(repo, tree, path, null);
  const commitSha = ctx.store.createCommit(repo, {
    tree: newTree,
    parents: [tip],
    message,
  });
  ctx.store.setRef(repo, `refs/heads/${branch}`, commitSha);
  sendJson(res, 200, { commit: { sha: commitSha } }, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Labels, issues, comments

function createLabel(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const body = bodyOf(ctx);
  const label = ctx.store.createLabel(repo, bodyString(body, 'name') ?? '', bodyString(body, 'color'));
  sendJson(res, 201, { name: label.name, color: label.color }, ctx.requestId);
}

function createIssue(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const body = bodyOf(ctx);
  const labels = Array.isArray(body.labels)
    ? (body.labels as unknown[]).filter((label): label is string => typeof label === 'string')
    : [];
  const issue = ctx.store.createIssue(
    repo,
    bodyString(body, 'title') ?? '',
    bodyString(body, 'body') ?? '',
    labels,
  );
  sendJson(res, 201, ctx.store.issueView(repo, issue), ctx.requestId);
}

function listIssues(
  req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const state = stateFilter(ctx);
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = ctx.store.listIssues(repo);
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues = [...issues].sort((a, b) =>
      direction === 'asc' ? a.number - b.number : b.number - a.number,
    );
  }
  const { perPage, page } = pagination(ctx);
  const { items, hasMore } = pageOf(issues, perPage, page);
  const extra = hasMore
    ? { link: `<${nextPageUrl(req, ctx, perPage, page)}>; rel="next"` }
    : {};
  sendJson(res, 200, items.map((issue) => ctx.store.issueView(repo, issue)), ctx.requestId, extra);
}

function parseNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function getIssue(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const issue = number === undefined ? undefined : ctx.store.getIssue(repo, number);
  if (!issue) throw new ApiError(404, `issue #${numberText} does not exist`);
  sendJson(res, 200, ctx.store.issueView(repo, issue), ctx.requestId);
}

function patchIssue(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const body = bodyOf(ctx);
  const issue =
    number === undefined
      ? undefined
      : ctx.store.updateIssue(repo, number, {
          state: bodyString(body, 'state'),
          title: bodyString(body, 'title'),
          body: bodyString(body, 'body'),
        });
  if (!issue) throw new ApiError(404, `issue #${numberText} does not exist`);
  sendJson(res, 200, ctx.store.issueView(repo, issue), ctx.requestId);
}

function createComment(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const body = bodyOf(ctx);
  const comment =
    number === undefined ? undefined : ctx.store.addComment(repo, number, bodyString(body, 'body') ?? '');
  if (!comment) throw new ApiError(404, `issue #${numberText} does not exist`);
  sendJson(res, 201, ctx.store.commentView(comment), ctx.requestId);
}

function listComments(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const issue = number === undefined ? undefined : ctx.store.getIssue(repo, number);
  if (!issue) throw new ApiError(404, `issue #${numberText} does not exist`);
  sendJson(res, 200, issue.comments.map((comment) => ctx.store.commentView(comment)), ctx.requestId);
}

// ---------------------------------------------------------------------------
// Pull requests

function createPull(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const body = bodyOf(ctx);
  const pull = ctx.store.createPull(
    repo,
    bodyString(body, 'head') ?? '',
    bodyString(body, 'base') ?? '',
    bodyString(body, 'title') ?? '',
    bodyString(body, 'body') ?? '',
  );
  sendJson(res, 201, ctx.store.pullView(pull), ctx.requestId);
}

function listPulls(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const state = stateFilter(ctx);
  let pulls = ctx.store.listPulls(repo);
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  sendPage(_req, res, ctx, pulls.map((pull) => ctx.store.pullView(pull)));
}

function getPull(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const pull = number === undefined ? undefined : ctx.store.getPull(repo, number);
  if (!pull) throw new ApiError(404, `pull request #${numberText} does not exist`);
  sendJson(res, 200, ctx.store.pullView(pull), ctx.requestId);
}

function listPullFiles(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const pull = number === undefined ? undefined : ctx.store.getPull(repo, number);
  if (!pull) throw new ApiError(404, `pull request #${numberText} does not exist`);
  const baseTip = ctx.store.resolveToCommit(repo, pull.baseSha);
  const headTip = ctx.store.resolveToCommit(repo, pull.headSha);
  const baseTree = baseTip ? commitTree(ctx, repo, baseTip) : undefined;
  const headTree = headTip ? commitTree(ctx, repo, headTip) : undefined;
  if (!baseTree || !headTree) throw new ApiError(404, `pull request #${numberText} has no commits`);
  const files = ctx.store.diffTrees(repo, baseTree, headTree).map((entry) => {
    const { additions, deletions } = lineDiff(
      blobText(ctx, repo, entry.oldOid),
      blobText(ctx, repo, entry.newOid),
    );
    return {
      filename: entry.path,
      status: entry.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
  sendJson(res, 200, files, ctx.requestId);
}

function mergePull(
  _req: Parameters<Handler>[0],
  res: Parameters<Handler>[1],
  ctx: HandlerCtx,
  owner: string,
  name: string,
  numberText: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const number = parseNumber(numberText);
  const pull = number === undefined ? undefined : ctx.store.getPull(repo, number);
  if (!pull) throw new ApiError(404, `pull request #${numberText} does not exist`);
  // merge_method is accepted and ignored: the forge always squash-merges.
  const { sha } = ctx.store.mergePull(repo, number);
  sendJson(
    res,
    200,
    {
      sha,
      merged: true,
      message: `Merge pull request #${number} from ${repo.owner}/${pull.headRef}`,
    },
    ctx.requestId,
  );
}

// ---------------------------------------------------------------------------
// Routing

/** The REST handler: /api/v3/* except the root, meta and user routes app.ts owns. */
export const handleRest: Handler = (req, res, ctx) => {
  const rest = decodedSegments(ctx).slice(2);

  // POST /user/repos, GET /user/repos.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (ctx.method === 'POST') return createUserRepo(req, res, ctx);
    if (ctx.method === 'GET') return listUserRepos(req, res, ctx);
    return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
  }

  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (tail.length === 0) {
      if (ctx.method === 'GET') return getRepo(req, res, ctx, owner, name);
      if (ctx.method === 'PATCH') return patchRepo(req, res, ctx, owner, name);
      if (ctx.method === 'DELETE') return deleteRepo(req, res, ctx, owner, name);
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (tail[0] === 'branches') {
      if (tail.length === 1 && ctx.method === 'GET') return listBranches(req, res, ctx, owner, name);
      if (tail.length >= 2 && ctx.method === 'GET') {
        return getBranch(req, res, ctx, owner, name, tail.slice(1).join('/'));
      }
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // POST /repos/{o}/{r}/git/refs, GET /git/refs/heads/{branch}
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && ctx.method === 'POST') return createRef(req, res, ctx, owner, name);
      if (tail.length >= 4 && tail[2] === 'heads' && ctx.method === 'GET') {
        return getRef(req, res, ctx, owner, name, tail.slice(3).join('/'));
      }
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // GET /repos/{o}/{r}/commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && ctx.method === 'GET') return listCommits(req, res, ctx, owner, name);
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // GET/PUT/DELETE /repos/{o}/{r}/contents[/{path...}]
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (ctx.method === 'GET') return getContents(req, res, ctx, owner, name, path);
      if (ctx.method === 'PUT') return putContents(req, res, ctx, owner, name, path);
      if (ctx.method === 'DELETE') return deleteContents(req, res, ctx, owner, name, path);
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // POST /repos/{o}/{r}/labels
    if (tail[0] === 'labels') {
      if (tail.length === 1 && ctx.method === 'POST') return createLabel(req, res, ctx, owner, name);
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // Issues: /issues, /issues/{n}, /issues/{n}/comments
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') return createIssue(req, res, ctx, owner, name);
        if (ctx.method === 'GET') return listIssues(req, res, ctx, owner, name);
        return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      }
      if (tail.length === 2) {
        if (ctx.method === 'GET') return getIssue(req, res, ctx, owner, name, tail[1]);
        if (ctx.method === 'PATCH') return patchIssue(req, res, ctx, owner, name, tail[1]);
        return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (ctx.method === 'POST') return createComment(req, res, ctx, owner, name, tail[1]);
        if (ctx.method === 'GET') return listComments(req, res, ctx, owner, name, tail[1]);
        return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      }
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }

    // Pulls: /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') return createPull(req, res, ctx, owner, name);
        if (ctx.method === 'GET') return listPulls(req, res, ctx, owner, name);
        return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      }
      if (tail.length === 2) {
        if (ctx.method === 'GET') return getPull(req, res, ctx, owner, name, tail[1]);
        return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
      }
      if (tail.length === 3 && tail[2] === 'files' && ctx.method === 'GET') {
        return listPullFiles(req, res, ctx, owner, name, tail[1]);
      }
      if (tail.length === 3 && tail[2] === 'merge' && ctx.method === 'PUT') {
        return mergePull(req, res, ctx, owner, name, tail[1]);
      }
      return sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    }
  }

  // Unknown route under /api/v3/*, or a wrong method on a known path.
  sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
};
