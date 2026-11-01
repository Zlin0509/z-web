export const MINUTE15 = 900000;
export const timeframeOf = value => value?.timeframe ?? '1d';
export function periodsPerYear(market, timeframe = '1d') {
  const days = market === 'crypto' ? 365 : 252;
  const barsPerDay = timeframe === '15m' ? (market === 'crypto' ? 96 : 26) : 1;
  return days * barsPerDay;
}
const ny = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
});
export function nyParts(time) {
  return Object.fromEntries(ny.formatToParts(new Date(time)).map(part => [part.type, part.value]));
}
export function regularSession(time) {
  const parts = nyParts(time);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !['Sat', 'Sun'].includes(parts.weekday) && minutes >= 570 && minutes < 960;
}
export function intradayGap(previous, next, market) {
  if (next - previous <= MINUTE15) return false;
  if (market === 'crypto') return true;
  const a = nyParts(previous), b = nyParts(next);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
