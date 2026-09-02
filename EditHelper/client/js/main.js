/* Edit Helper panel logic. Runs in the CEP panel's Chromium context with
 * Node.js integration enabled (--enable-nodejs --mixed-context in the
 * manifest), so `require()` works directly here alongside the DOM. */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");

const csInterface = new CSInterface();

// getSystemPath() can return "" on some setups; os.tmpdir() is always an
// absolute, writable path, so it's a safe fallback instead of "." (which
// resolves relative to Premiere's own process directory and isn't writable).
function getCacheDir() {
    let base = "";
    try { base = csInterface.getSystemPath(CSInterface.SystemPath.USER_DATA); } catch (e) {}
    if (!base) base = os.tmpdir();
    return path.join(base, "edit-helper-cache");
}

// ---------------------------------------------------------------------------
// Settings (persisted in localStorage - this is per-panel, local to the
// machine; API keys never leave the machine except in the direct HTTPS call
// to Giphy/Tenor's own servers to run the search the user asked for)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    giphyKey: "",
    tenorKey: "",
    youtubeKey: "",
    localFolder: "",
    presetsFolder: "",
    ffmpegPath: "ffmpeg",
    whisperPath: "whisper",
    ytDlpPath: "yt-dlp",
    targetLufs: -16,
    minGapSeconds: 0.2
};

// Recently downloaded memes/GIFs, stored separately from settings since it
// grows over time - a simple capped list, newest first.
function loadRecentDownloads() {
    try { return JSON.parse(localStorage.getItem("eh_recent_downloads") || "[]"); }
    catch (e) { return []; }
}

function addRecentDownload(entry) {
    const list = loadRecentDownloads();
    list.unshift(entry);
    localStorage.setItem("eh_recent_downloads", JSON.stringify(list.slice(0, 40)));
}

function loadSettings() {
    try {
        const raw = localStorage.getItem("eh_settings");
        if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
        return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

function saveSettings(settings) {
    localStorage.setItem("eh_settings", JSON.stringify(settings));
}

let settings = loadSettings();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function setStatus(msg, isError) {
    const el = $("statusBar");
    el.textContent = msg;
    el.className = isError ? "status error" : "status";
}

// Calls a $$eh_ function in host/index.jsx by name instead of constructing
// a new snippet of JavaScript as a string on every call. The only thing
// ever sent to evalScript() is a call to the single, pre-written
// $$eh_dispatch() function (parsed once when the file loads), with the
// real function name and its arguments passed as plain string/JSON
// literals - so there's no per-call code generation on the ExtendScript
// side left to get subtly wrong.
function callHost(fnName, args) {
    const script = `$$eh_dispatch(${JSON.stringify(fnName)}, ${JSON.stringify(JSON.stringify(args || []))})`;
    console.log("[EditHelper] calling host:", fnName, args);
    return new Promise((resolve) => {
        csInterface.evalScript(script, (result) => {
            console.log("[EditHelper] raw result from Premiere:", JSON.stringify(result));
            try { resolve(JSON.parse(result)); }
            catch (e) { resolve({ ok: false, error: "Bad response from Premiere: " + result }); }
        });
    });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".panel-view").forEach((v) => v.classList.remove("active"));
        tab.classList.add("active");
        $(tab.dataset.target).classList.add("active");
    });
});

// ---------------------------------------------------------------------------
// Timeline: remove gaps
// ---------------------------------------------------------------------------
$("btnRemoveGaps").addEventListener("click", async () => {
    setStatus("Scanning timeline for empty gaps...");
    const scope = $("gapScope").value;
    const minGap = parseFloat($("minGap").value) || 0;
    settings.minGapSeconds = minGap;
    saveSettings(settings);

    const result = await callHost("$$eh_removeGaps", [minGap, scope]);
    if (!result.ok) { setStatus("Error: " + result.error, true); return; }
    setStatus(`Removed ${result.removed} gap(s)${result.skipped ? ", " + result.skipped + " could not be removed" : ""}.`);
});

// ---------------------------------------------------------------------------
// Audio: one-click loudness normalization
// ---------------------------------------------------------------------------
function runFfmpegLoudnorm(filePath, targetI) {
    return new Promise((resolve) => {
        const args = ["-i", filePath, "-af", `loudnorm=I=${targetI}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"];
        execFile(settings.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
            if (err && err.code === "ENOENT") {
                resolve({ ok: false, error: `ffmpeg not found ("${settings.ffmpegPath}" - Premiere couldn't launch it). Check the ffmpeg path in Settings, or that ffmpeg is on PATH.` });
                return;
            }
            const text = stderr || "";
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                resolve({ ok: false, error: "ffmpeg ran but returned no loudness data" + (err ? ": " + err.message : " - unexpected output.") });
                return;
            }
            try {
                const data = JSON.parse(match[0]);
                resolve({ ok: true, inputI: parseFloat(data.input_i), inputTp: parseFloat(data.input_tp) });
            } catch (e) {
                resolve({ ok: false, error: "Could not parse ffmpeg output: " + e.message });
            }
        });
    });
}

function computeGainDb(inputI, inputTp, targetI) {
    if (isNaN(inputI) || isNaN(inputTp)) return 0;
    let gain = targetI - inputI;
    const maxAllowedGain = -1.0 - inputTp; // keep true peak under -1 dBTP to avoid clipping
    if (gain > maxAllowedGain) gain = maxAllowedGain;
    return Math.round(gain * 10) / 10;
}

