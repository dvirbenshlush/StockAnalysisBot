import TelegramBotAPI from 'node-telegram-bot-api';
import { YouTubeScraper } from '../scrapers/youtubeScraper';
import { TelegramScraper } from '../scrapers/telegramScraper';
import { WhatsAppScraper } from '../scrapers/whatsappScraper';
import { ClaudeAnalyzer, AnalysisInput } from '../analysis/claudeAnalyzer';
import { FinancialCrossRef } from '../analysis/financialCrossRef';
import { NewsSearcher } from '../utils/newsSearcher';
import { logger } from '../utils/logger';

export class TelegramBot {
  private bot: TelegramBotAPI;
  private readonly youtube: YouTubeScraper;
  private readonly telegram: TelegramScraper;
  private readonly whatsapp: WhatsAppScraper;
  private readonly claude: ClaudeAnalyzer;
  private readonly crossRef: FinancialCrossRef;
  private readonly news: NewsSearcher;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    youtube: YouTubeScraper,
    telegram: TelegramScraper,
    whatsapp: WhatsAppScraper,
    claude: ClaudeAnalyzer,
    crossRef: FinancialCrossRef
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    this.bot = new TelegramBotAPI(token, { polling: true });
    this.youtube = youtube;
    this.telegram = telegram;
    this.whatsapp = whatsapp;
    this.claude = claude;
    this.crossRef = crossRef;
    this.news = new NewsSearcher();
  }

  async start(): Promise<void> {
    this.registerCommands();
    await this.whatsapp.connect();
    this.startPolling();
    logger.info('Telegram bot started');
  }

  stop(): void {
    this.bot.stopPolling();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private registerCommands(): void {
    this.bot.onText(/\/start/, (msg) => {
      const welcome = [
        '👋 *Stock Analysis Bot*',
        '',
        'Commands:',
        '/analyze — Full analysis from all sources',
        '/youtube — Latest Micha Stock videos',
        '/telegram — Latest from Nadav Shaham & Channel 10',
        '/news <query> — Search financial news',
        '/stock <ticker> — Get stock data + analysis',
        '/help — Show this message',
      ].join('\n');
      this.sendMessage(msg.chat.id, welcome);
    });

    this.bot.onText(/\/help/, (msg) => {
      const welcome = [
        '👋 *Stock Analysis Bot*',
        '',
        'Commands:',
        '/analyze — Full analysis from all sources',
        '/youtube — Latest Micha Stock videos',
        '/telegram — Latest from Nadav Shaham & Channel 10',
        '/news <query> — Search financial news',
        '/stock <ticker> — Get stock data + analysis',
        '/help — Show this message',
      ].join('\n');
      this.sendMessage(msg.chat.id, welcome);
    });

    this.bot.onText(/\/analyze/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '🔄 Gathering data from all sources...');
      try {
        const result = await this.runFullAnalysis();
        await this.sendMessage(chatId, result, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('Full analysis failed', err);
        await this.sendMessage(chatId, '❌ Analysis failed. Please try again.');
      }
    });

    this.bot.onText(/\/youtube/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '🎥 Fetching Micha Stock videos...');
      try {
        const videos = await this.youtube.getLatestVideos(5);
        if (videos.length === 0) {
          await this.sendMessage(chatId, 'No videos found or YouTube API not configured.');
          return;
        }
        const lines = videos.map(
          (v, i) => `${i + 1}. [${v.title}](${v.url})\n   _${new Date(v.publishedAt).toLocaleDateString('he-IL')}_`
        );
        await this.sendMessage(chatId, `🎥 *Micha Stock — Latest Videos*\n\n${lines.join('\n\n')}`, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch (err) {
        await this.sendMessage(chatId, '❌ Failed to fetch YouTube videos.');
      }
    });

    this.bot.onText(/\/telegram/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '📨 Fetching Telegram channel messages...');
      try {
        const { nadavShaham, channel10 } = await this.telegram.getAllChannelMessages();
        const parts: string[] = ['📨 *Telegram Channels*\n'];

        if (nadavShaham.length > 0) {
          parts.push('*Nadav Shaham:*');
          nadavShaham.slice(0, 3).forEach((m) => parts.push(`• ${m.text.slice(0, 200)}`));
        }

        if (channel10.length > 0) {
          parts.push('\n*Channel 10:*');
          channel10.slice(0, 3).forEach((m) => parts.push(`• ${m.text.slice(0, 200)}`));
        }

        await this.sendMessage(chatId, parts.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        await this.sendMessage(chatId, '❌ Failed to fetch Telegram messages.');
      }
    });

    this.bot.onText(/\/news (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const query = match?.[1] ?? '';
      await this.sendMessage(chatId, `🔍 Searching news for: "${query}"...`);
      try {
        const results = await this.news.search(query);
        if (results.length === 0) {
          await this.sendMessage(chatId, 'No results found.');
          return;
        }
        const lines = results.map((r, i) => `${i + 1}. *${r.title}*\n   ${r.url}`);
        await this.sendMessage(chatId, lines.join('\n\n'), {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch (err) {
        await this.sendMessage(chatId, '❌ News search failed.');
      }
    });

    this.bot.onText(/\/stock (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const ticker = (match?.[1] ?? '').toUpperCase().trim();
      await this.sendMessage(chatId, `📊 Fetching data for ${ticker}...`);
      try {
        const [stockData, newsHeadlines] = await Promise.all([
          this.crossRef.getStockData(ticker),
          this.crossRef.getRecentNews(`${ticker} stock analysis`),
        ]);

        if (!stockData) {
          await this.sendMessage(chatId, `❌ Could not find data for ${ticker}.`);
          return;
        }

        const dir = stockData.change >= 0 ? '▲' : '▼';
        const newsContext = newsHeadlines.join('. ');
        const analysis = await this.claude.analyzeStockSpecific(ticker, newsContext);

        const lines = [
          `📊 *${ticker}*`,
          `Price: ${stockData.price.toFixed(2)} ${stockData.currency}`,
          `Change: ${dir} ${Math.abs(stockData.changePercent).toFixed(2)}%`,
          `Volume: ${stockData.volume.toLocaleString()}`,
          `Exchange: ${stockData.exchange}`,
        ];

        if (newsHeadlines.length > 0) {
          lines.push('\n📰 *Recent News:*');
          newsHeadlines.slice(0, 3).forEach((h) => lines.push(`• ${h}`));
        }

        if (analysis) {
          lines.push(`\n🤖 *AI Outlook:*\n${analysis}`);
        }

        await this.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        await this.sendMessage(chatId, `❌ Failed to fetch data for ${ticker}.`);
      }
    });
  }

  private async runFullAnalysis(): Promise<string> {
    const [videos, { nadavShaham, channel10 }, whatsappMsgs] = await Promise.all([
      this.youtube.getLatestVideosWithTranscripts(3),
      this.telegram.getAllChannelMessages(),
      Promise.resolve(this.whatsapp.getBufferedMessages()),
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
      ...whatsappMsgs.map((m) => ({
        source: `WhatsApp - ${m.groupName ?? m.from}`,
        content: m.body,
        timestamp: new Date(m.timestamp * 1000).toISOString(),
      })),
    ].filter((i) => i.content.length > 10);

    if (inputs.length === 0) {
      return '⚠️ No content collected from sources. Check API keys and channel configurations.';
    }

    const analysis = await this.claude.analyzeContent(inputs);
    const crossRefResults = await this.crossRef.crossReference(analysis.stockMentions);

    const summary = await this.claude.summarizeForBot(analysis);
    const crossRefSummary = this.crossRef.formatCrossRefSummary(crossRefResults);

    return `${summary}\n\n${crossRefSummary}`;
  }

  private startPolling(): void {
    const intervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '3600000', 10);
    this.pollInterval = setInterval(() => {
      logger.info('Scheduled analysis poll triggered');
      // Implement scheduled push to admin chat if needed
    }, intervalMs);
  }

  private async sendMessage(
    chatId: number,
    text: string,
    options?: TelegramBotAPI.SendMessageOptions
  ): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, text, options);
    } catch (err) {
      logger.error('Failed to send Telegram message', err);
    }
  }
}
