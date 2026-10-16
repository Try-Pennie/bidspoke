/**
 * The one colour-contrast waiver the accessibility scans allow (#2137): text in
 * a named class, inside a named surface, until the named issue sets its shade.
 * The partners form's grey hints (text-gray-500 on beige) wait for PR13 (#2144),
 * which deletes this. Every other contrast failure, and every other rule, still
 * fails the scan.
 */
export interface ContrastWaiver {
  /** The class whose text is waived (the node or an ancestor carries it). */
  className: string
  /** The surface the waiver is limited to, as a selector the node must sit inside. */
  within: string
  /** The issue that sets the shade and deletes the waiver. */
  issue: string
}

/**
 * The selector of a violating node axe found in the MAIN document, or null.
 * A node in an iframe or a shadow root comes as a longer, or nested, target;
 * it is never waived, so it fails the scan rather than being judged against the
 * wrong document.
 */
export function waivableSelector(target: unknown): string | null {
  return Array.isArray(target) && target.length === 1 && typeof target[0] === 'string' ? target[0] : null
}

/**
 * True when the node the selector names sits inside the waiver's surface and
 * carries (or sits inside) its class. Self contained, because it runs in the
 * page through page.evaluate as well as in a unit test.
 */
export function waivedInDocument(doc: Document, selector: string, waiver: { className: string; within: string }): boolean {
  const el = doc.querySelector(selector)
  return el !== null && el.closest(`.${waiver.className}`) !== null && el.closest(waiver.within) !== null
}