$("btnNormalize").addEventListener("click", async () => {
    const onlySelected = $("normalizeScope").value === "selected";
    const targetI = parseFloat($("targetLufs").value) || -16;
    settings.targetLufs = targetI;
    saveSettings(settings);

    setStatus("Reading clips from the timeline...");
    const info = await callHost("$$eh_getClipSources", [onlySelected]);
    if (!info.ok) { setStatus("Error: " + info.error, true); return; }

    const clips = info.clips;
    if (!clips.length) {
        setStatus(onlySelected ? "No audio clips selected." : "No audio clips found on the timeline.", true);
        return;
    }

    setStatus(`Measuring loudness of ${clips.length} clip(s) with ffmpeg...`);
    const cache = new Map();
    const entries = [];
    let failures = 0;
    let lastFailureReason = "";

    for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        setStatus(`Measuring loudness (${i + 1}/${clips.length}): ${clip.name}`);

        let measurement = cache.get(clip.mediaPath);
        if (!measurement) {
            measurement = await runFfmpegLoudnorm(clip.mediaPath, targetI);
            cache.set(clip.mediaPath, measurement);
        }

        if (!measurement.ok) { failures++; lastFailureReason = measurement.error; continue; }

        const gainDb = computeGainDb(measurement.inputI, measurement.inputTp, targetI);
        entries.push({ trackIndex: clip.trackIndex, clipIndex: clip.clipIndex, gainDb: gainDb });
    }

    if (!entries.length) {
        setStatus("Could not measure any clips. " + (lastFailureReason || "Make sure ffmpeg is installed (see Settings)."), true);
        return;
    }

    setStatus("Applying gain to clips in Premiere...");
    const applyResult = await callHost("$$eh_applyAudioGains", [entries]);
    if (!applyResult.ok) { setStatus("Error applying gain: " + applyResult.error, true); return; }

    setStatus(`Normalized ${applyResult.applied} clip(s) to ${targetI} LUFS.` + (failures ? ` (${failures} clip(s) could not be measured.)` : ""));
});

// ---------------------------------------------------------------------------
// Subtitles: Whisper transcription + styled, pop-animated caption overlay
// ---------------------------------------------------------------------------
// 5 trendy caption looks, defined as ASS (Advanced SubStation Alpha) style
// lines. ASS is the format every "animated TikTok-style caption" tool burns
// under the hood (via ffmpeg's libass renderer) - it's the only reliable way
// to get per-line scale/pop animation without needing to hand-build video
// frames. Colours are ASS's native &HAABBGGRR hex order.
const SUBTITLE_STYLES = {
    boldPop: {
        label: "Bold Pop", fontName: "Poppins ExtraBold", fontSize: 84,
        primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H00000000",
        bold: -1, borderStyle: 1, outline: 5, shadow: 0, alignment: 2, marginV: 90
    },
    yellowImpact: {
        label: "Yellow Impact", fontName: "Poppins ExtraBold", fontSize: 84,
        primaryColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000",
        bold: -1, borderStyle: 1, outline: 5, shadow: 0, alignment: 2, marginV: 90
    },
    neonGlow: {
        label: "Neon Glow", fontName: "Poppins SemiBold", fontSize: 78,
        primaryColour: "&H00FFFFFF", outlineColour: "&H00FF00FF", backColour: "&H00000000",
        bold: -1, borderStyle: 1, outline: 4, shadow: 2, alignment: 2, marginV: 90
    },
    cleanMinimal: {
        label: "Clean Minimal", fontName: "Poppins Medium", fontSize: 58,
        primaryColour: "&H00FFFFFF", outlineColour: "&H00202020", backColour: "&H00000000",
        bold: 0, borderStyle: 1, outline: 2, shadow: 1, alignment: 2, marginV: 70
    },
    karaokeBox: {
        label: "Karaoke Box", fontName: "Poppins SemiBold", fontSize: 68,
        primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H80000000",
        bold: -1, borderStyle: 3, outline: 8, shadow: 0, alignment: 2, marginV: 90
    }
};

function renderStylePreview(styleKey) {
    const style = SUBTITLE_STYLES[styleKey];
    const preview = $("stylePreview");
    const stroke = style.borderStyle === 3 ? "none" : `-2px 0 ${style.outlineColour === "&H00000000" ? "#000" : "#c0c"}`;
    preview.innerHTML = `<span style="color:#fff;font-family:'Poppins','Segoe UI',sans-serif;background:${style.borderStyle === 3 ? "rgba(0,0,0,0.6)" : "transparent"};-webkit-text-stroke:2px ${style.outlineColour === "&H00000000" ? "#000" : "#e040e0"};">${style.label}</span>`;
    preview.querySelector("span").style.color = style.primaryColour === "&H0000FFFF" ? "#ffe500" : "#fff";
}
$("subtitleStyle").addEventListener("change", () => renderStylePreview($("subtitleStyle").value));
renderStylePreview($("subtitleStyle").value);

$("strokeEnabled").addEventListener("change", () => {
    $("strokeWidth").disabled = !$("strokeEnabled").checked;
});
$("strokeWidth").addEventListener("input", () => {
    $("strokeWidthValue").textContent = `Stroke width: ${$("strokeWidth").value}`;
});
$("glowAmount").addEventListener("input", () => {
    const v = parseInt($("glowAmount").value, 10);
    $("glowAmountValue").textContent = v === 0 ? "Glow: off" : `Glow: ${v}`;
});

function parseSrt(text) {
    const blocks = text.replace(/\r/g, "").split(/\n\n+/);
    const cues = [];
    blocks.forEach((block) => {
        const lines = block.split("\n").filter(Boolean);
        const timeLineIndex = lines.findIndex((l) => l.indexOf("-->") !== -1);
        if (timeLineIndex === -1) return;
        const match = lines[timeLineIndex].match(/(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d),(\d\d\d)/);
        if (!match) return;
        const start = (+match[1]) * 3600 + (+match[2]) * 60 + (+match[3]) + (+match[4]) / 1000;
        const end = (+match[5]) * 3600 + (+match[6]) * 60 + (+match[7]) + (+match[8]) / 1000;
        const text2 = lines.slice(timeLineIndex + 1).join(" ").trim();
        if (text2) cues.push({ start, end, text: text2 });
    });
    return cues;
}

