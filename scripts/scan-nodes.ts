import * as net from 'node:net';
import * as tls from 'node:tls';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TargetNode {
  name: string;
  host: string;
  port: number;
}

interface TestResult {
  node: TargetNode;
  alive: boolean;
  tcpMs: number;
  tlsMs: number;
  error?: string;
}

function getSniHost(): string {
  if (process.env.HOST) return process.env.HOST;
  const wranglerPath = path.resolve(process.cwd(), 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    const content = fs.readFileSync(wranglerPath, 'utf-8');
    const match = content.match(/^HOST\s*=\s*["']([^"']+)["']/m);
    if (match && match[1] && !match[1].includes('example') && !match[1].includes('domain')) {
      return match[1];
    }
  }
  const examplePath = path.resolve(process.cwd(), 'example.wrangler.toml');
  if (fs.existsSync(examplePath)) {
    const content = fs.readFileSync(examplePath, 'utf-8');
    const match = content.match(/^HOST\s*=\s*["']([^"']+)["']/m);
    if (match && match[1]) return match[1];
  }
  return 'example.com';
}

const SNI_HOST = getSniHost();

const CANDIDATES: TargetNode[] = [
  ...(SNI_HOST !== 'example.com' ? [{ name: 'Direct-Host', host: SNI_HOST, port: 443 }] : []),
  { name: 'EU-Time', host: 'time.is', port: 443 },
  { name: 'Global-Shopify', host: 'shopify.com', port: 443 },
  { name: 'CDN-Cloudflare', host: 'cdnjs.com', port: 443 },
  { name: 'US-Visa', host: 'visa.com', port: 443 },
  { name: 'Edge-Zoom', host: 'zoom.us', port: 443 },
  { name: 'Dev-GitLab', host: 'gitlab.com', port: 443 },
  { name: 'HK-Cloudflare', host: 'icook.hk', port: 443 },
  { name: 'Speed-Cloudflare', host: 'speed.cloudflare.com', port: 443 },
  { name: 'Global-Discord', host: 'discord.com', port: 443 },
  { name: 'EU-Trade', host: 'tradingview.com', port: 443 },
  { name: 'Edge-Figma', host: 'figma.com', port: 443 },
  { name: 'Web-Archive', host: 'archive.org', port: 443 },
  { name: 'CF-IP-104-21', host: '104.21.90.107', port: 443 },
  { name: 'CF-IP-172-67', host: '172.67.199.221', port: 443 },
  { name: 'CF-IP-172-64', host: '172.64.155.249', port: 443 },
  { name: 'CF-IP-104-16', host: '104.16.85.20', port: 443 },
  { name: 'CF-IP-104-18', host: '104.18.43.174', port: 443 },
];
const TIMEOUT_MS = 2500;

async function testNode(node: TargetNode): Promise<TestResult> {
  const startTcp = performance.now();

  return new Promise<TestResult>((resolve) => {
    let resolved = false;

    const socket = net.createConnection({ host: node.host, port: node.port, timeout: TIMEOUT_MS });

    const finish = (result: TestResult) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.on('timeout', () => {
      finish({ node, alive: false, tcpMs: TIMEOUT_MS, tlsMs: TIMEOUT_MS, error: 'TCP Timeout' });
    });

    socket.on('error', (err) => {
      finish({ node, alive: false, tcpMs: Math.round(performance.now() - startTcp), tlsMs: 0, error: err.message });
    });

    socket.on('connect', () => {
      const tcpMs = Math.round(performance.now() - startTcp);
      const startTls = performance.now();

      const tlsSocket = tls.connect({
        socket,
        servername: SNI_HOST,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      });

      tlsSocket.on('timeout', () => {
        tlsSocket.destroy();
        finish({ node, alive: false, tcpMs, tlsMs: TIMEOUT_MS, error: 'TLS Timeout' });
      });

      tlsSocket.on('error', (err) => {
        tlsSocket.destroy();
        finish({ node, alive: false, tcpMs, tlsMs: Math.round(performance.now() - startTls), error: err.message });
      });

      tlsSocket.on('secureConnect', () => {
        const tlsMs = Math.round(performance.now() - startTls);
        tlsSocket.destroy();
        finish({ node, alive: true, tcpMs, tlsMs });
      });
    });
  });
}

async function main() {
  const applyFlag = process.argv.includes('--apply');
  console.log(`\x1b[36m⚡ Scanning Cloudflare Anycast nodes from local network (SNI: ${SNI_HOST})...\x1b[0m\n`);

  const results: TestResult[] = [];
  const chunkSize = 6;

  for (let i = 0; i < CANDIDATES.length; i += chunkSize) {
    const chunk = CANDIDATES.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(testNode));
    results.push(...chunkResults);
  }

  const alive = results.filter((r) => r.alive).sort((a, b) => a.tlsMs - b.tlsMs);
  const dead = results.filter((r) => !r.alive);

  console.log('\x1b[32m✔ ONLINE NODES (Ranked by Latency):\x1b[0m');
  console.log('----------------------------------------------------------------------');
  console.log(
    'Name'.padEnd(20) +
    'Address'.padEnd(24) +
    'TCP Latency'.padEnd(14) +
    'TLS RTT'
  );
  console.log('----------------------------------------------------------------------');

  for (const r of alive) {
    console.log(
      `\x1b[1m${r.node.name.padEnd(20)}\x1b[0m` +
      `${(r.node.host + ':' + r.node.port).padEnd(24)}` +
      `${(r.tcpMs + 'ms').padEnd(14)}` +
      `\x1b[32m${r.tlsMs}ms\x1b[0m`
    );
  }

  if (dead.length > 0) {
    console.log('\n\x1b[31m✖ BLOCKED / OFFLINE NODES:\x1b[0m');
    for (const r of dead) {
      console.log(`  - ${r.node.name} (${r.node.host}): ${r.error || 'Blocked'}`);
    }
  }

  const topNodes = alive.slice(0, 8);
  const addValue = topNodes.map((r) => `${r.node.host}:${r.node.port}#${r.node.name}`).join(',');

  console.log('\n\x1b[36mGenerated ADD string for wrangler.toml:\x1b[0m');
  console.log(`ADD = "${addValue}"\n`);

  if (applyFlag) {
    const wranglerPath = path.resolve(process.cwd(), 'wrangler.toml');
    const content = fs.readFileSync(wranglerPath, 'utf-8');
    const updated = content.replace(/^ADD\s*=\s*".*"/m, `ADD = "${addValue}"`);
    fs.writeFileSync(wranglerPath, updated, 'utf-8');
    console.log(`\x1b[32m✔ Successfully updated wrangler.toml with top ${topNodes.length} fastest nodes!\x1b[0m`);
    console.log('Run `bun run deploy` (or `npx wrangler deploy`) to publish changes to Cloudflare.');
  } else {
    console.log('Tip: Run `bun run scan -- --apply` to automatically write top nodes to wrangler.toml');
  }
}

main().catch(console.error);
