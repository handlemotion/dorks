import { useColorScheme } from "react-native";

// DESIGN.md on a phone: flat, no shadows, hairlines only where fill cannot separate, 6px controls (native glass keeps its own shapes),
// 400 and 500 weights only. The theme follows the phone's light or dark setting.

const light = {
  background: "#ffffff",
  /** The sidebar under the sliding app, and filled rows. */
  app: "#f2f2f2",
  /** A raised card on the page: the merge card. */
  card: "#f5f5f5",
  text: "#0a0a0a",
  muted: "#737373",
  hairline: "rgba(0,0,0,0.06)",
  fill: "rgba(0,0,0,0.04)",
  selected: "rgba(0,0,0,0.07)",
  userBubble: "#f2f2f2",
  userBubbleText: "#0a0a0a",
  brand: "#3b6be8",
  onBrand: "#ffffff",
  /** The slide-to-merge knob. */
  merge: "#6670e0",
  danger: "#dc2626",
  open: "#1a7f37",
  merged: "#8250df",
  closed: "#cf222e",
  draft: "#737373",
  /** Sign-in (ported from Wok's iOS sign-in): its canvas, raised controls, their edge, quiet ink and the primary button. */
  welcome: "#fafafa",
  surface: "#ffffff",
  border: "#e8e8e8",
  subtle: "#a6a6a6",
  primary: "#1d72e8",
  primaryButton: "#1a7ef5",
};

const dark: typeof light = {
  background: "#0a0a0a",
  app: "#171717",
  card: "#1f1f1f",
  text: "#fafafa",
  muted: "#a1a1a1",
  hairline: "rgba(255,255,255,0.07)",
  fill: "rgba(255,255,255,0.06)",
  selected: "rgba(255,255,255,0.1)",
  userBubble: "#ffffff",
  userBubbleText: "#0a0a0a",
  brand: "#3b6be8",
  onBrand: "#ffffff",
  merge: "#6670e0",
  danger: "#f87171",
  open: "#3fb950",
  merged: "#a371f7",
  closed: "#f85149",
  draft: "#a1a1a1",
  welcome: "#0a0a0a",
  surface: "#171717",
  border: "rgba(255,255,255,0.1)",
  subtle: "#737373",
  primary: "#1d72e8",
  primaryButton: "#1a7ef5",
};

export type Colors = typeof light;

export const radius = { control: 6, bubble: 10 };
export const type = { message: 16, ui: 15, small: 13, mono: "Menlo" };

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

export function useIsDark(): boolean {
  return useColorScheme() === "dark";
}

/** A pull request's state colour, as everywhere in Dorks: open green, draft grey, merged violet, closed red; unknown is grey. */
export function prColor(c: Colors, state: "open" | "merged" | "closed" | undefined, draft?: boolean): string {
  if (state === "merged") return c.merged;
  if (state === "closed") return c.closed;
  if (state === "open") return draft ? c.draft : c.open;
  return c.draft;
}
