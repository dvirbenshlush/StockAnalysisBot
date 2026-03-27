import axios from 'axios';
import { logger } from '../utils/logger';
import { StockMention } from './claudeAnalyzer';

export interface StockData {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  marketCap?: number;
  currency: string;
  exchange: string;
}

export interface CrossRefResult {
  mention: StockMention;
  marketData?: StockData;
  newsHeadlines: string[];
  technicalSignal?: 'buy' | 'sell' | 'hold';
  combinedScore: number; // -1 to 1
}

export class FinancialCrossRef {
  private readonly yahooBaseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart';
  private readonly tavilyApiKey: string;

  constructor() {
    this.tavilyApiKey = process.env.TAVILY_API_KEY ?? '';
  }

  async crossReference(mentions: StockMention[]): Promise<CrossRefResult[]> {
    const results = await Promise.all(mentions.map((m) => this.processOneMention(m)));
    return results;
  }

  async getStockData(ticker: string): Promise<StockData | null> {
    try {
      const response = await axios.get(`${this.yahooBaseUrl}/${ticker}`, {
        params: { interval: '1d', range: '1d' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000,
      });

      const meta = response.data?.chart?.result?.[0]?.meta;
      if (!meta) return null;

      return {
        ticker,
        price: meta.regularMarketPrice,
        change: meta.regularMarketPrice - meta.previousClose,
        changePercent: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100,
        volume: meta.regularMarketVolume,
        currency: meta.currency,
        exchange: meta.exchangeName,
      };
    } catch (err) {
      logger.warn(`Failed to fetch market data for ${ticker}`, err);
      return null;
    }
  }

  async getRecentNews(query: string): Promise<string[]> {
    if (!this.tavilyApiKey) {
      logger.warn('Tavily API key not configured, skipping news fetch');
      return [];
    }

    try {
      const response = await axios.post(
        'https://api.tavily.com/search',
        {
          api_key: this.tavilyApiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false,
          topic: 'finance',
        },
        { timeout: 8000 }
      );

      return (response.data?.results ?? []).map((r: any) => r.title as string);
    } catch (err) {
      logger.warn('Tavily news fetch failed', err);
      return [];
    }
  }

  formatCrossRefSummary(results: CrossRefResult[]): string {
    if (results.length === 0) return 'No cross-reference data available.';

    const lines: string[] = ['📉📈 *Cross-Reference Report*\n'];

    for (const r of results) {
      const { mention, marketData, newsHeadlines } = r;
      lines.push(`*${mention.ticker}*`);

      if (marketData) {
        const dir = marketData.change >= 0 ? '▲' : '▼';
        lines.push(
          `  Price: ${marketData.price.toFixed(2)} ${marketData.currency} ${dir} ${Math.abs(marketData.changePercent).toFixed(2)}%`
        );
      }

      if (newsHeadlines.length > 0) {
        lines.push(`  Recent news:`);
        newsHeadlines.slice(0, 3).forEach((h) => lines.push(`  • ${h}`));
      }

      const scoreLabel =
        r.combinedScore > 0.3 ? 'BULLISH' : r.combinedScore < -0.3 ? 'BEARISH' : 'NEUTRAL';
      lines.push(`  Combined signal: ${scoreLabel} (${r.combinedScore.toFixed(2)})\n`);
    }

    return lines.join('\n');
  }

  private async processOneMention(mention: StockMention): Promise<CrossRefResult> {
    const [marketData, newsHeadlines] = await Promise.all([
      this.getStockData(mention.ticker),
      this.getRecentNews(`${mention.ticker} ${mention.name} stock`),
    ]);

    // Compute a simple combined score
    const sentimentScore =
      mention.sentiment === 'bullish' ? mention.confidence : mention.sentiment === 'bearish' ? -mention.confidence : 0;

    let marketScore = 0;
    if (marketData) {
      marketScore = Math.max(-1, Math.min(1, marketData.changePercent / 5));
    }

    const combinedScore = sentimentScore * 0.7 + marketScore * 0.3;

    return { mention, marketData: marketData ?? undefined, newsHeadlines, combinedScore };
  }
}
