import { describe, expect, it } from 'bun:test';
import { parseAddList, generateBase64, generateClashYaml, generateSingboxJson } from '../src/sub';
import { parseVlessHeader, uuidToBytes, decodeBase64, parseProxyTarget } from '../src/vless';

describe('VLESS Protocol Wire Format', () => {
  const testUUID = '11111111-1111-4111-8111-111111111111';
  const expectedUUID = uuidToBytes(testUUID)!;

  function buildHeader(opts: {
    version?: number;
    uuid?: Uint8Array;
    addonLength?: number;
    addon?: Uint8Array;
    command?: number;
    port?: number;
    addressType?: number;
    address?: Uint8Array;
    payload?: Uint8Array;
  }): Uint8Array {
    const version = opts.version ?? 0;
    const uuid = opts.uuid ?? expectedUUID;
    const addonLength = opts.addonLength ?? (opts.addon ? opts.addon.length : 0);
    const addon = opts.addon ?? new Uint8Array(addonLength);
    const command = opts.command ?? 1; // TCP
    const port = opts.port ?? 443;
    const addressType = opts.addressType ?? 1; // IPv4
    const address = opts.address ?? new Uint8Array([1, 1, 1, 1]);
    const payload = opts.payload ?? new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const header = new Uint8Array(18 + addonLength + 1 + 2 + 1 + address.length + payload.length);
    header[0] = version;
    header.set(uuid, 1);
    header[17] = addonLength;
    if (addonLength > 0) {
      header.set(addon, 18);
    }
    let offset = 18 + addonLength;
    header[offset++] = command;
    header[offset++] = (port >> 8) & 0xff;
    header[offset++] = port & 0xff;
    header[offset++] = addressType;
    header.set(address, offset);
    offset += address.length;
    header.set(payload, offset);
    return header;
  }

  it('correctly parses standard VLESS IPv4 TCP header', () => {
    const raw = buildHeader({
      command: 1,
      port: 8080,
      addressType: 1,
      address: new Uint8Array([192, 168, 1, 100]),
      payload: new Uint8Array([1, 2, 3]),
    });
    const parsed = parseVlessHeader(raw, expectedUUID);
    expect(parsed.version).toBe(0);
    expect(parsed.command).toBe(1);
    expect(parsed.hostname).toBe('192.168.1.100');
    expect(parsed.port).toBe(8080);
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3]);
  });

  it('correctly parses standard VLESS Domain TCP header', () => {
    const domainBytes = new TextEncoder().encode('example.com');
    const addressField = new Uint8Array(1 + domainBytes.length);
    addressField[0] = domainBytes.length;
    addressField.set(domainBytes, 1);

    const raw = buildHeader({
      command: 1,
      port: 443,
      addressType: 2,
      address: addressField,
    });
    const parsed = parseVlessHeader(raw, expectedUUID);
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe(443);
  });

  it('correctly parses standard VLESS IPv6 UDP header', () => {
    // 2001:0db8:0000:0000:0000:0000:0000:0001
    const ipv6Bytes = new Uint8Array([
      0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    ]);
    const raw = buildHeader({
      command: 2,
      port: 53,
      addressType: 3,
      address: ipv6Bytes,
    });
    const parsed = parseVlessHeader(raw, expectedUUID);
    expect(parsed.command).toBe(2);
    expect(parsed.port).toBe(53);
    expect(parsed.hostname).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('rejects version != 0 per VLESS protocol specification', () => {
    const raw = buildHeader({ version: 1 });
    expect(() => parseVlessHeader(raw, expectedUUID)).toThrow('unsupported version 1');
  });

  it('rejects unauthorized UUID', () => {
    const wrongUUID = new Uint8Array(16).fill(0xff);
    const raw = buildHeader({ uuid: wrongUUID });
    expect(() => parseVlessHeader(raw, expectedUUID)).toThrow('invalid user');
  });

  it('rejects unsupported command (e.g. MUX command 3)', () => {
    const raw = buildHeader({ command: 3 });
    expect(() => parseVlessHeader(raw, expectedUUID)).toThrow('unsupported command 3');
  });

  it('rejects invalid port 0', () => {
    const raw = buildHeader({ port: 0 });
    expect(() => parseVlessHeader(raw, expectedUUID)).toThrow('invalid port');
  });

  it('rejects truncated domain length', () => {
    const raw = buildHeader({
      addonLength: 2,
      addressType: 2,
      address: new Uint8Array(0),
      payload: new Uint8Array(0),
    });
    // raw has length 24: 18 (header) + 2 (addon) + 1 (cmd) + 2 (port) + 1 (atyp) = 24 bytes
    expect(() => parseVlessHeader(raw, expectedUUID)).toThrow('truncated domain');
  });
});

describe('VLESS Helpers and Decoders', () => {
  it('correctly decodes base64url early data with and without padding', () => {
    const text = 'test-payload';
    const b64url = btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeBase64(b64url);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded!)).toBe(text);
  });

  it('parses IPv6 proxy targets with and without brackets', () => {
    const bracketed = parseProxyTarget('[2001:db8::1]:8443');
    expect(bracketed).toEqual({ hostname: '2001:db8::1', port: 8443 });

    const bare = parseProxyTarget('2001:db8::1');
    expect(bare).toEqual({ hostname: '2001:db8::1', port: 443 });

    const hostPort = parseProxyTarget('1.2.3.4:8080');
    expect(hostPort).toEqual({ hostname: '1.2.3.4', port: 8080 });
  });
});

describe('VLESS Subscription and Client Configs', () => {
  const testUUID = '11111111-1111-4111-8111-111111111111';

  it('generates standard vless:// URI with correct parameters', () => {
    const nodes = parseAddList('example.com:443#TestNode', 'example.com', testUUID, '/?ed=2048');
    expect(nodes.length).toBe(1);
    const link = atob(generateBase64(nodes)).trim();
    expect(link.startsWith(`vless://${testUUID}@example.com:443?`)).toBe(true);
    expect(link).toContain('type=ws');
    expect(link).toContain('encryption=none');
    expect(link).toContain('security=tls');
    expect(link).toContain('sni=example.com');
    expect(link).toContain('fp=chrome');
    expect(link).toContain('#TestNode');
  });

  it('generates sing-box outbound without xudp (packet_encoding: "") to avoid Command 3', () => {
    const nodes = parseAddList('example.com:443#TestNode', 'example.com', testUUID, '/?ed=2048');
    const json = JSON.parse(generateSingboxJson(nodes));
    const vless = json.outbounds.find((o: any) => o.type === 'vless');
    expect(vless).toBeDefined();
    expect(vless.uuid).toBe(testUUID);
    expect(vless.packet_encoding).toBe('');
    expect(vless.transport.type).toBe('ws');
  });

  it('generates clash yaml with udp: false since worker only proxies DNS', () => {
    const nodes = parseAddList('example.com:443#TestNode', 'example.com', testUUID, '/?ed=2048');
    const yaml = generateClashYaml(nodes, 'AetherEdge');
    expect(yaml).toContain('type: vless');
    expect(yaml).toContain('udp: false');
    expect(yaml).toContain('network: ws');
    expect(yaml).toContain('dns.google');
  });
});
