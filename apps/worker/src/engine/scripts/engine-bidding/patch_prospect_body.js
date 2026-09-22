 const constants = steps.constants.output;
  const responseBody = steps.offer_response.output.body ?? {};
  const responseOffers = responseBody.offers ?? [];

  let requestBody = {};

  if (responseOffers.length > 0 && responseOffers[0]) {
    const offer = responseOffers[0];
    const tripointClickUrl = constants.TripointClickUrl ?? '';
    const tripointBid = tripointClickUrl && offer.click_url.includes(tripointClickUrl);
    const clickUrl = offer.click_url;

    requestBody = {
      BidAmount__c: offer.rate,
      BidStatus__c: 'Bid',
      OfferLandingPage__c: clickUrl,
      Base_Bid__c: steps.prospect_trades.output.body?.baseBid,
    };

      // The sale from whichever node decided it (#1414, Phase 7), falling back to
      // tripoint_ping's legacy fields while the older script is still on the canvas.
      const tp = steps.tripoint_ping?.output;
      const sale = tp?.sale ?? steps.buyer_select?.output?.sale;
      const tripointLeadId = sale ? sale.buyer_reference : (tp?.createLead?.id ?? null);
      if (tripointLeadId) {
        requestBody.TripointLeadID__c = tripointLeadId;
      }
      const rc = sale ? (sale.result_code != null ? Number(sale.result_code) : null) : (tp?.resultCode ?? null);
      if (rc != null) {
        const success   = new Set([1000, 1001, 1013, 1014, 1015, 1016, 1017]);
        const duplicate = new Set([1003, 1004, 1020]);
        if (success.has(rc))         requestBody.Tripoint_Response__c = 'Success';
        else if (duplicate.has(rc))  requestBody.Tripoint_Response__c = 'Duplicate';
        else                         requestBody.Tripoint_Response__c = 'Fail';
      }

    if (tripointBid) {
      requestBody.ExternalPartnerName__c = 'Tripoint';
      requestBody.ExternalDebtAmount__c =
  steps.prospect_trades.output.body?.tradeCalculations?.enrollableDebt;
      requestBody.ExternalRoutingCode__c = 2;
      requestBody.ExternalExchangeStatus__c = 'Bid';
    }
    if (steps.prospect_trades.output.body?.discountApplied === true) {
  requestBody.Collections_Bid_Discount__c = true;
  }
}

  return requestBody;