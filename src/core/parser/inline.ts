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

const ASCII_ARROWS: Record<string, string> = {
  "<==>": "⇔",
  "<=>": "⇔",
  "<-->": "↔",
  "<->": "↔",
  "==>": "⇒",
  "=>": "⇒",
  "<==": "⇐",
  "-->": "→",
  "->": "→",
  "<--": "←",
  "<-": "←",
};

const ORG_ENTITIES: Record<string, string> = {
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  gets: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  downarrow: "↓",
  Downarrow: "⇓",
  uparrow: "↑",
  Uparrow: "⇑",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  neq: "≠",
  ne: "≠",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  propto: "∝",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  land: "∧",
  lor: "∨",
  lnot: "¬",
  neg: "¬",
  cdot: "·",
  dots: "…",
  ldots: "…",
  cdots: "⋯",
  checkmark: "✓",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

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

  // 5. Markdown **bold** (tolerant for GPT-assisted notes)
  {
    const boldMdRe =
      /(^|[\s([{'‘“「『【（《"\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])(\*\*)([^\s*](?:[^\n]*?[^\s*])?)\*\*(?=$|[\s)\]}'’”」』】）》".,;:!?…\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])/g;
    let m: RegExpExecArray | null;
    while ((m = boldMdRe.exec(text))) {
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + m[3].length + 4;
      if (overlaps(from, to, protectedRanges)) continue;
      if (m[3].includes("|")) continue;
      tokens.push({
        type: "emphasis",
        style: "bold",
        delim: "**",
        from,
        to,
        contentFrom: from + 2,
        contentTo: to - 2,
      });
      protectedRanges.push({ from, to });
    }
  }

  // 6. Org emphasis (*bold* allows CJK boundaries; / _ + require strict non-word non-CJK boundaries)
  {
    const starRe =
      /(^|[\s([{'‘“「『【（《"\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])(\*)([^\s|*](?:[^\n|]*?[^\s|*])?)\*(?=$|[\s)\]}'’”」』】）》".,;:!?…\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])/g;
    let m: RegExpExecArray | null;
    while ((m = starRe.exec(text))) {
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + m[3].length + 2;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({
        type: "emphasis",
        style: "bold",
        delim: "*",
        from,
        to,
        contentFrom: from + 1,
        contentTo: to - 1,
      });
      protectedRanges.push({ from, to });
    }

    const slashRe =
      /(^|[\s([{'‘“「『【（《"\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])(\/)([^\s|](?:[^\n|]*?[^\s|])?)\/(?=$|[\s)\]}'’”」』】）》".,;:!?…\-：，。；！？、\u4e00-\u9fff\u3040-\u30ff])/g;
    while ((m = slashRe.exec(text))) {
      const inner = m[3];
      if (inner.startsWith("/") || inner.endsWith("/")) continue;
      // Do not italicize file paths like /usr/local/bin/
      if (/[A-Za-z0-9_.]\/[A-Za-z0-9_.]/.test(inner)) continue;
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + inner.length + 2;
      const prevChar = delimiterAt > 0 ? text[delimiterAt - 1] : "";
      const nextOffset = delimiterAt + inner.length + 2;
      const nextChar = nextOffset < text.length ? text[nextOffset] : "";
      const prevIsCjkWord = /[\u4e00-\u9fff\u3040-\u30ff]/.test(prevChar);
      const nextIsCjkWord = /[\u4e00-\u9fff\u3040-\u30ff]/.test(nextChar);
      // Guard against A/B ... C/D slash-separated phrases in Chinese prose.
      if (prevIsCjkWord && nextIsCjkWord) continue;
      if ((prevIsCjkWord || nextIsCjkWord) && /[，、；：,]/.test(inner)) continue;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({
        type: "emphasis",
        style: "italic",
        delim: "/",
        from,
        to,
        contentFrom: from + 1,
        contentTo: to - 1,
      });
      protectedRanges.push({ from, to });
    }

    const styles: Record<string, "underline" | "strike"> = {
      _: "underline",
      "+": "strike",
    };
    const strictRe =
      /(^|[\s([{'‘“「『【（《"\-—–])([_+])([^\s|](?:[^\n|]*?[^\s|])?)\2(?=$|[\s)\]}'’”」』】）》".,;:!?…\-—–])/g;
    while ((m = strictRe.exec(text))) {
      const delim = m[2];
      const inner = m[3];
      if (inner.startsWith(delim) || inner.endsWith(delim)) continue;
      // Do not strike math/expression additions like +a + b+
      if (delim === "+" && /\s[+\-*/]\s/.test(inner)) continue;
      const delimiterAt = m.index + m[1].length;
      const from = base + delimiterAt;
      const to = from + inner.length + 2;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({
        type: "emphasis",
        style: styles[delim],
        delim,
        from,
        to,
        contentFrom: from + 1,
        contentTo: to - 1,
      });
      protectedRanges.push({ from, to });
    }
  }

  // 7. Org entities (\rightarrow, \Downarrow, \times, ...) and trailing line breaks (\\)
  {
    const entityRe = /\\([A-Za-z]{2,})(?:\{\})?(?![\\A-Za-z])/g;
    let m: RegExpExecArray | null;
    while ((m = entityRe.exec(text))) {
      if (m.index > 0 && text[m.index - 1] === "\\") continue;
      const symbol = ORG_ENTITIES[m[1]];
      if (!symbol) continue;
      const from = base + m.index;
      const to = from + m[0].length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "entity", from, to, name: m[1], symbol });
      protectedRanges.push({ from, to });
    }

    const lineBreakRe = /(\\\\)\s*$/g;
    while ((m = lineBreakRe.exec(text))) {
      if (m.index > 0 && text[m.index - 1] === "\\") continue;
      const from = base + m.index;
      const to = base + text.length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "linebreak", from, to });
      protectedRanges.push({ from, to });
    }

    // Notion-style ASCII arrows (--> / -> / <- / <-> / ==> / => / <=>) in prose.
    // Guarded against code identifiers like C struct dereference `q->x` or HTML `<!--`.
    const asciiArrowRe = /<==>|<=+>|==+>|=>|<==+|<--+>|<->|--+>|->|<--+|<-/g;
    while ((m = asciiArrowRe.exec(text))) {
      const raw = m[0];
      const symbol =
        ASCII_ARROWS[raw] ??
        (raw.startsWith("<") && raw.endsWith(">")
          ? raw.includes("=")
            ? "⇔"
            : "↔"
          : raw.endsWith(">")
          ? raw.includes("=")
            ? "⇒"
            : "→"
          : raw.includes("=")
          ? "⇐"
          : "←");
      const prevChar = m.index > 0 ? text[m.index - 1] : "";
      const nextChar = m.index + raw.length < text.length ? text[m.index + raw.length] : "";
      // Never convert C pointer dereference `q->x`, `(*q)->x`, HTML `<!--`, or comparisons without prose boundaries.
      if (prevChar === "!" || nextChar === "!" || prevChar === "-" || nextChar === "-" || prevChar === "=" || nextChar === "=") {
        continue;
      }
      if (/[A-Za-z0-9_)\]}]/.test(prevChar) || /[A-Za-z0-9_(\[{]/.test(nextChar)) {
        continue;
      }
      const from = base + m.index;
      const to = from + raw.length;
      if (overlaps(from, to, protectedRanges)) continue;
      tokens.push({ type: "entity", from, to, name: "arrow", symbol });
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
