// Known no gate (#1544): may a click sold buyer be offered this lead?
//
// Only on a KNOWN no from the node that decided the lead. An unknown answer (a timeout,
// a proxy 5xx, 1009 in progress, a buyer error, an outcome nobody could read) may be a
// sale the buyer made and never told us about, so offering the lead again could sell it
// twice (Dan, 2026-09-24). Anything this script does not recognise is not a known no.
//
// The deciding node is read by the same rule build_response_body reads its sale by:
// tripoint_ping when it carries a sale, else buyer_select when it carries one, else
// tripoint_ping. So the gate keeps working when buyer_select sells live at Stage B and
// tripoint_ping no longer runs.
//
// Both nodes' answers are put into tripoint_ping's words (#1540) and judged by the ONE
// list below (#1653), so a Tripoint answer is a known no or not whichever node recorded it.
//
//   tripoint_ping: its tripoint_answer, as it stands. An older script that names no
//                  answer is not a known no.
//   buyer_select:  a no_sale the buyer declined (declined_by_buyer) that carries the
//                  buyer's answer (a class) is declined, except where it cannot be told
//                  from Tripoint's 1009 in progress:
//                    a result code: Tripoint's 1009 is in_progress, any other is declined.
//                    no result code, detail http 5xx: declined. Tripoint's decline rules
//                      decline a 5xx only on its two known 502 answers, invalid data and
//                      the null id, which tripoint_ping calls invalid_data and null_id_fault.
//                    no result code otherwise: unknown for Tripoint, whose 1009 is also a
//                      decline by its rules; declined for any other buyer.
//                  A decline with no class (replayed from an earlier attempt) is unknown.
//                  Every other route or reason is named by its reason, never a known no.
//
// The Branch after this node sends known_no true to the buyer_click_check node.
const KNOWN_NO_ANSWERS = ['declined', 'invalid_data', 'null_id_fault'];
// Tripoint's "duplicate submission already in progress", the code tripoint_ping names
// in_progress (a test holds the two together).
const TRIPOINT_IN_PROGRESS_CODES = ['1009'];

const buyerSelectAnswer = (out) => {
  if (out._route !== 'no_sale' || out.reason !== 'declined_by_buyer') return typeof out.reason === 'string' ? out.reason : null;
  const sale = out.sale ?? {};
  if (sale.response_class == null) return 'unknown';
  const tripoint = sale.partner_slug === 'tripoint';
  if (sale.result_code != null) return tripoint && TRIPOINT_IN_PROGRESS_CODES.includes(String(sale.result_code)) ? 'in_progress' : 'declined';
  if (typeof out.detail === 'string' && /^http 5\d\d$/.test(out.detail)) return 'declined';
  return tripoint ? 'unknown' : 'declined';
};

const tp = steps.tripoint_ping?.output ?? null;
const bs = steps.buyer_select?.output ?? null;

let decidedBy = null;
if (tp && tp.sale) decidedBy = 'tripoint_ping';
else if (bs && bs.sale) decidedBy = 'buyer_select';
else if (tp) decidedBy = 'tripoint_ping';

let answer = null;
if (decidedBy === 'tripoint_ping') answer = typeof tp.tripoint_answer === 'string' ? tp.tripoint_answer : null;
if (decidedBy === 'buyer_select') answer = buyerSelectAnswer(bs);
return { known_no: answer !== null && KNOWN_NO_ANSWERS.includes(answer), decided_by: decidedBy, answer };
