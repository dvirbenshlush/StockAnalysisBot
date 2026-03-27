import axios from 'axios';
import { logger } from './logger';

export interface NewsResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
}

/**
 * NewsSearcher supports both Tavily and SerpAPI.
 * Tavily is preferred (finance-optimized). SerpAPI is the fallback.
 */
export class NewsSearcher {
  private readonly tavilyKey: string;
  private readonly serpApiKey: string;

  constructor() {
    this.tavilyKey = process.env.TAVILY_API_KEY ?? '';
    this.serpApiKey = process.env.SERPAPI_KEY ?? '';
  }

  async search(query: string, maxResults = 10): Promise<NewsResult[]> {
    if (this.tavilyKey) {
      const results = await this.searchTavily(query, maxResults);
      if (results.length > 0) return results;
    }

    if (this.serpApiKey) {
      return this.searchSerpApi(query, maxResults);
    }

    logger.warn('No search API keys configured (TAVILY_API_KEY or SERPAPI_KEY)');
    return [];
  }

  async searchFinancialNews(query: string, maxResults = 10): Promise<NewsResult[]> {
    return this.search(`${query} stock market finance`, maxResults);
  }

  private async searchTavily(query: string, maxResults: number): Promise<NewsResult[]> {
    try {
      const response = await axios.post(
        'https://api.tavily.com/search',
        {
          api_key: this.tavilyKey,
          query,
          search_depth: 'advanced',
          max_results: maxResults,
          include_answer: false,
          topic: 'finance',
          include_domains: [
            'reuters.com',
            'bloomberg.com',
            'ynet.co.il',
            'calcalist.co.il',
            'themarker.com',
            'globes.co.il',
            'investing.com',
            'marketwatch.com',
          ],
        },
        { timeout: 10000 }
      );

      return (response.data?.results ?? []).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        source: new URL(r.url).hostname,
        publishedAt: r.published_date,
      }));
    } catch (err) {
      logger.warn('Tavily search failed', err);
      return [];
    }
  }

  private async searchSerpApi(query: string, maxResults: number): Promise<NewsResult[]> {
    try {
      const response = await axios.get('https://serpapi.com/search', {
        params: {
          api_key: this.serpApiKey,
          q: query,
          tbm: 'nws',
          num: maxResults,
          hl: 'en',
        },
        timeout: 10000,
      });

      return (response.data?.news_results ?? []).map((r: any) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? '',
        source: r.source ?? '',
        publishedAt: r.date,
      }));
    } catch (err) {
      logger.warn('SerpAPI search failed', err);
      return [];
    }
  }
}
