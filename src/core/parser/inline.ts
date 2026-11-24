/**
 * Inline Org syntax scanner.
 *
 * Works on a single line at a time with absolute offsets.
 */

import type { InlineToken } from "../model/types";

export type { InlineToken };

export interface InlineOptions {
  /** Whether to recognise `:tag:` runs in body text (headlines handle tags themselves). */
  tags?: boolean;
}

interface Interval {
  from: number;
  to: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function overlaps(from: number, to: number, intervals: Interval[]): boolean {
  for (const interval of intervals) {
    if (from < interval.to && to > interval.from) return true;
  }
  return false;
}

const inlineCache = new Map<string, InlineToken[]>();

export function parseInline(text: string, base: number, options: InlineOptions = {}): InlineToken[] {
  const cacheKey = `${options.tags ? "1" : "0"}\u0000${base}\u0000${text}`;
  const cached = inlineCache.get(cacheKey);
  if (cached) return cached;

  const tokens: InlineToken[] = [];
  const protectedRanges: Interval[] = [];

  // 1. Verbatim and code (takes precedence over links/math/emphasis)
  {
    const re =
      /(^|[\s([{'‘“「『【（《"\-：，。；！？、一-鿿぀-ヿ])([=~])(\S(?:[^\n]*?\S)?)\2(?=$|[\s)\]}'’”」』】）》".,;:!?…\-：，。；！？、一-鿿぀-ヿ])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + m[3].length + 2;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({
        type: "verbatim",
        style: m[2] === "=" ? "verbatim" : "code",
        delim: m[2],
        from,
        to,
        contentFrom: from + 1,
        contentTo: to - 1,
      });
      protectedRanges.push({ from, to });
    }
  }

  // 2. Display and LaTeX-delimited math (takes precedence over links)
  {
    const displayRe = /\$\$([^$\n]+?)\$\$/g;
    let m: RegExpExecArray | null;
    while ((m = displayRe.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "math", from, to, latex: m[1], display: true });
      protectedRanges.push({ from, to });
    }
    const parenRe = /\\\(([^\n]*?)\\\)/g;
    while ((m = parenRe.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "math", from, to, latex: m[1], display: false });
      protectedRanges.push({ from, to });
    }
    const bracketRe = /\\\[([^\n]*?)\\\]/g;
    while ((m = bracketRe.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "math", from, to, latex: m[1], display: true });
      protectedRanges.push({ from, to });
    }
  }

  // 3. Links
  {
    const re = /\[\[([^[\]\n]*?)\](?:\[([^[\]\n]*?)\])?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      const target = m[1].trim();
      if (!target) continue;
      tokens.push({
        type: "link",
        from,
        to,
        target,
        desc: m[2],
        image: IMAGE_EXT.test(target.replace(/^file:/i, "")),
      });
      protectedRanges.push({ from, to });
    }
  }

  // 4. Single-dollar inline math
  {
    const inlineRe = /\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "math", from, to, latex: m[1], display: false });
      protectedRanges.push({ from, to });
    }
  }

  // 4. Timestamps, footnotes, cookies, URLs
  {
    const re = /[[<]\d{4}-\d{2}-\d{2}(?:[^\]>\n]*)[\]>]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "timestamp", from, to, active: m[0][0] === "<" });
    }
  }
  {
    const re = /\[fn:([^\]\n]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "footnote", from, to, name: m[1] });
    }
  }
  {
    const re = /\[\d+\/\d+\]|\[\d+%\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "cookie", from, to });
    }
  }
  {
    const re = /(?:https?|ftp):\/\/[^\s<>"')\]]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let value = m[0];
      const trailing = /[.,;:!?]+$/.exec(value);
      if (trailing) value = value.slice(0, -trailing[0].length);
      if (!value) continue;
      const from = base + m.index;
      const to = from + value.length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "url", from, to, url: value });
      protectedRanges.push({ from, to });
    }
  }

  // 5. Emphasis
  {
    const styles: Record<string, "bold" | "italic" | "underline" | "strike"> = {
      "*": "bold",
      "/": "italic",
      _: "underline",
      "+": "strike",
    };
    const re =
      /(^|[\s([{'‘“「『【（《"\-：，。；！？、一-鿿぀-ヿ])([*_/+])(\S(?:[^\n]*?\S)?)\2(?=$|[\s)\]}'’”」』】）》".,;:!?…\-：，。；！？、一-鿿぀-ヿ])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + m[3].length + 2;
      if (overlaps(from, to, protectedRanges)) continue;
      if (m[3].startsWith(m[2]) || m[3].endsWith(m[2])) continue;
      tokens.push({
        type: "emphasis",
        style: styles[m[2]],
        delim: m[2],
        from,
        to,
        contentFrom: from + 1,
        contentTo: to - 1,
      });
      protectedRanges.push({ from, to });
    }
  }

  // 6. Tags (headline bodies can opt in)
  if (options.tags) {
    const re =
      /(^|[\s(])(:[\p{L}\p{N}_@#%]+(?::[\p{L}\p{N}_@#%]+)*:)(?=$|[\s).,;!?\]]|$)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const groupStart = base + m.index + m[1].length;
      if (overlaps(groupStart, groupStart + m[2].length, protectedRanges)) continue;
      let pos = groupStart;
      const names = m[2].slice(1, -1).split(":");
      for (const name of names) {
        if (!name) continue;
        const from = pos;
        const to = pos + name.length + 2;
        tokens.push({ type: "tag", from, to, name });
        pos = to;
      }
    }
  }

  tokens.sort((a, b) => a.from - b.from || b.to - a.to);
  if (inlineCache.size > 1000) inlineCache.clear();
  inlineCache.set(cacheKey, tokens);
  return tokens;
}
