import { handler } from './handler.ts';
import { denoDeps } from '../_shared/deno.ts';

declare const Deno: { serve(h: (req: Request) => Response | Promise<Response>): unknown };

const deps = denoDeps();
Deno.serve(async (req) => {
  try {
    return await handler(req, deps);
  } catch (e) {
    deps.log('unhandled', { error: (e as Error).message });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
