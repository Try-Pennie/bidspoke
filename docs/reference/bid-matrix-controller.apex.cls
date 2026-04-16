public class BidMatrixController implements Metadata.DeployCallback {
  @AuraEnabled
  public static void saveBidRangeRows(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != NULL
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsSoFi__c = FALSE
        AND IsEPCVIP__c = FALSE
        AND IsDot818__c = FALSE
        AND IsNerdWallet__c = FALSE
        AND IsBrainsome__c = FALSE
        AND IsTLG__c = FALSE
        AND IsAmOne__c = FALSE
        AND IsAmOneDirect__c = FALSE
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }


  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRows(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsSoFi__c = FALSE
        AND IsEPCVIP__c = FALSE
        AND IsDot818__c = FALSE
        AND IsNerdWallet__c = FALSE
        AND IsBrainsome__c = FALSE
        AND IsTLG__c = FALSE
        AND IsAmOne__c = FALSE
        AND IsAmOneDirect__c = FALSE
        ORDER BY RowId__c, RangeLow__c
    ];
  }
  @AuraEnabled
  public static void saveBidRangeRowsSoFi(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsSoFi__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }


  }



  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsSoFi(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsSoFi__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }

  @AuraEnabled
  public static void saveBidRangeRowsEPCVIP(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsEPCVIP__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsEPCVIP(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsEPCVIP__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsDot818(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsDot818__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }



  @AuraEnabled
  public static void saveBidRangeRowsDot818(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsDot818__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsNerdWallet(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsNerdWallet__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }



  @AuraEnabled
  public static void saveBidRangeRowsNerdWallet(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsNerdWallet__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsBrainsome(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsBrainsome__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }



  @AuraEnabled
  public static void saveBidRangeRowsBrainsome(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsBrainsome__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }


  @AuraEnabled
  public static void saveBidRangeRowsTLG(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsTLG__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }


  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsTLG(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsTLG__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }

  @AuraEnabled
  public static void saveBidRangeRowsAmOne(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != null
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsAmOne__c = true
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }

  @AuraEnabled
  public static void saveBidRangeRowsAmOneDirect(List<BidRangeRow__c> records) {
    if (records == null || records.isEmpty()) {
      return;
    }
    List<BidRangeRow__c> toDelete = [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c
        FROM BidRangeRow__c
        WHERE RowId__c != NULL
        AND IsSellOff__c = :records[0].IsSellOff__c
        AND IsAmOneDirect__c = TRUE
    ];

    if (!toDelete.isEmpty()) {
      delete toDelete;
    }

    if (!records.isEmpty()) {
      insert records;
    }
  }


  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsAmOne(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsAmOne__c = true
        ORDER BY RowId__c, RangeLow__c
    ];
  }

  @AuraEnabled(cacheable=true)
  public static List<BidRangeRow__c> getBidRangeRowsAmOneDirect(Boolean isSellOff) {
    return [
        SELECT Id, RowId__c, RangeLow__c, RangeHigh__c,
            RowLow__c, RowHigh__c, RangeValue__c
        FROM BidRangeRow__c
        WHERE IsSellOff__c = :isSellOff
        AND IsAmOneDirect__c = TRUE
        ORDER BY RowId__c, RangeLow__c
    ];
  }



  @AuraEnabled
  public static Boolean getIsActiveFlag(String developerName) {
    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(developerName);
    return config != null && config.IsActive__c;
  }

  @AuraEnabled
  public static Boolean getIsActiveAltLandingPageFlag(String developerName) {
    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(developerName);
    return config != null && config.IsActiveAltLandingPage__c;
  }

  @AuraEnabled
  public static Boolean getIsActiveExpLandingPageFlag(String developerName) {
    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(developerName);
    return config != null && config.IsActiveExpLandingPage__c;
  }

  @AuraEnabled
  public static Boolean getTestOfferLanguage(String developerName) {
    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(developerName);
    return config != null && config.TestOfferLanguage__c;
  }

  @AuraEnabled
  public static Boolean getVantageScoreActiveFlag(String developerName) {
    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(developerName);
    return config != null && config.VantageScoreActive__c;
  }

  @AuraEnabled
  public static String updateIsActiveOnCMDT(String developerName, Boolean newValue) {
    try {
      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue isActiveField = new Metadata.CustomMetadataValue();
      isActiveField.field = 'IsActive__c';
      isActiveField.value = newValue;
      customMd.values.add(isActiveField);

      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  @AuraEnabled
  public static String updateIsActiveAltLandingPageOnCMDT(String developerName, Boolean newValue) {
    try {
      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue IsActiveAltLandingPageField = new Metadata.CustomMetadataValue();
      IsActiveAltLandingPageField.field = 'IsActiveAltLandingPage__c';
      IsActiveAltLandingPageField.value = newValue;
      customMd.values.add(IsActiveAltLandingPageField);

      if (newValue == true){
        Metadata.CustomMetadataValue IsActiveExpLandingPageField = new Metadata.CustomMetadataValue();
        IsActiveExpLandingPageField.field = 'IsActiveExpLandingPage__c';
        IsActiveExpLandingPageField.value = false;
        customMd.values.add(IsActiveExpLandingPageField);
      }



      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  @AuraEnabled
  public static String updateIsActiveExpLandingPageOnCMDT(String developerName, Boolean newValue) {
    try {
      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue IsActiveExpLandingPageField = new Metadata.CustomMetadataValue();
      IsActiveExpLandingPageField.field = 'IsActiveExpLandingPage__c';
      IsActiveExpLandingPageField.value = newValue;
      customMd.values.add(IsActiveExpLandingPageField);

      if (newValue == true){
        Metadata.CustomMetadataValue IsActiveAltLandingPageField = new Metadata.CustomMetadataValue();
        IsActiveAltLandingPageField.field = 'IsActiveAltLandingPage__c';
        IsActiveAltLandingPageField.value = false;
        customMd.values.add(IsActiveAltLandingPageField);
      }



      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  @AuraEnabled
  public static String updateTestOfferLanguageOnCMDT(String developerName, Boolean newValue) {
    try {
      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue testOfferLanguagePageField = new Metadata.CustomMetadataValue();
      testOfferLanguagePageField.field = 'TestOfferLanguage__c';
      testOfferLanguagePageField.value = newValue;
      customMd.values.add(testOfferLanguagePageField);


      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  @AuraEnabled
  public static String updateVantageScoreActiveOnCMDT(String developerName, Boolean newValue) {
    try {
      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue vantageActiveField = new Metadata.CustomMetadataValue();
      vantageActiveField.field = 'VantageScoreActive__c';
      vantageActiveField.value = newValue;
      customMd.values.add(vantageActiveField);

      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  @AuraEnabled
  public static MatrixFilterData getMatrixFilterDataFromCMDT(String developerName) {
    String dn = String.isBlank(developerName) ? 'Default' : developerName;

    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(dn);
    if (config == null) return null;

    MatrixFilterData dto = new MatrixFilterData();
    dto.engineDebtValue = config.EngineDebtValue__c;
    dto.engineDebtActive = config.EngineDebtActive__c;

    dto.collectionsPercentValue = config.CollectionsPercentValue__c;
    dto.collectionsPercentActive = config.CollectionsPercentActive__c;

    dto.stateActive = config.StateActive__c;
    dto.states = config.States__c;

    dto.loanAmountValue = config.LoanAmountValue__c;
    dto.loanAmountActive = config.LoanAmountActive__c;

    dto.vantageScoreValue = config.VantageScoreValue__c;
    dto.vantageScoreActive = config.VantageScoreActive__c;

    return dto;
  }

  @AuraEnabled
  public static String getMatrixFilterDataFromCMDTAsJson(String developerName) {
    String dn = String.isBlank(developerName) ? 'Default' : developerName;

    BidConfiguration__mdt config = BidConfiguration__mdt.getInstance(dn);
    if (config == null) return null;

    Map<String, Object> result = new Map<String, Object>();
    result.put('engineDebtValue', config.EngineDebtValue__c);
    result.put('engineDebtActive', config.EngineDebtActive__c);
    result.put('collectionsPercentValue', config.CollectionsPercentValue__c);
    result.put('collectionsPercentActive', config.CollectionsPercentActive__c);
    result.put('stateActive', config.StateActive__c);
    result.put('states', config.States__c);
    result.put('loanAmountValue', config.LoanAmountValue__c);
    result.put('loanAmountActive', config.LoanAmountActive__c);
    result.put('vantageScoreValue', config.VantageScoreValue__c);
    result.put('vantageScoreActive', config.VantageScoreActive__c);
    return JSON.serialize(result);
  }

  @AuraEnabled
  public static String updateMatrixFilterDataOnCMDT(String developerName, String matrixFilterDataJson) {
    try {
      if (String.isBlank(developerName)) {
        developerName = 'Default';
      }
      if (String.isBlank(matrixFilterDataJson)) {
        return 'matrixFilterDataJson is empty';
      }

      Map<String, Object> data = (Map<String, Object>) JSON.deserializeUntyped(matrixFilterDataJson);

      List<Metadata.Metadata> components = Metadata.Operations.retrieve(
          Metadata.MetadataType.CustomMetadata,
          new List<String>{ 'BidConfiguration__mdt.' + developerName });

      if (components.isEmpty()) {
        return 'Record not found';
      }
      Metadata.CustomMetadata customMd = (Metadata.CustomMetadata) components[0];

      Metadata.CustomMetadataValue engineDebtValueField = new Metadata.CustomMetadataValue();
      engineDebtValueField.field = 'EngineDebtValue__c';
      engineDebtValueField.value = data.get('engineDebtValue');
      customMd.values.add(engineDebtValueField);

      Metadata.CustomMetadataValue engineDebtActiveField = new Metadata.CustomMetadataValue();
      engineDebtActiveField.field = 'EngineDebtActive__c';
      engineDebtActiveField.value = data.get('engineDebtActive');
      customMd.values.add(engineDebtActiveField);

      Metadata.CustomMetadataValue collectionsPercentValueField = new Metadata.CustomMetadataValue();
      collectionsPercentValueField.field = 'CollectionsPercentValue__c';
      collectionsPercentValueField.value = data.get('collectionsPercentValue');
      customMd.values.add(collectionsPercentValueField);

      Metadata.CustomMetadataValue collectionsPercentActiveField = new Metadata.CustomMetadataValue();
      collectionsPercentActiveField.field = 'CollectionsPercentActive__c';
      collectionsPercentActiveField.value = data.get('collectionsPercentActive');
      customMd.values.add(collectionsPercentActiveField);

      Metadata.CustomMetadataValue statesField = new Metadata.CustomMetadataValue();
      statesField.field = 'States__c';
      statesField.value = data.get('states');
      customMd.values.add(statesField);

      Metadata.CustomMetadataValue stateActiveField = new Metadata.CustomMetadataValue();
      stateActiveField.field = 'StateActive__c';
      stateActiveField.value = data.get('stateActive');
      customMd.values.add(stateActiveField);

      Metadata.CustomMetadataValue loanAmountValueField = new Metadata.CustomMetadataValue();
      loanAmountValueField.field = 'LoanAmountValue__c';
      loanAmountValueField.value = data.get('loanAmountValue');
      customMd.values.add(loanAmountValueField);

      Metadata.CustomMetadataValue loanAmountActiveField = new Metadata.CustomMetadataValue();
      loanAmountActiveField.field = 'LoanAmountActive__c';
      loanAmountActiveField.value = data.get('loanAmountActive');
      customMd.values.add(loanAmountActiveField);

      Metadata.CustomMetadataValue vantageScoreValueField = new Metadata.CustomMetadataValue();
      vantageScoreValueField.field = 'VantageScoreValue__c';
      vantageScoreValueField.value = data.get('vantageScoreValue');
      customMd.values.add(vantageScoreValueField);

      Metadata.CustomMetadataValue vantageScoreActiveField = new Metadata.CustomMetadataValue();
      vantageScoreActiveField.field = 'VantageScoreActive__c';
      vantageScoreActiveField.value = data.get('vantageScoreActive');
      customMd.values.add(vantageScoreActiveField);

      Metadata.DeployContainer container = new Metadata.DeployContainer();
      container.addMetadata(customMd);

      Metadata.Operations.enqueueDeployment(container, new BidMatrixController());
      return 'Deployment queued';
    } catch (Exception ex) {
      return 'Error: ' + ex.getMessage();
    }
  }

  public void handleResult(Metadata.DeployResult result, Metadata.DeployCallbackContext context) {
    if (result.status == Metadata.DeployStatus.SUCCEEDED) {
      System.debug('CMDT update succeeded');
    } else {
      System.debug('CMDT update failed: ' + result);
    }
  }

  public class MatrixFilterData {
    @AuraEnabled public Decimal engineDebtValue;
    @AuraEnabled public Boolean engineDebtActive;

    @AuraEnabled public Decimal collectionsPercentValue;
    @AuraEnabled public Boolean collectionsPercentActive;

    @AuraEnabled public Boolean stateActive;
    @AuraEnabled public String states;

    @AuraEnabled public Decimal loanAmountValue;
    @AuraEnabled public Boolean loanAmountActive;

    @AuraEnabled public Decimal vantageScoreValue;
    @AuraEnabled public Boolean vantageScoreActive;
  }

}