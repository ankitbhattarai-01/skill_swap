// Fixed question bank for the "Guitar" skill at the basic level.
//
// WHY THIS EXISTS: every other skill is quizzed with AI-generated questions,
// which take a few seconds to write and vary between sittings. For the live
// judge demo we want ONE skill that is instant and 100% predictable, so the
// person demoing already knows every answer and never has to wait on a model.
// Basic Guitar is that skill.
//
// The ten questions and their answers never change. The Edge Function shuffles
// the ORDER of the ten and the ORDER of each question's four options at serve
// time, so two sittings don't look identical — but the underlying question and
// its correct answer are always the same ones written here.
//
// `correctIndex` points at the correct entry in `options` AS WRITTEN BELOW.
// Shuffling in the Edge Function moves the options and re-points the index, so
// only ever change the text here — never reorder options to "fix" an answer.

export type FixedQuestion = {
  prompt: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
};

export const GUITAR_BASIC_QUESTIONS: FixedQuestion[] = [
  {
    prompt: "How many strings does a standard guitar have?",
    options: ["Four", "Five", "Six", "Seven"],
    correctIndex: 2,
    explanation: "A standard guitar has six strings.",
  },
  {
    prompt:
      "In standard tuning, what are the six open strings from the thickest (lowest) to the thinnest (highest)?",
    options: ["E A D G B E", "E A D G C E", "D A D G B E", "E A D G B D"],
    correctIndex: 0,
    explanation: "Standard tuning is E, A, D, G, B, E from the low (thick) string to the high (thin) one.",
  },
  {
    prompt: "For a right-handed guitarist, which hand usually strums or picks the strings?",
    options: ["The left hand", "The right hand", "Both hands equally", "Neither hand"],
    correctIndex: 1,
    explanation: "A right-handed player frets notes with the left hand and strums or picks with the right.",
  },
  {
    prompt: "What is a 'fret' on a guitar?",
    options: [
      "A tuning peg on the headstock",
      "One of the metal strips along the neck that mark where the notes are",
      "The hole in the body of the guitar",
      "The button the strap clips onto",
    ],
    correctIndex: 1,
    explanation: "Frets are the metal strips on the neck; pressing a string just behind one changes its pitch.",
  },
  {
    prompt: "What is a chord?",
    options: [
      "A single note played on its own",
      "Three or more notes played together",
      "The strap that holds the guitar",
      "A spare string kept in the case",
    ],
    correctIndex: 1,
    explanation: "A chord is a group of notes — usually three or more — sounded together.",
  },
  {
    prompt: "Which of these is a chord beginners commonly learn first?",
    options: [
      "F sharp diminished seventh",
      "G major",
      "C major thirteenth",
      "B flat minor seven flat five",
    ],
    correctIndex: 1,
    explanation: "Open chords like G, C, D, E and A major are typical first chords; the others are advanced.",
  },
  {
    prompt: "What do the tuning pegs (machine heads) on the headstock do?",
    options: [
      "Hold the strap in place",
      "Adjust each string's tension to raise or lower its pitch",
      "Amplify the sound of the strings",
      "Store your spare picks",
    ],
    correctIndex: 1,
    explanation: "Turning a tuning peg tightens or loosens its string, raising or lowering the pitch to tune it.",
  },
  {
    prompt: "In standard tuning, which note is the thickest (6th) string?",
    options: ["A", "E", "D", "G"],
    correctIndex: 1,
    explanation: "The thickest, lowest-pitched string is the low E.",
  },
  {
    prompt: "What is a capo used for?",
    options: [
      "Clamping across the fretboard to raise the pitch of all the strings",
      "Cleaning dirt off the strings",
      "Replacing a broken string",
      "Storing your picks",
    ],
    correctIndex: 0,
    explanation: "A capo bars every string at a chosen fret, raising their pitch so the same shapes play in a new key.",
  },
  {
    prompt: "What does 'strumming' mean?",
    options: [
      "Tuning the guitar to pitch",
      "Sweeping the pick or fingers across several strings so they sound together",
      "Tapping the body of the guitar like a drum",
      "Muting every string at once",
    ],
    correctIndex: 1,
    explanation: "Strumming brushes across several strings so they ring together, which is how chords are played.",
  },
];
