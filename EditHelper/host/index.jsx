// Edit Helper - ExtendScript host code
// Runs inside Premiere Pro's ExtendScript engine. Every function here is called
// from the panel via CSInterface.evalScript() and returns a JSON string.

// Bump this whenever this file changes - shown in the panel's status bar on
// load, so a stale/partially-updated install is immediately visible instead
// of guessing from generic error messages.
var EH_HOST_VERSION = "2026-08-31-3";

// Some ExtendScript engines don't ship a native JSON object (older, or
// certain app/version combinations) - every function in this file returns
// its result via JSON.stringify, so if it's missing, absolutely everything
// fails the instant it tries to return anything, while plain expressions
// (that never touch JSON) work completely fine. That mismatch is exactly
// what pointed here. This polyfill only ever runs if JSON is truly absent.
if (typeof JSON === "undefined") {
    var JSON = {};
    JSON.stringify = function (value) {
        var type = typeof value;
        if (value === null || value === undefined) return "null";
        if (type === "number" || type === "boolean") return String(value);
        if (type === "string") {
            return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        }
        if (value instanceof Array) {
            var arrItems = [];
            for (var i = 0; i < value.length; i++) arrItems.push(JSON.stringify(value[i]));
            return "[" + arrItems.join(",") + "]";
        }
        if (type === "object") {
            var objItems = [];
            for (var key in value) {
                var v = value[key];
                if (typeof v === "function" || typeof v === "undefined") continue;
                objItems.push(JSON.stringify(key) + ":" + JSON.stringify(v));
            }
            return "{" + objItems.join(",") + "}";
        }
        return "null";
    };
    // Only ever parses JSON this file itself generated and sent across the
    // CEP bridge, or argument JSON built by the panel's own JSON.stringify -
    // not arbitrary external input - so eval() here is safe.
    JSON.parse = function (text) {
        return eval("(" + text + ")");
    };
}

app.enableQE();

function $$eh_ok(data) {
    data = data || {};
    data.ok = true;
    return JSON.stringify(data);
}

function $$eh_err(message) {
    return JSON.stringify({ ok: false, error: String(message) });
}

// Single, pre-written entry point the panel calls for everything, instead
// of building a new try/catch wrapper as a text string on every call. A
// dynamically-built wrapper string only gets checked by the ExtendScript
// parser at the moment it's submitted - if anything about that construction
// is wrong for this engine, it fails before our own try/catch ever runs,
// which is indistinguishable from every other failure (CEP just reports the
// generic "EvalScript error." either way). This function is parsed once,
// with the file, so its own correctness doesn't depend on what gets called
// through it. argsJson is a JSON-encoded array of arguments.
function $$eh_dispatch(fnName, argsJson) {
    try {
        var fn = this[fnName];
        if (typeof fn !== "function") {
            return $$eh_err("Unknown host function: " + fnName + " (host version " + EH_HOST_VERSION + ")");
        }
        var args = argsJson ? JSON.parse(argsJson) : [];
        return fn.apply(this, args);
    } catch (e) {
        return $$eh_err(e);
    }
}

// ---------------------------------------------------------------------------
// Gap removal
// ---------------------------------------------------------------------------
// Premiere's public scripting DOM does not expose gap/empty-space info or a
// ripple-delete call. We use the "QE" (Quality Engineering) DOM instead - an
// older, undocumented-but-stable API that many published Premiere scripts
// (gap-removal / "gap cutter" style panels) rely on for exactly this.
function $$eh_removeGaps(minGapSeconds, scope) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return $$eh_err("Could not access the QE DOM for the active sequence.");

        minGapSeconds = parseFloat(minGapSeconds) || 0;
        scope = scope || "all";

        var tracks = [];
        if (scope === "video" || scope === "all") {
            for (var v = 0; v < qeSeq.numVideoTracks; v++) tracks.push(qeSeq.getVideoTrackAt(v));
        }
        if (scope === "audio" || scope === "all") {
            for (var a = 0; a < qeSeq.numAudioTracks; a++) tracks.push(qeSeq.getAudioTrackAt(a));
        }

        var removed = 0;
        var skipped = 0;

        for (var t = 0; t < tracks.length; t++) {
            var track = tracks[t];
            if (!track) continue;
            // Walk backwards so removing an item never shifts the index of the
            // next item we still need to visit.
            for (var i = track.numItems - 1; i >= 0; i--) {
                var item = track.getItemAt(i);
                if (!item) continue;
                if (item.type === "Empty") {
                    var start = parseFloat(item.start);
                    var end = parseFloat(item.end);
                    var length = end - start;
                    if (length >= minGapSeconds) {
                        try {
                            item.remove(true, true); // ripple delete: close the gap, shift later clips left
                            removed++;
                        } catch (e) {
                            skipped++;
                        }
                    }
                }
            }
        }

        return $$eh_ok({ removed: removed, skipped: skipped });
    } catch (e) {
        return $$eh_err(e);
    }
}

