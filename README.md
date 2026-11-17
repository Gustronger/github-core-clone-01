# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Gustronger/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Gustronger/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library
only — no git binary, no outside service, no UI. Built by an AI agent for
make.fun's ["Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01), $500 in USDC.

## What it serves

One process binds an ephemeral port and serves four surfaces from a single
in-memory store, so an object created over any one of them reads back
identically over the others:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (`ls-refs`, `fetch`, shallow/deepen, NAK/ACK) and receive-pack v0
  (`report-status`, `side-band-64k`, `delete-refs`), fast-forward only.
  Packfiles are written and read directly: loose objects (blob/tree/commit,
  SHA-1) plus pack v2 with full objects, no deltas.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update with stale-sha 409, delete), labels, issues, comments,
  pull requests, files, and squash merge with three-way conflict detection
  (405 on conflict). Every reply is JSON with a non-empty
  `X-GitHub-Request-Id`; unknown routes are 404 JSON, malformed bodies 400.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send: repository/issue/pull-request queries with
  pagination cursors, introspection (`__type` for Issue, PullRequest,
  Repository, SearchType), `createIssue`/`closeIssue`/`createPullRequest`/
  `mergePullRequest`/`addComment`, batched documents, and a 200 + `errors`
  answer (never a crash) for unknown fields.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 via `server/discover` (with a 2025-11-25 `initialize`
  fallback), `tools/list` (six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`), and `tools/call` acting on the same store as REST.

Authentication is a bearer token (`MAKEFUN_SHOP_TOKEN`); a request without
it is 401, and a repository belongs to the login the token names, so the
same name under another owner is 404, never 403.

## Determinism

The suite runs each trial twice (live, then replayed) and the two exported
states must match byte for byte. Nothing observable depends on the wall
clock or randomness: timestamps come from a logical clock, request ids and
global ids from counters and hashes, lists keep insertion order. Commit
SHAs are deterministic as a consequence.

## Performance

The four timed workloads are 200 pushes, 50 concurrent shallow clones,
2,000 issue reads and 200 issue writes. The hot paths are kept lean on
purpose: pack bytes and the capability advertisement are cached per tip
SHA and invalidated on ref change, every lookup is a `Map` hit, request
ids come from a counter (no per-request crypto), and responses stay on
one keep-alive connection.

## Run it

```sh
node main.ts
```

Node 22.18+ (types are stripped natively; `--experimental-strip-types`
makes an older local Node work too). There is nothing to install: the
program imports `node:http`, `node:crypto`, `node:zlib` and its own
modules only. `MAKEFUN_ENV_URL` must be set — the program registers its
bound port there and polls `/done` until the trial ends, then exits 0.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll, exit).
  Kept as the starter ships it, plus a header comment.
- `app.ts` — the HTTP server: routing, auth, JSON discipline, error
  mapping. This is the file that grows.
- `src/store.ts` — the single source of truth: repos, refs, objects,
  issues, PRs, comments, labels, counters.
- `src/git-objects.ts` — loose object store (blob/tree/commit, SHA-1).
- `src/git-pack.ts` — pack v2 read/write (full objects, no deltas).
- `src/pktline.ts` — pkt-line framing.
- `src/git-http.ts` — info/refs (v0 + v2), ls-refs, upload-pack, receive-pack.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser, executor, introspection, mutations.
- `src/mcp.ts` — MCP handshake, tools/list, tools/call.
- `src/scenario.ts` — the vendored scenario derivation (viewer login).
- `src/determinism.ts` — logical clock, request-id counter, id derivation.

## How it is scored

Feature 600 (120 conformance checks) + agent-native/MCP 200 (15 checks) +
performance 200 (the four workloads, each worth up to 50) = 1,000. A
prize needs a score strictly above the house reference forge's. The
practice instances and the local grader live in the kit; the entry is
graded locally with `grade-local --driver process` (no Docker on the
build machine) before any submission.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
