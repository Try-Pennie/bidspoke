  const responseBody = steps.offer_response.output.body ?? {};
  const responseOffers = responseBody.offers ?? [];

  let requestBody = {};

  if (responseOffers.length > 0 && responseOffers[0]) {
    const offer = responseOffers[0];
    const clickUrl = offer.click_url;

    requestBody = {
      BidAmount__c: offer.rate,
      BidStatus__c: 'Bid',
      OfferLandingPage__c: clickUrl,
      Base_Bid__c: steps.prospect_trades.output.body?.baseBid,
    };

      // The sale as build_response_body normalised it (#1416): one shape whichever node
      // decided the lead, carrying the winner's name, routing code and class. Nothing
      // here holds a Tripoint literal; a second buyer is named by its own facts.
      const sale = steps.build_response_body?.output?.sale ?? null;
      const sold = !!sale && sale.accepted === true;

      // Tripoint's own Salesforce fields, written only when Tripoint is the buyer:
      // Salesforce has no field for another buyer's reference or class yet.
      if (sold && sale.partner_slug === 'tripoint') {
        if (sale.buyer_reference) requestBody.TripointLeadID__c = sale.buyer_reference;
        if (sale.response_class) requestBody.Tripoint_Response__c = sale.response_class;
      }

    if (sold) {
      requestBody.ExternalPartnerName__c = sale.partner_name;
      requestBody.ExternalDebtAmount__c =
  steps.prospect_trades.output.body?.tradeCalculations?.enrollableDebt;
      requestBody.ExternalRoutingCode__c = sale.routing_code;
      requestBody.ExternalExchangeStatus__c = 'Bid';
    }
    if (steps.prospect_trades.output.body?.discountApplied === true) {
  requestBody.Collections_Bid_Discount__c = true;
  }
}

  return requestBody;