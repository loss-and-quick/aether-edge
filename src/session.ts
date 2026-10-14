import { connect } from 'cloudflare:sockets';

export type Env = { UUID?: string; PASSWORD?: string; PROXYIP?: string; [key: string]: unknown };

export interface ProxyTarget {
  hostname: string;
  port: number;
}

export const WS_OPEN = 1;
const WS_CLOSING = 2;

const DOH_URL = 'https://dns.google/dns-query';
const DEFAULT_PROXY_PORT = 443;

/** Cloudflare IPv4 ranges: direct connections to these are not allowed from Workers. */
const CLOUDFLARE_CIDRS_V4: ReadonlyArray<readonly [number, number]> = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
].map((cidr) => {
  const [ip, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return [(ipv4ToInt(ip) & mask) >>> 0, mask] as const;
});

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((accumulator, part) => {
    return ((accumulator << 8) | (Number(part) & 0xff)) >>> 0;
  }, 0);
}

export function isCloudflareIPv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return false;
  }

  const value = ipv4ToInt(host);
  return CLOUDFLARE_CIDRS_V4.some(([network, mask]) => (value & mask) >>> 0 === network);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

export function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

export function decodeBase64(input: string): Uint8Array | null {
  try {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    let normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    if (pad) {
      normalized += '='.repeat(4 - pad);
    }
    const binary = atob(normalized);
    const output = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) {
      output[index] = binary.charCodeAt(index);
    }

    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

export function safeCloseWS(webSocket: WebSocket, code = 1000, reason = ''): void {
  try {
    if (webSocket.readyState === WS_OPEN || webSocket.readyState === WS_CLOSING) {
      webSocket.close(code, reason);
    }
  } catch {
    // Already closed.
  }
}

export function safeCloseSocket(socket: Socket | null): void {
  try {
    void socket?.close().catch(() => {});
  } catch {
    // Already closed.
  }
}

export function parseProxyTarget(raw: string | null | undefined): ProxyTarget | null {
  if (!raw) {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { hostname: bracketed[1], port: Number(bracketed[2] ?? DEFAULT_PROXY_PORT) };
  }

  if ((value.match(/:/g) ?? []).length > 1) {
    return { hostname: value, port: DEFAULT_PROXY_PORT };
  }

  const [hostname, port] = value.split(':');
  const portNumber = port ? Number(port) : DEFAULT_PROXY_PORT;
  if (!hostname || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return null;
  }

  return { hostname, port: portNumber };
}

export function resolveProxyTarget(url: URL, env: Env): ProxyTarget | null {
  const queryValue = url.searchParams.get('proxyip') ?? url.searchParams.get('proxyIP');
  const queryTarget = parseProxyTarget(queryValue);
  if (queryTarget) {
    return queryTarget;
  }

  let path = '';
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }

  const fromPath = path.match(/^\/(?:proxyip=)?([^/\s]+\.[^/\s]+|\[[^\]]+\](?::\d+)?)$/i);
  if (fromPath && /proxyip=/i.test(path)) {
    const pathTarget = parseProxyTarget(fromPath[1]);
    if (pathTarget) {
      return pathTarget;
    }
  }

  if (fromPath && /:\d+$/.test(fromPath[1])) {
    const pathTarget = parseProxyTarget(fromPath[1]);
    if (pathTarget) {
      return pathTarget;
    }
  }

  if (!env.PROXYIP) {
    return null;
  }

  const values = String(env.PROXYIP)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return null;
  }

  return parseProxyTarget(values[Math.floor(Math.random() * values.length)]);
}

export async function queryDoh(query: Uint8Array): Promise<Uint8Array | null> {
  try {
    const response = await fetch(DOH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/dns-message',
        accept: 'application/dns-message',
      },
      body: query,
    });

    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Handles datagram chunks of one UDP session; `reply` sends a framed answer to the client. */
export type DatagramFactory = (
  reply: (frame: Uint8Array) => void,
) => (chunk: Uint8Array) => Promise<void>;

export interface SessionRequest {
  hostname: string;
  port: number;
  payload: Uint8Array;
  /** Prepended to the first upstream bytes; empty when the protocol has none. */
  responseHeader: Uint8Array;
  /** Set for UDP requests; TCP requests are forwarded to hostname:port. */
  datagram: DatagramFactory | null;
}

/** Parses the first client message; throws to reject the session. */
export type RequestParser = (chunk: Uint8Array) => SessionRequest;

export function acceptWebSocket(request: Request, env: Env, parse: RequestParser): Response {
  const proxyTarget = resolveProxyTarget(new URL(request.url), env);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const protocolHeader = request.headers.get('Sec-WebSocket-Protocol');
  const earlyData = protocolHeader ? decodeBase64(protocolHeader) : null;

  runSession(server, earlyData, parse, proxyTarget);

  const headers = new Headers();
  if (protocolHeader && earlyData) {
    headers.set('Sec-WebSocket-Protocol', protocolHeader);
  }

  return new Response(null, { status: 101, webSocket: client, headers });
}

