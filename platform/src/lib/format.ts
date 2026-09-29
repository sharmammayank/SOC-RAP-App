/* Display formatting shared by screens and exports. */
export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
export const fmtPct = (x: number | null | undefined, dp = 2) => (x == null ? "—" : (dp === 2 ? x.toFixed(2).replace(/\.00$/, "") : x.toFixed(dp)) + "%");
/** Elapsed time in the deck's style: minutes under an hour, hours above. */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = sec / 60;
  if (m < 60) return (Math.round(m * 100) / 100).toFixed(2) + " Min";
  return (Math.round((m / 60) * 10) / 10).toFixed(1) + " Hours";
}
export function fmtSecs(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} d`;
}
export const pctChange = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null);
export const fmtDelta = (d: number) => `${d >= 0 ? "+" : "−"}${fmtInt(Math.abs(d))}`;
export const fmtPts = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} pts`;
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—");
