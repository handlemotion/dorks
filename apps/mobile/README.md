# Dorks for iPhone

An Expo (SDK 58, Expo Router) app: a second UI for the server on your Mac, reached through the Dorks Cloud relay. The contract is
[docs/mobile.md](../../docs/mobile.md). It reuses `@dorks/client` (with `expo/fetch`, so the live SSE stream works) and `@dorks/shared`.

```
src/app/_layout.tsx            sign-in gate, theme, EAS Update on launch, holds the launch screen (src/lib/splash.ts)
src/app/sign-in.tsx            Wok's sign-in, ported: Google, Apple (native) or email (src/lib/signIn.ts)
src/app/sign-in-email.tsx      email page, pushed; sends the code
src/app/sign-in-code.tsx       6-digit code page (six boxes, autofill, Resend after 30 s)
src/app/(app)/_layout.tsx      Macs, the picked Mac's client, the sliding sidebar shell
src/app/(app)/(tabs)/          native tabs: Chat (index) and Customize
src/app/(app)/pr.tsx           a pull request as a form sheet, with Slide to merge
src/app/(app)/settings.tsx     paired Macs, Pair a Mac, sign out
src/app/(app)/pair.tsx         QR scanner and code entry; also opened by dorks://pair?code=…&cloud=…
```

## Run it

Nothing runs on Linux; build on a Mac with Xcode.

```sh
pnpm install                                  # from the repository root
cd apps/mobile
npx expo run:ios                              # a development build on the simulator
pnpm start                                    # later: Metro for that build
```

Sign in with Apple needs a device and a build signed for `build.dorks.ios`; on the simulator use Continue with email (a local
relay without an email key prints the code in its log). Pair a Mac from Settings: on the Mac, Settings, Phone, Pair a phone.

Checks: `pnpm typecheck`, `npx expo export --platform ios` (bundles without a device), `npx expo-doctor`.

## Builds, TestFlight and updates

```sh
npm i -g eas-cli && eas login
eas init                                      # once: prints the project id; set EAS_PROJECT_ID or extra.eas.projectId
pnpm build:dev                                # development client, internal distribution
pnpm build:preview                            # internal build on the preview channel
pnpm build:prod && pnpm submit                # production build to TestFlight (build number auto-incremented)
pnpm update:preview                           # or update:prod: ship JS-only changes as an EAS Update
```

`runtimeVersion` is the fingerprint policy, so an update only reaches builds with the same native code; a native change needs a new
build. The app versions on its own, outside the desktop's changesets.

## Environment

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_CLOUD_URL` | The relay's origin. Default `https://dorks-cloud.handle-473.workers.dev`. |
| `EAS_PROJECT_ID` | The EAS project; turns on EAS Update (`updates.url`). |
