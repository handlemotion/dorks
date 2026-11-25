import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/Button";
import { CodeBoxes, SignInPage } from "@/components/SignInPage";
import { authClient } from "@/lib/auth";
import { sendEmailOtp, useAction, verifyEmailOtp } from "@/lib/signIn";
import { fonts, useColors } from "@/lib/theme";

const RESEND_AFTER_S = 30;

/** Email sign-in, step 2: the 6-digit code. It signs in as soon as the sixth digit lands; Resend unlocks after 30 s. */
export default function SignInCode() {
  const c = useColors();
  const { email = "" } = useLocalSearchParams<{ email?: string }>();
  const session = authClient.useSession();
  const [code, setCode] = useState("");
  const [wait, setWait] = useState(RESEND_AFTER_S);
  const verify = useAction((otp: string) => verifyEmailOtp(email, otp));
  const resend = useAction(() => sendEmailOtp(email), {
    onSuccess: () => {
      setCode("");
      setWait(RESEND_AFTER_S);
    },
  });

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const finishing = verify.isPending || (verify.isSuccess && session.isPending);
  const submit = (value = code) => {
    if (value.length === 6 && !finishing) verify.run(value);
  };
  const error = verify.error?.message ?? resend.error?.message;

  return (
    <SignInPage
      title="Enter code"
      detail={
        <>
          {"We sent a 6-digit code to "}
          <Text style={[styles.strong, { color: c.text }]}>{email}</Text>
        </>
      }
      footer={<Button size="lg" label="Continue" isPending={finishing} disabled={code.length < 6} onPress={() => submit()} />}
    >
      <CodeBoxes
        value={code}
        invalid={!!verify.error && code.length === 6}
        onChange={(digits) => {
          setCode(digits);
          if (verify.error) verify.reset();
          if (digits.length === 6) submit(digits);
        }}
        onSubmit={() => submit()}
      />
      {error ? <Text style={[styles.small, { color: c.danger }]}>{error}</Text> : null}
      <View style={styles.resend}>
        {wait > 0 ? (
          <Text style={[styles.small, { color: c.subtle }]}>{`Resend code in 00:${String(wait).padStart(2, "0")}`}</Text>
        ) : (
          <Button intent="quiet" size="sm" label="Resend code" isPending={resend.isPending} onPress={() => resend.run()} />
        )}
      </View>
    </SignInPage>
  );
}

const styles = StyleSheet.create({
  strong: { fontFamily: fonts.medium },
  small: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 19 },
  resend: { minHeight: 36, justifyContent: "center" },
});