function toAssTime(seconds) {
    seconds = Math.max(0, seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds - Math.floor(seconds)) * 100);
    const pad = (n) => String(n).padStart(2, "0");
    return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// overrides: { strokeEnabled, strokeWidth, glowAmount }
function buildAssContent(cues, style, width, height, overrides) {
    overrides = overrides || {};
    const outline = overrides.strokeEnabled === false ? 0 : (overrides.strokeWidth != null ? overrides.strokeWidth : style.outline);
    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSize},${style.primaryColour},&H000000FF,${style.outlineColour},${style.backColour},${style.bold},0,0,0,100,100,0,0,${style.borderStyle},${outline},${style.shadow},${style.alignment},40,40,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    // Pop animation: each line scales in from 0% to a 112% overshoot, then
    // settles to 100% - a classic bounce/pop-in, timed relative to that
    // line's own start (ASS \t transform times are cue-relative, in ms).
    // \blur applies a soft gaussian blur to the outline/shadow edges - the
    // standard libass technique for a "glow" look - driven by the slider.
    const glow = overrides.glowAmount || 0;
    const blurTag = glow > 0 ? `\\blur${glow}` : "";
    const pop = `{${blurTag}\\fscx0\\fscy0\\t(0,150,\\fscx112\\fscy112)\\t(150,260,\\fscx100\\fscy100)}`;
    const lines = cues.map((cue) => {
        const text = cue.text.replace(/\n/g, "\\N");
        return `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Default,,0,0,0,,${pop}${text}`;
    });
    return header + lines.join("\n") + "\n";
}

// ffmpeg's filtergraph syntax treats ':' and '\' specially, which breaks
// Windows paths (e.g. "C:\Users\...") unless escaped this way.
function escapeFfmpegFilterPath(p) {
    return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function extractTrimmedAudio(mediaPath, inSeconds, durationSeconds, outPath) {
    return new Promise((resolve) => {
        const args = ["-y", "-ss", String(inSeconds), "-t", String(durationSeconds), "-i", mediaPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outPath];
        execFile(settings.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) { resolve({ ok: false, error: "Could not extract audio: " + (stderr || err.message) }); return; }
            resolve({ ok: true, path: outPath });
        });
    });
}

function runWhisper(mediaPath, language, outDir) {
    return new Promise((resolve) => {
        // Support a multi-word command like "python -m whisper" - needed
        // whenever pip installs the whisper.exe launcher somewhere not on
        // PATH, which is a very common situation on Windows.
        const commandParts = settings.whisperPath.trim().split(/\s+/);
        const command = commandParts[0];
        const baseArgs = commandParts.slice(1);
        const args = baseArgs.concat([mediaPath, "--output_format", "srt", "--output_dir", outDir, "--verbose", "False"]);
        if (language && language !== "auto") args.push("--language", language);
        execFile(command, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) {
                resolve({ ok: false, error: "Whisper failed: " + (stderr || err.message) + "\nIs Whisper installed and on PATH? (pip install -U openai-whisper)" });
                return;
            }
            const base = path.basename(mediaPath, path.extname(mediaPath));
            const srtPath = path.join(outDir, base + ".srt");
            if (!fs.existsSync(srtPath)) {
                resolve({ ok: false, error: "Whisper ran but produced no .srt file." });
                return;
            }
            resolve({ ok: true, srtPath: srtPath });
        });
    });
}

function renderSubtitleOverlay(assPath, width, height, duration, outPath) {
    return new Promise((resolve) => {
        const escapedAss = escapeFfmpegFilterPath(assPath);
        const args = [
            "-y",
            "-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height}:d=${duration}`,
            "-vf", `subtitles='${escapedAss}'`,
            "-c:v", "qtrle",
            outPath
        ];
        execFile(settings.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) { resolve({ ok: false, error: "ffmpeg render failed: " + (stderr || err.message) }); return; }
            resolve({ ok: true });
        });
    });
}

$("btnGenerateSubtitles").addEventListener("click", async () => {
    const language = $("subtitleLanguage").value;
    const style = SUBTITLE_STYLES[$("subtitleStyle").value];
    const overrides = {
        strokeEnabled: $("strokeEnabled").checked,
        strokeWidth: parseInt($("strokeWidth").value, 10),
        glowAmount: parseInt($("glowAmount").value, 10)
    };

    setStatus("Reading selected clip...");
    const clipInfo = await callHost("$$eh_getSelectedVideoClip", []);
    if (!clipInfo.ok) { setStatus("Error: " + clipInfo.error, true); return; }

    const frameInfo = await callHost("$$eh_getFrameSize", []);
    if (!frameInfo.ok) { setStatus("Error: " + frameInfo.error, true); return; }

    const tempDir = getCacheDir();
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    setStatus("Extracting audio for the selected clip...");
    const trimmedWavPath = path.join(tempDir, `trim_${Date.now()}.wav`);
    const trimResult = await extractTrimmedAudio(clipInfo.mediaPath, clipInfo.sourceIn || 0, clipInfo.duration, trimmedWavPath);
    if (!trimResult.ok) { setStatus(trimResult.error, true); return; }

    setStatus("Transcribing with Whisper (this can take a minute)...");
    const whisperResult = await runWhisper(trimmedWavPath, language, tempDir);
    if (!whisperResult.ok) { setStatus(whisperResult.error, true); return; }

    const srtText = fs.readFileSync(whisperResult.srtPath, "utf8");
    const cues = parseSrt(srtText);
    if (!cues.length) { setStatus("Whisper didn't detect any speech in this clip.", true); return; }

    setStatus(`Transcribed ${cues.length} line(s). Rendering styled subtitles...`);
    const assPath = path.join(tempDir, `subs_${Date.now()}.ass`);
    fs.writeFileSync(assPath, buildAssContent(cues, style, frameInfo.width, frameInfo.height, overrides), "utf8");

    const overlayPath = path.join(tempDir, `subs_${Date.now()}.mov`);
    const renderResult = await renderSubtitleOverlay(assPath, frameInfo.width, frameInfo.height, clipInfo.duration, overlayPath);
    if (!renderResult.ok) { setStatus(renderResult.error, true); return; }

    setStatus("Inserting subtitles onto the timeline...");
    const insertResult = await callHost("$$eh_insertOverlayAtTime", [overlayPath, clipInfo.start]);
    if (!insertResult.ok) { setStatus("Error: " + insertResult.error, true); return; }

    setStatus(`Inserted styled subtitles (${cues.length} line(s)) on track V${insertResult.track + 1}.`);
});

