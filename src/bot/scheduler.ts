import cron from 'node-cron';
import TelegramBotAPI from 'node-telegram-bot-api';
import { YouTubeScraper } from '../scrapers/youtubeScraper';
import { TelegramScraper } from '../scrapers/telegramScraper';
import { ClaudeAnalyzer, AnalysisInput } from '../analysis/claudeAnalyzer';
import { FinancialCrossRef } from '../analysis/financialCrossRef';
import { NewsSearcher } from '../utils/newsSearcher';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const SUBSCRIBERS_FILE = path.join(process.cwd(), 'sessions', 'subscribers.json');

export class Scheduler {
  private subscribers: Set<number> = new Set();
  private readonly bot: TelegramBotAPI;
  private readonly youtube: YouTubeScraper;
  private readonly telegram: TelegramScraper;
  private readonly claude: ClaudeAnalyzer;
  private readonly crossRef: FinancialCrossRef;
  private readonly news: NewsSearcher;

  constructor(
    bot: TelegramBotAPI,
    youtube: YouTubeScraper,
    telegram: TelegramScraper,
    claude: ClaudeAnalyzer,
    crossRef: FinancialCrossRef
  ) {
    this.bot = bot;
    this.youtube = youtube;
    this.telegram = telegram;
    this.claude = claude;
    this.crossRef = crossRef;
    this.news = new NewsSearcher();
    this.loadSubscribers();
  }

  start(): void {
    // Daily summary at 08:00 Israel time (UTC+3 = 05:00 UTC)
    cron.schedule('0 5 * * *', () => {
      logger.info('Running daily summary job...');
      this.runDailySummary('🌅 <b>סיכום יומי</b>');
    }, { timezone: 'UTC' });

    // Market close summary at 17:00 Israel time (14:00 UTC)
    cron.schedule('0 14 * * 0-4', () => {
      logger.info('Running market close summary job...');
      this.runDailySummary('📉 <b>סיכום סגירת שוק</b>');
    }, { timezone: 'UTC' });

    logger.info('Scheduler started — daily summary at 08:00 IL, market close at 17:00 IL (Sun-Thu)');
  }

  subscribe(chatId: number): void {
    this.subscribers.add(chatId);
    this.saveSubscribers();
    logger.info(`Chat ${chatId} subscribed to daily summary`);
  }

  unsubscribe(chatId: number): void {
    this.subscribers.delete(chatId);
    this.saveSubscribers();
    logger.info(`Chat ${chatId} unsubscribed`);
  }

  isSubscribed(chatId: number): boolean {
    return this.subscribers.has(chatId);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  async broadcast(text: string): Promise<void> {
    for (const chatId of this.subscribers) {
      try {
        await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error(`Broadcast failed for chat ${chatId}`, err);
      }
    }
  }

  // Run manually on demand
  async runDailySummary(title = '🌅 *Daily Market Summary*'): Promise<void> {
    if (this.subscribers.size === 0) {
      logger.info('No subscribers, skipping summary broadcast');
      return;
    }

    try {
      const summary = await this.buildSummary(title);

      for (const chatId of this.subscribers) {
        try {
          await this.bot.sendMessage(chatId, summary, { parse_mode: 'HTML' });
        } catch (err) {
          logger.error(`Failed to send summary to chat ${chatId}`, err);
        }
      }

      logger.info(`Daily summary sent to ${this.subscribers.size} subscribers`);
    } catch (err) {
      logger.error('Daily summary job failed', err);
    }
  }

  private async buildSummary(title: string): Promise<string> {
    const date = new Date().toLocaleDateString('he-IL', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const [videos, { nadavShaham, channel10 }, generalNews] = await Promise.all([
      this.youtube.getLatestVideosWithTranscripts(3),
      this.telegram.getAllChannelMessages(),
      this.news.searchFinancialNews('שוק המניות ישראל בורסת תל אביב היום', 8),
    ]);

    const inputs: AnalysisInput[] = [
      ...videos.map((v) => ({
        source: `YouTube - Micha Stock: ${v.title}`,
        content: v.transcript || v.description,
        timestamp: v.publishedAt,
      })),
      ...nadavShaham.map((m) => ({
        source: 'Telegram - Nadav Shaham',
        content: m.text,
        timestamp: new Date(m.date * 1000).toISOString(),
      })),
      ...channel10.map((m) => ({
        source: 'Telegram - Channel 10',
        content: m.text,
        timestamp: new Date(m.date * 1000).toISOString(),
      })),
      ...generalNews.map((n) => ({
        source: `Web - ${n.source}`,
        content: `${n.title}. ${n.snippet}`,
      })),
    ].filter((i) => i.content.length > 10);

    if (inputs.length === 0) {
      return `${title}\n<i>${date}</i>\n\n⚠️ No data collected from sources today.`;
    }

    const analysis = await this.claude.analyzeContent(inputs);
    const crossRefResults = await this.crossRef.crossReference(analysis.stockMentions);

    const analysisSummary = await this.claude.summarizeForBot(analysis);
    const crossRefSummary = this.crossRef.formatCrossRefSummary(crossRefResults);

    const sourceCount = `\n\n<i>Sources: ${videos.length} YouTube videos, ${nadavShaham.length + channel10.length} Telegram posts, ${generalNews.length} web articles</i>`;

    return `${title}\n<i>${date}</i>\n\n${analysisSummary}\n\n${crossRefSummary}${sourceCount}`;
  }

  private loadSubscribers(): void {
    try {
      if (fs.existsSync(SUBSCRIBERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8')) as number[];
        this.subscribers = new Set(data);
        logger.info(`Loaded ${this.subscribers.size} subscribers`);
      }
    } catch {
      this.subscribers = new Set();
    }
  }

  private saveSubscribers(): void {
    try {
      fs.mkdirSync(path.dirname(SUBSCRIBERS_FILE), { recursive: true });
      fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...this.subscribers]));
    } catch (err) {
      logger.error('Failed to save subscribers', err);
    }
  }
}
