// Static scan for emoji in alert/UI copy, used by the CI guard that keeps emoji
// out of alerts and user-facing text (project convention: alerts must be plain
// and professional — no emoji). Catches two forms:
//   - Unicode emoji: characters that render as emoji by default
//     (\p{Emoji_Presentation}, e.g. a siren glyph) or any sequence carrying the
//     emoji variation selector VS16 (U+FE0F, e.g. a warning sign forced to
//     emoji). Deliberately NOT \p{Extended_Pictographic} — that also covers
//     bare typographic arrows (left-right arrow, etc.) used as plain glyphs in
//     comments and copy, which are not emoji and caused false positives.
//   - Slack emoji shortcodes, e.g. :rotating_light: / :warning: — these render
//     as emoji in Slack, so they count. A shortcode is a single-colon-delimited
//     token starting with a letter. Excluded look-alikes that are NOT emoji:
//       - clock times (12:00:00) — the token must start with a letter
//       - GitHub Actions commands (::error::, ::set-output::) — double colon
//       - POSIX character classes ([[:space:]], [[:digit:]]) — preceded by '['
// Exemption: any line carrying an `emoji-ok` marker.

export interface EmojiHit {
  line: number
  excerpt: string
  kind: 'unicode' | 'shortcode'
}

const UNICODE_EMOJI = /\p{Emoji_Presentation}|\u{FE0F}/u
// (?<![:[]) — not a ::command:: or [[:posix:]]; (?!:) — not the opening of one.
const SHORTCODE = /(?<![:[]):[a-z][a-z0-9_+-]*:(?!:)/

export function findEmoji(content: string, opts: { shortcodes?: boolean } = {}): EmojiHit[] {
  const lines = content.split('\n')
  const hits: EmojiHit[] = []
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i]
    if (src.includes('emoji-ok')) continue // explicit opt-out
    if (UNICODE_EMOJI.test(src)) {
      hits.push({ line: i + 1, excerpt: src.trim(), kind: 'unicode' })
      continue
    }
    if (opts.shortcodes && SHORTCODE.test(src)) {
      hits.push({ line: i + 1, excerpt: src.trim(), kind: 'shortcode' })
    }
  }
  return hits
}