// ---------------------------------------------------------------------------
// Quick Edit: personal Premiere presets + built-in one-click effects
// ---------------------------------------------------------------------------
function scanPresets(folder) {
    // Defensive against a pasted path that carries surrounding quotes
    // (common when copying a path from some sources) - fs calls treat the
    // quotes as literal characters and just fail to find anything.
    folder = (folder || "").trim().replace(/^["']|["']$/g, "");

    const results = [];
    let rootError = null;

    function walk(dir, isRoot) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            if (isRoot) rootError = e.message;
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full, false); continue; }
            if (path.extname(entry.name).toLowerCase() === ".prfpset") {
                results.push({ name: entry.name.replace(/\.prfpset$/i, ""), path: full });
            }
        }
    }

    if (folder) walk(folder, true);
    return { results, folder, rootError };
}

function renderPresetsList() {
    const container = $("presetsList");
    const { results, folder, rootError } = scanPresets(settings.presetsFolder);

    if (!folder) {
        container.innerHTML = `<div class="preset-empty">No presets folder set. Add it in Settings.</div>`;
        return;
    }
    if (rootError) {
        container.innerHTML = `<div class="preset-empty">Can't read that folder: ${escapeHtml(rootError)}<br>Path searched: ${escapeHtml(folder)}</div>`;
        return;
    }
    if (!results.length) {
        container.innerHTML = `<div class="preset-empty">No .prfpset files found under:<br>${escapeHtml(folder)}<br>(searched all subfolders)</div>`;
        return;
    }
    container.innerHTML = "";
    results.forEach((preset) => {
        const row = document.createElement("div");
        row.className = "preset-row";
        row.textContent = preset.name;
        row.title = preset.path;
        row.addEventListener("dblclick", () => applyPreset(preset));
        container.appendChild(row);
    });
}

async function applyPreset(preset) {
    setStatus(`Applying preset "${preset.name}"...`);
    const result = await callHost("$$eh_applyPresetToSelectedClip", [preset.path]);
    if (!result.ok) { setStatus("Error: " + result.error, true); return; }
    setStatus(`Applied preset "${preset.name}".`);
}

$("btnRefreshPresets").addEventListener("click", renderPresetsList);

const QUICK_EFFECTS = [
    { key: "zoomIn", name: "Zoom In", sliderMin: 0.1, sliderMax: 2, sliderStep: 0.1, sliderDefault: 0.4, labelFn: (v) => `${v.toFixed(1)}s ramp - lower = punchier` },
    { key: "zoomOut", name: "Zoom Out", sliderMin: 0.1, sliderMax: 2, sliderStep: 0.1, sliderDefault: 0.4, labelFn: (v) => `${v.toFixed(1)}s ramp - lower = punchier` },
    { key: "shake", name: "Camera Shake", sliderMin: 2, sliderMax: 40, sliderStep: 1, sliderDefault: 12, labelFn: (v) => `${v}px intensity` },
    { key: "impactPunch", name: "Impact Punch (zoom + shake)", sliderMin: 2, sliderMax: 40, sliderStep: 1, sliderDefault: 15, labelFn: (v) => `${v}px intensity` },
    { key: "whiteFlash", name: "White Flash", sliderMin: 0.05, sliderMax: 1, sliderStep: 0.05, sliderDefault: 0.2, labelFn: (v) => `${v.toFixed(2)}s flash` },
    { key: "blackFlash", name: "Black Flash", sliderMin: 0.05, sliderMax: 1, sliderStep: 0.05, sliderDefault: 0.2, labelFn: (v) => `${v.toFixed(2)}s flash` }
];

function renderQuickEffects() {
    const container = $("quickEffectsList");
    container.innerHTML = "";
    QUICK_EFFECTS.forEach((fx) => {
        const row = document.createElement("div");
        row.className = "quick-effect-row";
        row.innerHTML = `
            <div class="quick-effect-top">
                <span class="quick-effect-name">${fx.name}</span>
                <span class="quick-effect-value">${fx.labelFn(fx.sliderDefault)}</span>
            </div>
            <input type="range" min="${fx.sliderMin}" max="${fx.sliderMax}" step="${fx.sliderStep}" value="${fx.sliderDefault}" />
            <button class="quick-effect-apply">Apply to Selected Clip</button>
        `;
        const slider = row.querySelector("input[type=range]");
        const valueLabel = row.querySelector(".quick-effect-value");
        slider.addEventListener("input", () => {
            valueLabel.textContent = fx.labelFn(parseFloat(slider.value));
        });
        slider.addEventListener("click", (e) => e.stopPropagation());
        const apply = () => applyQuickEffect(fx.key, parseFloat(slider.value), fx.name);
        row.querySelector(".quick-effect-apply").addEventListener("click", apply);
        row.addEventListener("dblclick", apply);
        container.appendChild(row);
    });
}

