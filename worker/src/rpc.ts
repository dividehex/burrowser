/** Browser control goes through the MCP endpoint (/mcp); /rpc is only for what MCP has no equivalent for. */
export const WORKER_METHODS = ['passkeyEnrollBegin', 'passkeyEnrollPoll', 'passkeyList', 'thumbnail'] as const;

export function authorizeWorkerRequest(headers: Record<string, string | string[] | undefined>, credential: string) {
  const authorization = headers.authorization;
  return typeof authorization === 'string' && authorization === `Bearer ${credential}`;
}

export function validateRpcMethod(method: unknown) {
  if (typeof method !== 'string' || !(WORKER_METHODS as readonly string[]).includes(method)) throw new Error('worker method not allowed');
  return method as typeof WORKER_METHODS[number];
}
