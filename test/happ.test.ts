import { describe, expect, it } from 'bun:test';
import worker from '../src/index';
import {
  detectClient,
  generateHapp,
  happHeaders,
  parseAddList,
  toTrojanNodes,
} from '../src/sub';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('Happ client detection', () => {
  it('detects Happ by User-Agent, case-insensitively', () => {
    expect(detectClient('Happ/2.4.1')).toBe('happ');
    expect(detectClient('happ-android')).toBe('happ');
  });

  it('keeps other clients unchanged', () => {
    expect(detectClient('clash-verge/1.7')).toBe('clash');
    expect(detectClient('sing-box 1.9')).toBe('singbox');
    expect(detectClient('v2rayNG/1.8')).toBe('base64');
  });
});

describe('Happ subscription body', () => {
  const vless = parseAddList('example.com:443#Edge', 'example.com', UUID, '/?ed=2048');
  const nodes = [...vless, ...toTrojanNodes(vless, 'pw')];

  it('starts with meta directives followed by share links', () => {
    const lines = generateHapp(nodes, 'AetherEdge').split('\n');
    expect(lines.slice(0, 3)).toEqual([
      '#profile-title: AetherEdge',
      '#profile-update-interval: 6',
      '#subscription-userinfo: upload=0; download=0; total=0; expire=0',
    ]);
    expect(lines[3].startsWith(`vless://${UUID}@example.com:443?`)).toBe(true);
    expect(lines[4].startsWith('trojan://pw@example.com:443?')).toBe(true);
  });

  it('matches the Happ directive grammar', () => {
    const directive = /^#([a-z0-9-]+)\s*:\s*(.*)$/;
    const directives = generateHapp(nodes, 'AetherEdge')
      .split('\n')
      .filter((line) => line.startsWith('#'));
    expect(directives).toHaveLength(3);
    for (const line of directives) {
      expect(directive.test(line)).toBe(true);
    }
  });

  it('encodes non-ASCII titles as base64: values', () => {
    const encoded = 'base64:' + btoa(String.fromCharCode(...new TextEncoder().encode('Прокси')));
    expect(generateHapp(nodes, 'Прокси')).toContain(`#profile-title: ${encoded}`);
    expect(happHeaders('Прокси')['Profile-Title']).toBe(encoded);
  });

  it('builds response headers', () => {
    expect(happHeaders('AetherEdge')).toEqual({
      'Profile-Title': 'AetherEdge',
      'Profile-Update-Interval': '6',
      'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0',
    });
  });
});

describe('/sub endpoint for Happ', () => {
  const env = { UUID, HOST: 'sub.example.com', ADD: 'example.com:443#Edge' };
  const ctx = {} as ExecutionContext;
  const get = (path: string, userAgent?: string) =>
    worker.fetch(
      new Request(`https://sub.example.com${path}`, {
        headers: userAgent ? { 'User-Agent': userAgent } : {},
      }),
      env,
      ctx,
    );

  it('serves the Happ body for ?format=happ', async () => {
    const response = await get('/sub?format=happ');
    expect(response.headers.get('Profile-Title')).toBe('AetherEdge');
    expect(response.headers.get('Profile-Update-Interval')).toBe('6');
    expect(response.headers.get('Subscription-Userinfo')).toBe(
      'upload=0; download=0; total=0; expire=0',
    );
    const body = await response.text();
    expect(body.startsWith('#profile-title: AetherEdge\n')).toBe(true);
    expect(body).toContain('vless://');
    expect(body).toContain('trojan://');
  });

  it('serves the Happ body for a Happ User-Agent', async () => {
    const response = await get('/sub', 'Happ/2.0');
    expect((await response.text()).startsWith('#profile-title:')).toBe(true);
  });

  it('keeps base64 for unknown clients and includes trojan links', async () => {
    const body = atob(await (await get('/sub', 'curl/8')).text());
    expect(body).toContain('vless://');
    expect(body).toContain('trojan://');
  });

  it('omits trojan nodes when TROJAN=off', async () => {
    const response = await worker.fetch(
      new Request('https://sub.example.com/sub?format=happ'),
      { ...env, TROJAN: 'off' },
      ctx,
    );
    expect(await response.text()).not.toContain('trojan://');
  });

  it('serves the dashboard with a Happ copy button', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('Copy Happ URL');
    expect(html).toContain('format=happ');
  });
});
