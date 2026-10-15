import { Hono } from 'hono';
import {
  detectClient,
  generateBase64,
  generateClashYaml,
  generateSingboxJson,
  generateHapp,
  happHeaders,
  parseAddList,
  toTrojanNodes,
  type ClientType,
} from './sub';
import { RenderUI } from './ui';
import { handleTrojanWS, resolveTrojanPassword } from './trojan';
import { handleVlessWS } from './vless';

export interface Env {
  UUID?: string;
  PASSWORD?: string;
  TROJAN?: string;
  PROXYIP?: string;
  HOST?: string;
  ADD?: string;
  SUBNAME?: string;
  [key: string]: unknown;
}

const DEFAULT_SUB_NAME = 'AetherEdge';
const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';
const TROJAN_WS_PATH = '/trojan';

type AppBindings = {
  Bindings: Env;
};

const app = new Hono<AppBindings>();

function getConfig(request: Request, env: Env) {
  const url = new URL(request.url);
  const host = env.HOST ?? url.hostname;
  const subName = env.SUBNAME ?? DEFAULT_SUB_NAME;
  const defaultAdd = `${host}:443#Direct,time.is:443#EU-Time,shopify.com:443#Global`;

  return {
    host,
    subName,
    uuid: env.UUID,
    addList: env.ADD ?? defaultAdd,
  };
}

function isTrojanEnabled(env: Env): boolean {
  return !/^(0|false|off|no)$/i.test(String(env.TROJAN ?? '').trim());
}

function buildNodes(addList: string, host: string, uuid: string, trojanPassword: string | null) {
  const nodes = parseAddList(addList, host, uuid, '/?ed=2048');
  return trojanPassword ? [...nodes, ...toTrojanNodes(nodes, trojanPassword)] : nodes;
}

function buildAllNodes(config: ReturnType<typeof getConfig>, env: Env, uuid: string) {
  return buildNodes(
    config.addList,
    config.host,
    uuid,
    isTrojanEnabled(env) ? resolveTrojanPassword(env) : null,
  );
}

function resolveClientType(request: Request): ClientType {
  const url = new URL(request.url);
  const queryFormat = url.searchParams.get('format')?.toLowerCase();

  if (
    queryFormat === 'clash' ||
    queryFormat === 'singbox' ||
    queryFormat === 'happ' ||
    queryFormat === 'base64'
  ) {
    return queryFormat;
  }

  return detectClient(request.headers.get('User-Agent') ?? '');
}

app.get('/', (c) => {
  const config = getConfig(c.req.raw, c.env);
  const nodes = buildAllNodes(config, c.env, config.uuid ?? PLACEHOLDER_UUID);

  return c.html(
    <RenderUI
      host={config.host}
      subName={config.subName}
      nodesCount={nodes.length}
      subscriptionReady={Boolean(config.uuid)}
    />,
  );
});

app.get('/health', (c) => {
  const config = getConfig(c.req.raw, c.env);

  return c.json({
    status: 'ok',
    node: config.host,
    subscriptionReady: Boolean(config.uuid),
    time: Date.now(),
  });
});

app.get('/sub', (c) => {
  const config = getConfig(c.req.raw, c.env);

  if (!config.uuid) {
    return c.json({ error: 'UUID is not configured' }, 503);
  }

  const nodes = buildAllNodes(config, c.env, config.uuid);
  const clientType = resolveClientType(c.req.raw);
  const headers = new Headers({
    'Profile-Update-Interval': '6',
    'Profile-Title': config.subName,
  });

  if (clientType === 'clash') {
    headers.set('Content-Type', 'text/yaml; charset=utf-8');
    headers.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(config.subName)}.yaml"`,
    );
    return new Response(generateClashYaml(nodes, config.subName), { status: 200, headers });
  }

  if (clientType === 'happ') {
    for (const [name, value] of Object.entries(happHeaders(config.subName))) {
      headers.set(name, value);
    }
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(generateHapp(nodes, config.subName), { status: 200, headers });
  }

  if (clientType === 'singbox') {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(config.subName)}.json"`,
    );
    return new Response(generateSingboxJson(nodes), { status: 200, headers });
  }

  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(config.subName)}.txt"`,
  );
  return new Response(generateBase64(nodes), { status: 200, headers });
});

app.notFound((c) => c.text('Not Found', 404));

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    try {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const { pathname } = new URL(request.url);
        const cleanPath = decodeURIComponent(pathname).split('?')[0].replace(/\/+$/, '') || '/';
        if (cleanPath === TROJAN_WS_PATH || cleanPath.startsWith(`${TROJAN_WS_PATH}/`)) {
          return await handleTrojanWS(request, env);
        }

        return await handleVlessWS(request, env);
      }

      return await app.fetch(request, env, executionContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Worker Error: ${message}`, { status: 500 });
    }
  },
};
