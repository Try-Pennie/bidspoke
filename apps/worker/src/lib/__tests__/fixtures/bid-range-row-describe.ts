// Measured 2026-10-07 from the production org with
// `sf sobject describe -s BidRangeRow__c`, keeping only name, type and label.
// Field metadata only, no record data.
export const BID_RANGE_ROW_DESCRIBE = {
  fields: [
    { name: 'Id', type: 'id', label: 'Record ID' },
    { name: 'OwnerId', type: 'reference', label: 'Owner ID' },
    { name: 'IsDeleted', type: 'boolean', label: 'Deleted' },
    { name: 'Name', type: 'string', label: 'Bid Range Row  Name' },
    { name: 'CreatedDate', type: 'datetime', label: 'Created Date' },
    { name: 'CreatedById', type: 'reference', label: 'Created By ID' },
    { name: 'LastModifiedDate', type: 'datetime', label: 'Last Modified Date' },
    { name: 'LastModifiedById', type: 'reference', label: 'Last Modified By ID' },
    { name: 'SystemModstamp', type: 'datetime', label: 'System Modstamp' },
    { name: 'RangeHigh__c', type: 'double', label: 'Range High' },
    { name: 'RangeLow__c', type: 'double', label: 'Range Low' },
    { name: 'RangeValue__c', type: 'double', label: 'Range Value' },
    { name: 'RowHigh__c', type: 'double', label: 'Row High' },
    { name: 'RowId__c', type: 'double', label: 'Row Id' },
    { name: 'RowLow__c', type: 'double', label: 'Row Low' },
    { name: 'IsSellOff__c', type: 'boolean', label: 'Is Sell Off' },
    { name: 'IsEPCVIP__c', type: 'boolean', label: 'Is EPC VIP' },
    { name: 'IsSoFi__c', type: 'boolean', label: 'Is SoFi' },
    { name: 'IsDot818__c', type: 'boolean', label: 'Is Dot818' },
    { name: 'IsNerdWallet__c', type: 'boolean', label: 'Is Nerd Wallet' },
    { name: 'IsBrainsome__c', type: 'boolean', label: 'IsBrainsome' },
    { name: 'IsTLG__c', type: 'boolean', label: 'IsTLG' },
    { name: 'IsAmOne__c', type: 'boolean', label: 'IsAmOne' },
    { name: 'IsAmOneDirect__c', type: 'boolean', label: 'Is AmOne Direct' },
    { name: 'Is_Lead_Economy__c', type: 'boolean', label: 'Is Lead Economy' },
    { name: 'IsLendingTree__c', type: 'boolean', label: 'Is LendingTree' },
    { name: 'IsBorrowBetter__c', type: 'boolean', label: 'Is Borrow Better' },
  ],
}
