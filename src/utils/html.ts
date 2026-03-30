/** Escape text so it's safe inside Telegram HTML messages */
export function e(text: string | number): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const b = (text: string | number) => `<b>${e(text)}</b>`;
export const i = (text: string | number) => `<i>${e(text)}</i>`;
export const code = (text: string | number) => `<code>${e(text)}</code>`;