// ---------------------------------------------------------------------------
// Audio: gather source media for clips, then apply a computed gain
// ---------------------------------------------------------------------------
function $$eh_getClipSources(onlySelected) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var results = [];
        var audioTracks = seq.audioTracks;

        for (var ti = 0; ti < audioTracks.numTracks; ti++) {
            var track = audioTracks[ti];
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                var clip = track.clips[ci];
                var selected = false;
                try { selected = !!clip.isSelected(); } catch (e) {}
                if (onlySelected && !selected) continue;

                var mediaPath = "";
                try { mediaPath = clip.projectItem.getMediaPath(); } catch (e2) {}

                if (mediaPath) {
                    results.push({
                        trackIndex: ti,
                        clipIndex: ci,
                        name: clip.name,
                        mediaPath: mediaPath
                    });
                }
            }
        }

        return $$eh_ok({ clips: results });
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_findLevelParam(clip) {
    try {
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var comp = comps[i];
            if (comp.displayName === "Volume") {
                for (var p = 0; p < comp.properties.numItems; p++) {
                    var prop = comp.properties[p];
                    if (prop.displayName === "Level") return prop;
                }
            }
        }
    } catch (e) {}
    return null;
}

// entries: JSON string of [{trackIndex, clipIndex, gainDb}, ...]
function $$eh_applyAudioGains(entries) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var audioTracks = seq.audioTracks;
        var applied = 0;
        var failed = [];

        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            try {
                var track = audioTracks[entry.trackIndex];
                var clip = track.clips[entry.clipIndex];
                var levelParam = $$eh_findLevelParam(clip);
                if (!levelParam) {
                    failed.push(clip.name || (entry.trackIndex + ":" + entry.clipIndex));
                    continue;
                }
                var current = 0;
                try { current = levelParam.getValue(); } catch (e2) { current = 0; }
                levelParam.setValue(current + entry.gainDb, true);
                applied++;
            } catch (e3) {
                failed.push(String(e3));
            }
        }

        return $$eh_ok({ applied: applied, failed: failed });
    } catch (e) {
        return $$eh_err(e);
    }
}

// ---------------------------------------------------------------------------
// Meme / GIF / image insertion
// ---------------------------------------------------------------------------
function $$eh_insertMediaAtPlayhead(filePath, mode) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        app.project.importFiles([filePath], true, app.project.rootItem, false);

        var projectItem = null;
        var root = app.project.rootItem;
        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var child = root.children[i];
            var childPath = "";
            try { childPath = child.getMediaPath(); } catch (e) {}
            if (childPath === filePath) { projectItem = child; break; }
        }
        if (!projectItem) return $$eh_err("Import succeeded but the project item could not be located.");

        var targetTrackIndex = seq.videoTracks.numTracks - 1;
        var track = seq.videoTracks[targetTrackIndex];
        var playheadSeconds = parseFloat(seq.getPlayerPosition().seconds);

        if (mode === "overwrite") {
            track.overwriteClip(projectItem, playheadSeconds);
        } else {
            track.insertClip(projectItem, playheadSeconds);
        }

        return $$eh_ok({ track: targetTrackIndex, time: playheadSeconds });
    } catch (e) {
        return $$eh_err(e);
    }
}

