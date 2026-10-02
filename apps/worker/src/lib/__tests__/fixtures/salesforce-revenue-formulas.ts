/**
 * The three Salesforce revenue formulas, verbatim from the Tooling API on
 * 2026-10-02 (L48), read with
 * sf data query --use-tooling-api "SELECT Metadata FROM CustomField WHERE
 * EntityDefinition.QualifiedApiName=... AND DeveloperName=...".
 * Lead last changed 2026-09-30 17:32 UTC, Submission 2026-09-30 13:34 UTC,
 * Prospect 2026-09-30 17:54 UTC. On this day all three price Tripoint and
 * Liberty1 alike; Engine and AmOne differ between them, but not as rates.
 */

/** Lead.ExternalRevenue__c. */
export const LEAD_FORMULA_2026_10_02 = `IF(ISPICKVAL(External_Exchange_Status__c, "Completed"),
  IF(ExternalPartnerName__c = "Engine",
    TotalPayout__c,
    IF(ExternalPartnerName__c = "Liberty1",
      IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.001275,
      IF(ExternalPartnerName__c = "Tripoint",
        IF(AND(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 10000,
               IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) < 12500),
          IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0009,
          IF(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 12500,
            IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0013,
            0)),
        IF(ExternalPartnerName__c = "AmOne",
          AmOneBid__c,
          0)))),
  0)`

/** Submission__c.ExternalRevenue__c. */
export const SUBMISSION_FORMULA_2026_10_02 = `IF(ISPICKVAL(External_Exchange_Status__c, "Completed"),
  IF(External_Partner_Name__c = "Engine",
    TotalPayout__c,
    IF(External_Partner_Name__c = "Liberty1",
      IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.001275,
      IF(External_Partner_Name__c = "Tripoint",
        IF(AND(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 10000,
               IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) < 12500),
          IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0009,
          IF(IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) >= 12500,
            IF(NULLVALUE(EngineDebt__c, 0) > 0, EngineDebt__c, ExternalDebtAmount__c) * 0.0013,
            0)),
        IF(External_Partner_Name__c = "AmOne",
          AmOneBid__c,
          0)))),
  0)`

/** Prospect__c.ExternalExchangeRevenue__c. */
export const PROSPECT_FORMULA_2026_10_02 = `IF(
  ISPICKVAL(ExternalExchangeStatus__c, "Completed"),
  IF(
    ExternalPartnerName__c = "Engine",
    0,
    IF(
      ExternalPartnerName__c = "Liberty1",
      EngineDebt__c * 0.001275,
      IF(
        ExternalPartnerName__c = "Tripoint",
        IF(
          AND(EngineDebt__c >= 10000, EngineDebt__c < 12500),
          EngineDebt__c * 0.0009,
          IF(
            EngineDebt__c >= 12500,
            EngineDebt__c * 0.0013,
            0
          )
        ),
        0
      )
    )
  ),
  0
)`
