import Groq from 'groq-sdk';
import { GoogleGenerativeAI, Content } from '@google/generative-ai';
import { logger } from '../utils/logger';

const SYSTEM_CONTEXT = `אתה יועץ פיננסי ישראלי מומחה ואנליסט שוק ההון.
יש לך ידע מעמיק ב:
- בורסת תל אביב (ת"א) וחברות ישראליות
- חברות טכנולוגיה ישראליות הנסחרות בארה"ב (צ'ק פוינט, סייברארק, מאנדיי, וויקס וכו')
- מגמות מאקרו עולמיות המשפיעות על השוק הישראלי
- הכלכלה הישראלית, השקל, מדיניות בנק ישראל
- ניתוח טכני ופונדמנטלי

כללים:
- ענה תמיד בעברית, גם אם השאלה באנגלית
- היה תמציתי אך יסודי
- תמיד ציין סיכונים בעת מתן ייעוץ
- אל תיתן המלצות קנה/מכור חד משמעיות — הצג כניתוח בלבד`;

export class ChatHandler {
  private groq: Groq | null = null;
  private gemini: GoogleGenerativeAI | null = null;
  private readonly provider: 'groq' | 'gemini';

  // Per-user conversation history
  private readonly groqHistories = new Map<number, Array<{ role: 'user' | 'assistant'; content: string }>>();
  private readonly geminiHistories = new Map<number, Content[]>();
  private readonly MAX_HISTORY = 20;

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

  async chat(chatId: number, userMessage: string): Promise<string> {
    try {
      if (this.provider === 'groq') {
        return await this.chatGroq(chatId, userMessage);
      }
      return await this.chatGemini(chatId, userMessage);
    } catch (err: any) {
      if (err?.status === 429) {
        return '⏳ Too many requests — AI quota reached. Please try again in a few minutes.';
      }
      logger.error('Chat handler error', err);
      return '❌ Something went wrong. Please try again.';
    }
  }

  clearHistory(chatId: number): void {
    this.groqHistories.delete(chatId);
    this.geminiHistories.delete(chatId);
  }

  historyCount(): number {
    return this.provider === 'groq' ? this.groqHistories.size : this.geminiHistories.size;
  }

  private async chatGroq(chatId: number, userMessage: string): Promise<string> {
    const history = this.groqHistories.get(chatId) ?? [];

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SYSTEM_CONTEXT },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const response = await this.groq!.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.5,
      max_tokens: 1024,
    });

    const reply = response.choices[0]?.message?.content ?? '';

    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: reply });
    if (history.length > this.MAX_HISTORY * 2) history.splice(0, 2);
    this.groqHistories.set(chatId, history);

    return reply;
  }

  private async chatGemini(chatId: number, userMessage: string): Promise<string> {
    const history = this.geminiHistories.get(chatId) ?? [];

    const model = this.gemini!.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_CONTEXT,
    });

    const session = model.startChat({ history });
    const result = await session.sendMessage(userMessage);
    const reply = result.response.text();

    history.push({ role: 'user', parts: [{ text: userMessage }] });
    history.push({ role: 'model', parts: [{ text: reply }] });
    if (history.length > this.MAX_HISTORY * 2) history.splice(0, 2);
    this.geminiHistories.set(chatId, history);

    return reply;
  }
}
