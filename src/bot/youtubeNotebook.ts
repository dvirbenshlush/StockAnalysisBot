import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger';
import { b, i, e } from '../utils/html';
import { cache, AnalysisCache } from '../utils/analysisCache';

export interface NotebookSummary {
  title: string;
  overview: string;
  keyPoints: string[];
  stocksMentioned: Array<{ ticker: string; context: string }>;
  quotes: string[];
  faqs: Array<{ question: string; answer: string }>;
  conclusion: string;
}

export class YouTubeNotebook {
  private groq: Groq | null = null;
  private gemini: GoogleGenerativeAI | null = null;
  private readonly provider: 'groq' | 'gemini';

  constructor() {
    if (process.env.GROQ_API_KEY) {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      this.provider = 'groq';
    } else if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.provider = 'gemini';
    } else {
      throw new Error('Either GROQ_API_KEY or GEMINI_API_KEY is required');
    }
  }

  extractVideoId(input: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  async fetchTranscript(videoId: string): Promise<{ transcript: string; language: string }> {
    const { fetchYouTubeTranscript } = await import('../utils/transcriptFetcher');
    const transcript = await fetchYouTubeTranscript(videoId);
    return { transcript, language: 'he' };
  }

  async summarize(videoId: string, videoTitle?: string): Promise<NotebookSummary> {
    const cacheKey = 'notebook_' + videoId;
    const cached = cache.get<NotebookSummary>(cacheKey);
    if (cached) {
      logger.info(`Returning cached notebook for ${videoId}`);
      return cached;
    }

    const { transcript, language } = await this.fetchTranscript(videoId);

    if (!transcript || transcript.length < 50) {
      throw new Error('No transcript available for this video');
    }

    // Truncate to ~6000 chars to stay within token limits
    const truncated = transcript.length > 6000 ? transcript.slice(0, 6000) + '...' : transcript;
    const prompt = `אתה אנליסט פיננסי שיוצר סיכום מעמיק בסגנון NotebookLM של סרטון YouTube.
ענה בעברית בלבד.
${videoTitle ? `כותרת הסרטון: "${videoTitle}"` : ''}

תמליל:
${truncated}

ענה רק עם אובייקט JSON תקני במבנה הבא בדיוק:
{
  "title": "כותרת תמציתית לסרטון",
  "overview": "סיכום של 2-3 משפטים על מה הסרטון עוסק",
  "keyPoints": ["נקודה 1", "נקודה 2", "נקודה 3", "נקודה 4", "נקודה 5"],
  "stocksMentioned": [
    { "ticker": "שם מניה או חברה", "context": "מה נאמר עליה" }
  ],
  "quotes": ["ציטוט בולט 1", "ציטוט בולט 2"],
  "faqs": [
    { "question": "שאלה שצופה עשוי לשאול", "answer": "תשובה מבוססת על הסרטון" },
    { "question": "שאלה נוספת", "answer": "תשובה" }
  ],
  "conclusion": "המסקנה המרכזית או ההמלצה מהסרטון"
}`;

    try {
      let text = '';
      if (this.provider === 'groq') {
        const response = await this.groq!.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2048,
        });
        text = response.choices[0]?.message?.content?.trim() ?? '';
      } else {
        const model = this.gemini!.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent(prompt);
        text = result.response.text().trim();
      }

      const cleaned = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      const summary = JSON.parse(cleaned) as NotebookSummary;
      cache.set(cacheKey, summary);
      return summary;
    } catch (err: any) {
      if (err?.status === 429) throw new Error('QUOTA_EXCEEDED');
      logger.error('Notebook summarize failed', err);
      throw new Error('Failed to generate summary');
    }
  }

  formatForTelegram(summary: NotebookSummary, videoId: string): string {
    const lines: string[] = [];

    lines.push(`📓 ${b(summary.title)}`);
    lines.push(`🔗 https://youtu.be/${videoId}\n`);

    lines.push(`📋 ${b('Overview')}`);
    lines.push(e(summary.overview) + '\n');

    if (summary.keyPoints.length > 0) {
      lines.push(`💡 ${b('Key Points')}`);
      summary.keyPoints.forEach((p, idx) => lines.push(`${idx + 1}. ${e(p)}`));
      lines.push('');
    }

    if (summary.stocksMentioned.length > 0) {
      lines.push(`📈 ${b('Stocks Mentioned')}`);
      summary.stocksMentioned.forEach((s) => lines.push(`• ${b(s.ticker)} — ${e(s.context)}`));
      lines.push('');
    }

    if (summary.quotes.length > 0) {
      lines.push(`💬 ${b('Notable Quotes')}`);
      summary.quotes.forEach((q) => lines.push(i(`"${q}"`)));
      lines.push('');
    }

    if (summary.faqs.length > 0) {
      lines.push(`❓ ${b('Q&A')}`);
      summary.faqs.forEach((f) => {
        lines.push(`${b('Q:')} ${e(f.question)}`);
        lines.push(`A: ${e(f.answer)}`);
      });
      lines.push('');
    }

    lines.push(`🎯 ${b('Conclusion')}`);
    lines.push(e(summary.conclusion));

    return lines.join('\n');
  }
}
