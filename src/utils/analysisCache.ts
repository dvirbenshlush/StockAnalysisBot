import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const CACHE_FILE = path.join(process.cwd(), 'sessions', 'analysis_cache.json');
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry {
  result: unknown;
  createdAt: number;
}

type CacheStore = Record<string, CacheEntry>;

export class AnalysisCache {
  private store: CacheStore = {};

  constructor() {
    this.load();
  }

  get<T>(key: string): T | null {
    const entry = this.store[key];
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TTL_MS) {
      delete this.store[key];
      return null;
    }
    return entry.result as T;
  }

  set(key: string, result: unknown): void {
    this.store[key] = { result, createdAt: Date.now() };
    this.save();
  }

  /** Hash any string content into a stable cache key */
  static hash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 16);
  }

  /** Clear all expired entries */
  prune(): void {
    const now = Date.now();
    for (const key of Object.keys(this.store)) {
      if (now - this.store[key].createdAt > TTL_MS) delete this.store[key];
    }
    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        this.store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as CacheStore;
        this.prune();
      }
    } catch {
      this.store = {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.store));
    } catch { /* ignore */ }
  }
}

export const cache = new AnalysisCache();
