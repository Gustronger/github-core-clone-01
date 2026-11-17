// The store: the single source of truth for the whole forge.
//
// Git, REST, GraphQL and MCP all read and write the same in-memory store,
// so a repository, issue or pull request created over any surface reads back
// identically over the others (the cross-surface checks require the same
// ids, numbers and SHAs everywhere). All state lives in Maps keyed by the
// thing looked up (repo name, ref, object SHA, issue/PR number) — O(1)
// lookups on every path, never a scan.
//
// Determinism: every timestamp comes from the logical clock, every id from
// a counter, every list keeps insertion order. The same requests in the
// same order produce the same store, so a live trial and its replay agree.

import { LogicalClock } from './determinism.ts';
import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseIdent,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git-objects.ts';
import { VIEWER, VIEWER_IDENTITY, VIEWER_LOGIN } from './scenario.ts';

/** An error with the HTTP status the surface should answer with. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: Comment[];
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  /** The base tip at creation: the merge-base for the conflict rule. */
  readonly mergeBaseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly fullName: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** refs/heads/* and refs/tags/* → tip oid. */
  readonly refs: Map<string, string>;
  /** oid → object (loose, in-memory). */
  readonly objects: Map<string, GitObject>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** Increments on any ref change; the git caches key on it. */
  stateVersion: number;
}

/** A tree diff entry: one path changed between two trees. */
export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** Parse an author/committer identity line (re-exported from git-objects.ts). */
export { parseIdent } from './git-objects.ts';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

export class Store {
  readonly clock = new LogicalClock();
  private readonly reposByName = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  private nextGlobalId = 1;

  // ---------------------------------------------------------------- repos

  /** Create a repository. Duplicate name or an empty name is a 422. */
  createRepo(
    name: string,
    options: { description?: string; isPrivate?: boolean } = {},
  ): Repo {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new ApiError(422, 'name is required');
    if (this.reposByName.has(trimmed)) {
      throw new ApiError(422, `repository ${trimmed} already exists`);
    }
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name: trimmed,
      owner: VIEWER_LOGIN,
      fullName: `${VIEWER_LOGIN}/${trimmed}`,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      stateVersion: 0,
    };
    this.reposByName.set(trimmed, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.reposByName.get(name);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  /** Delete a repository and all its git objects, issues and pull requests. */
  deleteRepo(name: string): boolean {
    const repo = this.reposByName.get(name);
    if (!repo) return false;
    this.reposByName.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  /** All repositories, in creation order. */
  listRepos(): Repo[] {
    return [...this.reposByName.values()];
  }

  // ---------------------------------------------------------------- git: objects and refs

  /** Store an object if absent; return its SHA-1 id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Set a ref and bump the repo's state version (invalidates git caches). */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.stateVersion += 1;
  }

  /** Delete a ref; true when it existed. */
  deleteRef(repo: Repo, ref: string): boolean {
    const existed = repo.refs.delete(ref);
    if (existed) repo.stateVersion += 1;
    return existed;
  }

  /** All refs, sorted by name (the advertisement order). */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The ref HEAD points at: the default branch. */
  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /**
   * Peel an oid to the commit it names: a commit is itself; a tag follows
   * its target (recursively); anything else is undefined.
   */
  resolveToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** True when `ancestor` is `descendant` itself or reachable from it by parents. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const target = this.resolveToCommit(repo, ancestor);
    const start = this.resolveToCommit(repo, descendant);
    if (!target || !start) return false;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === target) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /**
   * History from a tip, tip-first, following all parents, deduplicated.
   * `limit` caps the walk (0 or undefined = no cap). Linear histories come
   * back as the plain parent chain.
   */
  walkHistory(repo: Repo, tip: string, limit = 0): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [];
    const start = this.resolveToCommit(repo, tip);
    if (start) stack.push(start);
    while (stack.length) {
      if (limit > 0 && out.length >= limit) break;
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  /**
   * Every object reachable from `tips`: commit → tree + parents, tree →
   * entries, tag → target. With `depth`, the commit walk stops after that
   * many generations from each tip (depth 1 = the tips only); trees and
   * blobs under an included commit are always fully included. With
   * `exclude`, objects in that set are removed from the result (the
   * client's already-held objects).
   */
  reachable(
    repo: Repo,
    tips: Iterable<string>,
    options: { depth?: number; exclude?: ReadonlySet<string> } = {},
  ): Set<string> {
    const depth = options.depth;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const out = new Set<string>();
    if (depth === undefined) {
      // Full closure: every tip's history plus the tip objects themselves
      // (a tag tip contributes its tag object, not just its target commit).
      const roots = new Set<string>();
      for (const tip of tips) {
        const resolved = this.resolveToCommit(repo, tip);
        if (resolved) {
          for (const oid of this.walkHistory(repo, resolved)) roots.add(oid);
        }
        roots.add(tip);
      }
      for (const oid of roots) {
        for (const reachableOid of collectReachable([oid], lookup, { allowMissing: true })) {
          out.add(reachableOid);
        }
      }
    } else {
      // Depth-limited: walk parents up to depth-1 edges from each tip.
      const commits = new Set<string>();
      const queue: Array<{ oid: string; generation: number }> = [];
      for (const tip of tips) {
        const resolved = this.resolveToCommit(repo, tip);
        if (resolved) queue.push({ oid: resolved, generation: 1 });
        else if (repo.objects.has(tip)) commits.add(tip);
      }
      const seen = new Set<string>();
      while (queue.length) {
        const { oid, generation } = queue.pop()!;
        if (seen.has(oid) || generation > depth) continue;
        seen.add(oid);
        commits.add(oid);
        if (generation === depth) continue;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          queue.push({ oid: parent, generation: generation + 1 });
        }
      }
      // A tag tip also contributes its tag object itself.
      for (const tip of tips) {
        const object = repo.objects.get(tip);
        if (object && object.type === 'tag') commits.add(tip);
      }
      for (const oid of commits) {
        for (const reachableOid of collectReachable([oid], lookup, { allowMissing: true })) {
          out.add(reachableOid);
        }
      }
    }
    if (options.exclude) {
      for (const oid of options.exclude) out.delete(oid);
    }
    return out;
  }

