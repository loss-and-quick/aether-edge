# AetherEdge

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](https://workers.cloudflare.com/)
[![Bun](https://img.shields.io/badge/Bun-1.4-black.svg)](https://bun.sh/)
[![Tests](https://img.shields.io/badge/Tests-41%20passing-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A high-performance, typed VLESS & Trojan edge proxy and subscription server on Cloudflare Workers. Built with TypeScript, Hono JSX, Tailwind CSS v4, and native `cloudflare:sockets`.

---

## Features

- **Dual Protocol Engine**:
  - **VLESS-over-WebSocket**: Spec-compliant VLESS protocol engine utilizing `cloudflare:sockets` TCP socket streaming with early-data decoding.
  - **Trojan-over-WebSocket**: Pure TypeScript SHA-224 authenticated Trojan implementation with zero third-party crypto bloat.
- **Universal Multi-Client Subscription Generator**:
  - **Clash / Mihomo**: Native YAML generation with auto-selected groups and QUIC rejection rules to prevent TCP stalling.
  - **Sing-box**: Native JSON outbounds with strict type mapping.
  - **Happ Protocol**: Native support for Happ client metadata directives (`#profile-title`, `#profile-update-interval`, `subscription-userinfo`) per the Happ subscription specification.
  - **Universal Share Links**: Plain and Base64-encoded `vless://` and `trojan://` links.
- **Built-in Node Benchmark & Scanner**:
  - Benchmarks local TCP and TLS handshake round-trip times (RTT) across global Cloudflare Anycast domains and clean IP pools.
  - Auto-selects and applies top-performing nodes directly to `wrangler.toml`.
- **Modern SSR Dashboard**:
  - Responsive web interface rendered on the edge with Hono JSX and Tailwind CSS v4.
  - Instant one-click clipboard copying for all client subscription formats.
- **Reproducible Nix Tooling**:
  - `flake.nix` with Bun dev environment and test runners.
- **Strict Quality Control**:
  - 41 unit tests covering wire parsers, auth hashing, subscription serialization, and client formats.
  - Formatted and linted with Biome.

---

## Quick Start & Deployment Guide

### Prerequisites

- [Bun](https://bun.sh) (`v1.2+`)
- Cloudflare Account with an active custom domain added to Cloudflare DNS.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/loss-and-quick/aether-edge.git
cd aether-edge
bun install
```

### 2. Configure Environment (`wrangler.toml`)

Copy the template configuration:

```bash
cp example.wrangler.toml wrangler.toml
```

Edit `wrangler.toml` with your settings:

```toml
name = "aether-edge"
main = "src/index.tsx"
compatibility_date = "2025-01-01"

[vars]
HOST = "sub.yourdomain.com"
UUID = "your-custom-uuid-v4-here" # Generate via `uuidgen`
PASSWORD = ""                      # Optional Trojan password (falls back to UUID if empty)
SUBNAME = "AetherEdge"
PROXYIP = ""                      # Optional fallback reverse proxy IP
ADD = "sub.yourdomain.com:443#Direct,time.is:443#EU-Time,shopify.com:443#Global"
```

### 3. Scan & Select Clean Anycast Nodes

Cloudflare Anycast IPs and domains can experience regional ISP throttling. Run the built-in scanner to benchmark endpoints directly from your network:

```bash
# Scan and inspect latency
bun run scan

# Scan and automatically write the top 8 fastest nodes to wrangler.toml
bun run scan --apply
```

### 4. Build & Deploy to Cloudflare

Log in to Cloudflare with Wrangler:

```bash
bunx wrangler login
```

Compile assets and deploy:

```bash
bun run build
bun run deploy
```

### 5. Attach Custom Domain (Worker Domain)

To enable WebSocket connections over custom domains:

1. Open Cloudflare Dashboard &rarr; **Workers & Pages** &rarr; Select your worker (`aether-edge`).
2. Go to **Settings** &rarr; **Domains & Routes** &rarr; **Add** &rarr; **Custom Domain**.
3. Enter your subdomain (e.g. `sub.yourdomain.com`).
4. Cloudflare will automatically provision SSL/TLS certificates and route traffic to your Worker.

---

## Subscription Endpoints

| Client | URL Endpoint | Format |
| :--- | :--- | :--- |
| **Universal / Base64** | `https://sub.yourdomain.com/sub` | Base64 URI list |
| **Clash / Mihomo** | `https://sub.yourdomain.com/sub?format=clash` | Clash YAML |
| **Sing-box** | `https://sub.yourdomain.com/sub?format=singbox` | Sing-box JSON |
| **Happ** | `https://sub.yourdomain.com/sub?format=happ` | Happ metadata + links |
| **Web Dashboard** | `https://sub.yourdomain.com/` | SSR HTML Dashboard |

*Note: User-Agent detection is built-in. If Happ, Clash, or Sing-box requests `/sub` directly, the appropriate format is returned automatically.*

---

## Recommended Client Settings

- **Remote DNS**: Do **NOT** use Cloudflare DNS (`1.1.1.1` or `cloudflare-dns.com`) inside your proxy client. Cloudflare Workers do not permit loopback TCP connections to Cloudflare IPs. Instead, use:
  - **Quad9**: `9.9.9.9`
  - **OpenDNS / Cisco**: `208.67.222.222`
  - **DNS.SB**: `185.222.222.222`
- **Domestic DNS (Local / ISP)**: Set to your local network or ISP DNS resolver for direct traffic.
- **Routing Rules**: Ensure local intranet sites and build cache servers (e.g. `domain:cachix.org`) are routed as `direct` to maximize bandwidth and prevent unnecessary Worker proxy loops.

---

## Development & Testing

```bash
# Run unit test suite (41 tests)
bun test

# Typecheck TypeScript
bun run typecheck

# Lint with Biome
bun run lint

# Format code
bun run format
```

---

## Project Structure

```text
├── scripts/
│   ├── embed-styles.mjs    # Embeds compiled Tailwind CSS into TypeScript bundle
│   └── scan-nodes.ts       # Anycast node latency scanner and benchmark tool
├── src/
│   ├── index.tsx           # Hono router and WebSocket dispatch
│   ├── session.ts          # Core socket streaming and connection multiplexing
│   ├── sub.ts              # Multi-format subscription serializer (Clash/Sing-box/Happ)
│   ├── trojan.ts           # Trojan protocol parser and pure TS SHA-224 engine
│   ├── ui.tsx              # Edge-rendered SSR dashboard with Hono JSX
│   └── vless.ts            # VLESS protocol wire parser and decoders
├── test/
│   ├── happ.test.ts        # Happ protocol and metadata directive test suite
│   ├── trojan.test.ts      # Trojan SHA-224 vectors and wire parser tests
│   └── vless.test.ts       # VLESS wire format and config generation tests
├── example.wrangler.toml   # Template configuration file
├── flake.nix               # Nix development flake
└── wrangler.toml           # Production deployment configuration
```

---

## License

MIT &copy; 2026 minicx
