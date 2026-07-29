import { Midi } from "@tonejs/midi";

/** Precomputed standard equal-temperament frequency (Hz, rounded) for MIDI notes 0-127. */
const NOTE_FREQUENCIES: number[] = Array.from({ length: 128 }, (_, midiNote) =>
  Math.round(440 * Math.pow(2, (midiNote - 69) / 12))
);

export interface RobotCOptions {
  /** Which track in the MIDI file to convert (0-indexed). */
  trackIndex?: number;
  /** Skip notes shorter than this, in milliseconds. */
  minDurationMs?: number;
  /** NXT PlayTone reliably reproduces roughly 220Hz-14kHz; values are clamped to this range. */
  minFrequency?: number;
  maxFrequency?: number;
  /**
   * Minimum forced silence (ms) inserted between two consecutive notes that
   * share the same quantized pitch. Without this, repeated notes at the same
   * frequency can sound like a single held tone on the NXT buzzer, since the
   * waveform just continues instead of audibly re-attacking. Default 35ms.
   */
  retriggerGapMs?: number;
  /**
   * When the source track has overlapping notes (chords, a bass line under
   * a tune, sustain-pedal bleed, two hands on one track, etc.), extract a
   * single-voice melody line instead of just playing notes in start order.
   * "highest" keeps whichever note is on top at each instant (the usual
   * choice -- melody is almost always the top voice), "lowest" keeps the
   * bottom voice (e.g. for a bassline), "off" disables extraction and plays
   * every note as-is, clipped to stay monophonic. Default "highest".
   */
  melodyMode?: "highest" | "lowest" | "off";
  /** Soft ceiling used only to warn in a comment if the song is large for NXT's flash/RAM budget. */
  maxNotesPerTask?: number;
}

export interface ConversionResult {
  code: string;
  noteCount: number;
  rawNoteCount: number;
  trackName: string;
  durationSeconds: number;
}

interface CompactEvent {
  /** 0 = rest (silence), not a tone. */
  frequency: number;
  /** RobotC PlayTone duration unit = hundredths of a second. */
  durationCentiseconds: number;
}

interface SimpleNote {
  time: number; // seconds
  duration: number; // seconds
  midi: number;
}

/**
 * Reduces a (possibly polyphonic) list of notes to a single-voice melody
 * line via a sweep over note-on/note-off events. At every instant, only the
 * "highest" (or "lowest") currently-sounding note is kept; everything else
 * underneath it is suppressed until it releases. This is the standard trick
 * for pulling a melody out of a piano part that has the tune plus
 * accompaniment/bass sharing one track.
 */
function extractMelodyLine(
  notes: SimpleNote[],
  mode: "highest" | "lowest"
): SimpleNote[] {
  if (notes.length === 0) return [];

  interface SweepEvent {
    timeMs: number;
    kind: "on" | "off";
    id: number;
  }

  const events: SweepEvent[] = [];
  notes.forEach((n, id) => {
    const startMs = Math.round(n.time * 1000);
    const endMs = startMs + Math.round(n.duration * 1000);
    events.push({ timeMs: startMs, kind: "on", id });
    events.push({ timeMs: endMs, kind: "off", id });
  });

  // Process "off" before "on" at equal timestamps, so a note ending exactly
  // when the next begins isn't briefly treated as an overlap.
  events.sort((a, b) => a.timeMs - b.timeMs || (a.kind === "off" ? -1 : 1));

  const active = new Map<number, number>(); // note id -> midi pitch
  const segments: SimpleNote[] = [];
  let currentTopId: number | null = null;
  let segmentStartMs = 0;

  const pickTop = (): number | null => {
    if (active.size === 0) return null;
    let bestId: number | null = null;
    let bestMidi = mode === "highest" ? -Infinity : Infinity;
    for (const [id, midi] of active) {
      if (mode === "highest" ? midi > bestMidi : midi < bestMidi) {
        bestMidi = midi;
        bestId = id;
      }
    }
    return bestId;
  };

  for (const evt of events) {
    if (evt.kind === "on") {
      active.set(evt.id, notes[evt.id].midi);
    } else {
      active.delete(evt.id);
    }

    const newTopId = pickTop();
    if (newTopId !== currentTopId) {
      if (currentTopId !== null && evt.timeMs > segmentStartMs) {
        segments.push({
          time: segmentStartMs / 1000,
          duration: (evt.timeMs - segmentStartMs) / 1000,
          midi: notes[currentTopId].midi,
        });
      }
      currentTopId = newTopId;
      segmentStartMs = evt.timeMs;
    }
  }

  return segments;
}

/**
 * Quantizes a raw MIDI note number to the nearest standard equal-tempered
 * frequency in Hz. This is what stops the generator from emitting
 * near-duplicate tones (e.g. 440Hz vs 443Hz) that the NXT speaker can't
 * actually tell apart -- every note snaps to the same fixed 128-value table.
 */
export function midiNoteToFrequency(midiNote: number): number {
  const clamped = Math.min(127, Math.max(0, Math.round(midiNote)));
  return NOTE_FREQUENCIES[clamped];
}

