// Lets node run the SDK's TypeScript sources directly: their `./x.js` imports point at `./x.ts`.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') && spec.endsWith('.js')) return next(`${spec.slice(0, -3)}.ts`, ctx);
      throw e;
    }
  },
});
