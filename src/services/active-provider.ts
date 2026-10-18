import { setActiveProviderResolver } from '../utils/config';
import type { NamedProvider } from '../utils/provider-registry';
import { modelSelectorService } from './model-selector';

/**
 * The one place that knows how to answer "which provider is the dashboard
 * currently pointing at?".
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * `utils/config.ts` needs that answer — `isMoonshotProvider()` and
 * `isOpenRouterProvider()` are URL-shaped, and under the registry the URL is
 * the selected provider's, not the boot-time one. But `model-selector.ts`
 * already imports `config`, so importing it back would close the cycle
 * `config -> model-selector -> config`; ESM does not reject that, it just hands
 * `model-selector` a half-built `config` and produces a provider that is
 * silently `undefined`. So the dependency is inverted instead: this module
 * imports both, and hands `config` a resolver at module-load time.
 *
 * Being an ESM module, this runs exactly once, before the first call of any
 * importer's body — so `import './active-provider'` is sufficient to guarantee
 * the resolver is installed before it is used. Consumers then read it through
 * `resolveActiveProvider()` from `utils/config.ts`, which is the same accessor
 * `isMoonshotProvider()` and friends go through, so there is exactly one
 * routing answer in the process.
 *
 * IMPORTANT: this module must not import `./openai`. That would defeat the
 * dynamic `require('./openai')` in `google-genai.ts`, which exists so a
 * Gemini-only deployment never evaluates the OpenAI singleton's constructor.
 * `src/services/__tests__/provider-parity.test.ts` guards that.
 */

setActiveProviderResolver(() => modelSelectorService.getActiveProvider());

/**
 * The provider backing the current dashboard selection, or `undefined` when
 * none can be resolved. Under legacy behaviour (`config.providers.active ===
 * false`) this is the single implicit provider carrying `OPENAI_BASE_URL` /
 * `OPENAI_API_KEY`, so callers can write uniform code.
 */
export function activeProvider(): NamedProvider | undefined {
  return modelSelectorService.getActiveProvider();
}