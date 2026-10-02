/**
 * Recorded shapes of Google Maps Platform answers (Address Validation API v1, Places API (New)),
 * trimmed to the fields Keel reads. Addresses are public landmarks or invented; no customer data.
 */
export const VALIDATE_OK = {
  result: {
    verdict: { inputGranularity: "PREMISE", validationGranularity: "PREMISE", geocodeGranularity: "PREMISE", addressComplete: true, hasInferredComponents: true },
    address: {
      formattedAddress: "1600 Amphitheatre Parkway, Mountain View, CA 94043-1351, USA",
      postalAddress: { regionCode: "US", languageCode: "en", postalCode: "94043-1351", administrativeArea: "CA", locality: "Mountain View", addressLines: ["1600 Amphitheatre Pkwy"] },
      addressComponents: [
        { componentName: { text: "1600" }, componentType: "street_number", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "Amphitheatre Parkway", languageCode: "en" }, componentType: "route", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "Mountain View", languageCode: "en" }, componentType: "locality", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "94043" }, componentType: "postal_code", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "1351" }, componentType: "postal_code_suffix", confirmationLevel: "CONFIRMED", inferred: true },
        { componentName: { text: "CA", languageCode: "en" }, componentType: "administrative_area_level_1", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "USA", languageCode: "en" }, componentType: "country", confirmationLevel: "CONFIRMED" },
      ],
    },
    geocode: { location: { latitude: 37.4225, longitude: -122.0847 }, placeId: "ChIJF4Yf2Ry7j4AR__1AkytDyAE" },
    metadata: { business: true, residential: false },
  },
  responseId: "c5b5f8a2-7d4e-4b61-9a3e-5e1f1d2c9b10",
};

/** An Italian address with a postal code that does not belong to the city and no house number. */
export const VALIDATE_SUSPICIOUS = {
  result: {
    verdict: { inputGranularity: "ROUTE", validationGranularity: "ROUTE", geocodeGranularity: "ROUTE", hasUnconfirmedComponents: true },
    address: {
      formattedAddress: "Via Torino, 00184 Roma RM, Italia",
      postalAddress: { regionCode: "IT", languageCode: "it", postalCode: "00184", administrativeArea: "RM", locality: "Roma", addressLines: ["Via Torino"] },
      addressComponents: [
        { componentName: { text: "Via Torino", languageCode: "it" }, componentType: "route", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "Roma", languageCode: "it" }, componentType: "locality", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "20121" }, componentType: "postal_code", confirmationLevel: "UNCONFIRMED_AND_SUSPICIOUS" },
        { componentName: { text: "Italia", languageCode: "it" }, componentType: "country", confirmationLevel: "CONFIRMED" },
      ],
      missingComponentTypes: ["street_number"],
      unconfirmedComponentTypes: ["postal_code"],
    },
  },
  responseId: "0d6f0e33-2b5b-4d4e-8a0e-31f1c7e0a7b2",
};

/** Google placed only the town: the street does not exist there. */
export const VALIDATE_LOCALITY_ONLY = {
  result: {
    verdict: { inputGranularity: "PREMISE", validationGranularity: "LOCALITY", geocodeGranularity: "LOCALITY", hasUnconfirmedComponents: true },
    address: {
      postalAddress: { regionCode: "IT", postalCode: "40121", locality: "Bologna", addressLines: ["Via Inesistente 99"] },
      addressComponents: [
        { componentName: { text: "Via Inesistente" }, componentType: "route", confirmationLevel: "UNCONFIRMED_BUT_PLAUSIBLE" },
        { componentName: { text: "99" }, componentType: "street_number", confirmationLevel: "UNCONFIRMED_BUT_PLAUSIBLE" },
        { componentName: { text: "Bologna" }, componentType: "locality", confirmationLevel: "CONFIRMED" },
        { componentName: { text: "40121" }, componentType: "postal_code", confirmationLevel: "CONFIRMED" },
      ],
      unconfirmedComponentTypes: ["route", "street_number"],
    },
  },
};

export const AUTOCOMPLETE = {
  suggestions: [
    { placePrediction: { place: "places/ChIJ-roma-1", placeId: "ChIJ-roma-1", text: { text: "Via Roma, 1, Milano, MI, Italia" }, structuredFormat: { mainText: { text: "Via Roma, 1" }, secondaryText: { text: "Milano, MI, Italia" } }, types: ["street_address", "geocode"] } },
    { placePrediction: { place: "places/ChIJ-roma-2", placeId: "ChIJ-roma-2", text: { text: "Via Roma, 1, Torino, TO, Italia" }, types: ["street_address", "geocode"] } },
    { queryPrediction: { text: { text: "via roma 1 pizzeria" } } },
  ],
};

export const PLACE_DETAILS: Record<string, unknown> = {
  "ChIJ-roma-1": {
    id: "ChIJ-roma-1",
    formattedAddress: "Via Roma, 1, 20121 Milano MI, Italia",
    addressComponents: [
      { longText: "1", shortText: "1", types: ["street_number"] },
      { longText: "Via Roma", shortText: "Via Roma", types: ["route"] },
      { longText: "Milano", shortText: "Milano", types: ["locality", "political"] },
      { longText: "Città Metropolitana di Milano", shortText: "MI", types: ["administrative_area_level_2", "political"] },
      { longText: "Lombardia", shortText: "Lombardia", types: ["administrative_area_level_1", "political"] },
      { longText: "Italia", shortText: "IT", types: ["country", "political"] },
      { longText: "20121", shortText: "20121", types: ["postal_code"] },
    ],
  },
  "ChIJ-roma-2": {
    id: "ChIJ-roma-2",
    formattedAddress: "Via Roma, 1, 10121 Torino TO, Italia",
    addressComponents: [
      { longText: "1", shortText: "1", types: ["street_number"] },
      { longText: "Via Roma", shortText: "Via Roma", types: ["route"] },
      { longText: "Torino", shortText: "Torino", types: ["locality", "political"] },
      { longText: "Città Metropolitana di Torino", shortText: "TO", types: ["administrative_area_level_2", "political"] },
      { longText: "Italia", shortText: "IT", types: ["country", "political"] },
      { longText: "10121", shortText: "10121", types: ["postal_code"] },
    ],
  },
  "ChIJ-us-1": {
    id: "ChIJ-us-1",
    formattedAddress: "350 5th Ave, New York, NY 10118, USA",
    addressComponents: [
      { longText: "350", shortText: "350", types: ["street_number"] },
      { longText: "5th Avenue", shortText: "5th Ave", types: ["route"] },
      { longText: "Suite 300", shortText: "Suite 300", types: ["subpremise"] },
      { longText: "New York", shortText: "New York", types: ["locality", "political"] },
      { longText: "New York", shortText: "NY", types: ["administrative_area_level_1", "political"] },
      { longText: "United States", shortText: "US", types: ["country", "political"] },
      { longText: "10118", shortText: "10118", types: ["postal_code"] },
    ],
  },
};

export const ERRORS = {
  keyInvalid: { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "addressvalidation.googleapis.com" } }] } } },
  serviceDisabled: { status: 403, body: { error: { code: 403, message: "Address Validation API has not been used in project 123456789 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }] } } },
  rateLimited: { status: 429, headers: { "retry-after": "1" }, body: { error: { code: 429, message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.", status: "RESOURCE_EXHAUSTED" } } },
  badRequest: { status: 400, body: { error: { code: 400, message: "Address lines are too long.", status: "INVALID_ARGUMENT" } } },
};
