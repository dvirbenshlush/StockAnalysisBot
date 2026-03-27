import axios from 'axios';
import { logger } from '../utils/logger';

export interface TelegramMessage {
  id: number;
  text: string;
  date: number;
  channel: string;
  mediaUrl?: string;
}

// Channel identifiers (public usernames or invite links)
const CHANNELS = {
  nadavShaham: process.env.NADAV_SHAHAM_CHANNEL ?? '@nadav_shaham',
  channel10: process.env.CHANNEL_10_CHANNEL ?? '@channel10news',
};

/**
 * TelegramScraper uses the Telegram Bot API to read messages from public channels.
 * For private channels, a user-session approach (e.g., gramjs / MTProto) is needed.
 */
export class TelegramScraper {
  private readonly botToken: string;
  private readonly baseUrl: string;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  async getUpdates(offset?: number): Promise<TelegramMessage[]> {
    if (!this.botToken) {
      logger.warn('Telegram bot token not configured');
      return [];
    }

    try {
      const response = await axios.get(`${this.baseUrl}/getUpdates`, {
        params: { offset, limit: 100, timeout: 30 },
      });

      const updates = response.data.result ?? [];
      return updates
        .filter((u: any) => u.channel_post)
        .map((u: any) => this.parseChannelPost(u.channel_post));
    } catch (err) {
      logger.error('Failed to get Telegram updates', err);
      return [];
    }
  }

  async getChannelHistory(channelUsername: string, limit = 20): Promise<TelegramMessage[]> {
    // Using public channel web scraping as fallback when bot isn't added to channel
    try {
      const response = await axios.get(`https://t.me/s/${channelUsername.replace('@', '')}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      return this.parsePublicChannelHtml(response.data, channelUsername);
    } catch (err) {
      logger.error(`Failed to scrape Telegram channel ${channelUsername}`, err);
      return [];
    }
  }

  async getNadavShahamMessages(limit = 20): Promise<TelegramMessage[]> {
    logger.info('Fetching Nadav Shaham Telegram messages...');
    return this.getChannelHistory(CHANNELS.nadavShaham, limit);
  }

  async getChannel10Messages(limit = 20): Promise<TelegramMessage[]> {
    logger.info('Fetching Channel 10 Telegram messages...');
    return this.getChannelHistory(CHANNELS.channel10, limit);
  }

  async getAllChannelMessages(): Promise<{ nadavShaham: TelegramMessage[]; channel10: TelegramMessage[] }> {
    const [nadavShaham, channel10] = await Promise.all([
      this.getNadavShahamMessages(),
      this.getChannel10Messages(),
    ]);
    return { nadavShaham, channel10 };
  }

  private parseChannelPost(post: any): TelegramMessage {
    return {
      id: post.message_id,
      text: post.text ?? post.caption ?? '',
      date: post.date,
      channel: post.chat?.username ?? post.chat?.title ?? 'unknown',
    };
  }

  private parsePublicChannelHtml(html: string, channel: string): TelegramMessage[] {
    // Basic extraction of message text from public Telegram web preview
    const messages: TelegramMessage[] = [];
    const messageRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const dateRegex = /<time[^>]*datetime="([^"]+)"[^>]*>/;

    let match: RegExpExecArray | null;
    let index = 0;

    while ((match = messageRegex.exec(html)) !== null) {
      const rawText = match[1].replace(/<[^>]+>/g, '').trim();
      if (rawText) {
        messages.push({
          id: index++,
          text: rawText,
          date: Math.floor(Date.now() / 1000),
          channel,
        });
      }
    }

    return messages;
  }
}
