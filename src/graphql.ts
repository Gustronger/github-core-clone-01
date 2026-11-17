// GraphQL v4 surface: POST /api/graphql — a hand-written parser and
// executor for the 18 fixed documents the suite sends, plus introspection
// and the five mutations. Implemented in the GraphQL step (PLAN §i step 7)
// against checks-graphql.ts: the checks there are the spec.

import { sendError, type Handler } from './context.ts';

/** Placeholder until the GraphQL surface lands: the endpoint is a JSON 404. */
export const handleGraphql: Handler = (_req, res, ctx) => {
  sendError(res, 404, 'Not Found', ctx.requestId);
};
