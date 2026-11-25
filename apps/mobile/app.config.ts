import type { ConfigContext, ExpoConfig } from "expo/config";

// The EAS project (Expo account handleui): EAS Build, Submit and Update. EAS_PROJECT_ID overrides it for a fork.
const EAS_PROJECT_ID = "cd31db4c-476f-4e2f-ba1e-27368794b2fe";

export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EAS_PROJECT_ID || EAS_PROJECT_ID;
  return {
    ...config,
    name: "Dorks",
    slug: "dorks",
    owner: "handleui",
    scheme: "dorks",
    version: "0.1.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    platforms: ["ios"],
    ios: {
      bundleIdentifier: "build.dorks.ios",
      icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png", tinted: "./assets/icon-tinted.png" },
      supportsTablet: false,
      usesAppleSignIn: true,
      config: { usesNonExemptEncryption: false },
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-apple-authentication",
      "expo-web-browser",
      [
        "expo-splash-screen",
        { image: "./assets/splash.png", imageWidth: 96, resizeMode: "contain", backgroundColor: "#ffffff", dark: { image: "./assets/splash-dark.png", backgroundColor: "#0a0a0a" } },
      ],
      ["expo-camera", { cameraPermission: "Dorks uses the camera to scan the pairing code your Mac shows.", microphonePermission: false, recordAudioAndroid: false }],
      ["expo-image-picker", { photosPermission: "Dorks attaches the photos you pick to your messages.", cameraPermission: false, microphonePermission: false }],
      "expo-updates",
    ],
    runtimeVersion: { policy: "fingerprint" },
    ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}` } } : {}),
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  };
};
