import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { authClient } from "@/lib/auth";
import { sendEmailOtp, signInWithApple, signInWithGoogle, useAction, useSignInMethods, verifyEmailOtp, type SignInMethods } from "@/lib/signIn";
import { useSplashDone } from "@/lib/splash";
import { useColors, useIsDark } from "@/lib/theme";

type Step = "choose" | "email" | "code";
type Social = "google" | "apple";

const mark = { light: require("../../assets/splash.png"), dark: require("../../assets/splash-dark.png") };
const google = require("../../assets/sign-in/google.png");
const apple = require("../../assets/sign-in/apple.png");

/** Sign-in, ported from Wok's iOS app: Google, Apple (native) or a 6-digit email code, on one screen in three steps. */
export default function SignIn() {
  const c = useColors();
  const dark = useIsDark();
  const session = authClient.useSession();
  const methods = useSignInMethods();
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [activeSocial, setActiveSocial] = useState<Social | null>(null);

  const social = useAction(
    (provider: Social) => {
      setActiveSocial(provider);
      return provider === "google" ? signInWithGoogle() : signInWithApple();
    },
    { onError: () => setActiveSocial(null), onSuccess: () => setActiveSocial(null) },
  );
  const sendOtp = useAction((address: string) => sendEmailOtp(address), {
    onSuccess: () => {
      setOtp("");
      setStep("code");
    },
  });
  const verifyOtp = useAction((address: string, code: string) => verifyEmailOtp(address, code));

  useSplashDone();

  const finishingSocial = activeSocial !== null && (social.isPending || session.isPending);
  const finishingOtp = verifyOtp.isPending || (verifyOtp.isSuccess && session.isPending);
  const busy = finishingSocial || sendOtp.isPending || finishingOtp;
  const errorText = { choose: social.error?.message, email: sendOtp.error?.message, code: verifyOtp.error?.message }[step];

  const submitEmail = () => {
    const trimmed = email.trim();
    if (trimmed && !busy) sendOtp.run(trimmed);
  };
  const submitCode = (value = otp) => {
    const trimmed = value.trim();
    if (trimmed.length === 6 && !busy) verifyOtp.run(email.trim(), trimmed);
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.welcome }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.body}>
        <View style={styles.hero}>
          <Image source={dark ? mark.dark : mark.light} style={styles.mark} contentFit="contain" accessible={false} />
          <Text accessibilityRole="header" maxFontSizeMultiplier={1.6} style={[styles.title, { color: c.text }]}>
            {step === "code" ? "Enter code" : "Sign in to Dorks"}
          </Text>
          {step === "code" ? (
            <Text maxFontSizeMultiplier={1.6} style={[styles.subhead, { color: c.muted }]}>
              {email.trim()}
            </Text>
          ) : null}
        </View>
        <View style={styles.footer}>
          {errorText ? (
            <Text maxFontSizeMultiplier={1.6} style={[styles.small, { color: c.danger }]}>
              {errorText}
            </Text>
          ) : null}
          {step === "choose" ? (
            <ChooseStep busy={busy} activeSocial={finishingSocial ? activeSocial : null} methods={methods} onSocial={(provider) => social.run(provider)} onEmail={() => setStep("email")} />
          ) : step === "email" ? (
            <EmailStep email={email} busy={busy} pending={sendOtp.isPending} onChange={setEmail} onSubmit={submitEmail} onBack={() => setStep("choose")} />
          ) : (
            <CodeStep
              otp={otp}
              busy={busy}
              pending={finishingOtp}
              onChange={(digits) => {
                setOtp(digits);
                if (digits.length === 6) submitCode(digits);
              }}
              onSubmit={() => submitCode()}
              onResend={() => sendOtp.run(email.trim())}
              onBack={() => {
                setOtp("");
                setStep("email");
              }}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ChooseStep(props: { busy: boolean; activeSocial: Social | null; methods?: SignInMethods; onSocial: (provider: Social) => void; onEmail: () => void }) {
  const c = useColors();
  return (
    <>
      <View style={styles.actions}>
        <Button
          intent="outline"
          size="lg"
          icon={({ size }) => <Image source={google} style={{ width: size, height: size }} accessible={false} />}
          label="Continue with Google"
          isPending={props.activeSocial === "google"}
          disabled={props.busy || props.methods?.google === false}
          onPress={() => props.onSocial("google")}
        />
        <Button
          intent="outline"
          size="lg"
          icon={({ size, color }) => <Image source={apple} tintColor={color} style={{ width: size, height: size }} accessible={false} />}
          label="Sign in with Apple"
          isPending={props.activeSocial === "apple"}
          disabled={props.busy || props.methods?.apple === false}
          onPress={() => props.onSocial("apple")}
        />
        <Button
          intent="outline"
          size="lg"
          icon={({ size, color }) => <SymbolView name="envelope" size={size} tintColor={color} weight="regular" />}
          label="Continue with email"
          disabled={props.busy || props.methods?.email === false}
          onPress={props.onEmail}
        />
      </View>
      <Text maxFontSizeMultiplier={1.6} style={[styles.legal, { color: c.subtle }]}>
        By continuing, you agree to our Terms of Service and Privacy Policy.
      </Text>
    </>
  );
}

function EmailStep(props: { email: string; busy: boolean; pending: boolean; onChange: (value: string) => void; onSubmit: () => void; onBack: () => void }) {
  return (
    <View style={styles.actions}>
      <TextField
        label="Email"
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="go"
        autoFocus
        value={props.email}
        onChangeText={props.onChange}
        onSubmitEditing={props.onSubmit}
      />
      <Button size="lg" label="Continue" isPending={props.pending} disabled={!props.email.trim() || props.busy} onPress={props.onSubmit} />
      <Button intent="quiet" size="sm" label="Back" disabled={props.busy} onPress={props.onBack} style={styles.centeredButton} />
    </View>
  );
}

function CodeStep(props: { otp: string; busy: boolean; pending: boolean; onChange: (digits: string) => void; onSubmit: () => void; onResend: () => void; onBack: () => void }) {
  return (
    <View style={styles.actions}>
      <TextField
        label="6-digit code"
        placeholder="000000"
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        value={props.otp}
        onChangeText={(next) => props.onChange(next.replace(/\D/g, "").slice(0, 6))}
        onSubmitEditing={props.onSubmit}
        style={styles.otpInput}
      />
      <Button size="lg" label="Sign in" isPending={props.pending} disabled={props.otp.length < 6 || props.busy} onPress={props.onSubmit} />
      <View style={styles.codeLinks}>
        <Button intent="quiet" size="sm" label="Resend" disabled={props.busy} onPress={props.onResend} />
        <Button intent="quiet" size="sm" label="Back" disabled={props.busy} onPress={props.onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 22, paddingBottom: 24 },
  mark: { width: 40, height: 40 },
  title: { fontSize: 25, lineHeight: 31, letterSpacing: -0.4, fontWeight: "500", textAlign: "center" },
  subhead: { fontSize: 14, lineHeight: 19, textAlign: "center" },
  small: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  legal: { fontSize: 11, lineHeight: 15, textAlign: "center", paddingHorizontal: 16 },
  footer: { gap: 18 },
  actions: { gap: 10 },
  centeredButton: { alignSelf: "center" },
  otpInput: { textAlign: "center", letterSpacing: 6 },
  codeLinks: { flexDirection: "row", justifyContent: "center", gap: 24 },
});
