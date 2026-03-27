import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';

export interface AnalysisInput {
  source: string;
  content: string;
  timestamp?: string;
}

export interface StockMention {
  ticker: string;
  name: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  reasoning: string;
}

export interface AnalysisResult {
  summary: string;
  stockMentions: StockMention[];
  keyInsights: string[];
  riskFactors: string[];
  recommendation?: string;
  rawResponse?: string;
}

export class ClaudeAnalyzer {
  private readonly client: Anthropic;
  private readonly model = 'claude-opus-4-6';

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async analyzeContent(inputs: AnalysisInput[]): Promise<AnalysisResult> {
    const combinedContent = inputs
      .map((i) => `[Source: ${i.source}${i.timestamp ? ` | ${i.timestamp}` : ''}]\n${i.content}`)
      .join('\n\n---\n\n');

    const prompt = `You are a financial analyst specializing in Israeli stocks and global markets.

Analyze the following content from various financial sources and extract actionable insights.

${combinedContent}

Respond in JSON with this exact structure:
{
  "summary": "2-3 sentence overview of main themes",
  "stockMentions": [
    {
      "ticker": "TICKER",
      "name": "Company Name",
      "sentiment": "bullish|bearish|neutral",
      "confidence": 0.0-1.0,
      "reasoning": "why this sentiment"
    }
  ],
  "keyInsights": ["insight 1", "insight 2"],
  "riskFactors": ["risk 1", "risk 2"],
  "recommendation": "optional overall market recommendation"
}

Focus on: Israeli stocks (TASE), US-listed Israeli companies, macro trends affecting Israeli market.
Respond only with the JSON object.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text) as AnalysisResult;
      return { ...parsed, rawResponse: text };
    } catch (err) {
      logger.error('Claude analysis failed', err);
      return {
        summary: 'Analysis failed',
        stockMentions: [],
        keyInsights: [],
        riskFactors: [],
      };
    }
  }

  async analyzeStockSpecific(ticker: string, context: string): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `You are a financial analyst. Analyze the following information about ${ticker} and provide a concise investment outlook (3-5 sentences):\n\n${context}`,
          },
        ],
      });

      return response.content[0].type === 'text' ? response.content[0].text : '';
    } catch (err) {
      logger.error(`Failed to analyze stock ${ticker}`, err);
      return '';
    }
  }

  async summarizeForBot(analysisResult: AnalysisResult): Promise<string> {
    const lines: string[] = [];

    lines.push(`📊 *Market Analysis*\n`);
    lines.push(`${analysisResult.summary}\n`);

    if (analysisResult.stockMentions.length > 0) {
      lines.push(`\n📈 *Stock Mentions:*`);
      for (const s of analysisResult.stockMentions) {
        const emoji = s.sentiment === 'bullish' ? '🟢' : s.sentiment === 'bearish' ? '🔴' : '🟡';
        lines.push(`${emoji} *${s.ticker}* (${s.name}) — ${s.sentiment} (${Math.round(s.confidence * 100)}%)`);
        lines.push(`  _${s.reasoning}_`);
      }
    }

    if (analysisResult.keyInsights.length > 0) {
      lines.push(`\n💡 *Key Insights:*`);
      analysisResult.keyInsights.forEach((i) => lines.push(`• ${i}`));
    }

    if (analysisResult.riskFactors.length > 0) {
      lines.push(`\n⚠️ *Risk Factors:*`);
      analysisResult.riskFactors.forEach((r) => lines.push(`• ${r}`));
    }

    if (analysisResult.recommendation) {
      lines.push(`\n🎯 *Recommendation:* ${analysisResult.recommendation}`);
    }

    return lines.join('\n');
  }
}