  /**
   * The shallow boundary of an included commit set: included commits that
   * have a parent the set does not include (and that parent exists in the
   * store). Those commits are the `shallow` lines of a depth-limited fetch.
   */
  shallowBoundary(repo: Repo, includedCommits: Iterable<string>): string[] {
    const included = new Set(includedCommits);
    const boundary: string[] = [];
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!included.has(parent) && repo.objects.has(parent)) {
          boundary.push(oid);
          break;
        }
      }
    }
    return boundary;
  }

  // ---------------------------------------------------------------- git: trees

  /** The tree entry at `path` under `treeOid` ('' = the root), or undefined. */
  getTreeEntry(
    repo: Repo,
    treeOid: string,
    path: string,
  ): { oid: string; mode: string } | undefined {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** The entries of the directory at `path` under `treeOid` ('' = root). */
  listTree(repo: Repo, treeOid: string, path: string): TreeEntry[] | undefined {
    if (path === '' || path === '/') {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return undefined;
      return parseTree(object.data);
    }
    const entry = this.getTreeEntry(repo, treeOid, path);
    if (!entry || entry.mode !== '40000') return undefined;
    const object = repo.objects.get(entry.oid);
    if (!object || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null),
   * creating intermediate directories as needed. The input tree is never
   * modified; every new tree object is stored.
   */
  updatePath(repo: Repo, treeOid: string, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return treeOid;
    const build = (currentOid: string, depth: number): string => {
      const object = repo.objects.get(currentOid);
      const entries: TreeEntry[] =
        object && object.type === 'tree' ? parseTree(object.data) : [];
      const name = segments[depth];
      const isLeaf = depth === segments.length - 1;
      const next = entries.filter((entry) => entry.name !== name);
      if (isLeaf) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.find((entry) => entry.name === name);
        const childOid = child && child.mode === '40000' ? child.oid : EMPTY_TREE_OID;
        const updated = build(childOid, depth + 1);
        if (updated !== EMPTY_TREE_OID) next.push({ mode: '40000', name, oid: updated });
      }
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(treeOid, 0);
  }

  /** Every file path under a tree (mode != 40000), with its blob oid. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (currentOid: string, prefix: string): void => {
      const object = repo.objects.get(currentOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The paths that differ between two trees, sorted by path. */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): DiffEntry[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: DiffEntry[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && !newEntry) {
        out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (!oldEntry && newEntry) {
        out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- git: commits

  /** Build and store a commit; author and committer are the viewer identity. */
  createCommit(
    repo: Repo,
    options: { tree: string; parents?: string[]; message: string },
  ): string {
    const timestamp = this.clock.nowSec();
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    const data = buildCommit({
      tree: options.tree,
      parents: options.parents ?? [],
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  // ---------------------------------------------------------------- issues

  /** Create an issue. An unknown label or an empty title is a 422. */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const cleanTitle = (title ?? '').trim();
    if (!cleanTitle) throw new ApiError(422, 'title is required');
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ApiError(422, `label "${name}" does not exist`);
    }
    const now = this.clock.nowIso();
    const issue: Issue = {
      id: this.nextGlobalId++,
      number: repo.nextIssueNumber++,
      title: cleanTitle,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** All issues, in creation (number) order. */
  listIssues(repo: Repo): Issue[] {
    return [...repo.issues.values()];
  }

  /** Patch an issue's state/title/body; undefined when the number is unknown. */
  updateIssue(
    repo: Repo,
    number: number,
    patch: { state?: string; title?: string; body?: string },
  ): Issue | undefined {
    const issue = repo.issues.get(number);
    if (!issue) return undefined;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string' && patch.title.trim() !== '') issue.title = patch.title.trim();
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedAt = this.clock.nowIso();
    return issue;
  }

  /** Add a comment to an issue; undefined when the issue is unknown. */
  addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined {
    const issue = repo.issues.get(issueNumber);
    if (!issue) return undefined;
    const now = this.clock.nowIso();
    const comment: Comment = {
      id: repo.nextCommentId++,
      body: body ?? '',
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedAt = this.clock.nowIso();
    return comment;
  }

  // ---------------------------------------------------------------- labels

  /** Create a label. A duplicate name is a 422. */
  createLabel(repo: Repo, name: string, color?: string): Label {
    const cleanName = (name ?? '').trim();
    if (!cleanName) throw new ApiError(422, 'name is required');
    if (repo.labels.has(cleanName)) throw new ApiError(422, `label "${cleanName}" already exists`);
    const label: Label = { name: cleanName, color: color ?? 'ededed' };
    repo.labels.set(cleanName, label);
    return label;
  }

  // ---------------------------------------------------------------- pull requests

  /**
   * Open a pull request. An unknown head/base branch or a duplicate open
   * PR for the same head+base is a 422. The base tip at creation is the
   * merge-base for the conflict rule.
   */
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (!headSha) throw new ApiError(422, `unknown head branch "${head}"`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!baseSha) throw new ApiError(422, `unknown base branch "${base}"`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        throw new ApiError(422, `a pull request from ${head} to ${base} is already open`);
      }
    }
    const cleanTitle = (title ?? '').trim();
    if (!cleanTitle) throw new ApiError(422, 'title is required');
    const now = this.clock.nowIso();
    const pull: Pull = {
      id: this.nextGlobalId++,
      number: repo.nextPullNumber++,
      title: cleanTitle,
      body: body ?? '',
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBaseSha: baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  /** All pull requests, in creation (number) order. */
  listPulls(repo: Repo): Pull[] {
    return [...repo.pulls.values()];
  }

  /**
   * The three-way conflict test: for each path changed between the PR's
   * merge-base and its head, if the same path also changed between the
   * merge-base and the current default tip and the contents differ, the
   * merge conflicts.
   */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!defaultTip) return false;
    const baseCommit = repo.objects.get(this.resolveToCommit(repo, pull.mergeBaseSha) ?? '');
    const headCommit = repo.objects.get(this.resolveToCommit(repo, pull.headSha) ?? '');
    const currentCommit = repo.objects.get(this.resolveToCommit(repo, defaultTip) ?? '');
    if (!baseCommit || !headCommit || !currentCommit) return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const currentTree = parseCommit(currentCommit.data).tree;
    const headChanges = new Map(this.diffTrees(repo, baseTree, headTree).map((d) => [d.path, d]));
    const currentChanges = new Map(this.diffTrees(repo, baseTree, currentTree).map((d) => [d.path, d]));
    for (const [path, headChange] of headChanges) {
      const currentChange = currentChanges.get(path);
      if (!currentChange) continue;
      if (headChange.newOid !== currentChange.newOid) return true;
    }
    return false;
  }

  /** MERGEABLE unless the three-way test says the merge conflicts. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    return this.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: a new commit on the default branch whose
   * tree is the default tip's tree with the head's changes applied, parent
   * the default tip. Unknown PR → 404; non-open → 405; conflict → 405.
   */
  mergePull(repo: Repo, number: number): { sha: string } {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, `pull request #${number} does not exist`);
    if (pull.state !== 'open') throw new ApiError(405, `pull request #${number} is not open`);
    if (this.pullConflicts(repo, pull)) throw new ApiError(405, 'Merge conflict');
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!defaultTip) throw new ApiError(405, 'the default branch has no commits');
    const baseCommit = repo.objects.get(this.resolveToCommit(repo, pull.mergeBaseSha) ?? '');
    const headCommit = repo.objects.get(this.resolveToCommit(repo, pull.headSha) ?? '');
    const currentCommit = repo.objects.get(this.resolveToCommit(repo, defaultTip) ?? '');
    if (!baseCommit || !headCommit || !currentCommit) {
      throw new ApiError(405, 'the pull request cannot be merged');
    }
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const currentTree = parseCommit(currentCommit.data).tree;
    let tree = currentTree;
    for (const change of this.diffTrees(repo, baseTree, headTree)) {
      tree = this.updatePath(repo, tree, change.path, change.newOid);
    }
    const sha = this.createCommit(repo, {
      tree,
      parents: [defaultTip],
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
    });
    this.setRef(repo, `refs/heads/${repo.defaultBranch}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = this.clock.nowIso();
    pull.updatedAt = this.clock.nowIso();
    return { sha };
  }

  // ---------------------------------------------------------------- global ids (GraphQL)

  /**
   * An opaque, stable global id: base64url of `Kind:repoId:number:extra`.
   * The same object always gets the same id, and the id decodes back to
   * the object without a lookup table.
   */
  globalId(
    kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment',
    repoId: number,
    number?: number,
    extra?: number,
  ): string {
    const parts = [kind, String(repoId)];
    if (number !== undefined) parts.push(String(number));
    if (extra !== undefined) parts.push(String(extra));
    return Buffer.from(parts.join(':'), 'utf8').toString('base64url');
  }

  /** Decode a global id, or null when it is not one the store issued. */
  parseGlobalId(
    gid: string,
  ): { kind: string; repoId: number; number?: number; extra?: number } | null {
    try {
      const text = Buffer.from(gid, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      const kind = parts[0];
      if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') {
        return null;
      }
      const repoId = Number(parts[1]);
      if (!Number.isSafeInteger(repoId) || repoId <= 0) return null;
      const out: { kind: string; repoId: number; number?: number; extra?: number } = { kind, repoId };
      if (parts.length >= 3) {
        const n = Number(parts[2]);
        if (!Number.isSafeInteger(n)) return null;
        out.number = n;
      }
      if (parts.length >= 4) {
        const e = Number(parts[3]);
        if (!Number.isSafeInteger(e)) return null;
        out.extra = e;
      }
      return out;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- REST views

  /** The repository object the REST (and MCP) surface answers with. */
  repoView(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner, id: VIEWER.id },
      html_url: `https://example.invalid/${repo.fullName}`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
    };
  }

  /** The issue object the REST (and MCP) surface answers with. */
  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({
        name,
        color: repo.labels.get(name)?.color ?? 'ededed',
      })),
      user: { login: VIEWER_LOGIN, id: VIEWER.id },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    };
  }

  /** The pull-request object the REST (and MCP) surface answers with. */
  pullView(pull: Pull): Record<string, unknown> {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merge_commit_sha: pull.mergeCommitSha,
      merged_at: pull.mergedAt,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      user: { login: VIEWER_LOGIN, id: VIEWER.id },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    };
  }

  /** The comment object the REST surface answers with. */
  commentView(comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER.id },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    };
  }
}
