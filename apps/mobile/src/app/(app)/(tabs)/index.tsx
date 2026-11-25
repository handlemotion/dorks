import type { Dork } from "@dorks/client";
import { useBuilds, useConnection, useDork, useDorkEvents, useDorks, useDorksClient, useGithubRepos, useSettings } from "@dorks/client/react";
import { useState, type ReactNode } from "react";
import { GlassView } from "expo-glass-effect";
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from "react-native";
import { Composer } from "@/components/Composer";
import { BuildMenu, ModelMenu, RepoMenu } from "@/components/ComposerMenus";
import { GlassIconButton } from "@/components/Glass";
import { Header } from "@/components/Header";
import { PrPills } from "@/components/PrPills";
import { QueuedMessages } from "@/components/QueuedMessages";
import { StatusLine } from "@/components/StatusLine";
import { Thread } from "@/components/Thread";
import { useCurrentChat } from "@/lib/chat";
import { errorText, greeting } from "@/lib/format";
import { type as size, useColors } from "@/lib/theme";

/** The page under the header: the tab bar's inset at the bottom, and the keyboard's while it is up. */
function Page({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[s.fill, { backgroundColor: c.background }]}>
      <Header title={title} right={right} />
      <KeyboardAvoidingView behavior="padding" style={s.fill}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

export default function ChatTab() {
  const { dorkId } = useCurrentChat();
  return dorkId ? <SessionChat key={dorkId} dorkId={dorkId} /> : <NewChat />;
}

/** An empty chat: the greeting, the latest chat as a card, and the composer; its + menu picks the repository, model and build. */
function NewChat() {
  const c = useColors();
  const { actions } = useDorksClient();
  const { setDorkId } = useCurrentChat();
  const settings = useSettings();
  const github = useGithubRepos();
  const builds = (useBuilds() ?? []).filter((b) => b.image);
  const recent = useDorks()?.[0]?.repo;
  const [repo, setRepo] = useState<string>();
  const [model, setModel] = useState<{ model: string | null; effort: string | null }>({ model: null, effort: null });
  const [buildId, setBuildId] = useState<string>();
  const chosenRepo = repo ?? recent ?? "";
  const chosenBuild = buildId ?? settings?.defaultBuildId ?? "";

  const start = async (message: string) => {
    const { id } = await actions.createDork({
      message,
      ...(chosenRepo ? { repo: chosenRepo, mode: "code" as const } : { mode: "chat" as const }),
      ...(model.model ? { model: model.model } : {}),
      ...(model.effort ? { effort: model.effort } : {}),
      buildId: chosenBuild || null,
    });
    setDorkId(id);
  };

  return (
    <Page>
      <View style={s.center}>
        <View style={s.greeting}>
          <Text style={[s.hello, { color: c.text }]}>{greeting()} 👋</Text>
          <Text style={[s.hello, { color: c.muted }]}>What are we tackling today?</Text>
        </View>
        <RecentChats onOpen={setDorkId} />
      </View>
      <Composer
        busy={false}
        onSend={start}
        menu={
          <>
            <RepoMenu repos={github?.repos ?? []} value={chosenRepo} onChange={setRepo} />
            <ModelMenu choices={settings?.claudeModels ?? []} model={model.model ?? undefined} effort={model.effort ?? undefined} onChange={(m, e) => setModel({ model: m, effort: e })} />
            {builds.length > 0 && <BuildMenu builds={builds} value={chosenBuild} onChange={setBuildId} />}
          </>
        }
      />
    </Page>
  );
}

const BUSY = new Set<Dork["state"]>(["working", "creating", "waking"]);

/** A session's thread and its composer: PRs and queued messages above it, its repository, model and build under it. */
function SessionChat({ dorkId }: { dorkId: string }) {
  const c = useColors();
  const dork = useDork(dorkId);
  const { view, canLoadMore, loadMore, send } = useDorkEvents(dorkId);
  const { actions } = useDorksClient();
  const { live } = useConnection();
  const settings = useSettings();
  const { setDorkId } = useCurrentChat();
  const [error, setError] = useState<string>();
  const run = (p: Promise<unknown>) =>
    p.then(
      () => setError(undefined),
      (e) => setError(errorText(e)),
    );

  if (dork === undefined) return <Page>{null}</Page>;
  if (dork === null)
    return (
      <Page>
        <View style={s.greeting}>
          <Text style={[s.hello, { color: c.muted }]}>Chat deleted</Text>
        </View>
      </Page>
    );

  const busy = BUSY.has(dork.state);
  return (
    <Page title={dork.title} right={<GlassIconButton icon="square.and.pencil" label="New chat" onPress={() => setDorkId(null)} />}>
      <Thread blocks={view.blocks} onLoadMore={() => canLoadMore && loadMore()} footer={<StatusLine state={dork.state} live={live} blocks={view.blocks} />} />
      <Composer
        busy={busy && !dork.archived}
        onSend={send}
        onQueue={(m) => actions.queueMessage(dorkId, m)}
        onStop={dork.state === "working" ? () => void run(actions.interrupt(dorkId)) : undefined}
        above={
          <>
            {error && <Text style={[s.error, { color: c.danger }]}>{error}</Text>}
            <QueuedMessages queue={dork.queue ?? []} onSend={(id) => void run(actions.takeQueued(dorkId, id, true))} onRemove={(id) => void run(actions.takeQueued(dorkId, id, false))} />
            <PrPills dorkId={dorkId} />
          </>
        }
        menu={
          dork.provider === "claude" ? (
            <ModelMenu choices={dork.modelChoices ?? settings?.claudeModels ?? []} model={dork.model} effort={dork.effort} onChange={(m, e) => void run(actions.chooseModel(dorkId, m, e))} />
          ) : undefined
        }
      />
    </Page>
  );
}

/** The latest chat as a glass card, with the next one peeking out under it, like a notification stack. */
function RecentChats({ onOpen }: { onOpen: (id: string) => void }) {
  const c = useColors();
  const dorks = useDorks();
  const latest = dorks?.[0];
  if (!latest) return null;
  return (
    <Pressable onPress={() => onOpen(latest.id)} accessibilityRole="button" style={s.stack}>
      {(dorks?.length ?? 0) > 1 && <GlassView style={[s.card, s.behind]} />}
      <GlassView isInteractive style={[s.card, s.front]}>
        <Text style={s.icon}>{latest.icon ?? "💬"}</Text>
        <View style={s.cardText}>
          <Text numberOfLines={1} style={[s.cardTitle, { color: c.text }]}>
            {latest.title}
          </Text>
          {latest.preview ? (
            <Text numberOfLines={1} style={[s.cardTitle, { color: c.muted }]}>
              {latest.preview}
            </Text>
          ) : null}
        </View>
      </GlassView>
    </Pressable>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: "center", gap: 28, paddingHorizontal: 28 },
  greeting: { alignItems: "center", gap: 2 },
  hello: { fontSize: 20, lineHeight: 26, textAlign: "center" },
  error: { fontSize: size.small, paddingHorizontal: 10 },
  stack: { paddingBottom: 10 },
  card: { borderRadius: 24 },
  front: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18, paddingVertical: 16 },
  behind: { position: "absolute", left: 14, right: 14, top: 10, bottom: 0 },
  icon: { fontSize: 30 },
  cardText: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 16, lineHeight: 21 },
});
