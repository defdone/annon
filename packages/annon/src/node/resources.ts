import { secureUrl } from '../download/download.js';
import { sameResource } from '../download/proof.js';

/** Absent means open HTTPS policy. An explicit empty list denies every resource. */
export function resourceAllowed(rules: readonly string[] | undefined, resource: string): boolean {
  try {
    const url = secureUrl(resource);
    if (/%2f|%5c/i.test(resource)) return false;
    if (url.username || url.password) return false;
    if (rules === undefined) return true;
    return rules.some((rule) => {
      if (!rule.endsWith('/*')) return sameResource(rule, resource);
      const prefix = secureUrl(rule.slice(0, -1));
      return (
        !prefix.search &&
        !prefix.hash &&
        prefix.origin === url.origin &&
        url.pathname.startsWith(prefix.pathname)
      );
    });
  } catch {
    return false;
  }
}
