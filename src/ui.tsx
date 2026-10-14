import { html, raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import { styles } from './styles.generated';

export interface RenderUIProps {
  host: string;
  subName: string;
  nodesCount: number;
  subscriptionReady: boolean;
}

const appShellScript = html`
  <script>
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest('[data-copy-url]');
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      const url = button.dataset.copyUrl;
      if (!url) {
        return;
      }

      const original = button.dataset.label || button.textContent || 'Copy';

      try {
        await navigator.clipboard.writeText(url);
        button.textContent = 'Copied';
        button.dataset.label = original;
      } catch {
        button.textContent = 'Copy failed';
      }

      window.setTimeout(() => {
        button.textContent = original;
      }, 1800);
    });
  </script>
`;

const StatusPill: FC<{ ready: boolean }> = ({ ready }) => (
  <div
    class={[
      'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium backdrop-blur',
      ready
        ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
        : 'border-amber-400/40 bg-amber-400/10 text-amber-100',
    ].join(' ')}
  >
    <span
      class={[
        'h-2.5 w-2.5 rounded-full',
        ready ? 'bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.9)]' : 'bg-amber-300',
      ].join(' ')}
    />
    {ready ? 'Subscription ready' : 'Configuration required'}
  </div>
);

const MetricCard: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div class="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
    <p class="text-sm text-slate-400">{label}</p>
    <p class="mt-2 text-2xl font-semibold tracking-tight text-white">{value}</p>
  </div>
);

const ActionButton: FC<{
  label: string;
  url: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}> = ({ label, url, variant = 'secondary', disabled = false }) => (
  <button
    type="button"
    data-copy-url={disabled ? undefined : url}
    class={[
      'inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition duration-200',
      variant === 'primary'
        ? 'bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-500/20 hover:bg-cyan-200'
        : 'border border-white/10 bg-white/5 text-slate-100 hover:border-cyan-300/40 hover:bg-white/10',
      disabled ? 'cursor-not-allowed opacity-50 hover:border-white/10 hover:bg-white/5' : '',
    ].join(' ')}
    disabled={disabled}
  >
    {label}
  </button>
);

