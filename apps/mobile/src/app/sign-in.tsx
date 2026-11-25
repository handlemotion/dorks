import * as AppleAuthentication from "expo-apple-authentication";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { authClient } from "@/lib/auth";
import { DEV_PASSWORD } from "@/lib/config";
import { errorText } from "@/lib/format";
import { radius, type as size, useColors, useIsDark } from "@/lib/theme";

/** Sign in with Apple, natively: Apple's ID token goes to Better Auth on the relay, which makes the session. */
async function signInWithApple() {
  const credential = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL, AppleAuthentication.AppleAuthenticationScope.FULL_NAME] });
  if (!credential.identityToken) throw new Error("Apple did not return an identity token.");
  const { error } = await authClient.signIn.social({ provider: "apple", idToken: { token: credential.identityToken } });
  if (error) throw new Error(error.message ?? "Sign in failed.");
}

/** Email and password, for the simulator only (EXPO_PUBLIC_DEV_PASSWORD=1): signs in, or creates the account the first time. */
function DevPassword({ onError }: { onError: (e?: string) => void }) {
  const c = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    onError(undefined);
    const signIn = await authClient.signIn.email({ email, password });
    if (signIn.error) {
      const signUp = await authClient.signUp.email({ email, password, name: email.split("@")[0] });
      if (signUp.error) onError(signIn.error.message ?? "Sign in failed.");
    }
    setBusy(false);
  };
  const field = [s.input, { color: c.text, backgroundColor: c.fill }];
  return (
    <View style={s.dev}>
      <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={c.muted} autoCapitalize="none" keyboardType="email-address" style={field} />
      <TextInput value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={c.muted} secureTextEntry style={field} />
      <Pressable disabled={busy} onPress={() => void submit()} style={[s.button, { backgroundColor: c.fill }]}>
        {busy ? <ActivityIndicator color={c.muted} /> : <Text style={[s.buttonText, { color: c.text }]}>Sign in with email</Text>}
      </Pressable>
    </View>
  );
}

export default function SignIn() {
  const c = useColors();
  const dark = useIsDark();
  const [error, setError] = useState<string>();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <View style={s.center}>
        <Text style={[s.title, { color: c.text }]}>Dorks</Text>
      </View>
      <View style={s.actions}>
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={radius.control}
          style={s.apple}
          onPress={() =>
            void signInWithApple().catch((e: { code?: string }) => {
              if (e.code !== "ERR_REQUEST_CANCELED") setError(errorText(e));
            })
          }
        />
        {DEV_PASSWORD && <DevPassword onError={setError} />}
        {error && <Text style={[s.detail, { color: c.danger }]}>{error}</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 34, fontWeight: "500" },
  detail: { fontSize: size.ui, textAlign: "center" },
  actions: { paddingHorizontal: 24, paddingBottom: 56, gap: 12 },
  apple: { height: 50 },
  dev: { gap: 8, paddingTop: 12 },
  input: { height: 44, borderRadius: radius.control, paddingHorizontal: 12, fontSize: size.ui },
  button: { height: 44, borderRadius: radius.control, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: size.ui, fontWeight: "500" },
});
