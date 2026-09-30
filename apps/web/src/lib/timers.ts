/**
 * GM timer-form helpers — minutes (form string) → seconds for game config.
 *
 * The GM lobby collects MINUTES ("5" = 5 minutes) but game config stores
 * SECONDS, so the string is parsed and multiplied by 60. A garbage input
 * returns undefined = "use the server default" (the field is simply omitted
 * from the POST body). "0" is a meaningful value (untimed) and passes
 * through as 0.
 */
export function minutesToSeconds(minutes: string): number | undefined {
  const trimmed = minutes.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed) * 60;
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}