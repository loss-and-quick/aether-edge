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

mock.module('cloudflare:sockets', () => ({
  connect: () => ({
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    readable: new ReadableStream(),
    writable: new WritableStream(),
    close: () => Promise.resolve(),
  }),
}));
