import * as AppleAuthentication from "expo-apple-authentication";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/Button";
import { authClient } from "@/lib/auth";
import { signInWithApple, signInWithGoogle, useAction, useSignInMethods } from "@/lib/signIn";
import { useSplashDone } from "@/lib/splash";
import { fonts, useColors, useIsDark } from "@/lib/theme";

type Social = "google" | "apple";

const mark = { light: require("../../assets/splash.png"), dark: require("../../assets/splash-dark.png") };
const google = require("../../assets/sign-in/google.png");

/** Sign-in: Apple first (Apple's own button, filled), then Google and email; email pushes the email and code pages. */
export default function SignIn() {
  const c = useColors();
  const dark = useIsDark();
  const session = authClient.useSession();
  const methods = useSignInMethods();
  const [activeSocial, setActiveSocial] = useState<Social | null>(null);
  const social = useAction(
    (provider: Social) => {
      setActiveSocial(provider);
      return provider === "google" ? signInWithGoogle() : signInWithApple();
    },
    { onError: () => setActiveSocial(null), onSuccess: () => setActiveSocial(null) },
  );

  useSplashDone();

  const finishing = activeSocial !== null && (social.isPending || session.isPending);
  const pending = finishing ? activeSocial : null;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.welcome }]} edges={["top", "bottom"]}>
      <View style={styles.hero}>
        <Image source={dark ? mark.dark : mark.light} style={styles.mark} contentFit="contain" accessible={false} />
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} style={[styles.title, { color: c.text }]}>
          Sign in to Dorks
        </Text>
      </View>
      <View style={styles.footer}>
        {social.error ? (
          <Text maxFontSizeMultiplier={1.4} style={[styles.error, { color: c.danger }]}>
            {social.error.message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <AppleButton pending={pending === "apple"} disabled={finishing || methods?.apple === false} onPress={() => social.run("apple")} />
          <Button
            intent="outline"
            size="lg"
            icon={({ size }) => <Image source={google} style={{ width: size, height: size }} accessible={false} />}
            label="Continue with Google"
            isPending={pending === "google"}
            disabled={finishing || methods?.google === false}
            onPress={() => social.run("google")}
          />
          <Button
            intent="outline"
            size="lg"
            icon={({ size, color }) => <SymbolView name="envelope" size={size} tintColor={color} weight="regular" />}
            label="Continue with email"
            disabled={finishing || methods?.email === false}
            onPress={() => router.push("/sign-in-email")}
          />
        </View>
        <Text maxFontSizeMultiplier={1.4} style={[styles.legal, { color: c.subtle }]}>
          {"By continuing, you agree to our\nTerms of Service and Privacy Policy."}
        </Text>
      </View>
    </SafeAreaView>
  );
}

/** Apple's own button (its glyph and wording at Apple's sizes), filled black, white in dark mode, with our spinner over it while it signs in. */
function AppleButton({ pending, disabled, onPress }: { pending: boolean; disabled: boolean; onPress: () => void }) {
  const dark = useIsDark();
  return (
    <View pointerEvents={disabled ? "none" : "auto"} style={[styles.apple, disabled && !pending ? styles.dimmed : null]}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={24}
        style={styles.apple}
        onPress={onPress}
      />
      {pending ? (
        <View style={[styles.applePending, { backgroundColor: dark ? "#ffffff" : "#000000" }]}>
          <ActivityIndicator color={dark ? "#000000" : "#ffffff"} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
  // The mark and title sit on the screen's optical centre, a little above the middle.
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20, paddingBottom: 32 },
  mark: { width: 44, height: 44 },
  title: { fontFamily: fonts.semibold, fontSize: 26, lineHeight: 32, letterSpacing: -0.6, textAlign: "center" },
  error: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, textAlign: "center" },
  footer: { gap: 18 },
  actions: { gap: 10 },
  apple: { height: 48, width: "100%" },
  applePending: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  dimmed: { opacity: 0.5 },
  legal: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, textAlign: "center" },
});
