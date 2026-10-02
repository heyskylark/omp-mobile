# Browser live view

The session header's `Browser` button (Safari symbol), and `Open browser` on a question or text card, open a full-screen browser screen. The server connects to the OMP Browser Relay (`browserRelayUrl`, default `http://127.0.0.1:9224`), lists Chrome's tabs, streams the watched tab's screencast over `WS /v1/browser/stream`, and sends the phone's taps, drags, and keys to the tab while the phone holds control.

## Sub-features

- `browser-entry`: the header `Browser` button appears while `GET /v1/browser` is not `relay_offline`; question and text cards show `Open browser`, approval cards do not. **Exercised** (`browser-live-view.yaml` up to `browser-01-question`, against the real relay).
- `browser-watch`: the screen auto-watches the most recently active tab and shows its frames, title in the header, tab count chip `Tabs`. **Exercised** with the fake relay (`browser-control.yaml`). With real Chrome: recipe-only, see Gotchas.
- `browser-control`: `Take control` → `Hand back`; a tap on `Browser tab` sends `mouseMoved`/`mousePressed`/`mouseReleased` at the matching CSS pixel; `Keyboard` + typing sends one `Input.insertText` per character; erasing sends `Backspace`; `Tab key`/`Escape key`/arrow buttons send key events; the key row rides above the keyboard. **Exercised** with the fake relay.
- `browser-picker`: `Tabs` opens the picker with `<title>, <host>` rows; picking one watches it. **Exercised** with the fake relay.
- `browser-not-drawing`: with the Mac's screen locked, the screen says `Chrome isn't drawing` (or keeps the last frame with `Not updating: …`). **Exercised** against the real relay.
- `browser-unavailable`: `Browser relay isn't running` (nothing on the relay port) and `Chrome isn't connected` (relay up, no extension). Recipe-only in the app; covered by `server/src/browser/browser.test.ts`.
- `browser-real-input`: phone input reaches real Chrome. Proved at the server API with a WebSocket client against the real relay; the DOM showed the tap and the typed text.

## Driving it with Maestro

### App against the fake relay (no Chrome needed)

1. Start the stand-in relay as a supervised process: `name` `omp-mobile-verify-relay-<RUN_ID>`, `command` `.omp/skills/verify-omp-mobile/bin/fake-browser-relay.ts 29224`, `ready` `{"log": "fake browser relay listening", "port": 29224}`.
2. Add `"browserRelayUrl": "http://127.0.0.1:29224"` to `<OMP_MOBILE_HOME>/config.json` and restart the run's server.
3. Run, with any session row of this computer as `SESSION` (a regex):

   ```sh
   maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/browser-control -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION=<session row regex>' .omp/skills/verify-omp-mobile/flows/browser-control.yaml
   ```

4. Save the relay's output (`read proc://omp-mobile-verify-relay-<RUN_ID>`). It must show, in order, `Target.activateTarget`, three `Input.dispatchMouseEvent` at the frame's centre (`x` 600, `y` about 374 for the fixture's 1200x749 viewport), five single-character `Input.insertText` (`h`, `e`, `l`, `l`, `o`), then `keyDown`/`keyUp` for `Backspace` and `Tab`.

### App against real Chrome

Needs the relay (`omp browser-relay`) and a Chrome with the OMP Browser Relay extension, and **an unlocked Mac screen**. Chrome for Testing works without touching the user's Chrome: `"<omp puppeteer dir>/Google Chrome for Testing" --user-data-dir=<SCRATCH>/chrome --load-extension=$HOME/.omp/browser-relay/extension` (branded Chrome ignores `--load-extension`).

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/browser -e MACHINE_NAME=<MACHINE_NAME> -e TOKEN=<unique lowercase word> -e "PROMPT=In the eval tool run: await browser.open({ name: 'check', url: 'file://<repo>/.omp/skills/verify-omp-mobile/fixtures/browser-page.html', app: { relay: true }, persist: true }). Then use the ask tool to ask me one question titled Sign in with the single option Done. After I answer, read the value of the #field input in tab check and reply with only that value." .omp/skills/verify-omp-mobile/flows/browser-live-view.yaml
```

The agent's reply must be `<TOKEN>`: the phone tapped the fixture's button (which focuses its field) and typed into the real page.

## Gotchas

- No Chrome on a Mac draws while its screen is locked, headless or not: screencasts stay silent and `Page.captureScreenshot` never answers. Check with `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())).CGSSessionScreenIsLocked'`. Input still reaches the page, slowly.
- Primary buttons read as `<SF Symbol>, <title>`: match `.*, Take control` and `.*, Hand back`.
- The New session screen's browse button is `move, Browse`; `.*Browse.*` also matches session rows titled `…Browser…`.
- Maestro evaluates `${…}` inside `inputText` strings, so pass a prompt containing braces through an env variable (`PROMPT`).
- The verify server is a separate process: restart it after server changes and after editing `config.json`.
