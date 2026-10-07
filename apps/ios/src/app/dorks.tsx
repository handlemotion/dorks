import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { api, errorMessage, useDork, useDorkEvents, useDorks, type Id } from '@dorks/convex/client';
import type { Block } from '@dorks/shared';
import { Authenticated, AuthLoading, Unauthenticated, useMutation } from 'convex/react';
import { useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authClient, convex } from '@/lib/convex';

// Plain RN components on purpose: this screen proves the data path (auth + reactive paginated stream), not the design.
export default function DorksScreen() {
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient as never}>
      <SafeAreaView style={s.root}>
        <AuthLoading><Text>Loading…</Text></AuthLoading>
        <Unauthenticated><SignIn /></Unauthenticated>
        <Authenticated><Dorks /></Authenticated>
      </SafeAreaView>
    </ConvexBetterAuthProvider>
  );
}

function Button({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.button}>
      <Text>{title}</Text>
    </Pressable>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  return (
    <View style={s.col}>
      <Text style={s.h1}>Sign in</Text>
      {!sent ? (
        <>
          <TextInput accessibilityLabel="email" style={s.input} autoCapitalize="none" keyboardType="email-address" placeholder="you@jaantonio.com" value={email} onChangeText={setEmail} />
          <Button title="Send code" onPress={async () => { setError(''); const r = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }); if (r.error) setError(r.error.message ?? 'Could not send a code'); else setSent(true); }} />
        </>
      ) : (
        <>
          <TextInput accessibilityLabel="code" style={s.input} keyboardType="number-pad" placeholder="6-digit code" value={code} onChangeText={setCode} />
          <Button title="Sign in" onPress={async () => { setError(''); const r = await authClient.signIn.emailOtp({ email, otp: code }); if (r.error) setError(r.error.message ?? 'Invalid code'); }} />
        </>
      )}
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

function Dorks() {
  const [selected, setSelected] = useState<Id<'dorks'> | null>(null);
  const dorks = useDorks(false);
  if (selected) return <Thread dorkId={selected} onBack={() => setSelected(null)} />;
  return (
    <View style={s.col}>
      <Text style={s.h1}>Dorks</Text>
      <FlatList
        data={dorks ?? []}
        keyExtractor={(d) => d._id}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item._id)} style={s.row}>
            <Text style={s.bold}>{item.title}</Text>
            <Text>{item.repo} · {item.state}</Text>
          </Pressable>
        )}
      />
      <NewDork onCreated={setSelected} />
      <Button title="Sign out" onPress={() => authClient.signOut()} />
    </View>
  );
}

function NewDork({ onCreated }: { onCreated: (id: Id<'dorks'>) => void }) {
  const create = useMutation(api.dorks.create);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  return (
    <View>
      <TextInput accessibilityLabel="first message" style={s.input} placeholder="What should it do?" value={message} onChangeText={setMessage} />
      <Button title="New dork" onPress={async () => { setError(''); try { onCreated(await create({ repo: 'jaantonio/demo', message })); setMessage(''); } catch (e) { setError(errorMessage(e)); } }} />
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

function Thread({ dorkId, onBack }: { dorkId: Id<'dorks'>; onBack: () => void }) {
  const dork = useDork(dorkId);
  const { view, canLoadMore, loadMore } = useDorkEvents(dorkId);
  const send = useMutation(api.dorks.sendMessage);
  const archive = useMutation(api.dorks.setArchived);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return (
    <View style={s.col}>
      <Button title="‹ Back" onPress={onBack} />
      <Text style={s.h1}>{dork?.title} <Text style={s.small}>{dork?.state}{dork?.archived ? ' (archived)' : ''}</Text></Text>
      {dork && <Button title={dork.archived ? 'Unarchive' : 'Archive'} onPress={() => archive({ dorkId, archived: !dork.archived })} />}
      <FlatList
        data={view.blocks}
        keyExtractor={(b) => b.id}
        renderItem={({ item }) => <BlockView b={item} />}
        ListHeaderComponent={canLoadMore ? <Button title="Load older" onPress={loadMore} /> : null}
      />
      <TextInput accessibilityLabel="message" style={s.input} value={text} onChangeText={setText} placeholder="Message" />
      <Button title="Send" onPress={async () => { setError(''); try { await send({ dorkId, text }); setText(''); } catch (e) { setError(errorMessage(e)); } }} />
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'user': return <Text><Text style={s.bold}>you: </Text>{b.text}</Text>;
    case 'assistant': return <Text><Text style={s.bold}>claude: </Text>{b.text}{b.streaming ? ' ▍' : ''}</Text>;
    case 'tool': return <Text style={s.mono}>{b.name} {b.summary} — {b.status}{b.preview ? `: ${b.preview}` : ''}</Text>;
    case 'notice': return <Text style={b.level === 'error' ? s.error : s.small}>{b.text}</Text>;
  }
}

const s = StyleSheet.create({
  root: { flex: 1, padding: 16, paddingTop: Platform.OS === 'web' ? 84 : 16, backgroundColor: '#fff' }, // web: clear the floating tab bar
  col: { flex: 1, gap: 8 },
  h1: { fontSize: 22, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#bbb', borderRadius: 6, padding: 8 },
  button: { borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 8, alignSelf: 'flex-start' },
  row: { paddingVertical: 8 },
  bold: { fontWeight: '600' },
  small: { fontSize: 12, color: '#666' },
  mono: { fontFamily: 'Menlo', fontSize: 12 },
  error: { color: 'crimson' },
});