async function applyQuickEffect(kind, value, label) {
    if (kind === "whiteFlash" || kind === "blackFlash") {
        await applyFlashEffect(kind, value, label);
        return;
    }
    setStatus(`Applying ${label}...`);
    const result = await callHost("$$eh_applyMotionEffect", [kind, value]);
    if (!result.ok) { setStatus("Error: " + result.error, true); return; }
    setStatus(`Applied ${label}.`);
}

async function applyFlashEffect(kind, duration, label) {
    setStatus("Reading selected clip...");
    const clipInfo = await callHost("$$eh_getSelectedVideoClip", []);
    if (!clipInfo.ok) { setStatus("Error: " + clipInfo.error, true); return; }

    const frameInfo = await callHost("$$eh_getFrameSize", []);
    if (!frameInfo.ok) { setStatus("Error: " + frameInfo.error, true); return; }

    const tempDir = getCacheDir();
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const color = kind === "whiteFlash" ? "white" : "black";
    const outPath = path.join(tempDir, `flash_${Date.now()}.mov`);
    const fadeHalf = (duration / 2).toFixed(3);

    setStatus(`Rendering ${label}...`);
    const args = [
        "-y",
        "-f", "lavfi", "-i", `color=c=${color}:s=${frameInfo.width}x${frameInfo.height}:d=${duration}`,
        "-vf", `format=yuva420p,fade=t=in:st=0:d=${fadeHalf}:alpha=1,fade=t=out:st=${fadeHalf}:d=${fadeHalf}:alpha=1`,
        "-c:v", "qtrle",
        outPath
    ];

    const renderOk = await new Promise((resolve) => {
        execFile(settings.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
            if (err) { setStatus("ffmpeg render failed: " + (stderr || err.message), true); resolve(false); return; }
            resolve(true);
        });
    });
    if (!renderOk) return;

    setStatus("Inserting flash onto the timeline...");
    const insertResult = await callHost("$$eh_insertOverlayAtTime", [outPath, clipInfo.start]);
    if (!insertResult.ok) { setStatus("Error: " + insertResult.error, true); return; }
    setStatus(`Inserted ${label} on track V${insertResult.track + 1}.`);
}

renderPresetsList();
renderQuickEffects();

// ---------------------------------------------------------------------------
// Meme / GIF finder
// ---------------------------------------------------------------------------
const GENRE_KEYWORDS = {
    minecraft: ["minecraft", "mc", "creeper", "steve", "enderman"],
    roblox: ["roblox", "noob", "oof"],
    trends: ["trend", "trending", "viral", "meme"],
    gaming: ["game", "gaming", "gamer", "gameplay", "esports"],
    documentary: ["documentary", "doc", "history", "science"],
    nature: ["nature", "wildlife", "animal", "outdoors", "landscape"],
    tech: ["tech", "technology", "gadget", "software", "ai"]
};

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on("error", reject);
    });
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (res) => {
            res.pipe(file);
            file.on("finish", () => file.close(() => resolve(destPath)));
        }).on("error", (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// yt-dlp is a separate, user-installed tool - not something bundled here.
// It downloads the whole source video (YouTube's API doesn't expose a way
// to fetch just a "meme moment" - trim the result down in Premiere).
// Same multi-word command support as Whisper's path - pip often installs
// the yt-dlp launcher somewhere not on PATH, especially on Windows, so
// "python -m yt_dlp" needs to work as a fallback too.
function ytDlpCommand() {
    const parts = settings.ytDlpPath.trim().split(/\s+/);
    return { command: parts[0], baseArgs: parts.slice(1) };
}

function downloadYoutubeVideo(url, outPath) {
    return new Promise((resolve) => {
        const { command, baseArgs } = ytDlpCommand();
        const args = baseArgs.concat(["-f", "mp4/best", "-o", outPath, url]);
        execFile(command, args, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
            if (err) {
                resolve({ ok: false, error: "yt-dlp failed: " + (stderr || err.message) + "\nIs yt-dlp installed? (pip install -U yt-dlp)" });
                return;
            }
            resolve({ ok: true });
        });
    });
}

// yt-dlp can search YouTube directly via its "ytsearchN:query" pseudo-URL,
// with no API key needed - same tool already used for downloading. Uses
// --flat-playlist for speed (a real per-video metadata fetch for every
// search result would be much slower), which means duration/view-count
// aren't available here, so the length/sort filters only apply to the
// official API search. Thumbnails use YouTube's public, key-free static
// image CDN (predictable from the video ID) since flat-playlist mode
// doesn't reliably return thumbnail URLs itself.
function searchYoutubeViaYtDlp(query, genre, count) {
    return new Promise((resolve) => {
        const q = buildYoutubeQuery(query, genre);
        const { command, baseArgs } = ytDlpCommand();
        const args = baseArgs.concat([`ytsearch${count}:${q}`, "--flat-playlist", "--dump-json", "--no-warnings"]);
        execFile(command, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout) => {
            const lines = (stdout || "").split("\n").filter(Boolean);
            if (!lines.length) {
                resolve({ results: [], error: err ? "yt-dlp search failed: " + err.message + "\nIs yt-dlp installed? (pip install -U yt-dlp)" : null });
                return;
            }
            const results = [];
            for (const line of lines) {
                try {
                    const item = JSON.parse(line);
                    if (!item.id) continue;
                    results.push({
                        source: "youtube",
                        title: item.title || "(untitled)",
                        thumb: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
                        full: `https://www.youtube.com/watch?v=${item.id}`,
                        ext: ".mp4"
                    });
                } catch (e) { /* skip a line that isn't valid JSON */ }
            }
            resolve({ results, error: null });
        });
    });
}

