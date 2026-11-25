import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

const SPLASH_MAX_MS = 10_000;

let hidden = false;
function hide() {
  if (hidden) return;
  hidden = true;
  void SplashScreen.hideAsync().catch(() => {});
}

/** Holds the launch screen until the app's first real screen can draw. Call once, at the root. */
export function holdSplash() {
  void SplashScreen.preventAutoHideAsync().catch(() => {});
  SplashScreen.setOptions({ fade: true, duration: 200 });
  setTimeout(hide, SPLASH_MAX_MS);
}

/** Lets the launch screen go once `ready`: a screen calls it when it has something to show. */
export function useSplashDone(ready = true) {
  useEffect(() => {
    if (ready) hide();
  }, [ready]);
}
