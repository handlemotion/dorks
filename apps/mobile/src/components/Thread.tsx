import type { Block } from "@dorks/shared";
import { Image } from "expo-image";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { memo, useState, type ReactElement } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Markdown } from "@/components/Markdown";
import { workedFor } from "@/lib/format";
import { useImageSource } from "@/lib/images";
import { radius, type as size, useColors } from "@/lib/theme";
import { entries, hookTitle, toolGroupTitle, turns, type Entry } from "@/lib/tools";

// The desktop's thread (apps/web ChatBlock.tsx) on a phone: the user's grey bubbles, the agent's messages unbubbled, each run of tool
// calls one compact line, and a finished turn folded behind "Worked for 2m 14s" with its final answer shown under it.

type AgentBlock = Exclude<Block, { kind: "user" }>;
type ToolBlock = Extract<Block, { kind: "tool" }>;

const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** A compact line with an optional SF Symbol, muted, at the conversation's size. */
function Line({ icon, text, color, onPress, trailing }: { icon?: SFSymbol; text: string; color?: string; onPress?: () => void; trailing?: SFSymbol }) {
  const c = useColors();
  const tint = color ?? c.muted;
  const body = (
    <View style={s.line}>
      {icon && <SymbolView name={icon} size={14} tintColor={tint} />}
      <Text style={[s.lineText, { color: tint }]} numberOfLines={2}>
        {text}
      </Text>
      {trailing && <SymbolView name={trailing} size={11} tintColor={tint} />}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** A run of tool calls: "Ran 3 commands, read 2 files"; a tap unfolds each call's summary. */
function ToolLine({ tools }: { tools: ToolBlock[] }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.status === "running");
  const failed = tools.filter((t) => t.status === "error").length;
  const title = toolGroupTitle(tools) + (failed ? ` · ${failed} failed` : "");
  return (
    <View style={s.tools}>
      <View style={s.row}>
        <Line text={title} color={failed ? c.danger : undefined} onPress={() => setOpen(!open)} trailing={open ? "chevron.down" : "chevron.right"} />
        {running && <ActivityIndicator size="small" color={c.muted} />}
      </View>
      {open &&
        tools.map((t) => (
          <Text key={t.id} numberOfLines={2} style={[s.toolCall, { color: t.status === "error" ? c.danger : c.muted }]}>
            {t.summary || t.name}
          </Text>
        ))}
    </View>
  );
}

/** An image build the agent started; a trial is only its tool row. */
function RunLine({ run }: { run: Extract<AgentBlock, { kind: "buildRun" }>["run"] }) {
  const c = useColors();
  if (run.kind === "trial") return null;
  return <Line icon="hammer" text={`Building the machine ${run.buildName}: ${run.status}`} color={run.status === "failed" ? c.danger : undefined} />;
}

/** Everything but the user's messages and the agent's words, as one line each. */
function OtherBlock({ block }: { block: AgentBlock }) {
  const c = useColors();
  switch (block.kind) {
    case "notice":
      return (
        <Line
          icon={block.level === "error" ? "exclamationmark.circle" : "checkmark.circle"}
          text={block.hook ? hookTitle(block.hook) : block.text}
          color={block.level === "error" ? c.danger : undefined}
        />
      );
    case "build":
      return <Line icon="shippingbox" text={`Machine change: ${block.buildName}${block.approved === null ? "" : block.approved ? " (approved)" : " (rejected)"}`} />;
    case "buildRun":
      return <RunLine run={block.run} />;
    case "local":
      return <Line icon="desktopcomputer" text={`Asked to use your Mac: ${block.command ?? block.path ?? block.reason} (${block.status})`} />;
    case "input":
      return <Line icon="key" text={`Asked for ${block.title} (${block.status})`} />;
    case "ship":
      return <Line icon="paperplane" text={`Shipping #${block.ship.number}: ${block.ship.status}`} />;
    case "crew":
      return (
        <Line icon="person.2" text={block.note ? `Note ${block.direction === "in" ? "from" : "to"} ${block.peer.title}` : `Report ${block.direction === "in" ? "from" : "to"} ${block.peer.title}`} />
      );
    default:
      return null;
  }
}

/** One turn's blocks in order: messages, tool lines (consecutive calls are one line), and notices. */
function TurnBlocks({ blocks }: { blocks: AgentBlock[] }) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "tool") {
      const tools: ToolBlock[] = [block];
      while (blocks[i + 1]?.kind === "tool") tools.push(blocks[++i] as ToolBlock);
      out.push(<ToolLine key={block.id} tools={tools} />);
    } else if (block.kind === "assistant") {
      out.push(<Markdown key={block.id}>{block.text}</Markdown>);
    } else out.push(<OtherBlock key={block.id} block={block} />);
  }
  return out;
}

