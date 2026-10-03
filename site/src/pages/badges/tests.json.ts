/*
  A shields.io endpoint badge, generated at build time, so the README's "tests" badge is
  as live as the rebuild: https://shields.io/badges/endpoint-badge

  Lives at src/pages/badges/tests.json.ts and is served from
  https://opencode-claude-code-plugin.dev/badges/tests.json
*/
import type { APIRoute } from 'astro';
import { loadStats, formatCount } from '../../data/stats';

export const GET: APIRoute = async () => {
  const stats = await loadStats();
  const body = {
    schemaVersion: 1,
    label: 'tests',
    message: formatCount(stats.tests),
    color: 'FFC46B', // shields.io sets #333 text on this (brightness > 0.69); the darker amber would get white text at 2.2:1
    labelColor: '15181E',
    cacheSeconds: 3600,
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
