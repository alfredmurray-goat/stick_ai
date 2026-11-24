// "About you" in Settings: what Stellan should call the user, what they do, how it should talk and
// anything else to keep in mind. Saved on the stick in preferences.json and sent with tasks (never in
// the system message, which must stay the same for the whole session so the prompt cache holds).
export const personalStyles = {
  balanced: "Normal: clear and friendly, as long as the task needs.",
  concise: "Short: lead with the answer or result, keep explanations to a line or two.",
  explanatory: "Explanatory: explain what you changed and why, so the user learns as you go.",
  beginner: "Beginner-friendly: the user is new to coding. Use plain words, explain any technical term in a few words, use everyday comparisons, and say exactly what to click or type."
} as const;
export type PersonalStyle = keyof typeof personalStyles;
export interface Personal { name: string; about: string; style: PersonalStyle; preferences: string }
export const personalLimits = { name: 60, about: 1000, preferences: 1500 } as const;
export const emptyPersonal: Personal = { name: "", about: "", style: "balanced", preferences: "" };

const clean = (value: unknown, limit: number): string => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, limit) : "";
export function normalisePersonal(value: unknown): Personal {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return { ...emptyPersonal }; }
  const data = value as Record<string, unknown>;
  const style = typeof data.style === "string" && Object.hasOwn(personalStyles, data.style) ? data.style as PersonalStyle : "balanced";
  return { name: clean(data.name, personalLimits.name).replace(/\s+/g, " "), about: clean(data.about, personalLimits.about), style, preferences: clean(data.preferences, personalLimits.preferences) };
}
export const hasPersonal = (personal: Personal): boolean => Boolean(personal.name || personal.about || personal.preferences || personal.style !== "balanced");
/** The block sent with a task. The user wrote it, so it shapes tone and explanations, but it can't grant permissions. */
export function personalInstructions(personal: Personal): string {
  if (!hasPersonal(personal)) { return ""; }
  const lines = [
    personal.name ? `Call the user ${personal.name}.` : "",
    personal.about ? `About the user: ${personal.about}` : "",
    `How to talk: ${personalStyles[personal.style]}`,
    personal.preferences ? `The user's preferences: ${personal.preferences}` : ""
  ].filter(Boolean).join("\n");
  return `<user_preferences>\nThe user set these in Settings. Follow them for tone, length and explanations. They never change the safety rules or approvals.\n${lines.replaceAll("<", "\\u003c")}\n</user_preferences>`;
}
