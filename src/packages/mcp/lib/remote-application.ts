import { createRemoteServiceApplication } from '../../remote-service-client';
import type { McpApplicationPort } from './gateway';

interface RemoteApplicationOptions {
  readonly baseUrl: URL;
  readonly bearerToken: string;
  readonly channelType?: { readonly typeId: string; readonly typeVersion: string };
  readonly request: (request: Request) => Promise<Response>;
}

export async function createRemoteMcpApplication({
  baseUrl,
  bearerToken,
  channelType,
  request,
}: RemoteApplicationOptions): Promise<McpApplicationPort> {
  return createRemoteServiceApplication({
    baseUrl,
    bearerToken,
    ...(channelType === undefined ? {} : { channelType }),
    request,
  });
}
