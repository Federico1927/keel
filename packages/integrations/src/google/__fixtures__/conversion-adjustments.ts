/**
 * customers/{id}:uploadConversionAdjustments (issue #82), shaped like the documented request and a
 * recorded partial-failure answer (camelCase JSON, anonymised ids). Field names and the error text
 * are [to verify] on each API version bump; Meta's Conversions API has no counterpart (no fixture).
 */
export const adjustmentRequest = {
  conversionAdjustments: [
    { conversionAction: "customers/1234567890/conversionActions/777", adjustmentType: "RETRACTION", adjustmentDateTime: "2026-10-01 09:30:00+00:00", orderId: "5001", gclidDateTimePair: { gclid: "Cj0K", conversionDateTime: "2026-09-30 10:00:00+00:00" } },
    { conversionAction: "customers/1234567890/conversionActions/777", adjustmentType: "RESTATEMENT", adjustmentDateTime: "2026-10-01 09:30:00+00:00", orderId: "5002", restatementValue: { adjustedValue: 79.9, currencyCode: "EUR" } },
  ],
  partialFailure: true,
};

export const adjustmentPartialFailure = {
  partialFailureError: {
    code: 3,
    message: "The conversion for this adjustment was not found.",
    details: [{ "@type": "type.googleapis.com/google.ads.googleads.v18.errors.GoogleAdsFailure", errors: [{ errorCode: { conversionAdjustmentUploadError: "CONVERSION_NOT_FOUND" }, message: "The conversion for this adjustment was not found.", location: { fieldPathElements: [{ fieldName: "conversion_adjustments", index: 1 }] } }] }],
  },
  results: [{ orderId: "5001", adjustmentType: "RETRACTION", conversionAction: "customers/1234567890/conversionActions/777" }, {}],
};
