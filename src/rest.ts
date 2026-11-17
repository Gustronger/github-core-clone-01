// REST v3 surface: /api/v3/* — repositories, branches, commits, contents,
// issues, labels, comments, pull requests and merges. Implemented in the
// REST steps (PLAN §i steps 4–6) against checks-rest.ts: the checks there
// are the spec.

import { sendError, type Handler } from './context.ts';

/** Placeholder until the REST surface lands: every REST route is a JSON 404. */
export const handleRest: Handler = (_req, res, ctx) => {
  sendError(res, 404, 'Not Found', ctx.requestId);
};