export function convertMidiToRobotC(
  midi: Midi,
  options: RobotCOptions = {}
): ConversionResult {
  const {
    trackIndex,
    minDurationMs = 30,
    minFrequency = 220,
    maxFrequency = 14000,
    retriggerGapMs = 35,
    melodyMode = "highest",
    maxNotesPerTask = 400,
  } = options;

  const resolvedIndex =
    trackIndex ?? midi.tracks.findIndex((t) => t.notes.length > 0);
  const track = midi.tracks[resolvedIndex];

  if (!track || track.notes.length === 0) {
    throw new Error("No notes found in the selected MIDI track.");
  }

  const trackNotes: SimpleNote[] = track.notes.map((n) => ({
    time: n.time,
    duration: n.duration,
    midi: n.midi,
  }));

  const melodySource =
    melodyMode === "off"
      ? trackNotes
      : extractMelodyLine(trackNotes, melodyMode);

  const rawNotes = melodySource
    .filter((n) => n.duration * 1000 >= minDurationMs)
    .sort((a, b) => a.time - b.time);

  const events: CompactEvent[] = [];
  let cursorMs = 0;
  let lastToneFrequency: number | null = null;

  for (const note of rawNotes) {
    const startMs = Math.round(note.time * 1000);
    const endMs = startMs + Math.round(note.duration * 1000);

    // Monophonic playback: if this note starts before the previous one
    // finished (sustain pedal, overlapping voicing, etc.), clip it to start
    // right where the previous tone ends instead of drifting the timeline.
    const effectiveStartMs = Math.max(startMs, cursorMs);
    if (endMs <= effectiveStartMs) {
      // Fully swallowed by the previous overlapping note -- nothing to play.
      continue;
    }

    let freq = midiNoteToFrequency(note.midi);
    freq = Math.min(maxFrequency, Math.max(minFrequency, freq));

    const gapMs = effectiveStartMs - cursorMs;
    const sameAsLastTone = lastToneFrequency !== null && lastToneFrequency === freq;
    // If this note repeats the immediately preceding pitch with too small a
    // gap to be heard as a re-attack, force a short silence so the NXT
    // buzzer audibly restarts the tone instead of sounding like one held note.
    const neededGapMs = sameAsLastTone ? retriggerGapMs : 0;
    const restMs = Math.max(gapMs, neededGapMs > gapMs ? neededGapMs : 0);

    if (restMs > 15) {
      events.push({
        frequency: 0,
        durationCentiseconds: Math.max(1, Math.round(restMs / 10)),
      });
    }

    const availableMs = endMs - effectiveStartMs - Math.max(0, restMs - gapMs);
    const durationCentis = Math.max(1, Math.round(availableMs / 10));

    events.push({ frequency: freq, durationCentiseconds: durationCentis });
    lastToneFrequency = freq;
    cursorMs = effectiveStartMs + Math.max(0, restMs - gapMs) + durationCentis * 10;
  }

  const code = generateCode(
    events,
    track.name || `Track ${resolvedIndex + 1}`,
    rawNotes.length,
    maxNotesPerTask
  );

  return {
    code,
    noteCount: events.filter((e) => e.frequency > 0).length,
    rawNoteCount: rawNotes.length,
    trackName: track.name || `Track ${resolvedIndex + 1}`,
    durationSeconds: cursorMs / 1000,
  };
}

/**
 * Emits data arrays + a loop instead of one PlayTone()/wait1Msec() pair per
 * note. For a long song that's the difference between a handful of lines and
 * many thousands -- and NXT's flash budget is small enough that the
 * line-per-note version can simply fail to fit.
 */
function generateCode(
  events: CompactEvent[],
  trackName: string,
  rawNoteCount: number,
  maxNotesPerTask: number
): string {
  const lines: string[] = [];
  lines.push("// ============================================================");
  lines.push("// Auto-generated by MIDI -> RobotC converter");
  lines.push(`// Source track: "${trackName}"`);
  lines.push(`// ${rawNoteCount} melody notes -> ${events.length} compact tone/rest events`);
  lines.push("// Overlapping notes were reduced to a single-voice melody line (highest note");
  lines.push("// wins at each instant), and frequencies are quantized to the nearest");
  lines.push("// equal-tempered semitone. Repeated notes at the same pitch keep a short");
  lines.push("// forced rest between them so the NXT buzzer audibly re-attacks instead of");
  lines.push("// sounding like one held tone.");
  lines.push("// ============================================================");
  lines.push("");
  lines.push(`#define NOTE_COUNT ${events.length}`);
  lines.push("");
  lines.push("// frequency[i] == 0 means a rest (silence), not a tone.");
  lines.push(
    `int frequency[NOTE_COUNT] = {${events.map((e) => e.frequency).join(", ")}};`
  );
  lines.push(
    `int durationCS[NOTE_COUNT] = {${events
      .map((e) => e.durationCentiseconds)
      .join(", ")}}; // hundredths of a second`
  );
  lines.push("");
  lines.push("task main()");
  lines.push("{");
  lines.push("\tint i;");
  lines.push("\tfor (i = 0; i < NOTE_COUNT; i++)");
  lines.push("\t{");
  lines.push("\t\tif (frequency[i] > 0)");
  lines.push("\t\t{");
  lines.push("\t\t\tPlayTone(frequency[i], durationCS[i]);");
  lines.push("\t\t}");
  lines.push("\t\twait1Msec(durationCS[i] * 10);");
  lines.push("\t}");
  lines.push("}");
  lines.push("");

  if (events.length > maxNotesPerTask) {
    lines.push(
      `// NOTE: ${events.length} events is a lot for the NXT's flash/RAM budget.`
    );
    lines.push(
      "// If this doesn't compile or fit, trim the song, raise minDurationMs to"
    );
    lines.push(
      `// drop more short notes, or split frequency[]/durationCS[] into chunks of`
    );
    lines.push(`// ~${maxNotesPerTask} events played back to back.`);
  }

  return lines.join("\n");
}

export interface TrackSummary {
  index: number;
  name: string;
  noteCount: number;
}

export function summarizeTracks(midi: Midi): TrackSummary[] {
  return midi.tracks.map((t, i) => ({
    index: i,
    name: t.name || `Track ${i + 1}`,
    noteCount: t.notes.length,
  }));
}