// Each search function returns { results, cursor } where cursor is
// whatever that provider needs to fetch the next page (null once exhausted)
// - Giphy uses a numeric offset, Tenor and YouTube use opaque page tokens.
async function searchGiphy(query, limit, offset) {
    if (!settings.giphyKey) return { results: [], cursor: null };
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(settings.giphyKey)}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset || 0}&rating=pg-13`;
    try {
        const data = await httpsGetJson(url);
        const results = (data.data || []).map((g) => ({
            source: "giphy",
            title: g.title,
            thumb: g.images.fixed_height_small.url,
            full: g.images.original.url,
            ext: ".gif"
        }));
        const total = data.pagination ? data.pagination.total_count : 0;
        const nextOffset = (offset || 0) + results.length;
        return { results, cursor: results.length && nextOffset < total ? nextOffset : null };
    } catch (e) { return { results: [], cursor: null }; }
}

async function searchTenor(query, limit, pos) {
    if (!settings.tenorKey) return { results: [], cursor: null };
    let url = `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(settings.tenorKey)}&q=${encodeURIComponent(query)}&limit=${limit}&contentfilter=medium`;
    if (pos) url += `&pos=${encodeURIComponent(pos)}`;
    try {
        const data = await httpsGetJson(url);
        const results = (data.results || []).map((r) => ({
            source: "tenor",
            title: r.content_description,
            thumb: r.media_formats.tinygif ? r.media_formats.tinygif.url : r.media_formats.gif.url,
            full: r.media_formats.gif.url,
            ext: ".gif"
        }));
        return { results, cursor: data.next || null };
    } catch (e) { return { results: [], cursor: null }; }
}

// Uses YouTube's official Data API v3 to find videos - this part is fully
// legitimate, same "bring your own free key" pattern as Giphy/Tenor.
// Actually pulling the video file (in the Memes tab's Insert button) is a
// separate step via yt-dlp, called out on its own since that's outside
// YouTube's own Terms of Service.
function buildYoutubeQuery(query, genre) {
    let q = (query || genre || "meme").trim();
    if (genre && q.toLowerCase().indexOf(genre) === -1) q += " " + genre;
    if (q.toLowerCase().indexOf("meme") === -1) q += " meme";
    return q;
}

// duration: "medium" (4-20 min) skips almost all YouTube Shorts, since the
// Data API has no direct "exclude Shorts" flag - Shorts are ~under 60s, so
// filtering out the API's own "short" (<4 min) bucket removes them along
// with other very short clips, which also biases toward the longer,
// compilation-style videos being asked for. "long" (20+ min) narrows
// further to compilations specifically. order lets results favor either
// text-match relevance or raw popularity (view count).
async function searchYouTube(query, genre, pageToken, duration, order) {
    if (!settings.youtubeKey) return { results: [], cursor: null };
    const q = buildYoutubeQuery(query, genre);
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(settings.youtubeKey)}`;
    if (duration && duration !== "any") url += `&videoDuration=${duration}`;
    if (order) url += `&order=${encodeURIComponent(order)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    try {
        const data = await httpsGetJson(url);
        const results = (data.items || []).map((item) => ({
            source: "youtube",
            title: item.snippet.title,
            thumb: (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url,
            full: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            ext: ".mp4"
        }));
        return { results, cursor: data.nextPageToken || null };
    } catch (e) { return { results: [], cursor: null }; }
}

// Playlists are exactly the "compilations other people curated" the user
// wants - search finds candidate playlists; double-clicking one drills in
// via playlistItems.list to show the actual videos inside it, from which a
// real video can be selected and inserted like any other result.
async function searchYoutubePlaylists(query, genre, pageToken) {
    if (!settings.youtubeKey) return { results: [], cursor: null };
    const q = buildYoutubeQuery(query, genre);
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=playlist&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(settings.youtubeKey)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    try {
        const data = await httpsGetJson(url);
        const results = (data.items || []).map((item) => ({
            source: "youtube-playlist",
            title: item.snippet.title,
            thumb: (item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url,
            playlistId: item.id.playlistId
        }));
        return { results, cursor: data.nextPageToken || null };
    } catch (e) { return { results: [], cursor: null }; }
}

async function fetchPlaylistVideos(playlistId, pageToken) {
    let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=25&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(settings.youtubeKey)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    try {
        const data = await httpsGetJson(url);
        const results = (data.items || [])
            .filter((item) => item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId)
            .map((item) => {
                const thumbs = item.snippet.thumbnails || {};
                return {
                    source: "youtube",
                    title: item.snippet.title,
                    thumb: (thumbs.medium || thumbs.default || {}).url || "",
                    full: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
                    ext: ".mp4"
                };
            });
        return { results, cursor: data.nextPageToken || null };
    } catch (e) { return { results: [], cursor: null }; }
}

function scanLocalFolder(folderPath, query, genre) {
    const exts = [".gif", ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov"];
    const results = [];
    const q = (query || "").toLowerCase();
    const genreWords = genre && GENRE_KEYWORDS[genre] ? GENRE_KEYWORDS[genre] : null;

    function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            const ext = path.extname(entry.name).toLowerCase();
            if (exts.indexOf(ext) === -1) continue;

            const base = entry.name.replace(ext, "");
            const tags = base.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((s) => s.toLowerCase());
            tags.push(path.basename(dir).toLowerCase());

            const matchesQuery = !q || tags.some((t) => t.indexOf(q) !== -1);
            const matchesGenre = !genreWords || tags.some((t) => genreWords.indexOf(t) !== -1);

            if (matchesQuery && matchesGenre) {
                results.push({
                    source: "local",
                    title: entry.name,
                    thumb: "file://" + full,
                    full: full,
                    ext: ext
                });
            }
        }
    }

    if (folderPath) walk(folderPath);
    return results;
}

let lastResults = [];
let selectedResultIndex = -1;
let searchState = {
    query: "", genre: "", typeFilter: "all",
    youtubeContentType: "video", youtubeDuration: "medium", youtubeOrder: "relevance", youtubeSearchEngine: "api",
    giphyCursor: 0, tenorCursor: null, youtubeCursor: null, ytdlpFetchedCount: 0
};
let playlistContext = null; // { playlistId, title, cursor } once a playlist is opened

function updateYoutubeOptionsVisibility() {
    const isYoutube = $("typeFilter").value === "youtube";
    const isYtdlp = $("youtubeSearchEngine").value === "ytdlp";
    $("youtubeOptions").hidden = !isYoutube;
    $("youtubeHint").hidden = !isYoutube;
    $("youtubeVideoOnlyOptions").hidden = isYtdlp;
    $("ytdlpSearchHint").hidden = !isYtdlp;
}
$("typeFilter").addEventListener("change", updateYoutubeOptionsVisibility);
$("youtubeSearchEngine").addEventListener("change", updateYoutubeOptionsVisibility);
updateYoutubeOptionsVisibility();

async function fetchResultsPage(params, isFirstPage) {
    const effectiveQuery = params.genre && !params.query ? params.genre : params.query;
    let results = [];
    let anyMore = false;
    let error = null;

    if (playlistContext) {
        const pl = await fetchPlaylistVideos(playlistContext.playlistId, isFirstPage ? null : playlistContext.cursor);
        results = pl.results;
        playlistContext.cursor = pl.cursor;
        anyMore = !!pl.cursor;
    } else if (params.genre === "recent") {
        if (isFirstPage) {
            const q = params.query.toLowerCase();
            results = loadRecentDownloads().filter((r) => !q || (r.title || "").toLowerCase().indexOf(q) !== -1);
        }
    } else if (params.typeFilter === "youtube") {
        if (params.youtubeContentType === "playlist") {
            // Playlist search always uses the official API - yt-dlp doesn't
            // have an equivalent playlist-search mode.
            const pl = await searchYoutubePlaylists(params.query, params.genre, isFirstPage ? null : searchState.youtubeCursor);
            results = pl.results;
            searchState.youtubeCursor = pl.cursor;
            anyMore = !!pl.cursor;
        } else if (params.youtubeSearchEngine === "ytdlp") {
            const nextCount = isFirstPage ? 15 : searchState.ytdlpFetchedCount + 15;
            const yt = await searchYoutubeViaYtDlp(params.query, params.genre, nextCount);
            error = yt.error;
            const already = isFirstPage ? 0 : searchState.ytdlpFetchedCount;
            results = yt.results.slice(already);
            searchState.ytdlpFetchedCount = yt.results.length;
            anyMore = yt.results.length >= nextCount;
        } else {
            const yt = await searchYouTube(params.query, params.genre, isFirstPage ? null : searchState.youtubeCursor, params.youtubeDuration, params.youtubeOrder);
            results = yt.results;
            searchState.youtubeCursor = yt.cursor;
            anyMore = !!yt.cursor;
        }
    } else {
        if (params.typeFilter !== "local") {
            const [giphy, tenor] = await Promise.all([
                searchGiphy(effectiveQuery, 15, isFirstPage ? 0 : searchState.giphyCursor),
                searchTenor(effectiveQuery, 15, isFirstPage ? null : searchState.tenorCursor)
            ]);
            results.push(...giphy.results, ...tenor.results);
            searchState.giphyCursor = giphy.cursor;
            searchState.tenorCursor = tenor.cursor;
            anyMore = !!giphy.cursor || !!tenor.cursor;
        }
        if (isFirstPage && (params.typeFilter !== "gif" || params.typeFilter === "local")) {
            results.push(...scanLocalFolder(settings.localFolder, params.query, params.genre));
        }
    }

    return { results, anyMore, error };
}

$("btnSearch").addEventListener("click", async () => {
    playlistContext = null;
    $("playlistBreadcrumb").hidden = true;
    searchState = {
        query: $("searchQuery").value.trim(),
        genre: $("genreFilter").value,
        typeFilter: $("typeFilter").value,
        youtubeContentType: $("youtubeContentType").value,
        youtubeSearchEngine: $("youtubeSearchEngine").value,
        youtubeDuration: $("youtubeDuration").value,
        youtubeOrder: $("youtubeOrder").value,
        giphyCursor: 0,
        tenorCursor: null,
        youtubeCursor: null,
        ytdlpFetchedCount: 0
    };

    setStatus("Searching...");
    selectedResultIndex = -1;

    const { results, anyMore, error } = await fetchResultsPage(searchState, true);
    lastResults = results;
    renderResults(lastResults);
    $("btnLoadMore").hidden = !anyMore;

    if (error) {
        setStatus(error, true);
    } else if (!results.length) {
        setStatus("No results. Check your API keys / local folder in Settings, or try a different search.", true);
    } else {
        setStatus(`Found ${results.length} result(s).`);
    }
});

$("btnLoadMore").addEventListener("click", async () => {
    setStatus("Loading more...");
    const { results, anyMore, error } = await fetchResultsPage(searchState, false);
    if (error) { setStatus(error, true); return; }
    lastResults = lastResults.concat(results);
    renderResults(lastResults);
    $("btnLoadMore").hidden = !anyMore;
    setStatus(`Found ${lastResults.length} result(s) total.`);
});

async function openPlaylist(result) {
    playlistContext = { playlistId: result.playlistId, title: result.title, cursor: null };
    selectedResultIndex = -1;
    setStatus(`Opening playlist "${result.title}"...`);

    const breadcrumb = $("playlistBreadcrumb");
    breadcrumb.hidden = false;
    breadcrumb.innerHTML = "";
    const back = document.createElement("a");
    back.href = "#";
    back.textContent = "< Back to search results";
    back.style.color = "#4a9eff";
    back.addEventListener("click", (e) => {
        e.preventDefault();
        playlistContext = null;
        breadcrumb.hidden = true;
        lastResults = [];
        renderResults([]);
        $("btnLoadMore").hidden = true;
        setStatus("Back to search.");
    });
    breadcrumb.appendChild(back);
    breadcrumb.appendChild(document.createTextNode(` - Playlist: ${result.title}`));

    const { results, anyMore } = await fetchResultsPage(searchState, true);
    lastResults = results;
    renderResults(lastResults);
    $("btnLoadMore").hidden = !anyMore;
    setStatus(results.length ? `Found ${results.length} video(s) in this playlist.` : "This playlist has no videos, or they're private/unavailable.");
}

function renderResults(results) {
    const grid = $("resultsGrid");
    grid.innerHTML = "";
    results.forEach((r, i) => {
        const cell = document.createElement("div");
        cell.className = "result-cell";
        const label = r.source === "youtube-playlist" ? "playlist" : r.source;
        cell.innerHTML = `<img src="${r.thumb}" alt="${escapeHtml(r.title || "")}" /><div class="result-label">${escapeHtml(label)}</div>`;
        cell.addEventListener("click", () => {
            document.querySelectorAll(".result-cell").forEach((c) => c.classList.remove("selected"));
            cell.classList.add("selected");
            selectedResultIndex = i;
        });
        if (r.source === "youtube-playlist") {
            cell.addEventListener("dblclick", () => openPlaylist(r));
            cell.title = "Double-click to open this playlist";
        }
        grid.appendChild(cell);
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("btnInsert").addEventListener("click", async () => {
    if (selectedResultIndex < 0) { setStatus("Select a result first.", true); return; }
    const result = lastResults[selectedResultIndex];
    if (result.source === "youtube-playlist") {
        setStatus("That's a playlist, not a video - double-click it to open it, then select a video inside.", true);
        return;
    }
    const mode = $("insertMode").value;

    setStatus("Preparing media...");
    let localPath = result.full;
    const alreadyLocal = result.source === "local" || result.source === "recent";

    if (result.source === "youtube") {
        const cacheDir = getCacheDir();
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        localPath = path.join(cacheDir, `yt_${Date.now()}.mp4`);
        setStatus("Downloading video with yt-dlp (this brings in the full source video)...");
        const ytResult = await downloadYoutubeVideo(result.full, localPath);
        if (!ytResult.ok) { setStatus(ytResult.error, true); return; }
        addRecentDownload({ source: "recent", title: result.title, thumb: localPath, full: localPath, ext: ".mp4" });
    } else if (!alreadyLocal) {
        try {
            const cacheDir = getCacheDir();
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            const fileName = `meme_${Date.now()}${result.ext}`;
            localPath = path.join(cacheDir, fileName);
            setStatus("Downloading media...");
            await downloadFile(result.full, localPath);
            addRecentDownload({ source: "recent", title: result.title, thumb: localPath, full: localPath, ext: result.ext });
        } catch (e) {
            setStatus("Download failed: " + e.message, true);
            return;
        }
    }

    setStatus("Inserting into the timeline...");
    const insertResult = await callHost("$$eh_insertMediaAtPlayhead", [localPath, mode]);
    if (!insertResult.ok) { setStatus("Error: " + insertResult.error, true); return; }
    setStatus(`Inserted on track V${insertResult.track + 1} at ${insertResult.time.toFixed(2)}s.`);
});

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
function populateSettingsForm() {
    $("giphyKey").value = settings.giphyKey;
    $("tenorKey").value = settings.tenorKey;
    $("youtubeKey").value = settings.youtubeKey;
    $("localFolder").value = settings.localFolder;
    $("presetsFolder").value = settings.presetsFolder;
    $("ffmpegPath").value = settings.ffmpegPath;
    $("whisperPath").value = settings.whisperPath;
    $("ytDlpPath").value = settings.ytDlpPath;
    $("targetLufs").value = settings.targetLufs;
    $("minGap").value = settings.minGapSeconds;
}

$("btnSaveSettings").addEventListener("click", () => {
    settings.giphyKey = $("giphyKey").value.trim();
    settings.tenorKey = $("tenorKey").value.trim();
    settings.youtubeKey = $("youtubeKey").value.trim();
    settings.localFolder = $("localFolder").value.trim();
    settings.presetsFolder = $("presetsFolder").value.trim();
    settings.ffmpegPath = $("ffmpegPath").value.trim() || "ffmpeg";
    settings.whisperPath = $("whisperPath").value.trim() || "whisper";
    settings.ytDlpPath = $("ytDlpPath").value.trim() || "yt-dlp";
    saveSettings(settings);
    setStatus("Settings saved.");
    renderPresetsList();
});

$("btnBrowseFolder").addEventListener("click", () => {
    // No native folder picker without extra Node deps - accept a pasted path instead.
    setStatus("Paste the full path to your meme/GIF folder into the field, then click Save.");
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
    populateSettingsForm();
    const status = await callHost("$$eh_getStatus", []);
    const versionTag = status.hostVersion ? ` [host ${status.hostVersion}]` : " [host version unknown - very old host/index.jsx]";
    if (status.ok && status.hasSequence) {
        setStatus(`Connected to sequence "${status.sequenceName}".${versionTag}`);
    } else if (status.ok) {
        setStatus(`Open a sequence in Premiere Pro to get started.${versionTag}`);
    } else {
        setStatus("Error talking to Premiere: " + status.error, true);
    }
}

init();
