/* Edit Helper panel logic. Runs in the CEP panel's Chromium context with
 * Node.js integration enabled (--enable-nodejs --mixed-context in the
 * manifest), so `require()` works directly here alongside the DOM. */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const csInterface = new CSInterface();

// ---------------------------------------------------------------------------
// Settings (persisted in localStorage - this is per-panel, local to the
// machine; API keys never leave the machine except in the direct HTTPS call
// to Giphy/Tenor's own servers to run the search the user asked for)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    giphyKey: "",
    tenorKey: "",
    localFolder: "",
    ffmpegPath: "ffmpeg",
    targetLufs: -16,
    minGapSeconds: 0.2
};

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

function evalScript(script) {
    return new Promise((resolve) => {
        csInterface.evalScript(script, (result) => {
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

    const script = `$$eh_removeGaps(${minGap}, "${scope}")`;
    const result = await evalScript(script);
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
            const text = stderr || "";
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                resolve({ ok: false, error: "ffmpeg did not return loudness data. Is ffmpeg installed and on PATH?" });
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
    const info = await evalScript(`$$eh_getClipSources(${onlySelected})`);
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

    for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        setStatus(`Measuring loudness (${i + 1}/${clips.length}): ${clip.name}`);

        let measurement = cache.get(clip.mediaPath);
        if (!measurement) {
            measurement = await runFfmpegLoudnorm(clip.mediaPath, targetI);
            cache.set(clip.mediaPath, measurement);
        }

        if (!measurement.ok) { failures++; continue; }

        const gainDb = computeGainDb(measurement.inputI, measurement.inputTp, targetI);
        entries.push({ trackIndex: clip.trackIndex, clipIndex: clip.clipIndex, gainDb: gainDb });
    }

    if (!entries.length) {
        setStatus("Could not measure any clips. " + (failures ? "Make sure ffmpeg is installed (see Settings)." : ""), true);
        return;
    }

    setStatus("Applying gain to clips in Premiere...");
    const applyResult = await evalScript(`$$eh_applyAudioGains(${JSON.stringify(JSON.stringify(entries))})`);
    if (!applyResult.ok) { setStatus("Error applying gain: " + applyResult.error, true); return; }

    setStatus(`Normalized ${applyResult.applied} clip(s) to ${targetI} LUFS.` + (failures ? ` (${failures} clip(s) could not be measured.)` : ""));
});

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

async function searchGiphy(query, limit) {
    if (!settings.giphyKey) return [];
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(settings.giphyKey)}&q=${encodeURIComponent(query)}&limit=${limit}&rating=pg-13`;
    try {
        const data = await httpsGetJson(url);
        return (data.data || []).map((g) => ({
            source: "giphy",
            title: g.title,
            thumb: g.images.fixed_height_small.url,
            full: g.images.original.url,
            ext: ".gif"
        }));
    } catch (e) { return []; }
}

async function searchTenor(query, limit) {
    if (!settings.tenorKey) return [];
    const url = `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(settings.tenorKey)}&q=${encodeURIComponent(query)}&limit=${limit}&contentfilter=medium`;
    try {
        const data = await httpsGetJson(url);
        return (data.results || []).map((r) => ({
            source: "tenor",
            title: r.content_description,
            thumb: r.media_formats.tinygif ? r.media_formats.tinygif.url : r.media_formats.gif.url,
            full: r.media_formats.gif.url,
            ext: ".gif"
        }));
    } catch (e) { return []; }
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

$("btnSearch").addEventListener("click", async () => {
    const query = $("searchQuery").value.trim();
    const genre = $("genreFilter").value;
    const typeFilter = $("typeFilter").value;
    const effectiveQuery = genre && !query ? genre : query;

    setStatus("Searching...");
    $("resultsGrid").innerHTML = "";
    selectedResultIndex = -1;

    const results = [];

    if (typeFilter !== "local") {
        const [giphyResults, tenorResults] = await Promise.all([
            searchGiphy(effectiveQuery, 15),
            searchTenor(effectiveQuery, 15)
        ]);
        results.push(...giphyResults, ...tenorResults);
    }
    if (typeFilter !== "gif" || typeFilter === "local") {
        results.push(...scanLocalFolder(settings.localFolder, query, genre));
    }

    lastResults = results;
    renderResults(results);

    if (!results.length) {
        setStatus("No results. Check your API keys / local folder in Settings, or try a different search.", true);
    } else {
        setStatus(`Found ${results.length} result(s).`);
    }
});

function renderResults(results) {
    const grid = $("resultsGrid");
    grid.innerHTML = "";
    results.forEach((r, i) => {
        const cell = document.createElement("div");
        cell.className = "result-cell";
        cell.innerHTML = `<img src="${r.thumb}" alt="${escapeHtml(r.title || "")}" /><div class="result-label">${escapeHtml(r.source)}</div>`;
        cell.addEventListener("click", () => {
            document.querySelectorAll(".result-cell").forEach((c) => c.classList.remove("selected"));
            cell.classList.add("selected");
            selectedResultIndex = i;
        });
        grid.appendChild(cell);
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("btnInsert").addEventListener("click", async () => {
    if (selectedResultIndex < 0) { setStatus("Select a result first.", true); return; }
    const result = lastResults[selectedResultIndex];
    const mode = $("insertMode").value;

    setStatus("Preparing media...");
    let localPath = result.full;

    if (result.source !== "local") {
        try {
            const cacheDir = path.join(csInterface.getSystemPath(CSInterface.SystemPath.USER_DATA) || ".", "edit-helper-cache");
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            const fileName = `meme_${Date.now()}${result.ext}`;
            localPath = path.join(cacheDir, fileName);
            setStatus("Downloading media...");
            await downloadFile(result.full, localPath);
        } catch (e) {
            setStatus("Download failed: " + e.message, true);
            return;
        }
    }

    setStatus("Inserting into the timeline...");
    const insertResult = await evalScript(`$$eh_insertMediaAtPlayhead(${JSON.stringify(localPath)}, "${mode}")`);
    if (!insertResult.ok) { setStatus("Error: " + insertResult.error, true); return; }
    setStatus(`Inserted on track V${insertResult.track + 1} at ${insertResult.time.toFixed(2)}s.`);
});

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
function populateSettingsForm() {
    $("giphyKey").value = settings.giphyKey;
    $("tenorKey").value = settings.tenorKey;
    $("localFolder").value = settings.localFolder;
    $("ffmpegPath").value = settings.ffmpegPath;
    $("targetLufs").value = settings.targetLufs;
    $("minGap").value = settings.minGapSeconds;
}

$("btnSaveSettings").addEventListener("click", () => {
    settings.giphyKey = $("giphyKey").value.trim();
    settings.tenorKey = $("tenorKey").value.trim();
    settings.localFolder = $("localFolder").value.trim();
    settings.ffmpegPath = $("ffmpegPath").value.trim() || "ffmpeg";
    saveSettings(settings);
    setStatus("Settings saved.");
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
    const status = await evalScript("$$eh_getStatus()");
    if (status.ok && status.hasSequence) {
        setStatus(`Connected to sequence "${status.sequenceName}".`);
    } else {
        setStatus("Open a sequence in Premiere Pro to get started.");
    }
}

init();
