import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Fetches YouTube transcript using yt-dlp (most reliable method).
 * Requires yt-dlp to be installed: pip install yt-dlp
 */
export async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Try Hebrew subtitles first, then auto-generated Hebrew, then English
  const langAttempts = ['he', 'iw', 'en'];

  for (const lang of langAttempts) {
    try {
      const text = await fetchWithLang(url, lang, false);
      if (text.length > 50) {
        logger.debug(`Got transcript for ${videoId} in lang=${lang}, chars=${text.length}`);
        return text;
      }
    } catch { /* try next */ }
  }

  // Last resort: auto-generated in any language
  try {
    const text = await fetchWithLang(url, 'he', true);
    if (text.length > 50) return text;
  } catch { /* fall through */ }

  throw new Error('No captions available for this video');
}

async function fetchWithLang(url: string, lang: string, autoOnly: boolean): Promise<string> {
  const args = [
    '-m', 'yt_dlp',
    '--write-auto-sub',
    '--sub-lang', lang,
    '--skip-download',
    '--sub-format', 'vtt',
    '-o', '-',           // output to stdout
    '--print', 'subtitles',
    url,
  ];

  // Use yt-dlp to get subtitle content directly via --get-transcript approach
  const subtitleArgs = [
    '-m', 'yt_dlp',
    autoOnly ? '--write-auto-sub' : '--write-sub',
    '--sub-lang', lang,
    '--skip-download',
    '--sub-format', 'vtt',
    '--no-write-comments',
    '--quiet',
    '-o', '/tmp/yt_transcript_%(id)s',
    url,
  ];

  // Actually the simplest reliable approach: dump JSON and parse subtitle URLs
  const { stdout } = await execFileAsync('python', [
    '-m', 'yt_dlp',
    '--dump-json',
    '--no-playlist',
    url,
  ], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 });

  const info = JSON.parse(stdout);

  // Find subtitle track
  const subs: Record<string, any[]> = info.subtitles ?? {};
  const autoSubs: Record<string, any[]> = info.automatic_captions ?? {};

  const track =
    subs[lang]?.[0] ??
    subs['iw']?.[0] ??
    autoSubs[lang]?.[0] ??
    autoSubs['iw']?.[0] ??
    autoSubs['he']?.[0] ??
    Object.values(autoSubs)[0]?.[0];

  if (!track?.url) throw new Error(`No subtitle track found for lang=${lang}`);

  // Fetch the VTT/JSON content
  const { stdout: subContent } = await execFileAsync('python', [
    '-c',
    `import urllib.request; r=urllib.request.urlopen("${track.url}"); print(r.read().decode('utf-8'))`,
  ], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 });

  return parseVttToText(subContent);
}

function parseVttToText(vtt: string): string {
  // Handle both VTT and JSON3 formats
  if (vtt.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(vtt);
      return (data.events ?? [])
        .filter((e: any) => e.segs)
        .flatMap((e: any) => e.segs.map((s: any) => s.utf8 ?? ''))
        .join('')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch { /* fall through to VTT parser */ }
  }

  // VTT format: remove headers, timestamps, tags
  return vtt
    .split('\n')
    .filter(line =>
      line.trim() &&
      !line.startsWith('WEBVTT') &&
      !line.startsWith('NOTE') &&
      !line.match(/^\d{2}:\d{2}/) &&  // timestamps
      !line.match(/^\d+$/)            // cue numbers
    )
    .map(line => line.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
