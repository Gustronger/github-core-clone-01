// Git smart HTTP surface: info/refs (v0 + v2), ls-refs, upload-pack v2/v0
// and receive-pack. Implemented in the git step (PLAN §i step 2–3) against
// the suite's git-client.ts: the checks there are the spec.

import { sendError, type Handler } from './context.ts';

/** Placeholder until the git surface lands: every git route is a JSON 404. */
export const handleGit: Handler = (_req, res, ctx) => {
  sendError(res, 404, 'Not Found', ctx.requestId);
};
