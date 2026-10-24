/**
 * Each service's own mark (#2339): drawn on the App Action card's header, where
 * Dan settled "the service's own icon" in the card's round 2
 * (docs/design/app-action-node-card.html). Display data only: no action's run
 * reads it, so it is outside every version fingerprint, as realSend and
 * multiline are.
 *
 * Keyed by what the card names: a catalogue service, or, for Google, the
 * product an action runs in (google.gmail, google.drive and so on), the way the
 * card names Gmail rather than Google.
 *
 * SOURCES, recorded on each mark:
 *  - Simple Icons 16.34.0 (CC0 1.0, https://simpleicons.org): each mark is the
 *    release's single path in its brand colour from data/simple-icons.json,
 *    fetched from https://cdn.jsdelivr.net/npm/simple-icons@16.34.0/ on
 *    2026-10-24.
 *  - Google Drive: the full colour mark the settled card design draws, kept
 *    exactly as it was so that design still scores.
 *  - HTTP, which has no brand: lucide's globe (lucide-react 1.57.0, ISC), the
 *    product's own icon set, drawn in the plain box's grey.
 *
 * Slack, Salesforce and OpenAI are not in Simple Icons (each was removed at its
 * brand owner's request), so they have no CC0 mark here and keep the plain box
 * until Dan chooses another source; MARKLESS says so, and the test holds it.
 */

export interface MarkPath {
  d: string
  fill?: string
  /** An outline mark (HTTP's globe) is stroked, 2 wide with round ends, as lucide draws it. */
  stroke?: string
}

export interface ServiceMark {
  /** The brand the mark is, as the card names it. */
  title: string
  viewBox: string
  paths: readonly MarkPath[]
  /** Where the mark was taken from, at which version and under which licence. */
  source: string
}

export const SIMPLE_ICONS_VERSION = '16.34.0'
const SIMPLE_ICONS = (slug: string) => `Simple Icons ${SIMPLE_ICONS_VERSION} (CC0 1.0), icons/${slug}.svg`

