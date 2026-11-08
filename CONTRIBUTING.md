# Contributing to Winglet

Thanks for wanting to help! Winglet is at a very early stage, so the most useful
things right now are ideas, feedback and small, focused pull requests.

## Ways to help

- **Try things and report back.** Open an issue if something is confusing or broken.
- **Suggest features.** Open a feature request and describe the moment you'd use it.
- **Design.** Mockups, icons and flows are just as welcome as code.
- **Code.** Pick an issue labelled `good first issue` or `help wanted`, or open an issue first for anything big.

## Project layout

```
app/      Expo / React Native app (Android APK + iPhone/desktop web app)
plugin/   Hermes Agent companion plugin (Python)
```

## Pull requests

Work lands on `integration/dev-all`. A release is a pull request from there to `main`, and the version tag goes on
`main`, which is what people install. (The pending updater/linking integration uses a topic branch off
current `main`; see `docs/APP_PLAN.md`.)

1. Fork the repo and create a branch from `integration/dev-all`, and open your pull request against that branch.
2. Keep each PR focused on one thing.
3. Describe what changed and how you tested it. Screenshots or a short clip help a lot for UI changes.
4. Update the docs in the same pull request if behaviour or screens changed (README, `docs/FEATURES.md`, `docs/BOTS.md`,
   `docs/DESIGN.md`, plus `docs/APP_PLAN.md`, `docs/SERVER_PLUGIN_UPDATE.md` and `docs/DEVICE_LINKING.md` where
   relevant). The pull request template has a checklist. Local integration and rebuild evidence is not
   approval to publish, install or restart.
5. Make sure it builds and any existing checks pass.

## Ground rules

- Be kind. We're all here to build something fun.
- Don't commit secrets, API keys, pairing tokens or personal data.
- Don't use Nous Research, OpenAI or other companies' logos or branding in the app.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
