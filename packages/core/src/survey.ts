import { z } from "zod";

/**
 * Post-purchase survey ("how did you hear about us?"). Each option maps to a channel key: click
 * channels (paid_social, organic_search…) where they overlap, plus channels clicks never see
 * (word of mouth, podcast, influencer, offline). Texts are per language, like the return portal.
 */
export const SURVEY_EXTRA_CHANNELS = ["word_of_mouth", "influencer", "podcast", "offline", "other"] as const;

const localized = z.record(z.string().min(2).max(5), z.string().trim().max(200));
export const surveyOptionSchema = z.object({
  key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/),
  labels: localized,
  channel: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/),
});
export const surveyConfigSchema = z.object({
  question: localized,
  thanks: localized,
  options: z.array(surveyOptionSchema).min(2).max(15),
  allowOther: z.boolean(),
  /** Share of an answered order credited to the answer in the survey-blend attribution model, in basis points. */
  blendBps: z.number().int().min(0).max(10_000),
});
export type SurveyConfig = z.infer<typeof surveyConfigSchema>;

export const DEFAULT_SURVEY_CONFIG: SurveyConfig = {
  question: { en: "How did you first hear about us?", it: "Come ci hai conosciuto?", es: "¿Cómo nos conociste?" },
  thanks: { en: "Thank you! Your answer helps us a lot.", it: "Grazie! La tua risposta ci aiuta molto.", es: "¡Gracias! Tu respuesta nos ayuda mucho." },
  options: [
    { key: "search", labels: { en: "Google or another search engine", it: "Google o un altro motore di ricerca", es: "Google u otro buscador" }, channel: "organic_search" },
    { key: "social_ad", labels: { en: "An ad on Instagram or Facebook", it: "Una pubblicità su Instagram o Facebook", es: "Un anuncio en Instagram o Facebook" }, channel: "paid_social" },
    { key: "social_post", labels: { en: "A post on social media", it: "Un post sui social", es: "Una publicación en redes sociales" }, channel: "social" },
    { key: "friend", labels: { en: "A friend or family member", it: "Un amico o un familiare", es: "Un amigo o familiar" }, channel: "word_of_mouth" },
    { key: "influencer", labels: { en: "An influencer or creator", it: "Un influencer o creator", es: "Un influencer o creador" }, channel: "influencer" },
    { key: "podcast", labels: { en: "A podcast", it: "Un podcast", es: "Un pódcast" }, channel: "podcast" },
    { key: "email", labels: { en: "Our newsletter", it: "La nostra newsletter", es: "Nuestra newsletter" }, channel: "email" },
  ],
  allowOther: true,
  blendBps: 5000,
};

/** Text in the requested language, then English, then any. */
export function surveyText(map: Record<string, string>, locale: string): string {
  return map[locale] ?? map[locale.slice(0, 2)] ?? map.en ?? Object.values(map)[0] ?? "";
}

export interface SurveyAnswerRow {
  answerChannel: string;
  clickChannel: string | null;
}

/**
 * Self-reported vs click-based: for each answer channel, how often the click data agreed, and
 * how many answers came from orders whose clicks say "direct" or nothing, i.e. demand the ad
 * platforms and analytics never saw.
 */
export function surveyCrosstab(rows: readonly SurveyAnswerRow[]): { channel: string; answers: number; agree: number; invisible: number }[] {
  const map = new Map<string, { channel: string; answers: number; agree: number; invisible: number }>();
  for (const r of rows) {
    const m = map.get(r.answerChannel) ?? { channel: r.answerChannel, answers: 0, agree: 0, invisible: 0 };
    m.answers++;
    if (r.clickChannel === r.answerChannel) m.agree++;
    if (!r.clickChannel || r.clickChannel === "direct" || r.clickChannel === "unknown") m.invisible++;
    map.set(r.answerChannel, m);
  }
  return [...map.values()].sort((a, b) => b.answers - a.answers);
}
