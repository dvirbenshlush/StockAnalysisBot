import dotenv from 'dotenv';
dotenv.config();

import { TelegramBot } from './bot/telegramBot';
import { YouTubeScraper } from './scrapers/youtubeScraper';
import { TelegramScraper } from './scrapers/telegramScraper';
import { WhatsAppScraper } from './scrapers/whatsappScraper';
import { ClaudeAnalyzer } from './analysis/claudeAnalyzer';
import { FinancialCrossRef } from './analysis/financialCrossRef';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Stock Analysis Bot...');

  // Initialize scrapers
  const youtubeScraper = new YouTubeScraper();
  const telegramScraper = new TelegramScraper();
  const whatsappScraper = new WhatsAppScraper();

  // Initialize analysis modules
  const claudeAnalyzer = new ClaudeAnalyzer();
  const financialCrossRef = new FinancialCrossRef();

  // Initialize and start the Telegram bot
  const bot = new TelegramBot(youtubeScraper, telegramScraper, whatsappScraper, claudeAnalyzer, financialCrossRef);
  await bot.start();

  logger.info('Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
