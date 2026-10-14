import { mock } from 'bun:test';

mock.module('cloudflare:sockets', () => ({
  connect: () => ({
    opened: Promise.resolve(),
    closed: Promise.resolve(),
    readable: new ReadableStream(),
    writable: new WritableStream(),
    close: () => Promise.resolve(),
  }),
}));
