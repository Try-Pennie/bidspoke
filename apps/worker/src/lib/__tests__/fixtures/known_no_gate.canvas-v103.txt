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
//   tripoint_ping: its tripoint_answer (#1540) is declined, invalid_data or null_id_fault.
//                  An older script that names no answer is not a known no.
//   buyer_select:  it routed no_sale because the buyer declined (declined_by_buyer).
//
// The Branch after this node sends known_no true to the buyer_click_check node.
const KNOWN_NO_ANSWERS = ['declined', 'invalid_data', 'null_id_fault'];

const tp = steps.tripoint_ping?.output ?? null;
const bs = steps.buyer_select?.output ?? null;

let decidedBy = null;
if (tp && tp.sale) decidedBy = 'tripoint_ping';
else if (bs && bs.sale) decidedBy = 'buyer_select';
else if (tp) decidedBy = 'tripoint_ping';

if (decidedBy === 'tripoint_ping') {
  const answer = typeof tp.tripoint_answer === 'string' ? tp.tripoint_answer : null;
  return { known_no: answer !== null && KNOWN_NO_ANSWERS.includes(answer), decided_by: decidedBy, answer };
}
if (decidedBy === 'buyer_select') {
  const answer = typeof bs.reason === 'string' ? bs.reason : null;
  return { known_no: bs._route === 'no_sale' && answer === 'declined_by_buyer', decided_by: decidedBy, answer };
}
return { known_no: false, decided_by: null, answer: null };
