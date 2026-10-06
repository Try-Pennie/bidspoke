/**
 * Addresses bound for a log, an alert or an outside service lose their query
 * string and fragment (L741, #1740).
 *
 * A scrub that finds personal data by its shape cannot see a percent-encoded
 * copy of it, and a query string percent-encodes exactly the characters such a
 * scrub keys on: an email's @ becomes %40, a phone's brackets %28 and %29. In
 * Slate a page address carried a lead's name, email and phone into Slack past a
 * pattern scrub that recognised none of them. So the query and fragment go,
 * whatever they hold, and the scheme, host and path stay, which is what anyone
 * diagnosing a failed call needs.
 *
 * The host and path end at whitespace, a quote, a backslash or a closing bracket,
 * as prose writes "(see https://...)". Once a ? or # starts the query, it runs to
 * the next whitespace, quote or backslash, brackets included, so an unencoded
 * value such as (201)555-0100 goes whole. A serialised JSON line keeps its
 * structure (an address ends at the closing quote or an escape), and sentence
 * punctuation directly after an address is kept. Known limit: a raw space inside
 * a query cannot be told from the end of the address, so text after it stays;
 * fetch and the platform encode spaces, so error text rarely carries one.
 */

const ADDRESS = /\b(?:https?|wss?):\/\/[^\s"'<>`\\)\]?#]*(?:[?#][^\s"'<>`\\]*)?/gi
const TRAILING_PUNCTUATION = /[.,;:!]+$/

/** The address without its query string and fragment. */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** The text with every address in it cut at its query string or fragment. */
export function stripUrlQueriesInText(text: string): string {
  return text.replace(ADDRESS, (address) => {
    const trailing = TRAILING_PUNCTUATION.exec(address)?.[0] ?? ''
    const core = trailing ? address.slice(0, -trailing.length) : address
    return stripUrlQuery(core) + trailing
  })
}
