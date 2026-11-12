import { expect, it, vi } from 'vitest';
import { hostAlerts, webhookUrl } from './alerts.ts';

it('sends Slack text only, redacts fields, bounds delivery and suppresses duplicates', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'));
  const alert = hostAlerts('https://hooks.slack.com/services/example', {
    fetcher: fetcher as never,
    now: () => 0,
  });
  await alert({
    type: 'facilitator_low_eth',
    balance: '0',
    error: 'private',
    url: 'private',
  } as never);
  await alert({ type: 'facilitator_low_eth', balance: '0' });
  expect(fetcher).toHaveBeenCalledOnce();
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(String(init.body));
  expect(Object.keys(body)).toEqual(['text']);
  expect(body.text).toContain('facilitator_low_eth');
  expect(body.text).not.toContain('private');
  expect(init.redirect).toBe('error');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(webhookUrl('https://hooks.slack.com/services/example')).toBe(
    'https://hooks.slack.com/services/example',
  );
  for (const url of [
    'http://hooks.slack.com/test',
    'https://user:pass@hooks.slack.com/test',
    'https://hooks.slack.com/test#secret',
  ])
    expect(() => webhookUrl(url)).toThrow();
  const failed = hostAlerts('https://hooks.slack.com/services/example', {
    fetcher: vi.fn(async () => {
      throw new Error('private');
    }),
  });
  await expect(failed({ type: 'base_rpc_unhealthy' })).resolves.toBeUndefined();
});
it('drops malformed numeric evidence instead of forwarding diagnostic text', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'));
  const alert = hostAlerts('https://hooks.slack.com/services/example', { fetcher });
  await alert({
    type: 'facilitator_stuck',
    balance: 'private',
    needed: '-1',
    count: -1,
    seconds: 1.5,
    percent: Infinity,
    status: NaN,
  });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.text).not.toContain('private');
  expect(body.text).not.toContain('null');
  expect(JSON.parse(body.text.slice('host: alert '.length))).toEqual({ type: 'facilitator_stuck' });
});

it('includes only whitelisted startup reason codes', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'));
  const alert = hostAlerts('https://hooks.slack.com/services/example', {
    fetcher,
    intervalSeconds: 0,
  });
  await alert({ type: 'host_startup_failed', reason: 'state_missing' });
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('state_missing');
  await alert({ type: 'host_startup_failed', reason: 'private diagnostic' } as never);
  expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toContain('private');
});
