/** Relayer settings for the shared exact-origin CORS policy. */
import { corsPolicy, DEFAULT_ORIGINS } from '@defdone/annon/download/http';
export interface CorsSettings {
  allow?: string[];
  previews?: string[];
  maxAgeSeconds?: number;
}
export const relayerCorsPolicy = (settings: CorsSettings = {}) =>
  corsPolicy(
    settings.allow ?? DEFAULT_ORIGINS,
    settings.previews,
    'relayer',
    settings.maxAgeSeconds,
  );
