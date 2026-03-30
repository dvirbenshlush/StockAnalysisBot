import TelegramBotAPI from 'node-telegram-bot-api';
import { YouTubeScraper } from '../scrapers/youtubeScraper';
import { TelegramScraper } from '../scrapers/telegramScraper';
import { WhatsAppScraper } from '../scrapers/whatsappScraper';
import { ClaudeAnalyzer, AnalysisInput } from '../analysis/claudeAnalyzer';
import { FinancialCrossRef } from '../analysis/financialCrossRef';
import { NewsSearcher } from '../utils/newsSearcher';
import { Scheduler } from './scheduler';
import { ChatHandler } from './chatHandler';
import { YouTubeNotebook } from './youtubeNotebook';
import { logger } from '../utils/logger';
import { b, i, e } from '../utils/html';

const ADMIN_ID = parseInt(process.env.ADMIN_CHAT_ID ?? '1949447941', 10);

export class TelegramBot {
  private bot: TelegramBotAPI;
  private readonly youtube: YouTubeScraper;
  private readonly telegram: TelegramScraper;
  private readonly whatsapp: WhatsAppScraper;
  private readonly claude: ClaudeAnalyzer;
  private readonly crossRef: FinancialCrossRef;
  private readonly news: NewsSearcher;
  private readonly scheduler: Scheduler;
  private readonly chatHandler: ChatHandler;
  private readonly notebook: YouTubeNotebook;
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

    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      // Webhook mode for production (Railway) — no polling conflict
      this.bot = new TelegramBotAPI(token, {
        webHook: { port: parseInt(process.env.PORT ?? '3000', 10) },
      });
    } else {
      // Polling mode for local dev
      this.bot = new TelegramBotAPI(token, { polling: true });
    }
    this.youtube = youtube;
    this.telegram = telegram;
    this.whatsapp = whatsapp;
    this.claude = claude;
    this.crossRef = crossRef;
    this.news = new NewsSearcher();
    this.scheduler = new Scheduler(this.bot, youtube, telegram, claude, crossRef);
    this.chatHandler = new ChatHandler();
    this.notebook = new YouTubeNotebook();
  }

  async start(): Promise<void> {
    this.registerCommands();
    this.registerChannelListener();
    await this.whatsapp.connect();
    this.scheduler.start();

    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      await this.bot.setWebHook(`${webhookUrl}/bot${token}`);
      logger.info(`Webhook set to ${webhookUrl}/bot<token>`);
    } else {
      this.startPolling();
    }

    logger.info('Telegram bot started');
  }

  stop(): void {
    if (!process.env.WEBHOOK_URL) this.bot.stopPolling();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private registerCommands(): void {
    // ── /start & /help ──────────────────────────────────────────────
    const helpText = [
      `👋 ${b('בוט ניתוח מניות')}`,
      '',
      `💬 ${b('צ\'אט וייעוץ:')}`,
      'פשוט כתוב כל שאלה — היועץ הפיננסי ישיב בעברית',
      '/clear — נקה היסטוריית שיחה',
      '',
      `📓 ${b('YouTube Notebook:')}`,
      '/notebook &lt;קישור יוטיוב&gt; — סיכום מעמיק בסגנון NotebookLM',
      '',
      `📅 ${b('סיכומים יומיים:')}`,
      '/subscribe — קבל סיכומים יומיים אוטומטיים',
      '/unsubscribe — הפסק סיכומים יומיים',
      '/summary — קבל סיכום עכשיו',
      '',
      `🔍 ${b('נתוני שוק:')}`,
      '/analyze — ניתוח מלא מכל המקורות',
      '/youtube — סרטוני מיכה סטוק אחרונים',
      '/telegram — הודעות אחרונות מנדב שחם וערוץ 10',
      '/news &lt;שאילתה&gt; — חיפוש חדשות פיננסיות',
      '/stock &lt;טיקר&gt; — מחיר מניה + ניתוח AI',
    ].join('\n');

    this.bot.onText(/\/start/, (msg) => this.sendMessage(msg.chat.id, helpText));
    this.bot.onText(/\/help/, (msg) => this.sendMessage(msg.chat.id, helpText));

    // ── /clear ───────────────────────────────────────────────────────
    this.bot.onText(/\/clear/, (msg) => {
      this.chatHandler.clearHistory(msg.chat.id);
      this.sendMessage(msg.chat.id, '🧹 היסטוריית השיחה נמחקה.');
    });

    // ── /notebook <url> ──────────────────────────────────────────────
    this.bot.onText(/\/notebook (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const input = (match?.[1] ?? '').trim();
      const videoId = this.notebook.extractVideoId(input);

      if (!videoId) {
        await this.sendMessage(chatId, `❌ קישור YouTube לא תקין. דוגמה:\n<code>/notebook https://youtu.be/VIDEO_ID</code>`);
        return;
      }

      await this.sendMessage(chatId, '📓 מביא תמליל ומייצר סיכום...');

      try {
        const summary = await this.notebook.summarize(videoId);
        const formatted = this.notebook.formatForTelegram(summary, videoId);

        // Split into chunks if too long for Telegram (4096 char limit)
        await this.sendLongMessage(chatId, formatted);
      } catch (err: any) {
        logger.error('Notebook error', { message: err?.message, stack: err?.stack?.slice(0, 300) });
        if (err.message === 'QUOTA_EXCEEDED') {
          await this.sendMessage(chatId, '⏳ מכסת AI נוצלה. נסה שוב מאוחר יותר.');
        } else if (err.message?.includes('transcript') || err.message?.includes('Transcript')) {
          await this.sendMessage(chatId, '❌ אין כתוביות זמינות לסרטון זה.\n\n💡 נסה סרטון אחר של מיכה סטוק שיש בו כתוביות אוטומטיות.');
        } else {
          await this.sendMessage(chatId, `❌ שגיאה: ${e(err?.message ?? 'שגיאה לא ידועה')}`);
        }
      }
    });

    // ── /analyze ─────────────────────────────────────────────────────
    this.bot.onText(/\/analyze/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '🔄 אוסף נתונים מכל המקורות...');
      try {
        const result = await this.runFullAnalysis();
        await this.sendLongMessage(chatId, result);
      } catch (err) {
        logger.error('Full analysis failed', err);
        await this.sendMessage(chatId, '❌ הניתוח נכשל. נסה שוב.');
      }
    });

    // ── /youtube ─────────────────────────────────────────────────────
    this.bot.onText(/\/youtube/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '🎥 מביא סרטוני מיכה סטוק...');
      try {
        const videos = await this.youtube.getLatestVideos(5);
        if (videos.length === 0) {
          await this.sendMessage(chatId, 'לא נמצאו סרטונים או שמפתח YouTube API לא מוגדר.');
          return;
        }
        const lines = videos.map(
          (v, idx) => `${idx + 1}. <a href="${v.url}">${e(v.title)}</a>\n   ${i(new Date(v.publishedAt).toLocaleDateString('he-IL'))}\n   /notebook ${v.url}`
        );
        await this.sendMessage(chatId, `🎥 ${b('מיכה סטוק — סרטונים אחרונים')}\n\n${lines.join('\n\n')}`, {
          disable_web_page_preview: true,
        });
      } catch (err) {
        await this.sendMessage(chatId, '❌ שגיאה בטעינת סרטוני YouTube.');
      }
    });

    // ── /telegram ────────────────────────────────────────────────────
    this.bot.onText(/\/telegram/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '📨 מביא הודעות מערוצי טלגרם...');
      try {
        const { nadavShaham, channel10 } = await this.telegram.getAllChannelMessages();
        const parts: string[] = [`📨 ${b('ערוצי טלגרם')}\n`];

        if (nadavShaham.length > 0) {
          parts.push(b('נדב שחם:'));
          nadavShaham.slice(0, 3).forEach((m) => parts.push(`• ${e(m.text.slice(0, 200))}`));
        }

        if (channel10.length > 0) {
          parts.push(`\n${b('ערוץ 10:')}`);
          channel10.slice(0, 3).forEach((m) => parts.push(`• ${e(m.text.slice(0, 200))}`));
        }

        await this.sendMessage(chatId, parts.join('\n'));
      } catch (err) {
        await this.sendMessage(chatId, '❌ שגיאה בטעינת הודעות טלגרם.');
      }
    });

    // ── /news ────────────────────────────────────────────────────────
    this.bot.onText(/\/news (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const query = match?.[1] ?? '';
      await this.sendMessage(chatId, `🔍 מחפש חדשות עבור: "${e(query)}"...`);
      try {
        const results = await this.news.search(query);
        if (results.length === 0) {
          await this.sendMessage(chatId, 'לא נמצאו תוצאות.');
          return;
        }
        const lines = results.map((r, idx) => `${idx + 1}. ${b(r.title)}\n   ${r.url}`);
        await this.sendMessage(chatId, lines.join('\n\n'), { disable_web_page_preview: true });
      } catch (err) {
        await this.sendMessage(chatId, '❌ חיפוש החדשות נכשל.');
      }
    });

    // ── /subscribe /unsubscribe /summary ─────────────────────────────
    this.bot.onText(/\/subscribe/, async (msg) => {
      const chatId = msg.chat.id;
      if (this.scheduler.isSubscribed(chatId)) {
        await this.sendMessage(chatId, '✅ אתה כבר רשום לסיכומים יומיים.');
      } else {
        this.scheduler.subscribe(chatId);
        await this.sendMessage(chatId, '✅ נרשמת! תקבל:\n• 🌅 סיכום בוקר בשעה 08:00\n• 📉 סיכום סגירת שוק בשעה 17:00 (א-ה)');
      }
    });

    this.bot.onText(/\/unsubscribe/, async (msg) => {
      this.scheduler.unsubscribe(msg.chat.id);
      await this.sendMessage(msg.chat.id, '🔕 בוטלה ההרשמה לסיכומים יומיים.');
    });

    this.bot.onText(/\/summary/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(chatId, '⏳ מייצר סיכום, זה עשוי לקחת דקה...');
      await this.scheduler.runDailySummary('📊 <b>סיכום לפי דרישה</b>');
      if (!this.scheduler.isSubscribed(chatId)) {
        await this.sendMessage(chatId, '<i>טיפ: השתמש ב-/subscribe לקבלת סיכום יומי אוטומטי.</i>');
      }
    });

    // ── /stock ───────────────────────────────────────────────────────
    this.bot.onText(/\/stock (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const ticker = (match?.[1] ?? '').toUpperCase().trim();
      await this.sendMessage(chatId, `📊 מביא נתונים עבור ${ticker}...`);
      try {
        const [stockData, newsHeadlines] = await Promise.all([
          this.crossRef.getStockData(ticker),
          this.crossRef.getRecentNews(`${ticker} stock analysis`),
        ]);

        if (!stockData) {
          await this.sendMessage(chatId, `❌ לא נמצאו נתונים עבור ${ticker}.`);
          return;
        }

        const dir = stockData.change >= 0 ? '▲' : '▼';
        const newsContext = newsHeadlines.join('. ');
        const analysis = await this.claude.analyzeStockSpecific(ticker, newsContext);

        const lines = [
          `📊 ${b(ticker)}`,
          `מחיר: ${stockData.price.toFixed(2)} ${e(stockData.currency)}`,
          `שינוי: ${dir} ${Math.abs(stockData.changePercent).toFixed(2)}%`,
          `נפח: ${stockData.volume.toLocaleString()}`,
          `בורסה: ${e(stockData.exchange)}`,
        ];

        if (newsHeadlines.length > 0) {
          lines.push(`\n📰 ${b('חדשות אחרונות:')}`);
          newsHeadlines.slice(0, 3).forEach((h) => lines.push(`• ${e(h)}`));
        }

        if (analysis) {
          lines.push(`\n🤖 ${b('ניתוח AI:')}\n${e(analysis)}`);
        }

        await this.sendMessage(chatId, lines.join('\n'));
      } catch (err) {
        await this.sendMessage(chatId, `❌ Failed to fetch data for ${ticker}.`);
      }
    });

    // ── Admin commands (only ADMIN_ID can use) ───────────────────────
    this.bot.onText(/\/admin/, (msg) => {
      if (msg.chat.id !== ADMIN_ID) return;
      const adminHelp = [
        `🔧 ${b('פקודות אדמין')}`,
        '',
        '/restart — הפעל מחדש את הבוט',
        '/broadcast &lt;הודעה&gt; — שלח הודעה לכל המנויים',
        '/status — סטטוס הבוט ומספר מנויים',
      ].join('\n');
      this.sendMessage(msg.chat.id, adminHelp);
    });

    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id !== ADMIN_ID) return;
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const secs = uptime % 60;
      await this.sendMessage(msg.chat.id, [
        `📟 ${b('סטטוס בוט')}`,
        `זמן פעילות: ${hours}h ${mins}m ${secs}s`,
        `זיכרון: ${Math.round(mem.rss / 1024 / 1024)} MB`,
        `מנויים: ${this.scheduler.subscriberCount()}`,
        `היסטוריות שיחה: ${this.chatHandler.historyCount()}`,
        `וואטסאפ: ${this.whatsapp.isReady() ? '✅ מחובר' : '❌ מנותק'}`,
      ].join('\n'));
    });

    this.bot.onText(/\/broadcast (.+)/, async (msg, match) => {
      if (msg.chat.id !== ADMIN_ID) return;
      const text = match?.[1] ?? '';
      await this.scheduler.broadcast(text);
      await this.sendMessage(msg.chat.id, `✅ ההודעה נשלחה ל-${this.scheduler.subscriberCount()} מנויים.`);
    });

    this.bot.onText(/\/restart/, async (msg) => {
      if (msg.chat.id !== ADMIN_ID) return;
      await this.sendMessage(msg.chat.id, '🔄 מפעיל מחדש...');
      this.bot.stopPolling();
      await new Promise((r) => setTimeout(r, 1000));
      this.bot.startPolling();
      await this.sendMessage(msg.chat.id, '✅ הבוט הופעל מחדש.');
    });

    // ── Free-text chat (must be registered LAST) ─────────────────────
    this.bot.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      const chatId = msg.chat.id;

      // Show typing indicator
      await this.bot.sendChatAction(chatId, 'typing');

      const reply = await this.chatHandler.chat(chatId, msg.text);
      await this.sendLongMessage(chatId, reply);
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
    }, intervalMs);
  }

  // Split messages longer than 4096 chars (Telegram limit)
  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    const MAX = 4000;
    if (text.length <= MAX) {
      await this.sendMessage(chatId, text);
      return;
    }
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.slice(0, MAX);
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline > MAX * 0.7) chunk = chunk.slice(0, lastNewline);
      await this.sendMessage(chatId, chunk);
      remaining = remaining.slice(chunk.length);
    }
  }

  private async sendMessage(chatId: number, text: string, options?: TelegramBotAPI.SendMessageOptions): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
    } catch (err) {
      logger.error('Failed to send Telegram message', err);
    }
  }

  // ── Channel command listener ─────────────────────────────────────
  private registerChannelListener(): void {
    const channelId = process.env.COMMAND_CHANNEL_ID;

    if (!channelId) {
      logger.info('COMMAND_CHANNEL_ID not set — channel listener disabled');
      return;
    }

    this.bot.on('channel_post', async (post) => {
      const fromChannel = String(post.chat.id);
      const fromUsername = post.chat.username ? `@${post.chat.username}` : fromChannel;

      // Accept posts from the configured channel only
      if (fromChannel !== channelId && fromUsername !== channelId) return;

      const text = post.text?.trim() ?? '';
      if (!text) return;

      logger.info(`Channel command received: ${text}`);

      // Reply goes back to the channel
      const reply = async (msg: string) => this.sendMessage(post.chat.id, msg);

      // Route the command
      if (text === '/status') {
        const mem = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
        await reply([
          `📟 ${b('Bot Status')}`,
          `Uptime: ${h}h ${m}m ${s}s`,
          `Memory: ${Math.round(mem.rss / 1024 / 1024)} MB`,
          `Subscribers: ${this.scheduler.subscriberCount()}`,
        ].join('\n'));

      } else if (text === '/summary') {
        await reply('⏳ Generating summary...');
        await this.scheduler.runDailySummary('📊 <b>On-Demand Summary</b>');

      } else if (text === '/analyze') {
        await reply('🔄 אוסף נתונים מכל המקורות...');
        const result = await this.runFullAnalysis();
        await this.sendLongMessage(post.chat.id, result);

      } else if (text.startsWith('/notebook ')) {
        const input = text.replace('/notebook ', '').trim();
        const videoId = this.notebook.extractVideoId(input);
        if (!videoId) { await reply('❌ Invalid YouTube URL.'); return; }
        await reply('📓 Generating notebook summary...');
        try {
          const summary = await this.notebook.summarize(videoId);
          await this.sendLongMessage(post.chat.id, this.notebook.formatForTelegram(summary, videoId));
        } catch (err: any) {
          await reply(err.message === 'QUOTA_EXCEEDED' ? '⏳ Gemini quota reached.' : '❌ Failed to summarize.');
        }

      } else if (text.startsWith('/stock ')) {
        const ticker = text.replace('/stock ', '').trim().toUpperCase();
        const [stockData, news] = await Promise.all([
          this.crossRef.getStockData(ticker),
          this.crossRef.getRecentNews(`${ticker} stock`),
        ]);
        if (!stockData) { await reply(`❌ No data for ${ticker}.`); return; }
        const dir = stockData.change >= 0 ? '▲' : '▼';
        await reply([
          `📊 ${b(ticker)}`,
          `Price: ${stockData.price.toFixed(2)} ${e(stockData.currency)} ${dir} ${Math.abs(stockData.changePercent).toFixed(2)}%`,
          `Volume: ${stockData.volume.toLocaleString()}`,
          news.length > 0 ? `\n📰 ${b('News:')}\n` + news.slice(0, 3).map(n => `• ${e(n)}`).join('\n') : '',
        ].join('\n'));

      } else if (text.startsWith('/broadcast ')) {
        const msg = text.replace('/broadcast ', '').trim();
        await this.scheduler.broadcast(msg);
        await reply(`✅ Broadcast sent to ${this.scheduler.subscriberCount()} subscribers.`);

      } else if (text === '/help' || text === '/start') {
        await reply([
          `📋 ${b('Channel Commands')}`,
          '/status — Bot status',
          '/summary — Daily summary now',
          '/analyze — Full multi-source analysis',
          '/stock TICKER — Stock data',
          '/notebook URL — YouTube summary',
          '/broadcast MESSAGE — Send to all subscribers',
        ].join('\n'));

      } else if (text.startsWith('/')) {
        await reply(`❓ Unknown command: <code>${e(text)}</code>\nSend /help to see available commands.`);
      }
    });

    logger.info(`Channel listener active for channel: ${channelId}`);
  }
}
