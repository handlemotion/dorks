import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { cloud, normalizeCode, parsePairUrl, sameCloud } from "@/lib/cloud";
import { errorText } from "@/lib/format";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

/**
 * Pair a Mac: scan the QR code its Settings show (`dorks://pair?code=…&cloud=…`), or type the code. The deep link opens this page
 * with the code filled in, and claims it at once.
 */
export default function PairScreen() {
  const c = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; cloud?: string }>();
  const { token, refresh, select } = useMacs();
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState(params.code ? normalizeCode(params.code) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const claimed = useRef(false);

  const claim = async (raw: string, cloudUrl: string | null = null) => {
    if (claimed.current || busy) return;
    if (!sameCloud(cloudUrl)) return setError("Code is for another Dorks Cloud");
    const value = normalizeCode(raw);
    if (value.length < 8) return setError("Code is 8 characters");
    claimed.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const { macId } = await cloud.claim(token, value);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refresh();
      select(macId);
      router.dismissTo("/");
    } catch (e) {
      claimed.current = false;
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (params.code) void claim(params.code, params.cloud ?? null);
    // Only the code the link opened with; a scan or a typed code claims on its own.
  }, [params.code]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.background }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={[s.title, { color: c.text }]}>Pair a Mac</Text>
      <View style={[s.camera, { backgroundColor: c.fill }]}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              busy
                ? undefined
                : ({ data }) => {
                    const pair = parsePairUrl(data);
                    if (pair) void claim(pair.code, pair.cloud);
                  }
            }
          />
        ) : (
          <Pressable onPress={() => void requestPermission()} style={s.allow}>
            <Text style={[s.detail, { color: c.text }]}>{permission?.canAskAgain === false ? "Allow camera in Settings" : "Allow camera"}</Text>
          </Pressable>
        )}
      </View>
      <View style={s.row}>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="ABCD-2345"
          placeholderTextColor={c.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={() => void claim(code)}
          style={[s.input, { color: c.text, backgroundColor: c.fill }]}
        />
        <Pressable disabled={busy || !code} onPress={() => void claim(code)} style={[s.button, { backgroundColor: c.text, opacity: busy || !code ? 0.4 : 1 }]}>
          {busy ? <ActivityIndicator color={c.background} /> : <Text style={[s.buttonText, { color: c.background }]}>Pair</Text>}
        </Pressable>
      </View>
      {error && <Text style={[s.detail, { color: c.danger }]}>{error}</Text>}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 20, paddingTop: 28, gap: 14 },
  title: { fontSize: 20, fontWeight: "500" },
  detail: { fontSize: size.small, lineHeight: 18 },
  camera: { aspectRatio: 1, borderRadius: 16, overflow: "hidden" },
  allow: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  row: { flexDirection: "row", gap: 8 },
  input: { flex: 1, height: 44, borderRadius: radius.control, paddingHorizontal: 12, fontSize: 17, letterSpacing: 2, fontFamily: size.mono },
  button: { height: 44, minWidth: 72, borderRadius: radius.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  buttonText: { fontSize: size.ui, fontWeight: "500" },
});
