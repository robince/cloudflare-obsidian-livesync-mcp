import MarkdownIt from 'markdown-it';
import type { GetVaultFileOutlineData } from '@cloudflare-obsidian-livesync/contracts';

/** Newline sequences stay attached to their lines, so slicing never rewrites bytes. */
export function fileLines(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line, index, all) => line !== '' || index < all.length - 1) ?? [];
}

export function outline(content: string): Pick<GetVaultFileOutlineData, 'headings' | 'totalLines'> {
  const lines = fileLines(content);
  if (lines.length > 8192) throw complexityError();
  // Blank frontmatter rather than removing it to preserve Markdown source maps.
  const markdown = [...lines];
  if (markdown[0]?.trim() === '---') {
    const end = markdown.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
    if (end > 0) for (let index = 0; index <= end; index++) markdown[index] = '\n';
  }
  // Recognize HTML blocks without rendering them; parse inline syntax only in headings.
  const parser = new MarkdownIt('commonmark', { html: true });
  parser.core.ruler.disable('inline');
  const environment = {};
  const tokens = parser.parse(markdown.join(''), environment);
  parser.core.ruler.enable('inline');
  let headingBytes = 0;
  const headings: GetVaultFileOutlineData['headings'] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || !token.map) continue;
    const inline = tokens[index + 1];
    headingBytes += new TextEncoder().encode(inline?.content ?? '').byteLength;
    if (headings.length >= 1024 || headingBytes > 32768) throw complexityError();
    const children = parser.parseInline(inline?.content ?? '', environment)[0]?.children ?? [];
    const text = children.map((child) => child.type === 'text' || child.type === 'code_inline' || child.type === 'image'
      ? child.content : child.type === 'softbreak' || child.type === 'hardbreak' ? ' ' : '').join('');
    headings.push({ text, level: Number(token.tag.slice(1)), startLine: token.map[0] + 1, endLine: lines.length });
  }
  const open: typeof headings = [];
  for (const heading of headings) {
    while (open.length && open[open.length - 1].level >= heading.level) open.pop()!.endLine = heading.startLine - 1;
    open.push(heading);
  }
  return { headings, totalLines: lines.length };
}

function complexityError() {
  return Object.assign(new Error('Outline exceeds parsing limits (8192 lines, 1024 headings, or 32 KB heading source). Use read_file line ranges instead.'), { code: 'too_large' });
}