export const RenderUI: FC<RenderUIProps> = ({ host, subName, nodesCount, subscriptionReady }) => {
  const subUrl = `https://${host}/sub`;
  const clashUrl = `${subUrl}?format=clash`;
  const singboxUrl = `${subUrl}?format=singbox`;
  const happUrl = `${subUrl}?format=happ`;

  return (
    <html lang="en" class="bg-slate-950 text-slate-100">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="Dashboard for managing VLESS subscriptions on Cloudflare Workers."
        />
        <title>{subName}</title>
        {html`<style>${raw(styles)}</style>`}
      </head>
      <body class="min-h-screen bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.18),transparent_30%),linear-gradient(180deg,#020617_0%,#020617_35%,#020617_100%)] text-slate-100">
        <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8 lg:px-8">
          <section class="relative overflow-hidden rounded-[32px] border border-white/10 bg-slate-950/80 p-8 shadow-2xl shadow-cyan-950/30 backdrop-blur xl:p-10">
            <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
            <div class="absolute -right-24 top-[-5rem] h-60 w-60 rounded-full bg-cyan-400/15 blur-3xl" />
            <div class="absolute -left-20 bottom-[-6rem] h-72 w-72 rounded-full bg-indigo-500/15 blur-3xl" />

            <div class="relative z-10 grid gap-8 lg:grid-cols-[1.3fr_0.9fr] lg:items-start">
              <div>
                <StatusPill ready={subscriptionReady} />
                <div class="mt-6 max-w-3xl">
                  <p class="text-sm font-medium uppercase tracking-[0.3em] text-cyan-300/80">
                    Cloudflare Workers · Edge Gateway
                  </p>
                  <h1 class="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    {subName} Gateway
                  </h1>
                  <p class="mt-4 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
                    Universal edge proxy and subscription gateway. Provides Anycast TLS acceleration,
                    optimized routing, and native profile auto-generation for all major clients.
                  </p>
                </div>

                <div class="mt-8 flex flex-wrap gap-3">
                  <ActionButton
                    label="Copy universal link"
                    url={subUrl}
                    variant="primary"
                    disabled={!subscriptionReady}
                  />
                  <ActionButton
                    label="Copy Clash URL"
                    url={clashUrl}
                    disabled={!subscriptionReady}
                  />
                  <ActionButton
                    label="Copy Sing-box URL"
                    url={singboxUrl}
                    disabled={!subscriptionReady}
                  />
                  <ActionButton
                    label="Copy Happ URL"
                    url={happUrl}
                    disabled={!subscriptionReady}
                  />
                </div>

                <div class="mt-8 rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p class="text-sm text-slate-400">Primary subscription endpoint</p>
                      <p class="mt-1 break-all font-mono text-sm text-cyan-200 sm:text-base">
                        {subUrl}
                      </p>
                    </div>
                    <span class="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.25em] text-cyan-200">
                      Auto-detect
                    </span>
                  </div>
                </div>

                {!subscriptionReady ? (
                  <div class="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-50">
                    UUID is not configured yet. The worker UI is available, but `/sub` and WebSocket
                    VLESS access stay disabled until the UUID is set.
                  </div>
                ) : null}
              </div>

              <div class="grid gap-4">
                <MetricCard label="Preferred nodes" value={String(nodesCount)} />
                <MetricCard label="Transport" value="TLS + WebSocket" />
                <MetricCard label="Fallback" value="ProxyIP aware" />
              </div>
            </div>
          </section>

          <section class="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div class="rounded-[28px] border border-white/10 bg-white/5 p-6 backdrop-blur xl:p-8">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium uppercase tracking-[0.24em] text-cyan-300/75">
                    Overview
                  </p>
                  <h2 class="mt-2 text-2xl font-semibold text-white">Connection profile</h2>
                </div>
                <div class="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-slate-300">
                  Live config
                </div>
              </div>

              <dl class="mt-6 grid gap-4 sm:grid-cols-2">
                <div class="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                  <dt class="text-sm text-slate-400">Host / SNI</dt>
                  <dd class="mt-2 break-all font-mono text-sm text-white">{host}</dd>
                </div>
                <div class="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                  <dt class="text-sm text-slate-400">Default path</dt>
                  <dd class="mt-2 font-mono text-sm text-white">/?ed=2048</dd>
                </div>
                <div class="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                  <dt class="text-sm text-slate-400">Security</dt>
                  <dd class="mt-2 text-sm text-white">TLS with WebSocket transport</dd>
                </div>
                <div class="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                  <dt class="text-sm text-slate-400">Subscription output</dt>
                  <dd class="mt-2 text-sm text-white">Base64, Clash YAML, Sing-box JSON, Happ</dd>
                </div>
              </dl>
            </div>

            <div class="rounded-[28px] border border-white/10 bg-white/5 p-6 backdrop-blur xl:p-8">
              <p class="text-sm font-medium uppercase tracking-[0.24em] text-cyan-300/75">
                Quick Setup
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-white">Client instructions</h2>
              <ul class="mt-6 space-y-4 text-sm leading-6 text-slate-300">
                <li class="flex gap-3">
                  <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
                  <span>
                    <strong class="text-white">1. Copy link:</strong> Choose Universal, Clash YAML,
                    Sing-box JSON, or Happ depending on your client software.
                  </span>
                </li>
                <li class="flex gap-3">
                  <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
                  <span>
                    <strong class="text-white">2. Import into client:</strong> Add as remote
                    subscription in Clash Verge Rev, Mihomo Party, Sing-box, NekoBox, v2rayNG, or Happ.
                  </span>
                </li>
                <li class="flex gap-3">
                  <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
                  <span>
                    <strong class="text-white">3. Set auto-update:</strong> Enable scheduled updates
                    every 6–12 hours for fresh node availability.
                  </span>
                </li>
                <li class="flex gap-3">
                  <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
                  <span>
                    <strong class="text-white">4. Recommended mode:</strong> Use Rule mode with Fake-IP
                    enabled to eliminate DNS leaks and latency.
                  </span>
                </li>
                <li class="flex gap-3">
                  <span class="mt-2 h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                  <span>
                    <strong class="text-amber-200">DNS Warning:</strong> Do not use Cloudflare DNS (<code>1.1.1.1</code> or <code>cloudflare-dns.com</code>) inside your proxy client. Cloudflare Workers block outbound connections to Cloudflare IPs. Use Google DNS (<code>https://dns.google/dns-query</code> or <code>8.8.8.8</code>), Quad9, or direct local DNS.
                  </span>
                </li>
              </ul>
            </div>
          </section>
        </main>
        {appShellScript}
      </body>
    </html>
  );
};
