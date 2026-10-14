import {
  acceptWebSocket,
  bytesEqual,
  concat,
  queryDoh,
  type DatagramFactory,
  type Env,
  type RequestParser,
} from './session';

/**
 * Trojan over WebSocket handler for Cloudflare Workers.
 *
 * Request header layout (first client message):
 *   [0..55]        lowercase hex of SHA-224(password), ASCII
 *   [56..57]       CRLF
 *   [58]           command (1 = TCP connect, 3 = UDP associate)
 *   [59]           address type (1 = IPv4, 3 = domain, 4 = IPv6)
 *   [...]          address (domain is prefixed with a 1-byte length)
 *   [...]          port (big endian)
 *   [...]          CRLF
 *   [...]          initial payload
 *
 * Unlike VLESS, Trojan has no response header: upstream bytes are sent as they are.
 * UDP packets use the same address encoding followed by a 2-byte length, CRLF and the data.
 */

export interface TrojanHeader {
  command: number;
  hostname: string;
  port: number;
  payload: Uint8Array;
}

interface TrojanAddress {
  hostname: string;
  port: number;
  /** Offset of the first byte after the port. */
  next: number;
}

const HASH_HEX_LENGTH = 56;
const CR = 0x0d;
const LF = 0x0a;

const CMD_TCP = 1;
const CMD_UDP = 3;

const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;

const DNS_PORT = 53;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA224_IV = [
  0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
];

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-224 (FIPS 180-4). WebCrypto in Workers has no SHA-224, so it is computed here. */
export function sha224(message: Uint8Array): Uint8Array {
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLength = message.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const state = Uint32Array.from(SHA224_IV);
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index++) {
      w[index] = view.getUint32(block + index * 4);
    }

    for (let index = 16; index < 64; index++) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = w[index - 16] + s0 + w[index - 7] + s1;
    }

    let [a, b, c, d, e, f, g, h] = state;

    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      state[index] += value;
    });
  }

  const digest = new Uint8Array(28);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 7; index++) {
    digestView.setUint32(index * 4, state[index]);
  }
  return digest;
}

/** The 56 ASCII bytes a Trojan client sends as credentials. */
export function trojanPasswordHash(password: string): Uint8Array {
  const hex = Array.from(sha224(new TextEncoder().encode(password)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return new TextEncoder().encode(hex);
}

export function resolveTrojanPassword(env: Env): string | null {
  for (const value of [env.PASSWORD, env.UUID]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readAddress(data: Uint8Array, offset: number): TrojanAddress {
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
      const length = data[offset++];
      if (!length || data.length < offset + length) {
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
        groups.push(((data[offset + index * 2] << 8) | data[offset + index * 2 + 1]).toString(16));
      }
      hostname = groups.join(':');
      offset += 16;
      break;
    }

    default:
      throw new Error(`unknown address type ${addressType}`);
  }

  if (data.length < offset + 2) {
    throw new Error('truncated port');
  }

  const port = (data[offset] << 8) | data[offset + 1];
  if (port === 0) {
    throw new Error('invalid port');
  }

  return { hostname, port, next: offset + 2 };
}

export function parseTrojanHeader(data: Uint8Array, expectedHash: Uint8Array): TrojanHeader {
  if (data.length < HASH_HEX_LENGTH + 2 + 2) {
    throw new Error('trojan header too short');
  }

  if (!bytesEqual(data.subarray(0, HASH_HEX_LENGTH), expectedHash)) {
    throw new Error('invalid user');
  }

  if (data[HASH_HEX_LENGTH] !== CR || data[HASH_HEX_LENGTH + 1] !== LF) {
    throw new Error('invalid header format (missing CRLF)');
  }

  let offset = HASH_HEX_LENGTH + 2;
  const command = data[offset++];
  if (command !== CMD_TCP && command !== CMD_UDP) {
    throw new Error(`unsupported command ${command}`);
  }

  const { hostname, port, next } = readAddress(data, offset);
  if (data.length < next + 2 || data[next] !== CR || data[next + 1] !== LF) {
    throw new Error('invalid header format (missing CRLF)');
  }

  return { command, hostname, port, payload: data.subarray(next + 2) };
}

/** Answers Trojan UDP packets addressed to port 53 through DNS-over-HTTPS; others are dropped. */
const createTrojanDnsProxy: DatagramFactory = (reply) => {
  let pending: Uint8Array = new Uint8Array(0);

  const resolve = async (addressBytes: Uint8Array, query: Uint8Array): Promise<void> => {
    const answer = await queryDoh(query);
    if (!answer) {
      return;
    }

    const lengthAndCrlf = new Uint8Array([answer.length >> 8, answer.length & 0xff, CR, LF]);
    reply(concat(concat(addressBytes, lengthAndCrlf), answer));
  };

  return async (chunk) => {
    pending = pending.length ? concat(pending, chunk) : chunk;
    const jobs: Promise<void>[] = [];

    for (;;) {
      let address: TrojanAddress;
      try {
        address = readAddress(pending, 0);
      } catch {
        break;
      }

      const bodyStart = address.next + 4;
      if (pending.length < bodyStart) {
        break;
      }

      const length = (pending[address.next] << 8) | pending[address.next + 1];
      if (pending.length < bodyStart + length) {
        break;
      }

      if (pending[address.next + 2] !== CR || pending[address.next + 3] !== LF) {
        throw new Error('invalid udp packet (missing CRLF)');
      }

      if (address.port === DNS_PORT) {
        jobs.push(
          resolve(pending.slice(0, address.next), pending.slice(bodyStart, bodyStart + length)),
        );
      }
      pending = pending.subarray(bodyStart + length);
    }

    await Promise.all(jobs);
  };
};

export async function handleTrojanWS(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const password = resolveTrojanPassword(env);
  if (!password) {
    return new Response('PASSWORD or UUID is not configured', { status: 500 });
  }

  const expectedHash = trojanPasswordHash(password);

  const parse: RequestParser = (chunk) => {
    const header = parseTrojanHeader(chunk, expectedHash);
    const isUdp = header.command === CMD_UDP;

    return {
      hostname: header.hostname,
      port: header.port,
      payload: header.payload,
      responseHeader: new Uint8Array(0),
      datagram: isUdp ? createTrojanDnsProxy : null,
    };
  };

  return acceptWebSocket(request, env, parse);
}
