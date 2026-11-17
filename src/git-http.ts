// Git smart HTTP surface: info/refs (v0 + v2), ls-refs, upload-pack v2/v0
// and receive-pack. Implemented against the suite's git-client.ts — the
// checks there are the spec (PLAN §b, §i steps 2–3).
//
// Protocol notes (what the client actually parses):
// - info/refs v2: `version 2` + capability lines + flush, NO service
//   preamble, NO agent capability. v0: `# service=...` preamble + flush,
//   ref lines `<oid> <ref>\0<caps>` (caps on the first line only), flush.
// - ls-refs v2: ref lines only + flush (no `version 2` line — the client
//   parses every data packet as a ref line).
// - fetch v2 sections, in order: acknowledgments, delim, shallow-info,
//   delim, wanted-refs, delim, packfile (sideband band 1), flush. The
//   shallow-info section is sent only when a depth was requested or the
//   client sent shallow boundaries; the packfile section is omitted
//   entirely when there is nothing to send.
// - receive-pack: command pkt-lines + flush + raw pack bytes; the report
//   is `unpack ok` + one `ok`/`ng` line per ref, pkt-lined inside sideband
//   band 1, then flush.
// - A missing repo is 404 on every git route; a foreign owner is 404,
//   never 403. Malformed pkt-lines are answered 400 and never crash the
//   process (app.ts maps ApiError; anything else is caught here).
//
// Depth semantics: store.reachable()'s depth option does NOT limit the
// walk — it runs collectReachable() per included commit, which follows
// parents, so depth 1 returns the full history (verified 2026-11-17 with
// a 3-commit probe: reachable(depth:1) held all 9 objects). The
// depth-limited collection below therefore walks commits itself and only
// collects each included commit's tree closure, never its parents.

import { sendError, sendRaw, type Handler, type HandlerCtx } from './context.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type Repo, type Store } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  decodePktLines,
  packetLines,
  pktLine,
  pktLines,
  sideband,
  splitAtFlush,
} from './pktline.ts';
import {
  ZERO_OID,
  collectReachable,
  isObjectId,
  parseCommit,
  type GitObject,
} from './git-objects.ts';
import { readPack, writePack } from './git-pack.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** v0 capabilities: the first ref line carries them after a NUL. */
const V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta agent=forge/1.0 ' +
  'report-status delete-refs shallow symref=HEAD:refs/heads/main';

// ---------------------------------------------------------------------------
// caches (PLAN §h): advertisements per repo state version; packs per
// (tip set, depth, have set). Buffers are never mutated, so sharing them
// across concurrent clones is safe. Keyed off the Repo object itself, so
// two Store instances can never collide.
// ---------------------------------------------------------------------------

interface CachedAd {
  version: number;
  buffer: Buffer;
}

const adCache = new WeakMap<Repo, Map<string, CachedAd>>();
const packCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedAd(repo: Repo, key: string, build: () => Buffer): Buffer {
  let perRepo = adCache.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    adCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit && hit.version === repo.stateVersion) return hit.buffer;
  const buffer = build();
  perRepo.set(key, { version: repo.stateVersion, buffer });
  return buffer;
}

function cachedPack(repo: Repo, key: string, build: () => Buffer): Buffer {
  let perRepo = packCache.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    packCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit) return hit;
  const buffer = build();
  if (perRepo.size >= 64) perRepo.clear();
  perRepo.set(key, buffer);
  return buffer;
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

/** Resolve the repo for a git route: foreign owner → 404, missing repo → 404. */
function resolveRepo(ctx: HandlerCtx): Repo {
  const owner = ctx.segments[0] ?? '';
  const repoSegment = ctx.segments[1] ?? '';
  if (!repoSegment.endsWith('.git')) throw new ApiError(404, 'Not Found');
  if (owner !== VIEWER_LOGIN) throw new ApiError(404, 'Not Found');
  const repo = ctx.store.getRepo(repoSegment.slice(0, -4));
  if (!repo) throw new ApiError(404, 'Not Found');
  return repo;
}