function runSession(
  webSocket: WebSocket,
  earlyData: Uint8Array | null,
  parse: RequestParser,
  proxyTarget: ProxyTarget | null,
): void {
  let remote: Socket | null = null;
  let remoteWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let dnsHandler: ((chunk: Uint8Array) => Promise<void>) | null = null;
  let headerParsed = false;
  let subsequentDataSent = false;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  const cleanup = (code = 1000, reason = ''): void => {
    if (closed) {
      return;
    }

    closed = true;
    try {
      remoteWriter?.releaseLock();
    } catch {
      // Ignore pending writes.
    }

    safeCloseSocket(remote);
    safeCloseWS(webSocket, code, reason);
  };

  const handleChunk = async (chunk: Uint8Array): Promise<void> => {
    if (closed) {
      return;
    }

    if (headerParsed) {
      if (dnsHandler) {
        await dnsHandler(chunk);
      } else if (remoteWriter) {
        subsequentDataSent = true;
        await remoteWriter.write(chunk);
      }
      return;
    }

    const header = parse(chunk);
    headerParsed = true;
    const { responseHeader } = header;

    if (header.datagram) {
      let headerSent = false;
      dnsHandler = header.datagram((frame) => {
        if (closed || webSocket.readyState !== WS_OPEN) {
          return;
        }

        webSocket.send(headerSent ? frame : concat(responseHeader, frame));
        headerSent = true;
      });

      if (header.payload.length) {
        await dnsHandler(header.payload);
      }
      return;
    }

    await openTcp(header);
  };

  const openTcp = async (header: SessionRequest): Promise<void> => {
    const { responseHeader } = header;
    const direct: ProxyTarget = { hostname: header.hostname, port: header.port };
    const mustProxy = isCloudflareIPv4(header.hostname);
    const firstTarget = mustProxy && proxyTarget ? proxyTarget : direct;

    const attach = async (target: ProxyTarget, initialPayload: Uint8Array): Promise<Socket> => {
      const socket = connect({ hostname: target.hostname, port: target.port });
      await socket.opened;

      remote = socket;
      remoteWriter = socket.writable.getWriter();
      if (initialPayload.length) {
        await remoteWriter.write(initialPayload);
      }

      return socket;
    };

    let socket: Socket;
    let viaProxy = firstTarget === proxyTarget;

    try {
      socket = await attach(firstTarget, header.payload);
    } catch (error) {
      if (viaProxy || !proxyTarget) {
        throw error;
      }

      viaProxy = true;
      socket = await attach(proxyTarget, header.payload);
    }

    const pipe = async (current: Socket, canRetry: boolean): Promise<void> => {
      let received = false;
      let sentHeader = false;

      try {
        const reader = current.readable.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            if (!value?.length || closed || webSocket.readyState !== WS_OPEN) {
              continue;
            }

            received = true;
            webSocket.send(sentHeader ? value : concat(responseHeader, value));
            sentHeader = true;
          }
        } finally {
          reader.releaseLock();
        }
      } catch {
        // Upstream errors are handled by the fallback or cleanup path below.
      }

      if (closed) {
        return;
      }

      if (!received && canRetry && proxyTarget && !subsequentDataSent) {
        try {
          if (remoteWriter) {
            remoteWriter.releaseLock();
            remoteWriter = null;
          }
        } catch {
          // Ignore release issues.
        }

        safeCloseSocket(current);

        try {
          const retried = await attach(proxyTarget, header.payload);
          return await pipe(retried, false);
        } catch {
          // Fall through to cleanup.
        }
      }

      if (responseHeader.length && !sentHeader && !closed && webSocket.readyState === WS_OPEN) {
        try {
          webSocket.send(responseHeader);
          sentHeader = true;
        } catch {
          // Ignore errors when sending response header before closing.
        }
      }

      cleanup();
    };

    void pipe(socket, !viaProxy);
  };

  webSocket.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === 'string') {
      return;
    }

    const chunk = new Uint8Array(data as ArrayBuffer);
    chain = chain
      .then(() => handleChunk(chunk))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message.slice(0, 100) : 'error';
        cleanup(1011, reason);
      });
  });

  webSocket.addEventListener('close', () => cleanup());
  webSocket.addEventListener('error', () => cleanup(1011, 'websocket error'));

  if (earlyData?.length) {
    chain = chain
      .then(() => handleChunk(earlyData))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message.slice(0, 100) : 'error';
        cleanup(1011, reason);
      });
  }
}
