import { beforeEach, describe, expect, it } from 'bun:test';
import type { Socket } from 'cloudflare:sockets';
import {
  MUX_NETWORK_TCP,
  MUX_STATUS_DATA,
  MUX_STATUS_END,
  MUX_STATUS_KEEP_ALIVE,
  MUX_STATUS_NEW,
  MuxFrameParser,
  decodeMuxTarget,
  handleVlessMux,
  serializeMuxDataFrame,
  serializeMuxEndFrame,
} from '../src/mux';

const encoder = new TextEncoder();

type MockCloudflareSockets = {
  connectImpl: (target: { hostname: string; port: number }) => Socket;
  reset: () => void;
};

function cloudflareSocketsMock(): MockCloudflareSockets {
  return (globalThis as any).__cloudflareSocketsMock;
}

function buildFrame(sessionId: number, status: number, payload: Uint8Array = new Uint8Array(0)) {
  const hasData = payload.length > 0;
  const metaLen = 4;
  const totalLen = 2 + metaLen + (hasData ? 2 + payload.length : 0);
  const frame = new Uint8Array(totalLen);
  const view = new DataView(frame.buffer);
  view.setUint16(0, metaLen);
  view.setUint16(2, sessionId);
  frame[4] = status;
  frame[5] = hasData ? 0x01 : 0x00;
  if (hasData) {
    view.setUint16(6, payload.length);
    frame.set(payload, 8);
  }
  return frame;
}

function encodeTarget(
  network: number,
  port: number,
  addressType: number,
  address: Uint8Array,
): Uint8Array {
  return new Uint8Array([network, port >> 8, port & 0xff, addressType, ...address]);
}

function encodeDomain(domain: string): Uint8Array {
  const bytes = encoder.encode(domain);
  return new Uint8Array([bytes.length, ...bytes]);
}

function buildNewFrame(
  sessionId: number,
  network: number,
  port: number,
  addressType: number,
  address: Uint8Array,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const target = encodeTarget(network, port, addressType, address);
  const hasData = payload.length > 0;
  const metaLen = 4 + target.length;
  const totalLen = 2 + metaLen + (hasData ? 2 + payload.length : 0);
  const frame = new Uint8Array(totalLen);
  const view = new DataView(frame.buffer);
  view.setUint16(0, metaLen);
  view.setUint16(2, sessionId);
  frame[4] = MUX_STATUS_NEW;
  frame[5] = hasData ? 0x01 : 0x00;
  frame.set(target, 6);
  if (hasData) {
    view.setUint16(6 + target.length, payload.length);
    frame.set(payload, 8 + target.length);
  }
  return frame;
}

function flushTasks(): Promise<void> {
  return Promise.resolve().then(() => undefined).then(() => undefined);
}

function createMockSocket() {
  const writes: Uint8Array[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const socket: Socket & {
    writes: Uint8Array[];
    emit: (chunk: Uint8Array) => void;
    end: () => void;
    isClosed: () => boolean;
  } = {
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    readable: new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        writes.push(new Uint8Array(chunk));
      },
      close() {
        closed = true;
      },
      abort() {
        closed = true;
      },
    }),
    close: () => {
      if (!closed) {
        closed = true;
        controller?.close();
      }
      return Promise.resolve();
    },
    writes,
    emit: (chunk) => controller?.enqueue(chunk),
    end: () => {
      if (!closed) {
        closed = true;
        controller?.close();
      }
    },
    isClosed: () => closed,
  };

  return socket;
}

beforeEach(() => {
  cloudflareSocketsMock().reset();
});

