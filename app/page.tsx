"use client";

import { useCallback, useState } from "react";
import { Midi } from "@tonejs/midi";
import {
  convertMidiToRobotC,
  summarizeTracks,
  TrackSummary,
} from "@/lib/midiToRobotC";

export default function Home() {
  const [midiData, setMidiData] = useState<Midi | null>(null);
  const [fileName, setFileName] = useState("");
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [selectedTrack, setSelectedTrack] = useState(0);
  const [code, setCode] = useState("");
  const [noteCount, setNoteCount] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const runConversion = useCallback((midi: Midi, trackIndex: number) => {
    try {
      const result = convertMidiToRobotC(midi, { trackIndex });
      setCode(result.code);
      setNoteCount(result.noteCount);
      setDurationSeconds(result.durationSeconds);
      setError("");
    } catch (err) {
      setCode("");
      setError(err instanceof Error ? err.message : "Conversion failed.");
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setError("");
      setCode("");
      if (!/\.midi?$/i.test(file.name)) {
        setError("Please upload a .mid or .midi file.");
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        const midi = new Midi(buffer);
        const summaries = summarizeTracks(midi);
        const firstNonEmpty = summaries.findIndex((t) => t.noteCount > 0);
        const idx = firstNonEmpty >= 0 ? firstNonEmpty : 0;

        setMidiData(midi);
        setFileName(file.name);
        setTracks(summaries);
        setSelectedTrack(idx);
        runConversion(midi, idx);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not parse MIDI file: ${err.message}`
            : "Could not parse MIDI file."
        );
      }
    },
    [runConversion]
  );

  const handleTrackChange = (idx: number) => {
    setSelectedTrack(idx);
    if (midiData) runConversion(midiData, idx);
  };

  const downloadCode = () => {
    if (!code) return;
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.midi?$/i, "") || "song"}.c`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main>
      <h1>MIDI → LEGO NXT RobotC Converter</h1>
      <p className="subtitle">
        Upload a MIDI file and get RobotC source code that plays the melody
        through the NXT brick's speaker using <code>PlayTone()</code>.
      </p>

      <label
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
      >
        <input
          type="file"
          accept=".mid,.midi"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <div>
          <span className="file-label">Click to upload</span> or drag a .mid
          file here
        </div>
      </label>

      {error && <div className="error">{error}</div>}

      {tracks.length > 0 && (
        <div className="controls">
          <label htmlFor="track-select">Track:</label>
          <select
            id="track-select"
            value={selectedTrack}
            onChange={(e) => handleTrackChange(Number(e.target.value))}
          >
            {tracks.map((t) => (
              <option key={t.index} value={t.index}>
                {t.name} ({t.noteCount} notes)
              </option>
            ))}
          </select>
          <button onClick={downloadCode} disabled={!code}>
            Download .c file
          </button>
        </div>
      )}

      {code && (
        <>
          <div className="meta-row">
            <span>{noteCount} notes converted</span>
            <span>~{durationSeconds.toFixed(1)}s playback</span>
          </div>
          <textarea readOnly value={code} spellCheck={false} />
        </>
      )}

      <p className="note">
        Notes: RobotC's <code>PlayTone(frequency, duration)</code> takes
        duration in hundredths of a second and the NXT speaker reliably
        reproduces roughly 220Hz–14kHz, so pitches outside that range are
        clamped. Very short notes (under 30ms) are dropped as noise. This
        targets a single-voice melody line — pick the track with the melody
        you want (usually not the drum/percussion track) since the NXT
        speaker can only play one tone at a time.
      </p>
    </main>
  );
}
