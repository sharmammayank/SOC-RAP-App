export type ThemePref = "system" | "light" | "dark";
const KEY = "socrap.theme";

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function applyTheme(pref: ThemePref = getTheme()) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* not persisted */
  }
  applyTheme(pref);
}
/** Resolved theme, for canvas and chart colours. */
export const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};
export const cssVar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
