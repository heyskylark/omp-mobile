# Transcript images

Images show in the transcript as OMP's terminal shows them. An image block in a user (or assistant) message carries an `ImageRef` (`{ id, mimeType, width?, height? }`), and a tool item carries `images: ImageRef[]` for the images it returned to the model (`read` on an image file, browser screenshots). The app loads each ref from `GET /v1/images/<id>` with its device bearer token. `id` is the SHA-256 of the image bytes, the same hash OMP's blob store (`~/.omp/agent/blobs/<id>`) uses. A running turn's tool images arrive inline in OMP's RPC frames; the server hashes them the same way and serves them from memory until OMP saves them, so the id does not change when the turn is saved.

## Sub-features

- `images-user`: a user message's images appear as thumbnails (at most 220 pt wide) inside its bubble. An image block with no `image` (no data the server can serve) still reads `Image attachment`. **Exercised** (real history).
- `images-tool`: a tool call's images appear under its header whether or not the card is expanded, as wide as the card and at most 360 pt tall. The tool's `output` no longer holds the image's JSON. **Exercised** (real history, and a new session whose model ran `read` on a PNG).
- `images-viewer`: tapping an image (`Image` for a message's, `Image from <tool>` for a tool's) opens it full screen with pinch zoom; `Close image` dismisses it. **Exercised** (open and close; pinch zoom is recipe-only, as Maestro has no pinch).
- `images-live`: during a turn, a tool's `timeline.upsert` already carries `images` with the size read from the bytes, and its id matches the blob OMP writes. **Exercised** at the server (stream subscriber).
- `images-endpoint`: `GET /v1/images/<id>` answers 401 without a device token, 200 with the image bytes, its sniffed `content-type`, and `cache-control: private, max-age=31536000, immutable`, and 404 for unknown hashes, non-hash ids, and blobs that are not PNG, JPEG, GIF, or WebP. **Exercised** (`curl` with the probe token, and server tests).

## Driving it with Maestro

1. Find sessions with images in the real history, then confirm the server's view and save it:

   ```sh
   .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions/<id>?limit=100' > <EVIDENCE>/api-<id>.json
   jq -c '.items[] | select(((.images // []) | length) > 0 or ((.blocks // []) | map(select(.kind == "image")) | length) > 0)' <EVIDENCE>/api-<id>.json
   ```

   For a fresh tool image, put a PNG in `<PROJECT>` and create a session that asks the model to `read` it. Send the request with the probe token (`~/.cache/omp-mobile-verify/<RUN_ID>/probe.json`) as `POST /v1/sessions` (`{ operationId, cwd: <PROJECT>, prompt }`).

2. Open the session by title search, scroll to the image, open and close the viewer:

   ```sh
   maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/images-tool -e MACHINE_NAME=<MACHINE_NAME> -e 'QUERY=<search words>' -e 'SESSION_TITLE=<escaped title>' -e 'IMAGE_LABEL=Image from read' -e PREFIX=images-tool .omp/skills/verify-omp-mobile/flows/chat-images.yaml
   maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/images-user -e MACHINE_NAME=<MACHINE_NAME> -e 'QUERY=<search words>' -e 'SESSION_TITLE=<escaped title>' -e IMAGE_LABEL=Image -e PREFIX=images-user .omp/skills/verify-omp-mobile/flows/chat-images.yaml
   ```

   Pass: `<PREFIX>-01-inline` shows the picture at its own aspect ratio, inside the bubble or under the tool header; `<PREFIX>-02-viewer` shows it full screen on black with `Close` at the top left; `<PREFIX>-03-closed` is the transcript again.

## Gotchas

- `IMAGE_LABEL=Image` matches every message image. With several in a session, `scrollUntilVisible` stops at the newest.
- Sessions whose images predate OMP's blob store, or that hold only `image_url` blocks, show `Image attachment`; pick a session whose JSONL image blocks have `data: "blob:sha256:…"`.