describe('Mux frame parsing and encoding', () => {
  it('parses new, data, end, and keep-alive frames from a streaming parser', () => {
    const parser = new MuxFrameParser();
    const ipv4 = buildNewFrame(
      0x1234,
      MUX_NETWORK_TCP,
      443,
      1,
      new Uint8Array([1, 2, 3, 4]),
      encoder.encode('hello'),
    );
    const data = buildFrame(0x1234, MUX_STATUS_DATA, encoder.encode('world'));
    const end = buildFrame(0x1234, MUX_STATUS_END);
    const keepAlive = buildFrame(0x9999, MUX_STATUS_KEEP_ALIVE);

    expect(parser.push(ipv4.subarray(0, 4))).toHaveLength(0);
    const frames = parser.push(
      new Uint8Array([
        ...ipv4.subarray(4),
        ...data,
        ...end,
        ...keepAlive,
      ]),
    );

    expect(frames).toHaveLength(4);
    expect(frames[0]).toMatchObject({
      sessionId: 0x1234,
      status: MUX_STATUS_NEW,
      network: MUX_NETWORK_TCP,
      hostname: '1.2.3.4',
      port: 443,
    });
    expect(Array.from(frames[0].payload)).toEqual(Array.from(encoder.encode('hello')));
    expect(frames[1]).toMatchObject({ sessionId: 0x1234, status: MUX_STATUS_DATA });
    expect(Array.from(frames[1].payload)).toEqual(Array.from(encoder.encode('world')));
    expect(frames[2]).toMatchObject({ sessionId: 0x1234, status: MUX_STATUS_END });
    expect(frames[3]).toMatchObject({ sessionId: 0x9999, status: MUX_STATUS_KEEP_ALIVE });
    expect(parser.getPending()).toHaveLength(0);
  });

  it('decodes IPv4, domain, and IPv6 mux targets', () => {
    const ipv4 = decodeMuxTarget(
      encodeTarget(MUX_NETWORK_TCP, 80, 1, new Uint8Array([203, 0, 113, 7])),
    );
    expect(ipv4).toMatchObject({
      network: MUX_NETWORK_TCP,
      hostname: '203.0.113.7',
      port: 80,
    });

    const domain = decodeMuxTarget(
      encodeTarget(MUX_NETWORK_TCP, 8443, 2, encodeDomain('example.com')),
    );
    expect(domain).toMatchObject({
      hostname: 'example.com',
      port: 8443,
    });

    const ipv6 = decodeMuxTarget(
      encodeTarget(
        MUX_NETWORK_TCP,
        53,
        3,
        new Uint8Array([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      ),
    );
    expect(ipv6).toMatchObject({
      hostname: '2001:db8:0:0:0:0:0:1',
      port: 53,
    });
  });

  it('serializes data and end response frames', () => {
    expect(Array.from(serializeMuxDataFrame(0x4242, encoder.encode('ok')))).toEqual([
      0,
      4,
      0x42,
      0x42,
      MUX_STATUS_DATA,
      1,
      0,
      2,
      0x6f,
      0x6b,
    ]);
    expect(Array.from(serializeMuxEndFrame(0x4242))).toEqual([0, 4, 0x42, 0x42, MUX_STATUS_END, 0]);
  });
});

describe('Mux session manager', () => {
  it('opens multiplexed sessions, forwards data, and emits framed responses', async () => {
    const connects: Array<{ hostname: string; port: number }> = [];
    const first = createMockSocket();
    const second = createMockSocket();

    cloudflareSocketsMock().connectImpl = (target) => {
      connects.push(target);
      return connects.length === 1 ? first : second;
    };

    const outboundFrames: Uint8Array[] = [];
    const handler = handleVlessMux((frame) => outboundFrames.push(frame), null);

    await handler.write(
      new Uint8Array([
        ...buildNewFrame(1, MUX_NETWORK_TCP, 443, 2, encodeDomain('alpha.example'), encoder.encode('hi')),
        ...buildNewFrame(2, MUX_NETWORK_TCP, 80, 1, new Uint8Array([198, 51, 100, 9])),
      ]),
    );
    await handler.write(buildFrame(1, MUX_STATUS_DATA, encoder.encode(' there')));
    await handler.write(buildFrame(2, MUX_STATUS_DATA, encoder.encode('GET /')));

    expect(connects).toEqual([
      { hostname: 'alpha.example', port: 443 },
      { hostname: '198.51.100.9', port: 80 },
    ]);
    expect(first.writes.map((chunk: Uint8Array) => new TextDecoder().decode(chunk))).toEqual([
      'hi',
      ' there',
    ]);
    expect(second.writes.map((chunk: Uint8Array) => new TextDecoder().decode(chunk))).toEqual([
      'GET /',
    ]);

    first.emit(encoder.encode('HTTP/1.1'));
    second.emit(encoder.encode('PONG'));
    await flushTasks();

    expect(outboundFrames.map((frame) => Array.from(frame))).toEqual([
      Array.from(serializeMuxDataFrame(1, encoder.encode('HTTP/1.1'))),
      Array.from(serializeMuxDataFrame(2, encoder.encode('PONG'))),
    ]);

    second.end();
    await flushTasks();
    expect(Array.from(outboundFrames[2])).toEqual(Array.from(serializeMuxEndFrame(2)));

    await handler.write(buildFrame(1, MUX_STATUS_END));
    expect(first.isClosed()).toBe(true);
  });

  it('ends unsupported UDP sessions and closes all upstream sockets on abort', async () => {
    const socket = createMockSocket();
    let connectCalls = 0;
    cloudflareSocketsMock().connectImpl = () => {
      connectCalls += 1;
      return socket;
    };

    const outboundFrames: Uint8Array[] = [];
    const handler = handleVlessMux((frame) => outboundFrames.push(frame), null);

    await handler.write(buildNewFrame(7, 2, 53, 2, encodeDomain('dns.google')));
    expect(connectCalls).toBe(0);
    expect(Array.from(outboundFrames[0])).toEqual(Array.from(serializeMuxEndFrame(7)));

    await handler.write(buildNewFrame(8, MUX_NETWORK_TCP, 443, 2, encodeDomain('beta.example')));
    handler.close?.();
    expect(socket.isClosed()).toBe(true);
  });
});
