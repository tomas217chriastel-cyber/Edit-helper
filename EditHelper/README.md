# Edit Helper — Premiere Pro assistant panel

A Premiere Pro extension panel that:

- Scans the active sequence and **removes empty gaps** on the timeline (video, audio, or both), with a minimum-gap-length threshold so intentional pauses aren't eaten.
- **Normalizes audio loudness with one click** to a target LUFS (broadcast/streaming standard), measuring each clip's actual source audio with `ffmpeg` and applying the right gain automatically.
- **Finds memes/GIFs/images** from Giphy, Tenor, and a local folder you point it at, filterable by keyword and by genre/topic (Minecraft, Roblox, Trends, Gaming, Documentary, Nature, Tech), and inserts your pick onto the timeline at the playhead.

It's a CEP (Common Extensibility Platform) panel — the framework Premiere plugins have used for years — because that's what actually exposes the timeline internals needed for gap detection/removal and clip-level audio gain. It is not distributed through Adobe Exchange; you install it locally.

## 1. Requirements

- Premiere Pro 2020 (14.0) or newer, Windows or macOS.
- [ffmpeg](https://ffmpeg.org/download.html) installed and available on your system PATH (used only to *measure* loudness — nothing is re-encoded). Test with `ffmpeg -version` in a terminal.
- (Optional, for internet meme/GIF search) Free API keys:
  - Giphy: https://developers.giphy.com/
  - Tenor: https://tenor.com/gifapi
  - You can skip both and just use the local-folder search.

## 2. Install

CEP panels that aren't signed/notarized through Adobe need Premiere's debug mode turned on once:

**Windows** — open Registry Editor and under
`HKEY_CURRENT_USER\Software\Adobe\CSXS.9` (or `.10`/`.11` depending on your Premiere version — try the highest number that exists) add a String value `PlayerDebugMode` set to `1`.

**macOS** — open Terminal and run:
```
defaults write com.adobe.CSXS.9 PlayerDebugMode 1
```
(again, try `.10`/`.11` if `.9` doesn't apply to your version — you can set it on all of them, it's harmless.)

Then copy this whole `EditHelper` folder into your CEP extensions directory:

- **Windows:** `%APPDATA%\Adobe\CEP\extensions\EditHelper`
- **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/EditHelper`

Restart Premiere Pro, then open it via **Window → Extensions → Edit Helper**.

## 3. Set up API keys / local folder

Open the **Settings** tab in the panel:

- Paste your Giphy and/or Tenor API keys (leave blank to skip internet search).
- Paste the full path to a local folder of memes/GIFs/images you already have. The assistant tags each file using its filename and parent folder name, so naming files/folders things like `minecraft-explosion.gif` or putting them in a `Gaming/` folder makes search and the genre filters work well.
- Adjust the ffmpeg path only if it's not on your system PATH.

Click **Save Settings**.

## 4. Using it

**Timeline tab**
- *Remove Gaps*: choose scope (all/video/audio tracks) and a minimum gap length in seconds, then click **Remove Gaps**. It ripple-deletes qualifying empty spaces so later clips shift left to close the gap.
- *Normalize Audio*: choose "Selected clips" (select clips on the timeline first) or "All audio clips", set a target LUFS (-16 is a common default for online video; -14 for many streaming platforms), and click **Normalize Audio**. It measures each clip's real source audio loudness with ffmpeg and adjusts that clip's Volume/Level to hit the target, capped so it won't clip.

**Memes tab**
- Type a keyword and/or pick a genre filter, choose your source (internet, local folder, or both), and click **Search**.
- Click a result thumbnail to select it, choose whether to insert it as an overlay at the playhead (doesn't shift the timeline) or a rippled insert, then click **Insert Selected at Playhead**. Internet results are downloaded to a local cache folder first, then imported into your project like any other media.

## Notes and honest limitations

- **Gap removal and the audio Volume/Level control use Premiere's internal "QE" scripting layer.** It's the same undocumented-but-widely-used API that most existing "remove gaps" Premiere scripts rely on, since Adobe's public scripting API doesn't expose empty-space detection or ripple delete. It's been stable for years but Adobe could change it in a future Premiere version — if a button stops working after a Premiere update, that's the likely reason. Check the panel's status bar for the exact error (or right-click the panel → Inspect Element → Console for full details).
- **Loudness normalization** uses a single-pass `ffmpeg loudnorm` measurement, which gets you very close to the target (typically within a fraction of a dB) without the extra time cost of a full two-pass render. Good enough for one-click leveling; if you need broadcast-spec mastering-grade accuracy, run a proper two-pass loudnorm afterward.
- **"Search the whole internet"** is implemented via Giphy's and Tenor's official public search APIs rather than open-ended web scraping — scraping arbitrary meme sites isn't something a distributable tool can legally or reliably do (most block it outright). Combined with your local folder, this covers the vast majority of meme/GIF search needs while staying on solid legal ground. You're welcome to extend `client/js/main.js`'s `searchGiphy`/`searchTenor` functions to add other APIs you have access to.
- There's no native OS folder-picker dialog (would need extra Node modules) — paste the folder path directly in Settings instead.

## Project layout

```
EditHelper/
  CSXS/manifest.xml     - extension manifest (Premiere version support, panel size, icons)
  .debug                - enables Chrome DevTools debugging on port 8088
  host/index.jsx         - ExtendScript: talks to Premiere's project/sequence/timeline
  client/index.html      - panel UI
  client/js/main.js      - panel logic: ffmpeg loudness, Giphy/Tenor search, local folder scan
  client/js/CSInterface.js - bridge library between the panel and Premiere
  client/css/style.css   - panel styling
  icons/                  - panel icons (placeholders — swap in your own artwork any time)
```

## Debugging

With `.debug` in place, open `http://localhost:8088` in Chrome while the panel is open in Premiere to get full DevTools (console, breakpoints, network tab) for the panel's JavaScript.
