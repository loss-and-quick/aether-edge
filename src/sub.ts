export type ProxyProtocol = 'vless' | 'trojan';

export interface ProxyNode {
  protocol: ProxyProtocol;
  name: string;
  server: string;
  port: number;
  /** VLESS user UUID or Trojan password. */
  credential: string;
  host: string;
  sni: string;
  path: string;
  tls: boolean;
}

export type ClientType = 'clash' | 'singbox' | 'happ' | 'base64';

const DEFAULT_PORT = 443;
export const TROJAN_PATH = '/trojan?ed=2048';
const HAPP_UPDATE_INTERVAL_HOURS = '6';
const HAPP_USER_INFO = 'upload=0; download=0; total=0; expire=0';
const TEST_URL = 'https://www.gstatic.com/generate_204';
const REMOTE_DOH_URL = 'https://dns.google/dns-query';
const LOCAL_DNS = '77.88.8.8';
const GROUP_PROXY = '🚀 PROXY';
const GROUP_AUTO = '♻️ AUTO';
const GROUP_FINAL = '🐟 Final';

function parseHostPort(raw: string): { server: string; port: number } | null {
  let server: string;
  let portStr = '';

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) {
      return null;
    }

    server = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest.startsWith(':')) {
      portStr = rest.slice(1);
    } else if (rest !== '') {
      return null;
    }
  } else {
    const firstColon = raw.indexOf(':');
    const lastColon = raw.lastIndexOf(':');

    if (firstColon >= 0 && firstColon !== lastColon) {
      server = raw;
    } else if (firstColon >= 0) {
      server = raw.slice(0, firstColon);
      portStr = raw.slice(firstColon + 1);
    } else {
      server = raw;
    }
  }

  if (!server) {
    return null;
  }

  let port = DEFAULT_PORT;
  if (portStr !== '') {
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
  }

  return { server, port };
}

function getUniqueName(name: string, usedNames: Map<string, number>): string {
  const seen = usedNames.get(name) ?? 0;
  usedNames.set(name, seen + 1);

  return seen === 0 ? name : `${name} ${seen + 1}`;
}

export function parseAddList(
  addVar: string,
  defaultHost: string,
  uuid: string,
  defaultPath: string,
): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  const usedNames = new Map<string, number>();

  for (const entry of addVar.split(/[\n\r,]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const hashAt = trimmed.indexOf('#');
    const addr = (hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed).trim();
    const remark = hashAt >= 0 ? trimmed.slice(hashAt + 1).trim() : '';
    const parsed = parseHostPort(addr);

    if (!parsed) {
      continue;
    }

    const baseName = remark || `${parsed.server}:${parsed.port}`;

    nodes.push({
      protocol: 'vless',
      name: getUniqueName(baseName, usedNames),
      server: parsed.server,
      port: parsed.port,
      credential: uuid,
      host: defaultHost,
      sni: defaultHost,
      path: defaultPath,
      tls: true,
    });
  }

  return nodes;
}

