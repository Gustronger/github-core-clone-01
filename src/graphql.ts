// GraphQL v4 surface: POST /api/graphql — a hand-written parser and
// executor for the 18 fixed documents the suite sends (checks-graphql.ts),
// plus introspection and the five mutations. Implemented in the GraphQL
// step (PLAN §i step 7) against checks-graphql.ts: the checks there are
// the spec.
//
// Wire rules (graphql-client.ts): one operation `{query, variables}` or a
// JSON array of them (batch, answered in order); every answer is HTTP 200
// with `{data, errors?}`; a GraphQL-level failure (unknown field, bad
// argument, failed mutation) is a 200 carrying `errors`, never an HTTP
// error; an unknown repository reads `data.repository: null` with no
// errors. Auth (401) and malformed JSON (400) are app.ts's job.
//
// Parser scope: operations `query`/`mutation` with optional names and
// variable definitions (parsed, values come from the request `variables`),
// anonymous operations, aliases, inline fragments (`... on Repository`),
// arguments with variables, string/int/enum literals, inline input
// objects, inline enum lists, `null` literals, nested selections. No
// directives. Every requested field is validated against the schema table
// below; an unknown field yields `Cannot query field "<name>" on type
// "<Type>".` and execution continues for the known fields.
//
// Determinism: cursors and global ids come only from the store helpers
// and base64url of stable inputs — no clock, no randomness anywhere here.

