import { MUX_HOST, handleVlessMux } from './mux';
import {
  acceptWebSocket,
  concat,
  decodeBase64,
  bytesEqual,
  parseProxyTarget,
  queryDoh,
  resolveProxyTarget,
  type Env,
  type RequestParser,
} from './session';

export { decodeBase64, parseProxyTarget };

/**
 * VLESS over WebSocket handler for Cloudflare Workers.
 *
 * Request header layout (first client message):
 *   [0]            version
 *   [1..16]        user UUID (16 bytes)
 *   [17]           addon length M
 *   [18..18+M)     addon bytes (ignored)
 *   [18+M]         command (1 = TCP, 2 = UDP, 3 = Mux.Cool)
 *   [+1..+2]       port (big endian) for TCP/UDP only
 *   [+3]           address type (1 = IPv4, 2 = domain, 3 = IPv6) for TCP/UDP only
 *   [...]          address for TCP/UDP only
 *   [...]          initial payload (for MUX: the first Mux frame bytes)
 *
 * Response header (sent once, before the first upstream bytes): [version, 0].
 */

interface VlessHeader {
  version: number;
  command: number;
  hostname: string;
  port: number;
  payload: Uint8Array;
}

const CMD_TCP = 1;
const CMD_UDP = 2;
const CMD_MUX = 3;

const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 2;
const ATYP_IPV6 = 3;

export function uuidToBytes(uuid: string): Uint8Array | null {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function parseVlessHeader(data: Uint8Array, expectedUUID: Uint8Array): VlessHeader {
  if (data.length < 19) {
    throw new Error('vless header too short');
  }

  const version = data[0];
  if (version !== 0) {
    throw new Error(`unsupported version ${version}`);
  }

  if (!bytesEqual(data.subarray(1, 17), expectedUUID)) {
    throw new Error('invalid user');
  }

  const addonLength = data[17];
  let offset = 18 + addonLength;
  if (data.length < offset + 1) {
    throw new Error('vless header truncated');
  }

  const command = data[offset++];
  if (command === CMD_MUX) {
    return { version, command, hostname: MUX_HOST, port: 0, payload: data.subarray(offset) };
  }

  if (command !== CMD_TCP && command !== CMD_UDP) {
    throw new Error(`unsupported command ${command}`);
  }

  if (data.length < offset + 3) {
    throw new Error('vless header truncated');
  }

  const port = (data[offset] << 8) | data[offset + 1];
  offset += 2;
  if (port === 0) {
    throw new Error('invalid port');
  }

  const addressType = data[offset++];
  let hostname: string;

  switch (addressType) {
    case ATYP_IPV4: {
      if (data.length < offset + 4) {
        throw new Error('truncated ipv4 address');
      }
      hostname = Array.from(data.subarray(offset, offset + 4)).join('.');
      offset += 4;
      break;
    }

    case ATYP_DOMAIN: {
      if (data.length < offset + 1) {
        throw new Error('truncated domain');
      }
      const length = data[offset++];
      if (length === 0 || data.length < offset + length) {
        throw new Error('truncated domain');
      }
      hostname = new TextDecoder().decode(data.subarray(offset, offset + length));
      offset += length;
      break;
    }

    case ATYP_IPV6: {
      if (data.length < offset + 16) {
        throw new Error('truncated ipv6 address');
      }
      const groups: string[] = [];
      for (let index = 0; index < 8; index++) {
        const group = (data[offset + index * 2] << 8) | data[offset + index * 2 + 1];
        groups.push(group.toString(16));
      }
      hostname = groups.join(':');
      offset += 16;
      break;
    }

    default:
      throw new Error(`unknown address type ${addressType}`);
  }

  return { version, command, hostname, port, payload: data.subarray(offset) };
}

function createDnsProxy(
  onReply: (frame: Uint8Array) => void,
): (chunk: Uint8Array) => Promise<void> {
  let pending: Uint8Array = new Uint8Array(0);

  const resolve = async (query: Uint8Array): Promise<void> => {
    const answer = await queryDoh(query);
    if (!answer) {
      return;
    }

    const frame = new Uint8Array(2 + answer.length);
    new DataView(frame.buffer).setUint16(0, answer.length);
    frame.set(answer, 2);
    onReply(frame);
  };

  return async (chunk) => {
    pending = pending.length ? concat(pending, chunk) : chunk;
    const jobs: Promise<void>[] = [];

    while (pending.length >= 2) {
      const length = (pending[0] << 8) | pending[1];
      if (pending.length < 2 + length) {
        break;
      }

      jobs.push(resolve(pending.slice(2, 2 + length)) as Promise<void>);
      pending = pending.subarray(2 + length) as Uint8Array;
    }

    await Promise.all(jobs);
  };
}

export async function handleVlessWS(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const rawUUID = typeof env.UUID === 'string' ? env.UUID.trim() : '';
  const expectedUUID = rawUUID ? uuidToBytes(rawUUID) : null;
  if (!expectedUUID) {
    return new Response('UUID is not configured', { status: 500 });
  }

  const proxyTarget = resolveProxyTarget(new URL(request.url), env);

  const parse: RequestParser = (chunk) => {
    const header = parseVlessHeader(chunk, expectedUUID);
    const isUdp = header.command === CMD_UDP;
    const isMux = header.command === CMD_MUX;
    if (isUdp && header.port !== 53) {
      throw new Error('only UDP port 53 (DNS) is supported');
    }

    return {
      hostname: header.hostname,
      port: header.port,
      payload: header.payload,
      responseHeader: new Uint8Array([header.version, 0]),
      datagram: isUdp ? createDnsProxy : isMux ? (reply) => handleVlessMux(reply, proxyTarget) : null,
    };
  };

  return acceptWebSocket(request, env, parse);
}
