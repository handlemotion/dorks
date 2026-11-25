import { router } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { Button } from "@/components/Button";
import { SignInPage } from "@/components/SignInPage";
import { TextField } from "@/components/TextField";
import { sendEmailOtp, useAction } from "@/lib/signIn";
import { fonts, useColors } from "@/lib/theme";

/** Email sign-in, step 1: the address. Continue sends a 6-digit code and pushes the code page. */
export default function SignInEmail() {
  const c = useColors();
  const [email, setEmail] = useState("");
  // The address the code went to: the field may change while the request is in flight, the code page must not.
  const sentTo = useRef("");
  const send = useAction(
    (address: string) => {
      sentTo.current = address;
      return sendEmailOtp(address);
    },
    { onSuccess: () => router.push({ pathname: "/sign-in-code", params: { email: sentTo.current } }) },
  );
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());
  const submit = () => {
    if (valid && !send.isPending) send.run(email.trim());
  };
  return (
    <SignInPage
      title="Enter your email"
      detail="We'll send you a 6-digit code to sign in."
      footer={<Button size="lg" label="Continue" isPending={send.isPending} disabled={!valid} onPress={submit} />}
    >
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
        editable={!send.isPending}
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={submit}
      />
      {send.error ? <Text style={[styles.error, { color: c.danger }]}>{send.error.message}</Text> : null}
    </SignInPage>
  );
}

const styles = StyleSheet.create({
  error: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
});