// ---------------------------------------------------------------------------
// Subtitles: locate the clip to transcribe, get sequence resolution, and
// drop the rendered subtitle overlay in at the right spot
// ---------------------------------------------------------------------------
function $$eh_getSelectedVideoClip() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var videoTracks = seq.videoTracks;
        for (var ti = 0; ti < videoTracks.numTracks; ti++) {
            var track = videoTracks[ti];
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                var clip = track.clips[ci];
                var selected = false;
                try { selected = !!clip.isSelected(); } catch (e) {}
                if (!selected) continue;

                var mediaPath = "";
                try { mediaPath = clip.projectItem.getMediaPath(); } catch (e2) {}
                if (!mediaPath) continue;

                var startSec = parseFloat(clip.start.seconds);
                var endSec = parseFloat(clip.end.seconds);
                var inSec = 0;
                try { inSec = parseFloat(clip.inPoint.seconds); } catch (e3) {}

                return $$eh_ok({
                    trackIndex: ti,
                    clipIndex: ci,
                    name: clip.name,
                    mediaPath: mediaPath,
                    start: startSec,
                    end: endSec,
                    duration: endSec - startSec,
                    sourceIn: inSec
                });
            }
        }
        return $$eh_err("No video clip selected. Click a clip on the timeline first.");
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_getFrameSize() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");
        var settings = seq.getSettings();
        return $$eh_ok({
            width: settings.videoFrameWidth,
            height: settings.videoFrameHeight
        });
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_insertOverlayAtTime(filePath, startSeconds) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        app.project.importFiles([filePath], true, app.project.rootItem, false);

        var projectItem = null;
        var root = app.project.rootItem;
        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var child = root.children[i];
            var childPath = "";
            try { childPath = child.getMediaPath(); } catch (e) {}
            if (childPath === filePath) { projectItem = child; break; }
        }
        if (!projectItem) return $$eh_err("Import succeeded but the project item could not be located.");

        var targetTrackIndex = seq.videoTracks.numTracks - 1;
        var track = seq.videoTracks[targetTrackIndex];
        track.overwriteClip(projectItem, parseFloat(startSeconds));

        return $$eh_ok({ track: targetTrackIndex, time: parseFloat(startSeconds) });
    } catch (e) {
        return $$eh_err(e);
    }
}

// ---------------------------------------------------------------------------
// Quick Edit: personal presets + built-in Motion-based effects
// ---------------------------------------------------------------------------
// Premiere's public scripting API has no documented "apply preset" or
// "keyframe an arbitrary effect" call, so this - like gap removal - leans on
// the QE DOM (for presets) and on the Motion effect that every video clip
// carries by default (for zoom/shake). This is the least-tested corner of
// the whole panel; if a Quick Edit action errors, the exact message here is
// what to go on.
function $$eh_getSelectedClipAnyTrack() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var groups = [
            { tracks: seq.videoTracks, type: "video" },
            { tracks: seq.audioTracks, type: "audio" }
        ];
        for (var g = 0; g < groups.length; g++) {
            var tracks = groups[g].tracks;
            for (var ti = 0; ti < tracks.numTracks; ti++) {
                var track = tracks[ti];
                for (var ci = 0; ci < track.clips.numItems; ci++) {
                    var clip = track.clips[ci];
                    var selected = false;
                    try { selected = !!clip.isSelected(); } catch (e) {}
                    if (selected) {
                        return $$eh_ok({ trackType: groups[g].type, trackIndex: ti, clipIndex: ci, name: clip.name });
                    }
                }
            }
        }
        return $$eh_err("No clip selected. Click a clip on the timeline first.");
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_applyPresetToSelectedClip(presetPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var clipResult = JSON.parse($$eh_getSelectedClipAnyTrack());
        if (!clipResult.ok) return $$eh_err(clipResult.error);

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return $$eh_err("Could not access the QE DOM for the active sequence.");

        var qeTrack = clipResult.trackType === "video"
            ? qeSeq.getVideoTrackAt(clipResult.trackIndex)
            : qeSeq.getAudioTrackAt(clipResult.trackIndex);
        if (!qeTrack) return $$eh_err("Could not access that track via the QE DOM.");

        var qeItem = qeTrack.getItemAt(clipResult.clipIndex);
        if (!qeItem) return $$eh_err("Could not access that clip via the QE DOM.");

        qeItem.filters.addPreset(presetPath);
        return $$eh_ok({ applied: presetPath });
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_findComponentProperty(clip, componentDisplayName, propertyDisplayName) {
    try {
        var comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var comp = comps[i];
            if (comp.displayName === componentDisplayName) {
                for (var p = 0; p < comp.properties.numItems; p++) {
                    var prop = comp.properties[p];
                    if (prop.displayName === propertyDisplayName) return prop;
                }
            }
        }
    } catch (e) {}
    return null;
}

