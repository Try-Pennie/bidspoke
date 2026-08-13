/**
 * A real Salesforce Edge HTTP 400 error page, as stored verbatim in
 * `execution_steps.error_message`.
 *
 * PROVENANCE: read out of the production Bidspoke database on 2026-08-13 from
 * the Engine Bidding Workflow's `trades_request` step, execution started
 * 2026-08-12 00:15:30 UTC. The full row was 16,691 characters. The head and the
 * tail below are the real captured bytes; the middle (roughly 12KB of inlined
 * normalize.css and SVG illustration path data) is elided to keep the fixture a
 * readable size. Nothing diagnostic lives in the elided region, and the
 * summarizer's job is to drop exactly that kind of content, so a separate test
 * covers a large style/SVG block explicitly rather than relying on this.
 *
 * Do not "tidy" this string. Its oddities are the real ones the parser has to
 * survive: `<!doctypehtml>` with no space, unquoted attribute values, an
 * unclosed `<p>` in the footer, and the request-ID stamp split across three
 * `<span>`s.
 */
export const SALESFORCE_EDGE_ERROR_PAGE =
  '<!doctypehtml><html lang=en-US><meta charset=UTF-8><title>Error Page</title>' +
  '<style>/*! normalize.css v3.0.2 | MIT License | git.io/normalize */' +
  'html{font-family:sans-serif;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%}body{margin:0}' +
  'h1,h2,h3,h4,h5,h6{font-weight:inherit;font-size:1em}a{color:#006dcc;text-decoration:none}' +
  '.slds-illustration.slds-illustration_large .slds-illustration__svg{width:100%;max-width:600px}' +
  '</style>' +
  '<style>html{background:#fff}p{color:#3e3e3c;font-size:16px!important}' +
  'h3{font-weight:700;font-size:26px;color:#3e3e3c}footer{position:fixed;bottom:0}' +
  '@media (max-height:745px){footer{position:relative;padding:50px 0 20px 0}}</style>' +
  '<div class="slds-illustration slds-illustration_large">' +
  '<svg aria-hidden=true class=slds-illustration__svg viewBox="0 0 454 265"xmlns=http://www.w3.org/2000/svg>' +
  '<g fill=none fill-rule=evenodd stroke=none stroke-width=1>' +
  '<g transform="translate(-77.000000, -60.000000)"><g>' +
  '<path d="M44,17.5 L63,17.5 C62.2789714,12.0723971 64.081543,7.53186978 68.4077148,3.87841797 ' +
  'C73.3754883,-0.195556641 79.2734375,0.717773438 82.440918,2.12353516 C85.6083984,3.52929687 87.9"' +
  'vector-effect=non-scaling-stroke></path>' +
  '<path d="M12.7302848,29.5865514 C12.7302848,29.5865514 22.2744424,26.8231586 24.3430565,36.8421318"' +
  'vector-effect=non-scaling-stroke transform="translate(18.536671, 33.039705) scale(-1, 1)"></path>' +
  '</g></g></g></svg>' +
  '<div class="slds-text-longform"><h3>An unexpected connection error occurred.</h3>' +
  '<p class="slds-text-body"> Try refreshing the page or visit our ' +
  '<a href="https://status.salesforce.com/"  target="_blank">status page</a> for more information.' +
  '<br><b>70aebd63701c0777f9ba663c488e2044 ; 2026-08-12T00:15:32+00:00' +
  '<span style="text-transform:uppercase">; aws-prod1-useast1</span>; ' +
  '<span style="color:red">400</span></b></p>' +
  '<span class="site-logo">' +
  '<img src="https://www.lightningdesignsystem.com/assets/images/logo.svg" alt="logo" class="logo">' +
  '</span></div></div>' +
  '<footer class=slds-align_absolute-center>' +
  '<p class=origin-p>This error originated from Salesforce Edge.</footer>'

/** The message the Salesforce node builds around that body, verbatim. */
export const SALESFORCE_EDGE_ERROR_MESSAGE =
  `Salesforce API error (400): ${SALESFORCE_EDGE_ERROR_PAGE}`
