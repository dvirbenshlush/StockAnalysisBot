import { logger } from '../utils/logger';

export interface WhatsAppMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  groupName?: string;
  isGroup: boolean;
}

/**
 * WhatsAppScraper integrates with WhatsApp via the @whiskeysockets/baileys library.
 *
 * NOTE: WhatsApp automation requires explicit consent from all participants.
 * This implementation is designed for personal/authorized use only.
 *
 * Installation: npm install @whiskeysockets/baileys
 */
export class WhatsAppScraper {
  private client: any = null;
  private isConnected = false;
  private messageBuffer: WhatsAppMessage[] = [];
  private readonly sessionPath: string;

  // Groups/contacts to monitor (set in .env or configure dynamically)
  private monitoredGroups: Set<string> = new Set();

  constructor() {
    this.sessionPath = process.env.WHATSAPP_SESSION_PATH ?? './sessions/whatsapp';
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import to avoid build errors when baileys is not installed
      // Install with: npm install @whiskeysockets/baileys
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const baileys = require('@whiskeysockets/baileys') as {
        default: (...args: unknown[]) => unknown;
        useMultiFileAuthState: (path: string) => Promise<{ state: unknown; saveCreds: () => void }>;
        DisconnectReason: Record<string, number>;
      };
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.client = makeWASocket({ auth: state, printQRInTerminal: true });

      this.client.ev.on('creds.update', saveCreds);

      this.client.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          logger.warn('WhatsApp connection closed', { shouldReconnect });
          if (shouldReconnect) {
            this.connect();
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          logger.info('WhatsApp connected');
        }
      });

      this.client.ev.on('messages.upsert', (m: any) => {
        for (const msg of m.messages) {
          if (!msg.key.fromMe) {
            this.handleIncomingMessage(msg);
          }
        }
      });
    } catch (err) {
      logger.error('Failed to connect WhatsApp — ensure @whiskeysockets/baileys is installed', err);
    }
  }

  addMonitoredGroup(groupId: string): void {
    this.monitoredGroups.add(groupId);
    logger.info(`Monitoring WhatsApp group: ${groupId}`);
  }

  removeMonitoredGroup(groupId: string): void {
    this.monitoredGroups.delete(groupId);
  }

  getBufferedMessages(): WhatsAppMessage[] {
    const msgs = [...this.messageBuffer];
    this.messageBuffer = [];
    return msgs;
  }

  isReady(): boolean {
    return this.isConnected;
  }

  private handleIncomingMessage(msg: any): void {
    const jid: string = msg.key.remoteJid ?? '';
    const isGroup = jid.endsWith('@g.us');
    const body: string =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.imageMessage?.caption ??
      '';

    if (!body) return;

    // Only buffer messages from monitored groups (or all if no filter set)
    if (this.monitoredGroups.size > 0 && !this.monitoredGroups.has(jid)) return;

    const message: WhatsAppMessage = {
      id: msg.key.id ?? '',
      from: msg.key.participant ?? jid,
      body,
      timestamp: msg.messageTimestamp as number,
      groupName: isGroup ? jid : undefined,
      isGroup,
    };

    this.messageBuffer.push(message);
    logger.debug('WhatsApp message buffered', { from: message.from, preview: body.slice(0, 50) });
  }
}
