import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Button, Host, Image as UIImage, Menu } from "@expo/ui/swift-ui";
import { SymbolView } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { GlassCapsule } from "@/components/Glass";
import { errorText } from "@/lib/format";
import { uploadImage } from "@/lib/images";
import { useMacs } from "@/lib/macs";
import { radius, type as size, useColors } from "@/lib/theme";

type Attachment = { key: string; uri: string; name: string; id?: string; failed?: boolean };

/** The message with its images, the way the desktop writes it: `![name](dorks-image:<id>)` after the text. */
const withImages = (text: string, images: Attachment[]) =>
  [text.trim(), ...images.filter((i) => i.id).map((i) => `![${i.name.replace(/[[\]\n]/g, " ")}](dorks-image:${i.id})`)].filter(Boolean).join("\n\n");

/**
 * The glass composer: a + menu (photos, and `menu`: repository, model, build), the text, and a round button that sends, or stops
 * while the agent works and nothing is typed. While a turn runs, a tap sends now (steering it); a long press offers to queue it.
 */
export function Composer({
  busy,
  onSend,
  onQueue,
  onStop,
  above,
  menu,
}: {
  busy: boolean;
  onSend: (message: string) => Promise<unknown>;
  onQueue?: (message: string) => Promise<unknown>;
  onStop?: () => void;
  above?: ReactNode;
  /** Native submenus (@expo/ui/swift-ui) after Photos. */
  menu?: ReactNode;
}) {
  const c = useColors();
  const { mac, token } = useMacs();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const uploading = images.some((i) => !i.id && !i.failed);
  const ready = (text.trim().length > 0 || images.some((i) => i.id)) && !uploading && !sending;

  async function pick() {
    if (!mac) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 6, quality: 0.85 });
    if (picked.canceled) return;
    const added = picked.assets.map((a, n) => ({ key: `${Date.now()}-${n}`, uri: a.uri, name: a.fileName ?? "Image", mime: a.mimeType ?? "image/jpeg" }));
    setImages((xs) => [...xs, ...added.map(({ mime: _mime, ...a }) => a)]);
    for (const a of added) {
      uploadImage(mac.id, token, a.uri, a.mime).then(
        (id) => setImages((xs) => xs.map((x) => (x.key === a.key ? { ...x, id } : x))),
        (e) => {
          setError(errorText(e));
          setImages((xs) => xs.map((x) => (x.key === a.key ? { ...x, failed: true } : x)));
        },
      );
    }
  }

  async function deliver(how: (message: string) => Promise<unknown>) {
    const message = withImages(text, images);
    setSending(true);
    setError(undefined);
    setText("");
    setImages([]);
    try {
      await how(message);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      // Put the failed draft back without dropping what was typed or attached while it was sending.
      setText((now) => (now.trim() ? `${text}\n${now}` : text));
      setImages((now) => [...images, ...now]);
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  const queueMenu = () => {
    if (!onQueue || !ready) return;
    ActionSheetIOS.showActionSheetWithOptions({ options: ["Queue", "Cancel"], cancelButtonIndex: 1 }, (i) => i === 0 && void deliver(onQueue));
  };

  const stop = busy && !ready && onStop;
  return (
    <View style={s.root}>
      {above}
      {error && <Text style={[s.error, { color: c.danger }]}>{error}</Text>}
      <GlassCapsule style={s.glass}>
        {images.length > 0 && (
          <View style={s.images}>
            {images.map((i) => (
              <Pressable key={i.key} onPress={() => setImages((xs) => xs.filter((x) => x.key !== i.key))} accessibilityLabel={`Remove ${i.name}`}>
                <Image source={{ uri: i.uri }} style={[s.thumb, { opacity: i.id ? 1 : 0.5, borderColor: i.failed ? c.danger : "transparent" }]} />
              </Pressable>
            ))}
          </View>
        )}
        <View style={s.row}>
          <View style={s.side}>
            <Host matchContents>
              <Menu label={<UIImage systemName="plus" size={20} color={c.text} />}>
                <Button label="Photos" systemImage="photo.on.rectangle" onPress={() => void pick()} />
                {menu}
              </Menu>
            </Host>
          </View>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Ask anything"
            placeholderTextColor={c.muted}
            multiline
            style={[s.input, { color: c.text, textAlign: text ? "left" : "center" }]}
          />
          {stop || ready || sending ? (
            <Pressable
              onPress={() => (stop ? onStop() : ready && void deliver(onSend))}
              onLongPress={busy ? queueMenu : undefined}
              accessibilityLabel={stop ? "Stop" : "Send"}
              style={[s.send, { backgroundColor: c.brand }]}
            >
              {sending ? <ActivityIndicator size="small" color={c.onBrand} /> : <SymbolView name={stop ? "stop.fill" : "arrow.up"} size={stop ? 13 : 16} weight="semibold" tintColor={c.onBrand} />}
            </Pressable>
          ) : (
            <View style={s.side} />
          )}
        </View>
      </GlassCapsule>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: 16, paddingBottom: 6, gap: 8 },
  glass: { borderRadius: 22, paddingHorizontal: 6, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  side: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, fontSize: size.message, lineHeight: 20, maxHeight: 160, paddingTop: 7, paddingBottom: 7 },
  send: { width: 32, height: 32, borderRadius: 16, marginHorizontal: 2, alignItems: "center", justifyContent: "center" },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 6 },
  thumb: { width: 56, height: 56, borderRadius: radius.control, borderWidth: 1 },
  error: { fontSize: size.small, paddingHorizontal: 8 },
});
