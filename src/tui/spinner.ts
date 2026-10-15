/** Playful status words shown while the model is working. */

export const THINKING_STATUS_MESSAGES = [
  "Brewing…",
  "Calibrating…",
  "Conjuring…",
  "Contemplating…",
  "Cooking…",
  "Distilling…",
  "Dreaming…",
  "Fermenting…",
  "Germinating…",
  "Incubating…",
  "Marinating…",
  "Mulling…",
  "Noodling…",
  "Percolating…",
  "Pondering…",
  "Ruminating…",
  "Scheming…",
  "Synthesizing…",
  "Tinkering…",
  "Wrangling…",
] as const;

export function pickThinkingStatusMessage(
  random: () => number = Math.random,
): string {
  const index = Math.floor(random() * THINKING_STATUS_MESSAGES.length);
  return THINKING_STATUS_MESSAGES[index]!;
}
