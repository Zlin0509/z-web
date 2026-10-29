import { env } from 'cloudflare:workers';
import { getChatGPTUser } from './chatgpt-auth';
import { handleRequest } from '../server/controller.mjs';
export const dynamic='force-dynamic';
async function dispatch(request:Request){return handleRequest(request,env,await getChatGPTUser());}
export {dispatch as GET,dispatch as POST,dispatch as PUT,dispatch as DELETE};
