import { config } from '../utils/config';

export interface SearXNGResult {
  url: string;
  title: string;
  content: string;
  engines: string[];
  positions: number[];
  score: number;
  category: string;
}

export interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  suggestions: string[];
  answers: string[];
  corrections: string[];
  infoboxes: unknown[];
}

export interface SearXNGHealth {
  configured: boolean;
  reachable: boolean;
  url: string | null;
  status: number | null;
  latencyMs: number | null;
  detail: string | null;
}

export class SearXNGService {
  private baseUrl: string;
  private maxResults: number;
  private safeSearch: number;

  constructor() {
    this.baseUrl = config.searxng.baseUrl.replace(/\/$/, '');
    this.maxResults = config.searxng.maxResults;
    this.safeSearch = config.searxng.safeSearch;
  }

  /**
   * Liveness probe for the dashboard's integrations view.
   *
   * Deliberately does not go through `search()`: that method logs a large block
   * per call and has no timeout, so a hung instance would stall the health
   * endpoint indefinitely. Any HTTP response counts as reachable — the question
   * is whether the server answers, not whether the route is `/healthz`.
   */
  async ping(timeoutMs = 4000): Promise<SearXNGHealth> {
    const url = this.baseUrl || null;

    if (!url) {
      return { configured: false, reachable: false, url: null, status: null, latencyMs: null, detail: 'SEARXNG_URL is not set' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(`${url}/healthz`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      return {
        configured: true,
        reachable: true,
        url,
        status: res.status,
        latencyMs: Date.now() - started,
        detail: res.ok ? 'healthy' : `answered with HTTP ${res.status}`,
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        configured: true,
        reachable: false,
        url,
        status: null,
        latencyMs: Date.now() - started,
        detail: aborted ? `no response after ${timeoutMs}ms` : (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, options: {
    categories?: string;
    language?: string;
    timeRange?: string;
    engines?: string;
  } = {}): Promise<SearXNGResponse> {
    const startTime = Date.now();
    const searchId = Math.random().toString(36).substring(2, 8);
    
    console.log(`\n🔍 [SEARCH:${searchId}] ========================================`);
    console.log(`🔍 [SEARCH:${searchId}] Initiating web search`);
    console.log(`🔍 [SEARCH:${searchId}] Query: "${query}"`);
    console.log(`🔍 [SEARCH:${searchId}] Options:`, JSON.stringify({
      categories: options.categories || 'general',
      language: options.language || 'auto',
      timeRange: options.timeRange || 'any',
      engines: options.engines || 'all',
      maxResults: this.maxResults,
      safeSearch: this.safeSearch,
    }, null, 2));

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      safesearch: this.safeSearch.toString(),
      pageno: '1',
    });

    if (options.categories) params.set('categories', options.categories);
    if (options.language) params.set('language', options.language);
    if (options.timeRange) params.set('time_range', options.timeRange);
    if (options.engines) params.set('engines', options.engines);

    const url = `${this.baseUrl}/search?${params.toString()}`;
    console.log(`🔍 [SEARCH:${searchId}] URL: ${url}`);

    try {
      console.log(`🔍 [SEARCH:${searchId}] Sending request...`);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`SearXNG request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as SearXNGResponse;
      const duration = Date.now() - startTime;
      
      // Log search results summary
      console.log(`\n✅ [SEARCH:${searchId}] ========================================`);
      console.log(`✅ [SEARCH:${searchId}] Search completed successfully`);
      console.log(`✅ [SEARCH:${searchId}] Duration: ${duration}ms`);
      console.log(`✅ [SEARCH:${searchId}] Total results found: ${data.number_of_results}`);
      console.log(`✅ [SEARCH:${searchId}] Results returned: ${Math.min(data.results?.length || 0, this.maxResults)}`);
      
      const engines = [...new Set(data.results?.flatMap(r => r.engines) || [])];
      console.log(`✅ [SEARCH:${searchId}] Search engines used: ${engines.join(', ') || 'N/A'}`);
      
      if (data.suggestions?.length > 0) {
        console.log(`✅ [SEARCH:${searchId}] Suggestions: ${data.suggestions.slice(0, 3).join(', ')}`);
      }
      
      if (data.answers?.length > 0) {
        console.log(`✅ [SEARCH:${searchId}] Direct answers: ${data.answers.length} found`);
      }
      
      console.log(`✅ [SEARCH:${searchId}] ========================================\n`);
      
      // Limit results to maxResults
      if (data.results && data.results.length > this.maxResults) {
        data.results = data.results.slice(0, this.maxResults);
      }

      return data;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`\n❌ [SEARCH:${searchId}] ========================================`);
      console.error(`❌ [SEARCH:${searchId}] Search failed after ${duration}ms`);
      console.error(`❌ [SEARCH:${searchId}] Error:`, error);
      console.error(`❌ [SEARCH:${searchId}] ========================================\n`);
      throw error;
    }
  }

  formatResultsForLLM(results: SearXNGResponse): string {
    if (!results.results || results.results.length === 0) {
      console.log(`   [SEARCH] No results to format for LLM`);
      return 'No search results found.';
    }

    console.log(`   [SEARCH] Formatting ${results.results.length} results for LLM context`);

    let formatted = `Search results for "${results.query}":\n\n`;
    
    results.results.forEach((result, index) => {
      formatted += `[${index + 1}] ${result.title}\n`;
      formatted += `URL: ${result.url}\n`;
      formatted += `Content: ${result.content}\n`;
      formatted += `Sources: ${result.engines.join(', ')}\n\n`;
    });

    if (results.suggestions && results.suggestions.length > 0) {
      formatted += `\nRelated searches: ${results.suggestions.join(', ')}`;
    }

    return formatted;
  }
}

export const searxngService = new SearXNGService();