# Edit Helper — Premiere Pro assistant panel

A Premiere Pro extension panel that:

- Scans the active sequence and **removes empty gaps** on the timeline (video, audio, or both), with a minimum-gap-length threshold so intentional pauses aren't eaten.
- **Normalizes audio loudness with one click** to a target LUFS (broadcast/streaming standard), measuring each clip's actual source audio with `ffmpeg` and applying the right gain automatically.
- **Finds memes/GIFs/images** from Giphy, Tenor, and a local folder you point it at, filterable by keyword and by genre/topic (Minecraft, Roblox, Trends, Gaming, Documentary, Nature, Tech), and inserts your pick onto the timeline at the playhead.
- **Transcribes speech (Czech, Slovak, English, or auto-detect) and generates styled, animated subtitles** with one click — 5 trendy caption looks (bold white/black-stroke, yellow impact, neon glow, clean minimal, boxed karaoke-style), each with a pop/bounce-in animation per line, rendered as a transparent overlay clip dropped onto the timeline above your footage.
- **Quick Edit tab**: lists your own saved Premiere effect/transition presets and applies one to the selected clip on double-click, plus 6 built-in one-click effects with a customizable slider each — Zoom In, Zoom Out, Camera Shake, Impact Punch (zoom+shake, popular for gaming highlight moments), White Flash, and Black Flash.
- **"Recently Downloaded" filter** on the Memes tab — every GIF/meme you've downloaded through the panel is remembered so you can quickly reuse it without searching again.
- **YouTube meme video search** — searches YouTube's official API for meme/reaction videos matching a mood or keyword (e.g. "angry" + Gaming filter finds angry-reaction gaming meme clips), with a **Load More** button on every internet source (Giphy, Tenor, YouTube) to keep paging through results instead of being capped at one batch.

It's a CEP (Common Extensibility Platform) panel — the framework Premiere plugins have used for years — because that's what actually exposes the timeline internals needed for gap detection/removal and clip-level audio gain. It is not distributed through Adobe Exchange; you install it locally.

## 1. Requirements