function isV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const value = Array.isArray(header) ? header[0] : header;
  return value === 'version=2';
}

/** The peeled commit of a ref, when the ref names an annotated tag. */
function peeledCommit(store: Store, repo: Repo, oid: string): string | undefined {
  const object = store.getObject(repo, oid);
  if (!object || object.type !== 'tag') return undefined;
  return store.resolveToCommit(repo, oid);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function buildV0Advertisement(store: Store, repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${V0_CAPS}\n`));
  } else {
    const headOid = store.getRef(repo, store.headTarget(repo)) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledCommit(store, repo, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function buildV2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'fetch=shallow thin-pack\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
  repo: Repo,
): void {
  const service = ctx.query.get('service') ?? 'git-upload-pack';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    throw new ApiError(404, 'Not Found');
  }
  // Receive-pack is v0-only, whatever the client asked for.
  const v2 = service === 'git-upload-pack' && isV2(req);
  if (v2) {
    const body = cachedAd(repo, 'v2', buildV2Advertisement);
    sendRaw(res, 200, body, UPLOAD_AD_CT, ctx.requestId);
    return;
  }
  const contentType = service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT;
  const body = cachedAd(repo, `v0:${service}`, () => buildV0Advertisement(ctx.store, repo, service));
  sendRaw(res, 200, body, contentType, ctx.requestId);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(res: ServerResponse, ctx: HandlerCtx, repo: Repo, lines: string[]): void {
  if (!lines[0]?.startsWith('command=ls-refs')) {
    throw new ApiError(400, 'expected command=ls-refs');
  }
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    // agent=, object-format=, unborn and anything else: parsed, not needed
    // beyond the flags above (unborn HEAD is always reported when unborn).
  }
  const headTarget = ctx.store.headTarget(repo);
  const out: string[] = [];
  const refs = ctx.store.listRefs(repo);
  if (refs.length === 0) {
    // Unborn repo: the one line the empty-clone check reads. With a
    // ref-prefix filter HEAD is excluded, so nothing is reported.
    if (prefixes.length === 0) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  } else if (prefixes.length === 0) {
    const headOid = ctx.store.getRef(repo, headTarget) ?? ZERO_OID;
    out.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    for (const ref of refs) {
      out.push(lsRefLine(ctx.store, repo, ref, peel));
    }
  } else {
    for (const ref of refs) {
      if (prefixes.some((prefix) => ref.name.startsWith(prefix))) {
        out.push(lsRefLine(ctx.store, repo, ref, peel));
      }
    }
  }
  sendRaw(res, 200, pktLines([...out, 'flush']), UPLOAD_RESULT_CT, ctx.requestId);
}

function lsRefLine(store: Store, repo: Repo, ref: { name: string; oid: string }, peel: boolean): string {
  let line = `${ref.oid} ${ref.name}`;
  if (peel) {
    const peeled = peeledCommit(store, repo, ref.oid);
    if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
  }
  return `${line}\n`;
}

// ---------------------------------------------------------------------------
// fetch: shared negotiation + pack building for v2 and v0
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Acknowledgment lines, without trailing newline. */
  ackLines: string[];
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
  /** The pack bytes, or null when there is nothing to send. */
  pack: Buffer | null;
}

/**
 * Depth-limited object collection (see the header note: store.reachable
 * cannot do this). Returns the included commits and every object under
 * them — each included commit itself plus its tree closure — never a
 * parent commit or anything above the boundary.
 */
function depthLimitedObjects(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  depth: number,
): { commits: Set<string>; objects: Set<string> } {
  const commits = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = [];
  const tagObjects = new Set<string>();
  for (const want of wants) {
    const object = store.getObject(repo, want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const commit = store.resolveToCommit(repo, want);
      if (commit) queue.push({ oid: commit, generation: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, generation: 1 });
    } else if (object.type === 'tree' || object.type === 'blob') {
      // A want naming a tree/blob directly: it is its own object.
      tagObjects.add(want);
    }
  }
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, generation } = queue.pop()!;
    if (seen.has(oid) || generation > depth) continue;
    seen.add(oid);
    commits.add(oid);
    if (generation === depth) continue;
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, generation: generation + 1 });
    }
  }
  const objects = new Set<string>(tagObjects);
  const lookup = (oid: string): GitObject | undefined => store.getObject(repo, oid);
  for (const oid of commits) {
    objects.add(oid);
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const reachableOid of collectReachable([parseCommit(object.data).tree], lookup, {
      allowMissing: true,
    })) {
      objects.add(reachableOid);
    }
  }
  return { commits, objects };
}

function sortPackObjects(store: Store, repo: Repo, oids: Iterable<string>): GitObject[] {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = store.getObject(repo, oid);
    if (object) objects.push(object);
  }
  // Deterministic order (type, then oid) so the same fetch is byte-identical.
  objects.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return objects;
}

/**
 * What the client already holds, given its haves and its current shallow
 * boundaries: the commit closure of the haves, stopping at (but including)
 * each shallow boundary commit, plus each held commit's tree closure. With
 * no shallow boundaries this is the full closure; with them it is exactly
 * a shallow clone's contents — using the full closure here would wrongly
 * exclude the parent a deepen fetch is supposed to deliver.
 */
function heldObjects(
  store: Store,
  repo: Repo,
  haves: readonly string[],
  shallowBoundaries: readonly string[],
): Set<string> {
  const boundary = new Set(shallowBoundaries);
  const commits = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) {
    const object = store.getObject(repo, have);
    if (!object) continue;
    if (object.type === 'tag') {
      commits.add(have);
      const commit = store.resolveToCommit(repo, have);
      if (commit) queue.push(commit);
    } else if (object.type === 'commit') {
      queue.push(have);
    } else {
      commits.add(have);
    }
  }
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    commits.add(oid);
    if (boundary.has(oid)) continue;
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const out = new Set<string>(commits);
  const lookup = (oid: string): GitObject | undefined => store.getObject(repo, oid);
  for (const oid of commits) {
    const object = store.getObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const reachableOid of collectReachable([parseCommit(object.data).tree], lookup, {
      allowMissing: true,
    })) {
      out.add(reachableOid);
    }
  }
  return out;
}

function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const wantSet = new Set(wants);
  const haveReachable = heldObjects(store, repo, haves, shallowIn);
  const wantCommits = wants
    .map((want) => store.resolveToCommit(repo, want))
    .filter((oid): oid is string => oid !== undefined);

  // Included commits and objects, minus anything the client already holds.
  // "Already held" is judged on the requested closure, not on the want
  // alone: a deepen fetch holds its tip commit yet still needs the parent.
  let includedCommits: Set<string>;
  let objects: Set<string>;
  if (depth !== undefined) {
    const limited = depthLimitedObjects(store, repo, wants, depth);
    includedCommits = limited.commits;
    objects = limited.objects;
  } else {
    objects = store.reachable(repo, wants, { exclude: haveReachable });
    includedCommits = new Set<string>();
    for (const want of wantCommits) {
      for (const commit of store.walkHistory(repo, want)) includedCommits.add(commit);
    }
  }
  for (const oid of haveReachable) objects.delete(oid);
  const allHeld = wantCommits.length > 0 && objects.size === 0;

  let ackLines: string[];
  if (haves.length === 0) {
    ackLines = ['NAK'];
  } else if (allHeld) {
    const acked =
      haves.find((have) => wantCommits.some((want) => store.isAncestor(repo, have, want))) ?? haves[0];
    ackLines = [`ACK ${acked} ready`];
  } else {
    const qualifying = haves.filter((have) =>
      wantCommits.some((want) => store.isAncestor(repo, have, want)),
    );
    ackLines =
      qualifying.length > 0 ? qualifying.map((have) => `ACK ${have} continue`) : ['NAK'];
  }

  // Shallow boundary of what this fetch includes; previously-shallow
  // commits that are now fully included become unshallow lines.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined || shallowIn.length > 0) {
    shallow = store.shallowBoundary(repo, includedCommits).sort();
    const shallowSet = new Set(shallow);
    unshallow = shallowIn
      .filter((oid) => includedCommits.has(oid) && !shallowSet.has(oid))
      .sort();
  }

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of store.listRefs(repo)) {
    if (
      wantSet.has(ref.oid) ||
      wantCommits.includes(store.resolveToCommit(repo, ref.oid) ?? '')
    ) {
      wantedRefs.push({ oid: ref.oid, ref: ref.name });
    }
  }

  let pack: Buffer | null = null;
  if (objects.size > 0 && !allHeld) {
    const key = [
      repo.stateVersion,
      repo.objects.size,
      depth ?? '',
      [...wantSet].sort().join(','),
      [...haves].sort().join(','),
      // The held set (and therefore the pack) also depends on the client's
      // shallow boundaries: the same wants/depth/haves with a different
      // boundary must not share a cached pack.
      [...shallowIn].sort().join(','),
    ].join('|');
    pack = cachedPack(repo, key, () =>
      writePack(sortPackObjects(store, repo, objects).map((object) => ({
        type: object.type,
        data: object.data,
      }))),
    );
  }
  return { ackLines, shallow, unshallow, wantedRefs, pack };
}

function handleFetchV2(res: ServerResponse, ctx: HandlerCtx, repo: Repo, lines: string[]): void {
  if (!lines[0]?.startsWith('command=fetch')) {
    throw new ApiError(400, 'expected command=fetch');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // agent=, object-format=, thin-pack, no-progress, ofs-delta, filter,
    // deepen-since, deepen-not, done: parsed and ignored.
  }
  for (const oid of [...wants, ...haves]) {
    if (!isObjectId(oid)) throw new ApiError(400, `bad object id ${oid}`);
  }
  const plan = planFetch(ctx.store, repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const line of plan.ackLines) parts.push(pktLine(`${line}\n`));
  parts.push(PKT_DELIM);
  if (depth !== undefined || shallowIn.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('wanted-refs\n'));
  // NOTE: each line is a bare `<oid> <ref>` — the client's parseV2Fetch
  // takes the text before the first space as the oid, so no `wanted-ref`
  // prefix here (the task text's `wanted-ref <sha> <ref>` would fail it).
  for (const ref of plan.wantedRefs) parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
  parts.push(PKT_DELIM);
  if (plan.pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(plan.pack, 1));
  }
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), UPLOAD_RESULT_CT, ctx.requestId);
}

function handleFetchV0(res: ServerResponse, ctx: HandlerCtx, repo: Repo): void {
  const packets = decodePktLines(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      wants.push(line.slice(5).split(' ')[0]);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // done and anything else: ignored.
  }
  if (wants.length === 0) throw new ApiError(400, 'v0 upload-pack needs a want line');
  for (const oid of [...wants, ...haves]) {
    if (!isObjectId(oid)) throw new ApiError(400, `bad object id ${oid}`);
  }
  const plan = planFetch(ctx.store, repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  for (const line of plan.ackLines) parts.push(pktLine(`${line}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.pack !== null) parts.push(sideband(plan.pack, 1));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), UPLOAD_RESULT_CT, ctx.requestId);
}