// kind: "zoomIn" | "zoomOut" | "shake" | "impactPunch"
// paramValue: seconds (zoom ramp duration) or pixels (shake intensity)
function $$eh_applyMotionEffect(kind, paramValue) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var clipResult = JSON.parse($$eh_getSelectedVideoClip());
        if (!clipResult.ok) return $$eh_err(clipResult.error);

        var track = seq.videoTracks[clipResult.trackIndex];
        var clip = track.clips[clipResult.clipIndex];

        var TICKS_PER_SECOND = 254016000000;
        function toTicks(sec) { return Math.round(sec * TICKS_PER_SECOND); }

        var scaleProp = $$eh_findComponentProperty(clip, "Motion", "Scale");
        var positionProp = $$eh_findComponentProperty(clip, "Motion", "Position");
        paramValue = parseFloat(paramValue);

        if (kind === "zoomIn" || kind === "zoomOut") {
            if (!scaleProp) return $$eh_err("Could not find the Motion/Scale property on this clip.");
            var duration = Math.min(Math.max(paramValue, 0.1), Math.max(clipResult.duration, 0.2));
            var startScale = 100;
            var endScale = kind === "zoomIn" ? 130 : 80;
            scaleProp.setTimeVarying(true);
            scaleProp.addKey(0);
            scaleProp.setValueAtKey(0, startScale, true);
            scaleProp.addKey(toTicks(duration));
            scaleProp.setValueAtKey(toTicks(duration), endScale, true);
            return $$eh_ok({ applied: kind, duration: duration });
        }

        if (kind === "shake" || kind === "impactPunch") {
            if (!positionProp) return $$eh_err("Could not find the Motion/Position property on this clip.");
            var intensity = Math.max(paramValue, 1);
            var basePos = positionProp.getValue();
            var baseX = basePos[0], baseY = basePos[1];
            var shakeDuration = 0.35;
            var steps = 8;
            positionProp.setTimeVarying(true);
            for (var s = 0; s <= steps; s++) {
                var t = (shakeDuration / steps) * s;
                var offsetX = (s === steps) ? 0 : (Math.random() - 0.5) * 2 * intensity;
                var offsetY = (s === steps) ? 0 : (Math.random() - 0.5) * 2 * intensity;
                var ticks = toTicks(t);
                positionProp.addKey(ticks);
                positionProp.setValueAtKey(ticks, [baseX + offsetX, baseY + offsetY], true);
            }

            if (kind === "impactPunch" && scaleProp) {
                scaleProp.setTimeVarying(true);
                scaleProp.addKey(0);
                scaleProp.setValueAtKey(0, 115, true);
                scaleProp.addKey(toTicks(shakeDuration));
                scaleProp.setValueAtKey(toTicks(shakeDuration), 100, true);
            }

            return $$eh_ok({ applied: kind, intensity: intensity });
        }

        return $$eh_err("Unknown effect kind: " + kind);
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_addVideoTrack() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");
        seq.addTracks(1, seq.videoTracks.numTracks, 0, 0, 1);
        return $$eh_ok({ numVideoTracks: seq.videoTracks.numTracks });
    } catch (e) {
        return $$eh_err(e);
    }
}

function $$eh_getStatus() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_ok({ hasSequence: false, hostVersion: EH_HOST_VERSION });
        return $$eh_ok({
            hasSequence: true,
            sequenceName: seq.name,
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: seq.audioTracks.numTracks,
            hostVersion: EH_HOST_VERSION
        });
    } catch (e) {
        return $$eh_err(e);
    }
}
