// Edit Helper - ExtendScript host code
// Runs inside Premiere Pro's ExtendScript engine. Every function here is called
// from the panel via CSInterface.evalScript() and returns a JSON string.

app.enableQE();

function $$eh_ok(data) {
    data = data || {};
    data.ok = true;
    return JSON.stringify(data);
}

function $$eh_err(message) {
    return JSON.stringify({ ok: false, error: String(message) });
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
function $$eh_applyAudioGains(entriesJSON) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return $$eh_err("No active sequence. Open a sequence first.");

        var entries = JSON.parse(entriesJSON);
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
        if (!seq) return $$eh_ok({ hasSequence: false });
        return $$eh_ok({
            hasSequence: true,
            sequenceName: seq.name,
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: seq.audioTracks.numTracks
        });
    } catch (e) {
        return $$eh_err(e);
    }
}
