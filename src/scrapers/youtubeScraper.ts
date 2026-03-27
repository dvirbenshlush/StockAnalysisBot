import axios from 'axios';
import { YoutubeTranscript } from 'youtube-transcript';
import { logger } from '../utils/logger';

export interface YouTubeVideo {
  id: string;
  title: string;
  publishedAt: string;
  description: string;
  transcript?: string;
  channelId: string;
  url: string;
}

export class YouTubeScraper {
  private readonly apiKey: string;
  private readonly michaStockChannelId: string;
  private readonly baseUrl = 'https://www.googleapis.com/youtube/v3';

  constructor() {
    this.apiKey = process.env.YOUTUBE_API_KEY ?? '';
    this.michaStockChannelId = process.env.MICHA_STOCK_CHANNEL_ID ?? '';
  }

  async getLatestVideos(maxResults = 10): Promise<YouTubeVideo[]> {
    if (!this.apiKey || !this.michaStockChannelId) {
      logger.warn('YouTube API key or channel ID not configured');
      return [];
    }

    try {
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          key: this.apiKey,
          channelId: this.michaStockChannelId,
          part: 'snippet',
          order: 'date',
          maxResults,
          type: 'video',
        },
      });

      const videos: YouTubeVideo[] = response.data.items.map((item: any) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        publishedAt: item.snippet.publishedAt,
        description: item.snippet.description,
        channelId: item.snippet.channelId,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      }));

      return videos;
    } catch (err) {
      logger.error('Failed to fetch YouTube videos', err);
      return [];
    }
  }

  async getTranscript(videoId: string): Promise<string> {
    try {
      const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'he' });
      return transcriptItems.map((t) => t.text).join(' ');
    } catch {
      try {
        // fallback to English transcript
        const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
        return transcriptItems.map((t) => t.text).join(' ');
      } catch (err) {
        logger.warn(`No transcript available for video ${videoId}`, err);
        return '';
      }
    }
  }

  async getLatestVideosWithTranscripts(maxResults = 5): Promise<YouTubeVideo[]> {
    const videos = await this.getLatestVideos(maxResults);

    const enriched = await Promise.all(
      videos.map(async (v) => ({
        ...v,
        transcript: await this.getTranscript(v.id),
      }))
    );

    return enriched;
  }
}
