import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import worker from '../src/index';
import {
  generateBase64,
  generateClashYaml,
  generateSingboxJson,
  parseAddList,
  toTrojanNodes,
} from '../src/sub';
import {
  parseTrojanHeader,
  resolveTrojanPassword,
  sha224,
  trojanPasswordHash,
} from '../src/trojan';

const PASSWORD = 'correct horse battery staple';
const hash = trojanPasswordHash(PASSWORD);
const encoder = new TextEncoder();

function buildHeader(opts: {
  hash?: Uint8Array;
  command?: number;
  addressType?: number;
  address?: Uint8Array;
  port?: number;
  payload?: Uint8Array;
  crlf?: [number, number];
}): Uint8Array {
  const port = opts.port ?? 443;
  const address = opts.address ?? new Uint8Array([1, 1, 1, 1]);
  const payload = opts.payload ?? new Uint8Array([0xde, 0xad]);
  const [cr, lf] = opts.crlf ?? [0x0d, 0x0a];
  return new Uint8Array([
    ...(opts.hash ?? hash),
    cr,
    lf,
    opts.command ?? 1,
    opts.addressType ?? 1,
    ...address,
    port >> 8,
    port & 0xff,
    0x0d,
    0x0a,
    ...payload,
  ]);
}

describe('Trojan SHA-224 authentication', () => {
  it('matches known SHA-224 test vectors', () => {
    const hex = (text: string) =>
      Array.from(sha224(encoder.encode(text)), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex('')).toBe('d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f');
    expect(hex('abc')).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
  });

  it('matches node:crypto for varied lengths, including block boundaries', () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(length).map((_, index) => (index * 31 + 7) & 0xff);
      const expected = createHash('sha224').update(data).digest();
      expect(Buffer.from(sha224(data)).equals(expected)).toBe(true);
    }
  });

  it('produces 56 lowercase ASCII hex bytes', () => {
    expect(hash.length).toBe(56);
    expect(new TextDecoder().decode(hash)).toBe(
      createHash('sha224').update(PASSWORD).digest('hex'),
    );
  });

  it('prefers PASSWORD and falls back to UUID', () => {
    expect(resolveTrojanPassword({ PASSWORD: ' secret ', UUID: 'uuid' })).toBe('secret');
    expect(resolveTrojanPassword({ UUID: 'uuid' })).toBe('uuid');
    expect(resolveTrojanPassword({ PASSWORD: '  ' })).toBeNull();
  });
});

describe('Trojan header parsing', () => {
  it('parses IPv4 TCP connect', () => {
    const parsed = parseTrojanHeader(
      buildHeader({ address: new Uint8Array([192, 168, 1, 100]), port: 8080 }),
      hash,
    );
    expect(parsed.command).toBe(1);
    expect(parsed.hostname).toBe('192.168.1.100');
    expect(parsed.port).toBe(8080);
    expect(Array.from(parsed.payload)).toEqual([0xde, 0xad]);
  });

  it('parses domain TCP connect', () => {
    const domain = encoder.encode('example.com');
    const parsed = parseTrojanHeader(
      buildHeader({ addressType: 3, address: new Uint8Array([domain.length, ...domain]) }),
      hash,
    );
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe(443);
  });

  it('parses IPv6 UDP associate', () => {
    const ipv6 = new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const parsed = parseTrojanHeader(
      buildHeader({ command: 3, addressType: 4, address: ipv6, port: 53 }),
      hash,
    );
    expect(parsed.command).toBe(3);
    expect(parsed.hostname).toBe('2001:db8:0:0:0:0:0:1');
    expect(parsed.port).toBe(53);
  });

  it('allows an empty initial payload', () => {
    const parsed = parseTrojanHeader(buildHeader({ payload: new Uint8Array(0) }), hash);
    expect(parsed.payload.length).toBe(0);
  });

  it('rejects a wrong password hash', () => {
    const wrong = trojanPasswordHash('other');
    expect(() => parseTrojanHeader(buildHeader({ hash: wrong }), hash)).toThrow('invalid user');
  });

  it('rejects missing CRLF after the hash and after the port', () => {
    expect(() => parseTrojanHeader(buildHeader({ crlf: [0x0a, 0x0d] }), hash)).toThrow('CRLF');
    const raw = buildHeader({});
    raw[raw.length - 4] = 0x00;
    expect(() => parseTrojanHeader(raw, hash)).toThrow('CRLF');
  });

  it('rejects unsupported commands, unknown address types and port 0', () => {
    expect(() => parseTrojanHeader(buildHeader({ command: 2 }), hash)).toThrow(
      'unsupported command 2',
    );
    expect(() => parseTrojanHeader(buildHeader({ addressType: 2 }), hash)).toThrow(
      'unknown address type 2',
    );
    expect(() => parseTrojanHeader(buildHeader({ port: 0 }), hash)).toThrow('invalid port');
  });

  it('rejects truncated input', () => {
    expect(() => parseTrojanHeader(hash.slice(0, 20), hash)).toThrow('too short');
    const raw = buildHeader({ addressType: 4, address: new Uint8Array(4), payload: new Uint8Array(0) });
    expect(() => parseTrojanHeader(raw, hash)).toThrow('truncated ipv6');
  });
});

