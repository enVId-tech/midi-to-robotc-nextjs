# MIDI → LEGO NXT RobotC Converter

A small Next.js app that parses a MIDI file in the browser and generates
RobotC source code to play the melody on a LEGO Mindstorms NXT brick's
built-in speaker.

## How it works

1. You upload a `.mid`/`.midi` file (parsed client-side with `@tonejs/midi`,
   nothing is uploaded to a server).
2. Pick which track to convert — the NXT speaker can only play one note at a
   time, so choose the track with the melody (not drums/percussion).
3. Each MIDI note is converted to a frequency in Hz (`freq = 440 * 2^((midiNote-69)/12)`)
   and a duration in centiseconds (RobotC's `PlayTone` duration unit).
4. The app emits a `task main() { ... }` block of `PlayTone(freq, duration);`
   / `wait1Msec(...)` pairs, with `wait1Msec` rests inserted for silences.
5. Download the generated `.c` file and open it in the RobotC IDE, or paste
   its contents into an existing project.

## Setup

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Project structure

```
app/
  layout.tsx       root layout
  page.tsx          upload UI, track picker, code preview/download
  globals.css       styling
lib/
  midiToRobotC.ts   MIDI parsing -> RobotC code generation
```

## Known limitations

- Only single-voice (monophonic) output — polyphonic passages in the source
  track get flattened to overlapping/sequential tones based on note order,
  since the NXT can only sound one tone at a time.
- `PlayTone` frequency range is clamped to roughly 220Hz–14kHz to match what
  the NXT speaker can reliably reproduce.
- Notes shorter than 30ms are dropped as likely MIDI noise/grace notes; adjust
  `minDurationMs` in `lib/midiToRobotC.ts` if you want to keep them.
- Tempo/timing comes straight from the MIDI file's absolute note timestamps,
  so tempo changes mid-file are respected automatically.
