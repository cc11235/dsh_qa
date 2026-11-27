/**
 * Shared helpers for the QA Guardian test suite.
 *
 * Everything here is dependency-free and deterministic: temp stores live in the
 * OS temp directory, and the HTTP/plugin contexts are small fakes shaped like
 * the DSH host interfaces the plugin actually uses.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { BugStore } from '../lib/store.js';

export async function tempDir(prefix = 'qa-guardian-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function newStore(dir) {
  return new BugStore({ filePath: path.join(dir, 'data.json'), log: () => {} }).load();
}

/** A session object shaped like DSH's session runtime. */
export function fakeSession({ id = 'session-1', cwd = 'D:\\demo', title = '', header = {} } = {}) {
  const events = title ? [{ type: 'session/title', data: { title } }] : [];
  return {
    id,
    header: { cwd, ...header },
    snapshotEvents: () => events,
  };
}

export function userMessage(text, overrides = {}) {
  return {
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
      ...overrides,
    },
    time: Date.now(),
  };
}

/**
 * Minimal `apply(ctx, config)` host context. Routes and tools are captured so
 * tests can invoke them without starting the real DSH host.
 */
export function makeContext({ sessionQuery = null } = {}) {
  const tools = new Map();
  const routes = new Map();
  const sections = [];
  const listeners = new Map();
  let cleanup = () => {};

  const ctx = {
    logger: { info() {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    effect(fn) {
      cleanup = fn() || (() => {});
      return () => {};
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
    get(name) {
      if (name === 'sessionQuery') return sessionQuery;
      return null;
    },
  };

  return { ctx, tools, routes, sections, listeners, cleanup: () => cleanup() };
}

export function routeOf(routes, suffix) {
  for (const [routePath, route] of routes) {
    if (routePath.endsWith(suffix)) return route;
  }
  throw new Error(`route not registered: ${suffix}`);
}

function requestStream(body) {
  if (body === undefined || body === null) {
    const stream = new PassThrough();
    stream.end();
    return stream;
  }
  return Readable.from([Buffer.from(String(body))]);
}

/**
 * Fake IncomingMessage for a route handler. Uses a PassThrough when `open` is
 * set (SSE keeps the request alive until the handler's close listener fires).
 */
export function mockReq({
  method = 'GET',
  body = null,
  headers = {},
  remoteAddress = '127.0.0.1',
  host = '127.0.0.1:50739',
  open = false,
  url = '/',
} = {}) {
  let req;
  if (open) {
    req = new PassThrough();
  } else {
    req = requestStream(body);
  }
  req.method = method;
  req.url = url;
  req.headers = { host, ...headers };
  req.socket = { remoteAddress };
  return req;
}

/** Fake ServerResponse that records status, headers and body chunks. */
export function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.ended = true;
    },
    get body() {
      return this.chunks.join('');
    },
    get json() {
      const text = this.body;
      return text ? JSON.parse(text) : null;
    },
  };
}

/** Invoke a registered route with fake req/res. Returns both objects. */
export async function invokeRoute(route, options = {}) {
  const req = mockReq(options);
  const res = mockRes();
  await route.handler(req, res);
  return { req, res };
}

/** Remove a temp directory, tolerating an already-missing path. */
export async function cleanupDir(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}