export const SERVICE_MARKS: Readonly<Record<string, ServiceMark>> = {
  'google.drive': {
    title: 'Google Drive',
    viewBox: '0 0 87.3 78',
    paths: [
      { d: 'm6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z', fill: '#0066da' },
      { d: 'm43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z', fill: '#00ac47' },
      { d: 'm73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z', fill: '#ea4335' },
      { d: 'm43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z', fill: '#00832d' },
      { d: 'm59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z', fill: '#2684fc' },
      { d: 'm73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z', fill: '#ffba00' },
    ],
    source: 'Google Drive\'s full colour mark, as the settled card design draws it (docs/design/app-action-node-card.html, round 2)',
  },
  'google.gmail': {
    title: 'Gmail',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z', fill: '#EA4335' }],
    source: SIMPLE_ICONS('gmail'),
  },
  'google.sheets': {
    title: 'Google Sheets',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z', fill: '#34A853' }],
    source: SIMPLE_ICONS('googlesheets'),
  },
  'google.calendar': {
    title: 'Google Calendar',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z', fill: '#4285F4' }],
    source: SIMPLE_ICONS('googlecalendar'),
  },
  anthropic: {
    title: 'Anthropic',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z', fill: '#191919' }],
    source: SIMPLE_ICONS('anthropic'),
  },
  snowflake: {
    title: 'Snowflake',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M24 3.459c0 .646-.418 1.18-1.141 1.18-.723 0-1.142-.534-1.142-1.18 0-.647.419-1.18 1.142-1.18.723 0 1.141.533 1.141 1.18zm-.228 0c0-.533-.38-.951-.913-.951s-.913.38-.913.95c0 .533.38.952.913.952.57 0 .913-.419.913-.951zm-1.37-.533h.495c.266 0 .456.152.456.38 0 .153-.076.229-.19.305l.19.266v.038h-.266l-.19-.266h-.229v.266h-.266zm.495.228h-.229v.267h.229c.114 0 .152-.038.152-.114.038-.077-.038-.153-.152-.153zM7.602 12.4c.038-.151.076-.304.076-.456 0-.114-.038-.228-.038-.342-.114-.343-.304-.647-.646-.838l-4.87-2.777c-.685-.38-1.56-.152-1.94.533-.381.685-.153 1.56.532 1.94l2.701 1.56-2.701 1.56c-.685.38-.913 1.256-.533 1.94.38.685 1.256.914 1.94.533l4.832-2.777c.343-.267.571-.533.647-.876zm1.332 2.626c-.266-.038-.57.038-.837.19l-4.832 2.777c-.685.38-.913 1.256-.532 1.94.38.686 1.255.914 1.94.533l2.701-1.56v3.12c0 .8.647 1.408 1.446 1.408.799 0 1.407-.647 1.407-1.408v-5.592c0-.761-.57-1.37-1.293-1.408zm4.946-6.088c.266.038.57-.038.837-.19l4.832-2.777c.685-.38.913-1.256.532-1.94-.38-.686-1.255-.914-1.94-.533l-2.701 1.56V1.975c0-.799-.647-1.408-1.446-1.408-.799 0-1.446.609-1.446 1.408V7.53c0 .76.609 1.37 1.332 1.407zM3.265 5.97l4.832 2.777c.266.152.533.19.837.19.723-.038 1.331-.684 1.331-1.407V1.975c0-.799-.646-1.408-1.407-1.408-.799 0-1.446.647-1.446 1.408v3.12l-2.701-1.56c-.685-.38-1.56-.152-1.94.533-.419.646-.19 1.521.494 1.902zm9.093 6.011a.412.412 0 00-.114-.266l-.57-.571a.346.346 0 00-.267-.114.412.412 0 00-.266.114l-.571.57a.411.411 0 00-.114.267c0 .076.038.19.114.267l.57.57a.345.345 0 00.267.114c.076 0 .19-.038.266-.114l.571-.57a.412.412 0 00.114-.267zm1.598.533L11.94 14.53c-.039.038-.153.114-.229.114h-.608a.411.411 0 01-.267-.114L8.82 12.514a.408.408 0 01-.076-.229v-.608c0-.076.038-.19.114-.267l2.016-2.016a.41.41 0 01.267-.114h.608a.41.41 0 01.267.114l2.016 2.016a.347.347 0 01.114.267v.608c-.076.077-.114.19-.19.229zm5.593 5.44l-4.832-2.777c-.266-.152-.57-.19-.837-.152-.723.038-1.332.684-1.332 1.408v5.554c0 .8.647 1.408 1.408 1.408.799 0 1.446-.647 1.446-1.408v-3.12l2.7 1.56c.686.38 1.561.152 1.941-.533.419-.646.19-1.521-.494-1.94zm2.549-7.533l-2.701 1.56 2.7 1.56c.686.38.914 1.256.533 1.94-.38.685-1.255.913-1.94.533l-4.832-2.778a1.644 1.644 0 01-.647-.798c-.037-.153-.076-.305-.076-.457 0-.114.039-.228.039-.342.114-.343.342-.647.646-.837l4.832-2.778c.685-.38 1.56-.152 1.94.533.457.609.19 1.484-.494 1.864', fill: '#29B5E8' }],
    source: SIMPLE_ICONS('snowflake'),
  },
  supabase: {
    title: 'Supabase',
    viewBox: '0 0 24 24',
    paths: [{ d: 'M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z', fill: '#3FCF8E' }],
    source: SIMPLE_ICONS('supabase'),
  },
  http: {
    title: 'HTTP',
    viewBox: '0 0 24 24',
    paths: [
      { d: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', stroke: '#94a3b8' },
      { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', stroke: '#94a3b8' },
      { d: 'M2 12h20', stroke: '#94a3b8' },
    ],
    source: 'lucide globe, lucide-react 1.57.0 (ISC): HTTP has no brand of its own',
  },
}

/** Catalogue services with no mark yet, and why: each keeps the plain box. */
export const MARKLESS: Readonly<Record<string, string>> = {
  slack: 'not in Simple Icons, removed at Slack\'s request; no CC0 mark',
  salesforce: 'not in Simple Icons, removed at Salesforce\'s request; no CC0 mark',
  openai: 'not in Simple Icons, removed at OpenAI\'s request; no CC0 mark',
}

/** Google is one catalogue service whose actions run in four products, each with its own mark. */
export const GOOGLE_PRODUCT_MARKS: Readonly<Record<string, string>> = {
  'google.drive-': 'google.drive',
  'google.gmail-': 'google.gmail',
  'google.sheets-': 'google.sheets',
  'google.calendar-': 'google.calendar',
}

/** The mark key an action is drawn with: its Google product's, else its service's when one is held; null keeps the plain box. */
export function markKeyFor(service: string | null, action: string | null): string | null {
  if (action !== null) {
    for (const [prefix, key] of Object.entries(GOOGLE_PRODUCT_MARKS)) if (action.startsWith(prefix)) return key
  }
  return service !== null && service !== 'google' && Object.hasOwn(SERVICE_MARKS, service) ? service : null
}
