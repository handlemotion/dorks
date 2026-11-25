import type { ConfigContext, ExpoConfig } from "expo/config";

// The EAS project id: `eas init` prints it; set EAS_PROJECT_ID (or extra.eas.projectId) and EAS Update turns on. Until then the
// app builds and runs without updates.
export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EAS_PROJECT_ID || (config.extra?.eas as { projectId?: string } | undefined)?.projectId;
  return {
    ...config,
    name: "Dorks",
    slug: "dorks",
    scheme: "dorks",
    version: "0.1.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    platforms: ["ios"],
    ios: {
      bundleIdentifier: "build.dorks.ios",
      supportsTablet: false,
      usesAppleSignIn: true,
      config: { usesNonExemptEncryption: false },
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-apple-authentication",
      "expo-web-browser",
      ["expo-camera", { cameraPermission: "Dorks uses the camera to scan the pairing code your Mac shows.", microphonePermission: false, recordAudioAndroid: false }],
      ["expo-image-picker", { photosPermission: "Dorks attaches the photos you pick to your messages.", cameraPermission: false, microphonePermission: false }],
      "expo-updates",
    ],
    runtimeVersion: { policy: "fingerprint" },
    ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` } } : {}),
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  };
};
