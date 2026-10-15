import { mock } from 'bun:test';

if (typeof (globalThis as any).WebSocketPair === 'undefined') {
  (globalThis as any).WebSocketPair = class {
    0: any;
    1: any;
    constructor() {
      this[0] = { accept() {}, addEventListener() {}, send() {}, close() {}, readyState: 1 };
      this[1] = { accept() {}, addEventListener() {}, send() {}, close() {}, readyState: 1 };
    }
  };
}

const defaultConnect = () => ({
  opened: Promise.resolve(),
  closed: Promise.resolve(),
  readable: new ReadableStream<Uint8Array>(),
  writable: new WritableStream<Uint8Array>(),
  close: () => Promise.resolve(),
});

(globalThis as any).__cloudflareSocketsMock = {
  connectImpl: defaultConnect,
  reset() {
    this.connectImpl = defaultConnect;
  },
};

mock.module('cloudflare:sockets', () => ({
  connect: (target: { hostname: string; port: number }) =>
    (globalThis as any).__cloudflareSocketsMock.connectImpl(target),
}));
