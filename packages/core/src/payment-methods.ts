/** Normalised payment methods, in a module of their own so client code that lists them loads no schema code (zod). */
export const PAYMENT_METHODS = ["card", "wallet", "bank_transfer", "cod", "bnpl", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