function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
  repo: Repo,
): void {
  if (isV2(req)) {
    // v2: the first line names the command; ls-refs and fetch share the
    // route. Decode once here and hand the lines down (decoding twice
    // would double the work on every fetch, including the 50-clone burst).
    const lines = packetLines(decodePktLines(ctx.body));
    const first = lines[0] ?? '';
    if (first.startsWith('command=ls-refs')) {
      handleLsRefs(res, ctx, repo, lines);
      return;
    }
    if (first.startsWith('command=fetch')) {
      handleFetchV2(res, ctx, repo, lines);
      return;
    }
    throw new ApiError(400, 'unknown v2 upload-pack command');
  }
  handleFetchV0(res, ctx, repo);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, ctx: HandlerCtx, repo: Repo): void {
  const { packets, restOffset } = splitAtFlush(ctx.body);
  const commands: PushCommand[] = [];
  let sidebandRequested = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sidebandRequested = true;
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
      throw new ApiError(400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new ApiError(400, 'receive-pack needs a command');

  // Unpack first: objects are stored even when a ref update is refused.
  let unpackError: string | null = null;
  const packBytes = ctx.body.subarray(restOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, {
        resolveBase: (oid) => ctx.store.getObject(repo, oid),
      });
      for (const object of objects.values()) {
        ctx.store.putObject(repo, object.type, object.data);
      }
    } catch (err) {
      unpackError = (err instanceof Error ? err.message : 'unpack failed').replace(/\n/g, ' ');
    }
  }

  // Evaluate every command against the pre-push tips, then apply only the
  // fast-forward ones (a mixed push moves the ok refs and leaves the rest).
  const currentTips = new Map(repo.refs);
  const headTarget = ctx.store.headTarget(repo);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    let ok = false;
    if (unpackError !== null) {
      ok = false;
    } else if (command.newOid === ZERO_OID) {
      // Delete: the ref must exist and must not be the default branch.
      ok = currentTips.has(command.ref) && command.ref !== headTarget;
    } else if (command.oldOid === ZERO_OID) {
      // Create: the ref must not exist and the new object must be stored.
      ok = !currentTips.has(command.ref) && ctx.store.getObject(repo, command.newOid) !== undefined;
    } else if (currentTips.get(command.ref) === command.oldOid) {
      ok = ctx.store.isAncestor(repo, command.oldOid, command.newOid);
    }
    results.push({
      ref: command.ref,
      ok,
      reason: ok ? '' : unpackError !== null ? 'unpack failed' : 'non-fast-forward',
    });
  }
  for (let i = 0; i < commands.length; i += 1) {
    if (!results[i].ok) continue;
    const command = commands[i];
    if (command.newOid === ZERO_OID) ctx.store.deleteRef(repo, command.ref);
    else ctx.store.setRef(repo, command.ref, command.newOid);
  }

  const reportLines = [
    `unpack ${unpackError === null ? 'ok' : unpackError}\n`,
    ...results.map((result) =>
      result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`,
    ),
  ];
  const report = pktLines(reportLines);
  const body = sidebandRequested
    ? Buffer.concat([sideband(report, 1), PKT_FLUSH])
    : Buffer.concat([report, PKT_FLUSH]);
  sendRaw(res, 200, body, RECEIVE_RESULT_CT, ctx.requestId);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export const handleGit: Handler = (req, res, ctx) => {
  try {
    const repo = resolveRepo(ctx);
    const rest = ctx.segments.slice(2);
    if (ctx.method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
      handleInfoRefs(req, res, ctx, repo);
      return;
    }
    if (ctx.method === 'POST' && rest[0] === 'git-upload-pack') {
      handleUploadPack(req, res, ctx, repo);
      return;
    }
    if (ctx.method === 'POST' && rest[0] === 'git-receive-pack') {
      handleReceivePack(res, ctx, repo);
      return;
    }
    throw new ApiError(404, 'Not Found');
  } catch (err) {
    // A malformed pkt-line, a corrupt pack, a bad oid: answer 400 and keep
    // serving. ApiErrors keep their own status (404 for a missing repo).
    if (err instanceof ApiError) {
      sendError(res, err.status, err.message, ctx.requestId);
      return;
    }
    sendError(res, 400, err instanceof Error ? err.message : 'Bad Request', ctx.requestId);
  }
};