/** Derives a Trojan node for every VLESS node, reusing its address and TLS settings. */
export function toTrojanNodes(
  nodes: ProxyNode[],
  password: string,
  path = TROJAN_PATH,
): ProxyNode[] {
  return nodes.map((node) => ({
    ...node,
    protocol: 'trojan',
    name: `${node.name} Trojan`,
    credential: password,
    path,
  }));
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function formatUriHost(server: string): string {
  return server.includes(':') ? `[${server}]` : server;
}

function toVlessUri(node: ProxyNode): string {
  const params = new URLSearchParams({
    security: node.tls ? 'tls' : 'none',
    sni: node.sni,
    type: 'ws',
    host: node.host,
    path: node.path,
    encryption: 'none',
  });

  if (node.tls) {
    params.set('fp', 'chrome');
  } else {
    params.delete('sni');
  }

  const query = params.toString().replace(/\+/g, '%20');
  return `vless://${node.credential}@${formatUriHost(node.server)}:${node.port}?${query}#${encodeURIComponent(node.name)}`;
}

function toTrojanUri(node: ProxyNode): string {
  const params = new URLSearchParams({
    security: node.tls ? 'tls' : 'none',
    sni: node.sni,
    type: 'ws',
    host: node.host,
    path: node.path,
  });

  if (node.tls) {
    params.set('fp', 'chrome');
  } else {
    params.delete('sni');
  }

  const query = params.toString().replace(/\+/g, '%20');
  return `trojan://${encodeURIComponent(node.credential)}@${formatUriHost(node.server)}:${node.port}?${query}#${encodeURIComponent(node.name)}`;
}

export function toShareUri(node: ProxyNode): string {
  return node.protocol === 'trojan' ? toTrojanUri(node) : toVlessUri(node);
}

export function generateBase64(nodes: ProxyNode[]): string {
  return utf8ToBase64(nodes.map(toShareUri).join('\n'));
}

/** Header values are effectively ASCII, so other titles travel as `base64:` (Happ decodes it). */
function toHappValue(value: string): string {
  const single = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(single) ? single : `base64:${utf8ToBase64(single)}`;
}

export function happHeaders(subName: string): Record<string, string> {
  return {
    'Profile-Title': toHappValue(subName),
    'Profile-Update-Interval': HAPP_UPDATE_INTERVAL_HOURS,
    'Subscription-Userinfo': HAPP_USER_INFO,
  };
}

export function generateHapp(nodes: ProxyNode[], subName: string): string {
  return [
    `#profile-title: ${toHappValue(subName)}`,
    `#profile-update-interval: ${HAPP_UPDATE_INTERVAL_HOURS}`,
    `#subscription-userinfo: ${HAPP_USER_INFO}`,
    ...nodes.map(toShareUri),
    '',
  ].join('\n');
}

const q = (value: string): string => JSON.stringify(value);

function toClashProxy(node: ProxyNode): string[] {
  const common = [
    `  - name: ${q(node.name)}`,
    `    type: ${node.protocol}`,
    `    server: ${q(node.server)}`,
    `    port: ${node.port}`,
  ];
  const transport = [
    '    network: ws',
    '    udp: false',
    '    client-fingerprint: chrome',
    '    ws-opts:',
    `      path: ${q(node.path)}`,
    '      headers:',
    `        Host: ${q(node.host)}`,
  ];

  if (node.protocol === 'trojan') {
    return [
      ...common,
      `    password: ${q(node.credential)}`,
      `    sni: ${q(node.sni)}`,
      ...transport,
    ];
  }

  return [
    ...common,
    `    uuid: ${q(node.credential)}`,
    `    tls: ${node.tls}`,
    `    servername: ${q(node.sni)}`,
    ...transport,
  ];
}

export function generateClashYaml(nodes: ProxyNode[], subName: string): string {
  const names = nodes.map((node) => node.name);
  const lines: string[] = [
    `# ${subName.replace(/[\r\n]+/g, ' ')}`,
    'port: 7890',
    'socks-port: 7891',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'external-controller: 127.0.0.1:9090',
    'dns:',
    '  enable: true',
    '  ipv6: false',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  default-nameserver:',
    '    - 77.88.8.8',
    '    - 8.8.8.8',
    '  nameserver:',
    '    - https://dns.google/dns-query',
    '    - https://common.dot.dns.yandex.net/dns-query',
    '    - 8.8.8.8',
    '    - 77.88.8.8',
    '  fallback:',
    '    - 8.8.8.8',
    '    - 77.88.8.8',
    'proxies:',
  ];

  for (const node of nodes) {
    lines.push(...toClashProxy(node));
  }

  lines.push(
    'proxy-groups:',
    `  - name: ${q(GROUP_PROXY)}`,
    '    type: select',
    '    proxies:',
    `      - ${q(GROUP_AUTO)}`,
    ...names.map((name) => `      - ${q(name)}`),
    `  - name: ${q(GROUP_AUTO)}`,
    '    type: url-test',
    `    url: ${q(TEST_URL)}`,
    '    interval: 300',
    '    tolerance: 50',
    '    proxies:',
    ...names.map((name) => `      - ${q(name)}`),
    `  - name: ${q(GROUP_FINAL)}`,
    '    type: select',
    '    proxies:',
    `      - ${q(GROUP_PROXY)}`,
    '      - DIRECT',
    'rules:',
    '  - AND,((NETWORK,udp),(DST-PORT,443)),REJECT',
    '  - GEOIP,private,DIRECT,no-resolve',
    '  - GEOSITE,private,DIRECT',
    '  - DOMAIN-SUFFIX,ru,DIRECT',
    '  - DOMAIN-SUFFIX,su,DIRECT',
    '  - DOMAIN-SUFFIX,xn--p1ai,DIRECT',
    '  - GEOIP,RU,DIRECT',
    `  - MATCH,${GROUP_PROXY}`,
    '',
  );

  return lines.join('\n');
}

function toSingboxOutbound(node: ProxyNode) {
  const common = {
    tag: node.name,
    server: node.server,
    server_port: node.port,
    tls: {
      enabled: node.tls,
      server_name: node.sni,
      utls: { enabled: true, fingerprint: 'chrome' },
    },
    transport: {
      type: 'ws',
      path: node.path,
      headers: { Host: node.host },
    },
  };

  if (node.protocol === 'trojan') {
    return { type: 'trojan', password: node.credential, ...common };
  }

  return { type: 'vless', uuid: node.credential, packet_encoding: '', ...common };
}

export function generateSingboxJson(nodes: ProxyNode[]): string {
  const tags = nodes.map((node) => node.name);

  const proxyOutbounds = nodes.map(toSingboxOutbound);

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', address: REMOTE_DOH_URL, detour: GROUP_PROXY },
        { tag: 'local', address: LOCAL_DNS, detour: 'direct' },
      ],
      rules: [{ outbound: 'any', server: 'local' }],
      final: 'remote',
      strategy: 'ipv4_only',
    },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 2080,
        sniff: true,
      },
    ],
    outbounds: [
      { type: 'selector', tag: GROUP_PROXY, outbounds: [GROUP_AUTO, ...tags], default: GROUP_AUTO },
      {
        type: 'urltest',
        tag: GROUP_AUTO,
        outbounds: tags,
        url: TEST_URL,
        interval: '5m',
        tolerance: 50,
      },
      ...proxyOutbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      rules: [
        { ip_is_private: true, outbound: 'direct' },
        { domain_suffix: ['.ru', '.su', '.рф', 'yandex.net'], outbound: 'direct' },
        { geoip: 'ru', outbound: 'direct' },
      ],
      final: GROUP_PROXY,
      auto_detect_interface: true,
    },
    experimental: {
      clash_api: { external_controller: '127.0.0.1:9090' },
    },
  };

  return JSON.stringify(config, null, 2);
}

export function detectClient(userAgent: string): ClientType {
  const normalizedUserAgent = userAgent.toLowerCase();

  if (normalizedUserAgent.includes('happ')) {
    return 'happ';
  }

  if (/sing-box|singbox|sfi/.test(normalizedUserAgent)) {
    return 'singbox';
  }

  if (/clash|meta|mihomo|verge/.test(normalizedUserAgent)) {
    return 'clash';
  }

  return 'base64';
}