/**
 * A turn. Done with a final answer: "Worked for 2m 14s" (a tap unfolds the work) and the answer. Running, failed or from before
 * outcomes existed: all of it, in order. Stopped: what it did, then "Stopped after …".
 */
function Turn({ blocks, end }: ReturnType<typeof turns>[number]) {
  const [open, setOpen] = useState(false);
  const final = end?.outcome === "done" && end.finalId ? blocks.find((b) => b.kind === "assistant" && b.id === end.finalId) : undefined;
  if (end && final) {
    const work = blocks.filter((b) => b !== final);
    return (
      <View style={s.turn}>
        {work.length > 0 && <Line text={`Worked for ${workedFor(end.durationMs)}`} trailing={open ? "chevron.down" : "chevron.right"} onPress={() => setOpen(!open)} />}
        {open && <TurnBlocks blocks={work} />}
        <TurnBlocks blocks={[final]} />
      </View>
    );
  }
  return (
    <View style={s.turn}>
      <TurnBlocks blocks={blocks} />
      {end?.outcome === "stopped" && <Line icon="stop.circle" text={`Stopped after ${workedFor(end.durationMs)}`} />}
    </View>
  );
}

function UserBubble({ text }: { text: string }) {
  const c = useColors();
  const image = useImageSource();
  const images = [...text.matchAll(IMAGE)].map((m) => m[2]);
  const body = text.replace(IMAGE, "").trim();
  return (
    <View style={s.user}>
      {images.length > 0 && (
        <View style={s.userImages}>
          {images.map((src, i) => (
            <Image key={i} source={image(src)} style={[s.thumb, { backgroundColor: c.fill }]} contentFit="cover" />
          ))}
        </View>
      )}
      {body.length > 0 && (
        <View style={[s.bubble, { backgroundColor: c.userBubble }]}>
          <Text selectable style={[s.bubbleText, { color: c.userBubbleText }]}>
            {body}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Equal when it holds the same blocks: the feed keeps unchanged blocks' objects, so while the agent streams only the newest entry redraws. */
function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === "user" || b.kind === "user") return a.kind === "user" && b.kind === "user" && a.block === b.block;
  return a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i]);
}

const EntryView = memo(
  function EntryView({ entry }: { entry: Entry }) {
    if (entry.kind === "user") return <UserBubble text={entry.block.text} />;
    return (
      <View style={s.agent}>
        {turns(entry.blocks).map((t, i) => (
          <Turn key={i} {...t} />
        ))}
      </View>
    );
  },
  (a, b) => sameEntry(a.entry, b.entry),
);

/** The transcript, newest at the bottom; scrolling up loads older pages. `footer` sits under the last message (the status line). */
export function Thread({ blocks, onLoadMore, footer }: { blocks: Block[]; onLoadMore: () => void; footer?: ReactElement }) {
  const data = entries(blocks).reverse();
  return (
    <FlatList
      inverted
      data={data}
      keyExtractor={(e) => (e.kind === "user" ? e.block.id : e.id)}
      renderItem={({ item }) => <EntryView entry={item} />}
      ListHeaderComponent={footer}
      onEndReached={onLoadMore}
      onEndReachedThreshold={1.5}
      keyboardDismissMode="interactive"
      contentContainerStyle={s.list}
    />
  );
}

const s = StyleSheet.create({
  list: { paddingHorizontal: 20, paddingVertical: 16, gap: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  line: { flexDirection: "row", alignItems: "center", gap: 6 },
  lineText: { fontSize: size.ui, lineHeight: 21, flexShrink: 1 },
  tools: { gap: 4 },
  toolCall: { fontFamily: size.mono, fontSize: 12, lineHeight: 18, paddingLeft: 2 },
  turn: { gap: 12 },
  agent: { gap: 16 },
  user: { alignItems: "flex-end", gap: 6 },
  userImages: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  thumb: { width: 120, height: 120, borderRadius: radius.control },
  bubble: { maxWidth: "85%", borderRadius: radius.bubble, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleText: { fontSize: size.message, lineHeight: 22 },
});
