import type { PullRequestView } from "@dorks/shared";
import { useDorksClient, usePullRequest, useSubscriptions } from "@dorks/client/react";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { MergeFacts, SlideToMerge } from "@/components/SlideToMerge";
import { errorText } from "@/lib/format";
import { prColor, type as size, useColors, type Colors } from "@/lib/theme";

// A pull request as a native sheet: title, state, branches, checks, changed files with their stats, and Slide to merge, pinned to
// the head SHA shown (a newer push makes the merge fail instead of merging something unseen).

const STATE: Record<string, string> = { open: "Open", merged: "Merged", closed: "Closed" };
const BLOCKED: Partial<Record<PullRequestView["mergeableState"], string>> = {
  dirty: "Has merge conflicts with the base branch.",
  blocked: "Blocked by branch protection: required checks or reviews.",
  behind: "Behind its base branch.",
  unknown: "GitHub is still checking whether it can merge.",
  draft: "Still a draft.",
};

export default function PullRequestSheet() {
  const c = useColors();
  const { dork, url } = useLocalSearchParams<{ dork: string; url?: string }>();
  const { data: pr, status, error } = usePullRequest(dork, url);
  const subs = useSubscriptions(dork);
  const { actions } = useDorksClient();
  const [merged, setMerged] = useState<string>();
  const [mergeError, setMergeError] = useState<string>();

  if (!pr) {
    return (
      <View style={[s.center, { backgroundColor: c.background }]}>{status === "loading" ? <ActivityIndicator /> : <Text style={{ color: c.muted }}>{error?.message ?? "No pull request."}</Text>}</View>
    );
  }

  // Stacked on another open PR of this session: GitHub merges every open PR below it too.
  const stacked = (subs ?? []).some((p) => p.state === "open" && p.number !== pr.number && p.headRef === pr.baseRef);
  const method = pr.mergeMethods[0] ?? "merge";
  const canMerge = pr.state === "open" && !pr.draft && pr.mergeableState !== "dirty";
  const merge = async () => {
    setMergeError(undefined);
    try {
      const r = await actions.mergePullRequest(dork, method, pr.headSha, pr.url);
      setMerged(r.merged ? "Merged." : "Queued to merge.");
    } catch (e) {
      setMergeError(errorText(e));
      throw e;
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={s.body}>
      <View style={s.head}>
        <Text style={[s.meta, { color: prColor(c, pr.state, pr.draft) }]}>
          {pr.draft && pr.state === "open" ? "Draft" : STATE[pr.state]} · #{pr.number} · {pr.repo}
        </Text>
        <Text style={[s.title, { color: c.text }]}>{pr.title}</Text>
        <Text style={[s.meta, { color: c.muted }]}>
          <Text style={{ color: c.open }}>+{pr.additions}</Text> <Text style={{ color: c.closed }}>−{pr.deletions}</Text> in {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
        </Text>
      </View>

      {pr.state === "open" && (
        <View style={s.merge}>
          <MergeFacts method={method} base={pr.baseRef} head={pr.headRef} />
          {BLOCKED[pr.mergeableState] && <Text style={[s.meta, { color: c.muted }]}>{BLOCKED[pr.mergeableState]}</Text>}
          {merged ? <Text style={[s.meta, { color: c.merged }]}>{merged}</Text> : <SlideToMerge label={stacked ? "Slide to merge stack" : "Slide to merge"} disabled={!canMerge} onMerge={merge} />}
          {mergeError && <Text style={[s.meta, { color: c.danger }]}>{mergeError}</Text>}
        </View>
      )}

      <Checks pr={pr} c={c} />

      <Section title="Files" c={c}>
        {pr.unavailable?.includes("files") ? (
          <Text style={[s.meta, { color: c.muted }]}>GitHub did not return the files this time.</Text>
        ) : (
          pr.files.map((f) => (
            <View key={f.path} style={[s.file, { borderBottomColor: c.hairline }]}>
              <Text numberOfLines={1} ellipsizeMode="head" style={[s.path, { color: c.text }]}>
                {f.path}
              </Text>
              <Text style={[s.stat, { color: c.open }]}>+{f.additions}</Text>
              <Text style={[s.stat, { color: c.closed }]}>−{f.deletions}</Text>
            </View>
          ))
        )}
      </Section>
    </ScrollView>
  );
}

function Checks({ pr, c }: { pr: PullRequestView; c: Colors }) {
  const k = pr.checks;
  if (pr.unavailable?.includes("checks")) return null;
  const summary = k.total ? [k.failed && `${k.failed} failed`, k.pending && `${k.pending} running`, k.passed && `${k.passed} passed`].filter(Boolean).join(" · ") : "No checks";
  const color = k.failed ? c.closed : k.pending ? c.muted : k.total ? c.open : c.muted;
  return (
    <Section title="Checks" c={c}>
      <View style={s.checkRow}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <Text style={[s.meta, { color: c.text }]}>{summary}</Text>
      </View>
      {k.failing.map((name) => (
        <Text key={name} numberOfLines={1} style={[s.meta, { color: c.closed, paddingLeft: 16 }]}>
          {name}
        </Text>
      ))}
    </Section>
  );
}

function Section({ title, c, children }: { title: string; c: Colors; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: c.muted }]}>{title}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  body: { padding: 20, paddingTop: 28, gap: 24 },
  head: { gap: 6 },
  title: { fontSize: 20, fontWeight: "500", lineHeight: 26 },
  meta: { fontSize: size.small, lineHeight: 18 },
  merge: { gap: 12 },
  section: { gap: 8 },
  sectionTitle: { fontSize: size.small },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  path: { flex: 1, fontFamily: size.mono, fontSize: 12 },
  stat: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