- Premiere Pro 2020 (14.0) or newer, Windows or macOS.
- [ffmpeg](https://ffmpeg.org/download.html) installed and available on your system PATH (used to measure loudness, extract audio, and render subtitle overlays). Test with `ffmpeg -version` in a terminal.
- (Optional, for internet meme/GIF search) Free API keys:
  - Giphy: https://developers.giphy.com/
  - Tenor: https://tenor.com/gifapi
  - YouTube Data API v3: create a project at https://console.cloud.google.com/, enable "YouTube Data API v3", create an API key. This has a modest free daily quota that's plenty for casual searching.
  - You can skip all three and just use the local-folder search.
- (Optional, only to actually insert a YouTube search result — searching itself doesn't need it) [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and on PATH: `pip install -U yt-dlp`. **Read the note under "Notes and honest limitations" below before installing this one** — it's a different kind of tool than the others here.
- (Optional, for auto-transcription/subtitles) [OpenAI Whisper](https://github.com/openai/whisper) installed and on PATH: `pip install -U openai-whisper` (requires Python). Runs fully locally and offline, at no cost, and handles Czech and Slovak well.
- (Optional, for the intended look of the subtitle styles) The free **Poppins** font family from [Google Fonts](https://fonts.google.com/specimen/Poppins), installed as a system font. If it's not installed, subtitles still render — just with your system's default fallback font instead of Poppins.

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
- Type a keyword and/or pick a genre filter, choose your source (internet, local folder, both, or YouTube meme videos), and click **Search**.
- If more results exist, a **Load More** button appears below the results grid — click it to fetch the next page from whichever internet source(s) you searched, appended to what's already shown.
- **YouTube meme videos**: searches YouTube directly for clips matching your keyword, sharpened toward memes (e.g. typing "angry" with the Gaming genre filter searches for "angry gaming meme"). Extra controls appear for this source:
  - **Content type**: *Videos*, or *Playlists* — playlists are the best way to find curated compilations other creators built (e.g. "Minecraft meme compilation" playlists). Search returns playlist thumbnails; **double-click one to open it** and see the actual videos inside, from which you pick one to insert. Click "< Back to search results" to return. Playlist search always uses the official API (below), regardless of the search engine choice.
  - **Search engine**: *Official YouTube API* (needs a free key in Settings, see Requirements) — legitimate, quota-limited, supports the length/sort filters below. Or *yt-dlp* — no key needed at all, uses the same tool already required for downloading, but like the download step, it's a third-party tool operating outside YouTube's own Terms of Service rather than an official method; it also can't apply the length/sort filters (those need the official API's metadata, which yt-dlp's fast search mode doesn't fetch).
  - **Video length** (API engine only): defaults to *Skip Shorts (4+ min)* — YouTube's API has no direct "exclude Shorts" flag, but filtering out videos under 4 minutes removes nearly all of them along with other very short clips, which also naturally favors longer, compilation-style results. *Compilations only (20+ min)* narrows further; *Any length* removes the filter.
  - **Sort by** (API engine only): *Most Relevant* (best text match) or *Most Popular* (raw view count).
- Click a result thumbnail to select it, choose whether to insert it as an overlay at the playhead (doesn't shift the timeline) or a rippled insert, then click **Insert Selected at Playhead**. Internet results are downloaded to a local cache folder first, then imported into your project like any other media. YouTube results are downloaded via yt-dlp instead (see the note below).

**Subtitles tab**
- Click a clip on the timeline to select it (the one you want captioned).
- Pick the spoken language (Czech, Slovak, English, or Auto-detect) and one of the 5 subtitle styles.
- Click **Transcribe & Insert Styled Subtitles**. It extracts just that clip's audio, transcribes it locally with Whisper, builds the styled/animated captions, renders them as a transparent overlay video, and drops that overlay onto the topmost video track lined up with the clip. Your original footage is untouched — the captions are a separate clip you can move, delete, or restyle by re-running with a different style choice.
- The 5 styles: **Bold Pop** (white, thick black stroke — the classic MrBeast/TikTok look), **Yellow Impact** (bright yellow, black stroke), **Neon Glow** (white with a magenta glow-style outline), **Clean Minimal** (smaller, subtle shadow, no heavy stroke — good for documentary/vlog tone), and **Karaoke Box** (white text on a solid dark background bar). Every style pops in with a quick scale bounce as each line appears.

**Quick Edit tab**
- *Your Premiere presets*: point Settings → "Premiere presets folder" at your saved-presets folder (typically `Documents\Adobe\Premiere Pro\<version>\Presets` on Windows, `~/Documents/Adobe/Premiere Pro/<version>/Presets` on Mac — the folder Premiere's own Effects panel saves to when you right-click an effect/transition and choose "Save Preset"). Click **Refresh List**, then double-click a preset name to apply it to whichever clip is currently selected on the timeline. If nothing shows up, the empty-list message now says exactly which folder it searched and why (folder not found/unreadable vs. found the folder but no `.prfpset` files in it) — that's local file scanning only, unrelated to Premiere itself, so it always works the same regardless of the panel's connection to Premiere.
- *Quick effects*: select a clip, drag the slider under an effect to taste, then double-click the row (or press its Apply button).
  - **Zoom In / Zoom Out** — the slider sets how fast the zoom ramps (lower = punchier snap-zoom, higher = a slow push).
  - **Camera Shake** — the slider sets shake intensity in pixels.
  - **Impact Punch** — a quick zoom-in plus shake together, good for hit/kill-moment emphasis in gaming edits; slider controls shake intensity.
  - **White Flash / Black Flash** — a quick full-frame flash inserted as an overlay at the clip's start; slider controls flash duration.

## Notes and honest limitations

- **Gap removal and the audio Volume/Level control use Premiere's internal "QE" scripting layer.** It's the same undocumented-but-widely-used API that most existing "remove gaps" Premiere scripts rely on, since Adobe's public scripting API doesn't expose empty-space detection or ripple delete. It's been stable for years but Adobe could change it in a future Premiere version — if a button stops working after a Premiere update, that's the likely reason. Check the panel's status bar for the exact error (or right-click the panel → Inspect Element → Console for full details).
- **Loudness normalization** uses a single-pass `ffmpeg loudnorm` measurement, which gets you very close to the target (typically within a fraction of a dB) without the extra time cost of a full two-pass render. Good enough for one-click leveling; if you need broadcast-spec mastering-grade accuracy, run a proper two-pass loudnorm afterward.
- **"Search the whole internet"** is implemented via Giphy's and Tenor's official public search APIs rather than open-ended web scraping — scraping arbitrary meme sites isn't something a distributable tool can legally or reliably do (most block it outright). Combined with your local folder, this covers the vast majority of meme/GIF search needs while staying on solid legal ground. You're welcome to extend `client/js/main.js`'s `searchGiphy`/`searchTenor` functions to add other APIs you have access to.
- There's no native OS folder-picker dialog (would need extra Node modules) — paste the folder path directly in Settings instead.
- **Subtitles rely on Whisper being installed separately** (it's a large, actively-maintained open-source project, not something we can bundle into a small panel download). Transcription accuracy for Czech and Slovak is very good with Whisper's default/`small` model but improves further with a larger model (`whisper file.wav --model medium ...`) at the cost of speed — you can pass extra flags by editing `runWhisper()` in `client/js/main.js` if you want to change the model.
- **The pop animation and styling are done via the ASS subtitle format** (rendered through ffmpeg's bundled libass), the same underlying technique most "animated caption" apps use — not a Premiere-native caption feature. This makes it reliable across Premiere versions, but it also means the captions are a burned overlay clip rather than editable native Premiere caption text; to change wording after the fact, edit the transcript logic and regenerate rather than double-clicking text on the timeline.
- **Quick Edit is the most experimental part of the panel.** Applying a saved preset uses the same internal QE layer as gap removal, via a method (`filters.addPreset`) that's consistent with how similar community tools work but isn't something covered in Adobe's public documentation — if double-clicking a preset does nothing or errors, send me the exact status-bar message and we'll adjust. Zoom/Shake/Impact Punch keyframe the "Motion" effect that's present on every video clip by default (Scale and Position properties) — this is a documented mechanism, but exact behavior can vary by Premiere version; if a slider effect doesn't animate as expected, check Effect Controls on that clip to see what keyframes actually landed.
- **YouTube search vs. YouTube download are two different things, deliberately.** Finding videos (the search box, thumbnails, titles) uses YouTube's official Data API — completely legitimate, same as the Giphy/Tenor integration. Actually downloading the video file when you click Insert uses `yt-dlp`, a separate, widely-used open-source tool that isn't provided or sanctioned by YouTube — doing that is outside YouTube's own Terms of Service, the same way it would be if you used any other third-party downloader yourself. It's not bundled or auto-installed for that reason; you install it deliberately, and it's your call whether downloading a given video for your own edit is something you're comfortable doing. Searching alone never touches yt-dlp at all.

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
