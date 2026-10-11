/** Work with civil dates explicitly so server timezone cannot change reminders. */
export function civilDate(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function resolveDateExpression(expression: string | null | undefined, timezone: string, now = new Date()): string | null {
  if (!expression) return null;
  let value = expression.toLowerCase().trim();
  const malay: Record<string, string> = { "hari ini": "today", "esok": "tomorrow", "lusa": "in 2 days", "ahad": "sunday", "isnin": "monday", "selasa": "tuesday", "rabu": "wednesday", "khamis": "thursday", "jumaat": "friday", "sabtu": "saturday" };
  value = malay[value] ?? value;
  const nextMalay = /^(?:hari )?(ahad|isnin|selasa|rabu|khamis|jumaat|sabtu) (?:depan|akan datang)$/.exec(value);
  if (nextMalay) value = "next " + malay[nextMalay[1]];
  const daysMalay = /^(?:dalam )?(\d{1,3}) hari(?: lagi)?$/.exec(value);
  if (daysMalay) value = "in " + daysMalay[1] + " days";
  if (validDateSafe(value)) return value;
  const today = new Date(`${civilDate(now, timezone)}T12:00:00Z`);
  let offset: number | undefined;
  if (value === "today") offset = 0;
  if (value === "tomorrow") offset = 1;
  const days = /^(?:in )?(\d{1,3}) days?(?: from now)?$/.exec(value);
  if (days) offset = Number(days[1]);
  const weekday = /^(?:(next|this|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(value);
  if (weekday) {
    const index = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday[2]);
    offset = (index - today.getUTCDay() + 7) % 7;
    if (offset === 0 && weekday[1] !== "this") offset = 7;
  }
  if (offset === undefined) return null;
  today.setUTCDate(today.getUTCDate() + offset);
  return today.toISOString().slice(0, 10);
}
export function validDateSafe(value: string) { try { return validDate(value); } catch { return false; } }
export function dueDateInZone(value: string, timezone: string): Date {
  if (!validDateSafe(value)) throw new Error("Choose a valid calendar date");
  const desired = Date.parse(`${value}T09:00:00Z`);
  let guess = desired;
  // Two passes account for timezone offsets and DST. 09:00 avoids overnight DST gaps.
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const p = (name: string) => parts.find(x => x.type === name)!.value;
    const seen = Date.parse(`${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}Z`);
    guess += desired - seen;
  }
  return new Date(guess);
}
