import { Image } from "expo-image";
import { marked, type Token, type Tokens } from "marked";
import { memo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { useImageSource } from "@/lib/images";
import { radius, type as size, useColors, type Colors } from "@/lib/theme";

// The agent's messages as markdown: marked's lexer (no HTML, no DOM) drawn with React Native views. Paragraphs, headings, lists,
// quotes, code blocks (scrolling sideways), tables as monospace rows, inline code, emphasis, links and images.

type Ctx = { c: Colors; image: ReturnType<typeof useImageSource> };

function inline(tokens: Token[] | undefined, ctx: Ctx, key = "i"): ReactNode[] {
  return (tokens ?? []).map((t, i) => inlineToken(t, ctx, `${key}.${i}`));
}

function inlineToken(t: Token, ctx: Ctx, key: string): ReactNode {
  const { c } = ctx;
  switch (t.type) {
    case "strong":
      return (
        <Text key={key} style={{ fontWeight: "500" }}>
          {inline(t.tokens, ctx, key)}
        </Text>
      );
    case "em":
      return (
        <Text key={key} style={{ fontStyle: "italic" }}>
          {inline(t.tokens, ctx, key)}
        </Text>
      );
    case "del":
      return (
        <Text key={key} style={{ textDecorationLine: "line-through" }}>
          {inline(t.tokens, ctx, key)}
        </Text>
      );
    case "codespan":
      return (
        <Text key={key} style={{ fontFamily: size.mono, fontSize: size.message - 2, backgroundColor: c.fill }}>
          {decode(t.text)}
        </Text>
      );
    case "link":
      return (
        <Text key={key} style={{ textDecorationLine: "underline" }} onPress={() => void Linking.openURL(t.href)}>
          {inline(t.tokens, ctx, key)}
        </Text>
      );
    case "br":
      return "\n";
    case "image":
      return null; // drawn as a block by the paragraph (see `imagesOf`)
    case "text":
    case "escape":
      return "tokens" in t && t.tokens ? <Text key={key}>{inline(t.tokens, ctx, key)}</Text> : decode(t.text);
    default:
      return "text" in t ? decode(String(t.text)) : null;
  }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

function imagesOf(tokens: Token[] | undefined): Tokens.Image[] {
  return (tokens ?? []).filter((t): t is Tokens.Image => t.type === "image");
}

function block(t: Token, ctx: Ctx, key: string, text: TextStyle): ReactNode {
  const { c } = ctx;
  switch (t.type) {
    case "paragraph": {
      const images = imagesOf(t.tokens);
      const words = (t.tokens ?? []).some((x) => x.type !== "image" && !(x.type === "text" && !x.raw.trim()));
      return (
        <View key={key} style={s.gap}>
          {words && <Text style={text}>{inline(t.tokens, ctx, key)}</Text>}
          {images.map((img, i) => (
            <Image key={i} source={ctx.image(img.href)} accessibilityLabel={img.text} contentFit="contain" style={[s.image, { backgroundColor: c.fill }]} />
          ))}
        </View>
      );
    }
    case "heading":
      return (
        <Text key={key} style={[text, { fontWeight: "500", fontSize: t.depth <= 2 ? size.message + 2 : size.message }]}>
          {inline(t.tokens, ctx, key)}
        </Text>
      );
    case "code":
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} style={[s.code, { backgroundColor: c.fill }]} contentContainerStyle={s.codeInner}>
          <Text selectable style={{ fontFamily: size.mono, fontSize: 13, lineHeight: 19, color: c.text }}>
            {t.text}
          </Text>
        </ScrollView>
      );
    case "list":
      return (
        <View key={key} style={s.list}>
          {t.items.map((item: Tokens.ListItem, i: number) => (
            <View key={i} style={s.item}>
              <Text style={[text, s.bullet]}>{t.ordered ? `${(Number(t.start) || 1) + i}.` : "•"}</Text>
              <View style={s.itemBody}>{blocks(item.tokens, ctx, `${key}.${i}`, text)}</View>
            </View>
          ))}
        </View>
      );
    case "blockquote":
      return (
        <View key={key} style={[s.quote, { borderLeftColor: c.hairline }]}>
          {blocks(t.tokens ?? [], ctx, key, { ...text, color: c.muted })}
        </View>
      );
    case "hr":
      return <View key={key} style={[s.hr, { backgroundColor: c.hairline }]} />;
    case "table": {
      const rows = [t.header.map((h: Tokens.TableCell) => h.text), ...t.rows.map((r: Tokens.TableCell[]) => r.map((cell) => cell.text))];
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} style={[s.code, { backgroundColor: c.fill }]} contentContainerStyle={s.codeInner}>
          <Text style={{ fontFamily: size.mono, fontSize: 13, lineHeight: 19, color: c.text }}>{rows.map((r) => r.join("  |  ")).join("\n")}</Text>
        </ScrollView>
      );
    }
    case "text":
      return (
        <Text key={key} style={text}>
          {"tokens" in t && t.tokens ? inline(t.tokens, ctx, key) : decode(t.text)}
        </Text>
      );
    case "space":
      return null;
    default:
      return "raw" in t && t.raw.trim() ? (
        <Text key={key} style={text}>
          {t.raw.trim()}
        </Text>
      ) : null;
  }
}

function blocks(tokens: Token[], ctx: Ctx, key: string, text: TextStyle): ReactNode[] {
  return tokens.map((t, i) => block(t, ctx, `${key}.${i}`, text));
}

/** Markdown text at the conversation's size; `color` overrides the text colour (a muted note). */
export const Markdown = memo(function Markdown({ children, color }: { children: string; color?: string }) {
  const c = useColors();
  const image = useImageSource();
  const tokens = marked.lexer(children, { gfm: true });
  const text: TextStyle = { color: color ?? c.text, fontSize: size.message, lineHeight: 23 };
  return <View style={s.root}>{blocks(tokens, { c, image }, "m", text)}</View>;
});

const s = StyleSheet.create({
  root: { gap: 12 },
  gap: { gap: 8 },
  code: { borderRadius: radius.control },
  codeInner: { padding: 12 },
  list: { gap: 6 },
  item: { flexDirection: "row", gap: 8 },
  bullet: { minWidth: 14 },
  itemBody: { flex: 1, gap: 6 },
  quote: { borderLeftWidth: 2, paddingLeft: 12, gap: 8 },
  hr: { height: StyleSheet.hairlineWidth },
  image: { width: "100%", aspectRatio: 4 / 3, borderRadius: radius.control },
});
