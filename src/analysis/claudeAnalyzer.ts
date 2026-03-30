import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger';
import { b, i, e } from '../utils/html';
import { cache, AnalysisCache } from '../utils/analysisCache';

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
  private groq: Groq | null = null;
  private gemini: GoogleGenerativeAI | null = null;
  private readonly provider: 'groq' | 'gemini';

  constructor() {
    if (process.env.GROQ_API_KEY) {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      this.provider = 'groq';
      logger.info('AI provider: Groq (llama-3.3-70b)');
    } else if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.provider = 'gemini';
      logger.info('AI provider: Gemini (gemini-2.0-flash)');
    } else {
      throw new Error('Either GROQ_API_KEY or GEMINI_API_KEY is required');
    }
  }

  async analyzeContent(inputs: AnalysisInput[]): Promise<AnalysisResult> {
    const combinedContent = inputs
      .map((inp) => {
        const truncated = inp.content.length > 800 ? inp.content.slice(0, 800) + '...' : inp.content;
        return `[Source: ${inp.source}${inp.timestamp ? ` | ${inp.timestamp}` : ''}]\n${truncated}`;
      })
      .join('\n\n---\n\n');

    const cacheKey = 'analysis_' + AnalysisCache.hash(combinedContent);
    const cached = cache.get<AnalysisResult>(cacheKey);
    if (cached) {
      logger.info('Returning cached analysis result');
      return cached;
    }

    const systemPrompt = `אתה אנליסט פיננסי המתמחה במניות ישראליות ובשווקים גלובליים.
התמקד ב: מניות ישראליות (ת"א), חברות ישראליות הנסחרות בארה"ב, מגמות מאקרו המשפיעות על השוק הישראלי.
ענה רק עם אובייקט JSON תקני, ללא markdown וללא טקסט נוסף.
כל הטקסטים בתוך ה-JSON יהיו בעברית.`;

    const userPrompt = `נתח את התוכן הפיננסי הבא וחלץ תובנות מעשיות.

${combinedContent}

ענה ב-JSON עם המבנה הבא בדיוק:
{
  "summary": "סקירה של 2-3 משפטים על הנושאים המרכזיים",
  "stockMentions": [
    { "ticker": "TICKER", "name": "שם החברה", "sentiment": "bullish|bearish|neutral", "confidence": 0.0-1.0, "reasoning": "הסיבה" }
  ],
  "keyInsights": ["תובנה 1", "תובנה 2"],
  "riskFactors": ["סיכון 1", "סיכון 2"],
  "recommendation": "המלצה כללית אופציונלית"
}`;

    const result = await this.callAI(systemPrompt, userPrompt, {
      summary: 'Analysis failed',
      stockMentions: [] as StockMention[],
      keyInsights: [] as string[],
      riskFactors: [] as string[],
    } as AnalysisResult);

    if (result.summary !== 'Analysis failed') {
      cache.set(cacheKey, result);
    }
    return result;
  }

  async analyzeStockSpecific(ticker: string, context: string): Promise<string> {
    const result = await this.callAI(
      'אתה אנליסט פיננסי. ענה בעברית בלבד. היה תמציתי.',
      `נתח את המידע הבא על ${ticker} וספק תחזית השקעה של 3-5 משפטים:\n\n${context.slice(0, 1000)}`,
      ''
    );
    return typeof result === 'string' ? result : '';
  }

  async summarizeForBot(analysisResult: AnalysisResult): Promise<string> {
    const lines: string[] = [];
    lines.push(`📊 ${b('Market Analysis')}\n`);
    lines.push(e(analysisResult.summary) + '\n');

    if (analysisResult.stockMentions.length > 0) {
      lines.push(`\n📈 ${b('Stock Mentions:')}`);
      for (const s of analysisResult.stockMentions) {
        const emoji = s.sentiment === 'bullish' ? '🟢' : s.sentiment === 'bearish' ? '🔴' : '🟡';
        lines.push(`${emoji} ${b(s.ticker)} (${e(s.name)}) — ${e(s.sentiment)} (${Math.round(s.confidence * 100)}%)`);
        lines.push(`  ${i(s.reasoning)}`);
      }
    }

    if (analysisResult.keyInsights.length > 0) {
      lines.push(`\n💡 ${b('Key Insights:')}`);
      analysisResult.keyInsights.forEach((ins) => lines.push(`• ${e(ins)}`));
    }

    if (analysisResult.riskFactors.length > 0) {
      lines.push(`\n⚠️ ${b('Risk Factors:')}`);
      analysisResult.riskFactors.forEach((r) => lines.push(`• ${e(r)}`));
    }

    if (analysisResult.recommendation) {
      lines.push(`\n🎯 ${b('Recommendation:')} ${e(analysisResult.recommendation)}`);
    }

    return lines.join('\n');
  }

  // ── Core AI call with provider fallback ─────────────────────────
  private async callAI<T>(system: string, user: string, fallback: T): Promise<T> {
    if (this.provider === 'groq') {
      return this.callGroq(system, user, fallback);
    }
    return this.callGemini(system, user, fallback);
  }

  private async callGroq<T>(system: string, user: string, fallback: T): Promise<T> {
    try {
      const response = await this.groq!.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      const text = response.choices[0]?.message?.content?.trim() ?? '';
      if (typeof fallback === 'string') return text as T;

      const cleaned = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      return JSON.parse(cleaned) as T;
    } catch (err: any) {
      logger.error('Groq call failed', { message: err?.message });
      return fallback;
    }
  }

  private async callGemini<T>(system: string, user: string, fallback: T, retries = 2): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const model = this.gemini!.getGenerativeModel({
          model: 'gemini-2.0-flash',
          systemInstruction: system,
        });
        const result = await model.generateContent(user);
        const text = result.response.text().trim();
        if (typeof fallback === 'string') return text as T;
        const cleaned = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        return JSON.parse(cleaned) as T;
      } catch (err: any) {
        if (err?.status === 429 && attempt < retries) {
          const delay = attempt * 30000;
          logger.warn(`Gemini rate limit, retrying in ${delay / 1000}s`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          logger.error('Gemini call failed', { message: err?.message });
          return fallback;
        }
      }
    }
    return fallback;
  }
}
