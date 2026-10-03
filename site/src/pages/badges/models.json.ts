/*
  A shields.io endpoint badge, generated at build time, so the README's "models" badge
  is as live as the rebuild: https://shields.io/badges/endpoint-badge

  The README used to print the count in prose, which went stale every time a model was
  registered. The figure now has exactly one source, `defaultModels` in src/models.ts,
  counted by the Docs workflow into OCC_STAT_MODELS.

  Lives at src/pages/badges/models.json.ts and is served from
  https://opencode-claude-code-plugin.dev/badges/models.json
*/
import type { APIRoute } from 'astro';
import { loadStats, formatCount } from '../../data/stats';

export const GET: APIRoute = async () => {
  const stats = await loadStats();
  const body = {
    schemaVersion: 1,
    label: 'models',
    message: formatCount(stats.models),
    color: 'FFC46B', // the same amber as the tests badge; shields.io sets #333 text on it
    labelColor: '15181E',
    cacheSeconds: 3600,
  };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