import { sendError, sendJson, type Handler } from './context.ts';
import { parseCommit } from './git-objects.ts';
import { VIEWER, VIEWER_LOGIN } from './scenario.ts';
import { ApiError, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// Schema table: the fields the executor answers, per type. The
// introspection lists are derived from this same table, so __type can
// never claim a field the executor does not serve.
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName',
    'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

/** Enum types and their values, for __type(...).enumValues. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

/** Object types __type may be asked about: fields from SCHEMA, no enum values. */
function typeInfo(name: string): { fields: string[]; enumValues: string[] } | null {
  if (name in ENUM_VALUES) return { fields: [], enumValues: [...ENUM_VALUES[name]] };
  const fields = SCHEMA[name];
  if (fields) return { fields: [...fields], enumValues: [] };
  return null;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'ellipsis' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += esc ?? '';
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      if (i >= n) throw new Error('Unterminated string in GraphQL document');
      i += 1; // closing quote
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token stream)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new Error(`Expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    if (value !== undefined && token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  /** Parse the whole document; returns the operation to run. */
  parseDocument(operationName?: string): Operation {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('Empty GraphQL document');
    if (operationName !== undefined) {
      const named = operations.find((op) => op.name === operationName);
      if (named) return named;
    }
    return operations[0];
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      this.next();
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === 'name' && token.value === 'subscription') {
      throw new Error('Subscriptions are not supported');
    }
    // Variable definitions: ($name: Type, ...) — parsed and ignored; the
    // values come from the request `variables`.
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === 'eof') throw new Error('Unterminated variable definitions');
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
    const selection = this.parseSelectionSet();
    return { type, name, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        // Named fragment spread — not used by the fixed documents; skip it.
        this.next();
        return { kind: 'fragment', typeCondition: null, selection: [] };
      }
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selection };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated argument list');
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated input object');
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value ${JSON.stringify(token.value)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------------------
// Value resolution (AST values + request variables → plain JS values)
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
      return node.value;
    case 'int':
      return node.value;
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Cursors: base64url of "cursor:<number>" — deterministic, opaque.
// ---------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(-?\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typed values: every resolved object carries its GraphQL type so the
// executor can validate subfields and apply inline fragments.
// ---------------------------------------------------------------------------

interface Typed {
  type: string;
  value: unknown;
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface ExecState {
  store: Store;
  variables: Variables;
  errors: GqlError[];
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** GitHub's PullRequestState: a merged PR reports MERGED, a closed-but-unmerged one CLOSED. */
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoTyped(repo: Repo): Typed {
  return { type: 'Repository', value: repo };
}

function issueTyped(repo: Repo, issue: Issue): Typed {
  return { type: 'Issue', value: { repo, issue } };
}

function pullTyped(repo: Repo, pull: Pull): Typed {
  return { type: 'PullRequest', value: { repo, pull } };
}

function globalRepoId(store: Store, repo: Repo): string {
  return store.globalId('Repository', repo.id);
}

function globalIssueId(store: Store, repo: Repo, issue: Issue): string {
  return store.globalId('Issue', repo.id, issue.number);
}

function globalPullId(store: Store, repo: Repo, pull: Pull): string {
  return store.globalId('PullRequest', repo.id, pull.number);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Execute a selection set against a typed value; null value → null. */
function executeSelection(
  state: ExecState,
  type: string,
  value: unknown,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== type) continue;
      const sub = executeSelection(state, type, value, selection.selection, path);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const field = selection;
    const allowed = SCHEMA[type];
    if (!allowed || !allowed.includes(field.name)) {
      state.errors.push({
        message: `Cannot query field "${field.name}" on type "${type}".`,
        path: [...path, field.alias],
      });
      continue;
    }
    const resolved = resolveField(state, type, value, field, [...path, field.alias]);
    out[field.alias] = resolved;
  }
  return out;
}

/**
 * Resolve one field. Scalars come back directly; object/list fields come
 * back as already-selected JSON (subselections executed here, so a null
 * parent never reaches a subfield).
 */
function resolveField(
  state: ExecState,
  type: string,
  value: unknown,
  field: FieldNode,
  path: Array<string | number>,
): unknown {
  const args = argMap(field, state.variables);
  const sel = field.selection;
  const store = state.store;

  // A subselection on a scalar-typed result is a schema error in real
  // GraphQL; the fixed documents never do it — treat it as the scalar.
  const select = (typed: Typed | null): unknown => {
    if (typed === null) return null;
    if (!sel) return typed.value;
    return executeSelection(state, typed.type, typed.value, sel, path);
  };
  const selectList = (items: Typed[]): unknown => {
    if (!sel) return items.map((item) => item.value);
    return items.map((item) => executeSelection(state, item.type, item.value, sel, path));
  };

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return select({ type: 'User', value: { login: VIEWER_LOGIN } });
      }
      if (field.name === 'repository') {
        const owner = asString(args.owner);
        const name = asString(args.name);
        if (owner !== VIEWER_LOGIN || !name) return null;
        const repo = store.getRepo(name);
        if (!repo) return null;
        return select(repoTyped(repo));
      }
      if (field.name === 'node') {
        const gid = asString(args.id);
        const parsed = gid ? store.parseGlobalId(gid) : null;
        if (!parsed) return null;
        const repo = store.getRepoById(parsed.repoId);
        if (!repo) return null;
        if (parsed.kind === 'Repository') return select(repoTyped(repo));
        if (parsed.kind === 'Issue' && parsed.number !== undefined) {
          const issue = store.getIssue(repo, parsed.number);
          return issue ? select(issueTyped(repo, issue)) : null;
        }
        if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
          const pull = store.getPull(repo, parsed.number);
          return pull ? select(pullTyped(repo, pull)) : null;
        }
        if (parsed.kind === 'IssueComment' && parsed.number !== undefined && parsed.extra !== undefined) {
          const issue = store.getIssue(repo, parsed.number);
          const comment = issue?.comments.find((c) => c.id === parsed.extra);
          return comment
            ? select({ type: 'IssueComment', value: { repo, issue, comment } })
            : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = asString(args.name);
        if (!name) return null;
        const info = typeInfo(name);
        if (!info) return null;
        return select({ type: '__Type', value: { name, fields: info.fields, enumValues: info.enumValues } });
      }
      return null;
    }

    case 'Mutation': {
      return resolveMutation(state, field, args, sel, path);
    }

    case 'User': {
      const user = value as { login: string };
      if (field.name === 'login') return user.login;
      // The viewer is the only User the surface ever resolves; its
      // identity comes from the scenario, not from the request.
      if (field.name === 'id') return VIEWER.id;
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      return null;
    }

    case 'Repository': {
      const repo = value as Repo;
      switch (field.name) {
        case 'id':
          return globalRepoId(store, repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return select({ type: 'User', value: { login: repo.owner } });
        case 'defaultBranchRef':
          return select({ type: 'Ref', value: { name: repo.defaultBranch } });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const number = asInt(args.number);
          if (number === undefined) return null;
          const issue = store.getIssue(repo, number);
          return issue ? select(issueTyped(repo, issue)) : null;
        }
        case 'issues':
          return select(issueConnection(state, repo, args));
        case 'pullRequests':
          return select(pullRequestConnection(state, repo, args));
        case 'pullRequest': {
          const number = asInt(args.number);
          if (number === undefined) return null;
          const pull = store.getPull(repo, number);
          return pull ? select(pullTyped(repo, pull)) : null;
        }
        default:
          return null;
      }
    }

    case 'Ref': {
      const ref = value as { name: string };
      return field.name === 'name' ? ref.name : null;
    }

    case 'Issue': {
      const { issue } = value as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return globalIssueId(store, (value as { repo: Repo }).repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        default:
          return null;
      }
    }

    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const conn = value as {
        nodes: Typed[];
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
      if (field.name === 'nodes') return selectList(conn.nodes);
      if (field.name === 'pageInfo') {
        return select({ type: 'PageInfo', value: conn.pageInfo });
      }
      // totalCount is the filtered total, not the page size: the
      // connection value carries it (see issueConnection /
      // pullRequestConnection / the files resolver).
      if (field.name === 'totalCount') return conn.totalCount;
      return null;
    }

    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id':
          return globalPullId(store, repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return store.pullMergeable(repo, pull);
        case 'files': {
          const first = asInt(args.first);
          const paths = pullFiles(store, repo, pull);
          const sliced = first === undefined ? paths : paths.slice(0, first);
          const nodes: Typed[] = sliced.map((path) => ({
            type: 'PullRequestChangedFile',
            value: { path },
          }));
          const conn: Typed = {
            type: 'PullRequestChangedFileConnection',
            value: {
              nodes,
              totalCount: paths.length,
              pageInfo: {
                hasNextPage: first !== undefined && paths.length > first,
                endCursor: nodes.length ? encodeCursor(nodes.length) : null,
                hasPreviousPage: false,
                startCursor: null,
              },
            },
          };
          return select(conn);
        }
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        default:
          return null;
      }
    }

    case 'PullRequestChangedFile': {
      const file = value as { path: string };
      return field.name === 'path' ? file.path : null;
    }

    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; endCursor: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage ?? false;
      if (field.name === 'startCursor') return info.startCursor ?? null;
      return null;
    }

    case 'IssueComment': {
      const { comment } = value as { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } };
      if (field.name === 'id') {
        const { repo, issue } = value as { repo: Repo; issue: Issue };
        return store.globalId('IssueComment', repo.id, issue.number, comment.id);
      }
      if (field.name === 'body') return comment.body;
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'updatedAt') return comment.updatedAt;
      return null;
    }

    case 'IssueCommentEdge': {
      const edge = value as { node: Typed; cursor: string | null };
      if (field.name === 'node') return select(edge.node);
      if (field.name === 'cursor') return edge.cursor;
      return null;
    }

    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: Typed | null };
      if (field.name === 'issue') return select(payload.issue);
      if (field.name === 'clientMutationId') return null;
      return null;
    }

    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: Typed | null };
      if (field.name === 'pullRequest') return select(payload.pullRequest);
      if (field.name === 'clientMutationId') return null;
      return null;
    }

    case 'AddCommentPayload': {
      const payload = value as { commentEdge: Typed | null };
      if (field.name === 'commentEdge') return select(payload.commentEdge);
      if (field.name === 'clientMutationId') return null;
      return null;
    }

    case '__Type': {
      const info = value as { name: string; fields: string[]; enumValues: string[] };
      if (field.name === 'name') return info.name;
      if (field.name === 'kind') return info.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return selectList(info.fields.map((name) => ({ type: '__Field', value: { name } })));
      }
      if (field.name === 'enumValues') {
        return selectList(info.enumValues.map((name) => ({ type: '__EnumValue', value: { name } })));
      }
      return null;
    }

    case '__Field':
    case '__EnumValue': {
      const entry = value as { name: string };
      if (field.name === 'name') return entry.name;
      if (field.name === 'description') return null;
      return null;
    }

    default:
      return null;
  }
}

/** The changed paths between a PR's base tip tree and its head tip tree. */
function pullFiles(store: Store, repo: Repo, pull: Pull): string[] {
  const baseCommitOid = store.resolveToCommit(repo, pull.baseSha);
  const headCommitOid = store.resolveToCommit(repo, pull.headSha);
  if (!baseCommitOid || !headCommitOid) return [];
  const base = store.getObject(repo, baseCommitOid);
  const head = store.getObject(repo, headCommitOid);
  if (!base || !head) return [];
  const baseTree = parseCommit(base.data).tree;
  const headTree = parseCommit(head.data).tree;
  return store.diffTrees(repo, baseTree, headTree).map((entry) => entry.path);
}

/** Repository.issues: states filter, orderBy, cursor `after`, `first`. */
function issueConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): Typed {
  const store = state.store;
  let issues = store.listIssues(repo);
  const statesArg = args.states;
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = new Set(statesArg.map((s) => String(s)));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = asRecord(args.orderBy);
  const descending =
    orderBy !== null &&
    String(orderBy.field ?? '') === 'CREATED_AT' &&
    String(orderBy.direction ?? '') === 'DESC';
  issues = [...issues].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  // totalCount counts every issue matching the states filter, before the
  // cursor and `first` narrow the page.
  const totalCount = issues.length;
  const after = decodeCursor(args.after);
  if (after !== null) {
    issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
  }
  const first = asInt(args.first);
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined && issues.length > first;
  const endCursor = page.length ? encodeCursor(page[page.length - 1].number) : null;
  return {
    type: 'IssueConnection',
    value: {
      nodes: page.map((issue) => issueTyped(repo, issue)),
      totalCount,
      pageInfo: { hasNextPage, endCursor, hasPreviousPage: false, startCursor: null },
    },
  };
}

/** Repository.pullRequests: newest first (number DESC), `first` caps it. */
function pullRequestConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): Typed {
  const store = state.store;
  const pulls = [...store.listPulls(repo)].sort((a, b) => b.number - a.number);
  const totalCount = pulls.length;
  const first = asInt(args.first);
  const page = first === undefined ? pulls : pulls.slice(0, first);
  const hasNextPage = first !== undefined && pulls.length > first;
  const endCursor = page.length ? encodeCursor(page[page.length - 1].number) : null;
  return {
    type: 'PullRequestConnection',
    value: {
      nodes: page.map((pull) => pullTyped(repo, pull)),
      totalCount,
      pageInfo: { hasNextPage, endCursor, hasPreviousPage: false, startCursor: null },
    },
  };
}

// ---------------------------------------------------------------------------
// Mutations. A store ApiError (unknown repo/id, duplicate PR, conflict,
// non-open PR) becomes a GraphQL error entry and a null field — HTTP 200.
// ---------------------------------------------------------------------------

function resolveMutation(
  state: ExecState,
  field: FieldNode,
  args: Record<string, unknown>,
  sel: SelectionNode[] | null,
  path: Array<string | number>,
): unknown {
  const store = state.store;
  const input = asRecord(args.input) ?? {};
  const select = (typed: Typed | null): unknown => {
    if (typed === null) return null;
    if (!sel) return typed.value;
    return executeSelection(state, typed.type, typed.value, sel, path);
  };
  try {
    switch (field.name) {
      case 'createIssue': {
        const parsed = typeof input.repositoryId === 'string' ? store.parseGlobalId(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? store.getRepoById(parsed.repoId) : undefined;
        if (!repo) throw new ApiError(422, 'repository not found');
        const issue = store.createIssue(repo, asString(input.title) ?? '', asString(input.body) ?? '', []);
        return select({ type: 'CreateIssuePayload', value: { issue: issueTyped(repo, issue) } });
      }
      case 'closeIssue': {
        const parsed = typeof input.issueId === 'string' ? store.parseGlobalId(input.issueId) : null;
        const repo = parsed?.kind === 'Issue' ? store.getRepoById(parsed.repoId) : undefined;
        const issue = repo && parsed?.number !== undefined ? store.getIssue(repo, parsed.number) : undefined;
        if (!repo || !issue) throw new ApiError(422, 'issue not found');
        const closed = store.updateIssue(repo, issue.number, { state: 'closed' });
        if (!closed) throw new ApiError(422, 'issue not found');
        return select({ type: 'CloseIssuePayload', value: { issue: issueTyped(repo, closed) } });
      }
      case 'createPullRequest': {
        const parsed = typeof input.repositoryId === 'string' ? store.parseGlobalId(input.repositoryId) : null;
        const repo = parsed?.kind === 'Repository' ? store.getRepoById(parsed.repoId) : undefined;
        if (!repo) throw new ApiError(422, 'repository not found');
        const pull = store.createPull(
          repo,
          asString(input.headRefName) ?? '',
          asString(input.baseRefName) ?? '',
          asString(input.title) ?? '',
          asString(input.body) ?? '',
        );
        return select({ type: 'CreatePullRequestPayload', value: { pullRequest: pullTyped(repo, pull) } });
      }
      case 'mergePullRequest': {
        const parsed = typeof input.pullRequestId === 'string' ? store.parseGlobalId(input.pullRequestId) : null;
        const repo = parsed?.kind === 'PullRequest' ? store.getRepoById(parsed.repoId) : undefined;
        if (!repo || parsed?.number === undefined) throw new ApiError(422, 'pull request not found');
        store.mergePull(repo, parsed.number);
        const pull = store.getPull(repo, parsed.number);
        if (!pull) throw new ApiError(422, 'pull request not found');
        return select({ type: 'MergePullRequestPayload', value: { pullRequest: pullTyped(repo, pull) } });
      }
      case 'addComment': {
        const parsed = typeof input.subjectId === 'string' ? store.parseGlobalId(input.subjectId) : null;
        const repo = parsed?.kind === 'Issue' ? store.getRepoById(parsed.repoId) : undefined;
        const issue = repo && parsed?.number !== undefined ? store.getIssue(repo, parsed.number) : undefined;
        if (!repo || !issue) throw new ApiError(422, 'issue not found');
        const comment = store.addComment(repo, issue.number, asString(input.body) ?? '');
        if (!comment) throw new ApiError(422, 'issue not found');
        const node: Typed = {
          type: 'IssueComment',
          value: { repo, issue, comment },
        };
        const edge: Typed = {
          type: 'IssueCommentEdge',
          value: { node, cursor: encodeCursor(comment.id) },
        };
        return select({ type: 'AddCommentPayload', value: { commentEdge: edge } });
      }
      default:
        return null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Mutation failed';
    state.errors.push({ message, path });
    return null;
  }
}

// ---------------------------------------------------------------------------
// One operation → one {data, errors?} envelope.
// ---------------------------------------------------------------------------

function executeOperation(store: Store, operation: unknown): Record<string, unknown> {
  if (!asRecord(operation) || typeof (operation as Record<string, unknown>).query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL operation needs a string "query".' }] };
  }
  const record = operation as Record<string, unknown>;
  const query = record.query as string;
  const variables = asRecord(record.variables) ?? {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  const state: ExecState = { store, variables, errors: [] };
  let parsed: Operation;
  try {
    parsed = new Parser(query).parseDocument(operationName);
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'Could not parse the GraphQL document.' }],
    };
  }
  const rootType = parsed.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(state, rootType, {}, parsed.selection, []);
  const out: Record<string, unknown> = { data: data ?? {} };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

// ---------------------------------------------------------------------------
// Handler: POST /api/graphql only; anything else is a 404 JSON.
// ---------------------------------------------------------------------------

export const handleGraphql: Handler = (_req, res, ctx) => {
  if (ctx.method !== 'POST') {
    sendError(res, 404, 'Not Found', ctx.requestId);
    return;
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((op) => executeOperation(ctx.store, op)), ctx.requestId);
    return;
  }
  sendJson(res, 200, executeOperation(ctx.store, body), ctx.requestId);
};
