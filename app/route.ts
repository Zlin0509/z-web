import { env } from 'cloudflare:workers';
import { getChatGPTUser } from './chatgpt-auth';
import { handleRequest } from '../server/controller.mjs';
export const dynamic = 'force-dynamic';
async function dispatch(request: Request) {
  const path = new URL(request.url).pathname;
  const user = path.startsWith('/admin') || path.startsWith('/api/admin/') ? await getChatGPTUser() : null;
  return handleRequest(request, env, user);
}
export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE, dispatch as HEAD };