describe('Trojan subscription output', () => {
  const vlessNodes = parseAddList('example.com:443#Edge', 'example.com', 'uuid-1', '/?ed=2048');
  const trojanNodes = toTrojanNodes(vlessNodes, 'p@ss word');

  it('derives trojan nodes from vless nodes', () => {
    expect(trojanNodes).toHaveLength(1);
    expect(trojanNodes[0]).toMatchObject({
      protocol: 'trojan',
      name: 'Edge Trojan',
      credential: 'p@ss word',
      path: '/trojan?ed=2048',
      server: 'example.com',
    });
  });

  it('generates trojan:// share links', () => {
    const links = atob(generateBase64([...vlessNodes, ...trojanNodes])).split('\n');
    expect(links[0].startsWith('vless://uuid-1@example.com:443?')).toBe(true);
    const url = new URL(links[1]);
    expect(url.protocol).toBe('trojan:');
    expect(decodeURIComponent(url.username)).toBe('p@ss word');
    expect(url.host).toBe('example.com:443');
    expect(url.searchParams.get('security')).toBe('tls');
    expect(url.searchParams.get('sni')).toBe('example.com');
    expect(url.searchParams.get('type')).toBe('ws');
    expect(url.searchParams.get('host')).toBe('example.com');
    expect(url.searchParams.get('path')).toBe('/trojan?ed=2048');
    expect(decodeURIComponent(url.hash.slice(1))).toBe('Edge Trojan');
  });

  it('brackets IPv6 servers in trojan links', () => {
    const nodes = toTrojanNodes(parseAddList('[2001:db8::1]:8443', 'h.example', 'u', '/'), 'pw');
    expect(atob(generateBase64(nodes))).toContain('trojan://pw@[2001:db8::1]:8443?');
  });

  it('emits trojan proxies in Clash YAML', () => {
    const yaml = generateClashYaml([...vlessNodes, ...trojanNodes], 'AetherEdge');
    expect(yaml).toContain('type: trojan');
    expect(yaml).toContain('password: "p@ss word"');
    expect(yaml).toContain('sni: "example.com"');
    expect(yaml).toContain('path: "/trojan?ed=2048"');
    expect(yaml).toContain('type: vless');
    expect(yaml).toContain('- "Edge Trojan"');
  });

  it('emits trojan outbounds in Sing-box JSON', () => {
    const json = JSON.parse(generateSingboxJson([...vlessNodes, ...trojanNodes]));
    const trojan = json.outbounds.find((o: { type: string }) => o.type === 'trojan');
    expect(trojan.password).toBe('p@ss word');
    expect(trojan.tag).toBe('Edge Trojan');
    expect(trojan.tls.server_name).toBe('example.com');
    expect(trojan.transport).toEqual({
      type: 'ws',
      path: '/trojan?ed=2048',
      headers: { Host: 'example.com' },
    });
    expect(json.outbounds.find((o: { type: string }) => o.type === 'vless').uuid).toBe('uuid-1');
  });

  it('routes percent-encoded trojan paths to trojan handler', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/trojan%3Fed=2048', {
        headers: { Upgrade: 'websocket' },
      }),
      { UUID: 'c4f9a17e-52db-4b63-9e12-88d4bfd19e07' },
      {} as any,
    );
    expect(response.status).toBe(101);
  });

  it('handles trojan mux connections to v1.mux.cool', () => {
    const domainBytes = encoder.encode('v1.mux.cool');
    const raw = buildHeader({
      addressType: 3,
      address: new Uint8Array([domainBytes.length, ...domainBytes]),
      port: 9527,
    });
    const header = parseTrojanHeader(raw, hash);
    expect(header.hostname).toBe('v1.mux.cool');
    expect(header.port).toBe(9527);
  });
});
