export type FaqEntry = {
  id: string;
  category: FaqCategory;
  question: string;
  answer: string;
};

export type FaqCategory =
  | "Getting Started"
  | "Booking & Sessions"
  | "Video Calls"
  | "AI Session Notes"
  | "Verified Skills"
  | "Practice"
  | "Suggestions"
  | "Skill Swaps"
  | "Credits & Billing"
  | "Messages & Safety"
  | "Strikes & Suspensions"
  | "Account"
  | "Support";

export const FAQ_CATEGORIES: FaqCategory[] = [
  "Getting Started",
  "Booking & Sessions",
  "Video Calls",
  "AI Session Notes",
  "Verified Skills",
  "Practice",
  "Suggestions",
  "Skill Swaps",
  "Credits & Billing",
  "Messages & Safety",
  "Strikes & Suspensions",
  "Account",
  "Support",
];

export const FAQ_ENTRIES: FaqEntry[] = [
  // ── Getting Started ───────────────────────────────────────────────────────
  {
    id: "what-is-skillswap",
    category: "Getting Started",
    question: "What is SkillSwap?",
    answer:
      "It's a place where students teach and learn from each other. You pay each other in credits, not money. You can also swap skills directly with someone, teach for teach, with no credits at all.",
  },
  {
    id: "whats-new",
    category: "Getting Started",
    question: "What's new in the app?",
    answer:
      "Five big ones. Practice gives you unlimited multiple-choice problems on any skill. Verify puts a blue tick next to a skill you teach after you pass a short quiz. AI Session Notes turn a recorded call into a written summary you can download as a PDF. Direct skill swaps let two people trade lessons with no credits. And Suggestions on your dashboard point you at what to do next. Each one has its own section below.",
  },
  {
    id: "who-can-join",
    category: "Getting Started",
    question: "Who can sign up?",
    answer:
      "Any student with a mailbox at Gmail, Outlook or Hotmail, Yahoo, or iCloud. Throwaway and temp-mail addresses are turned away at signup so people can't spin up fake accounts. If you already have an account on another domain, you can still log in as normal.",
  },
  {
    id: "google-signin",
    category: "Getting Started",
    question: "Can I sign in with Google instead of a password?",
    answer:
      "Yes. Tap Continue with Google on the login or signup screen and you're in. No password to remember, and no reset email to wait for.",
  },
  {
    id: "after-signup",
    category: "Getting Started",
    question: "What happens right after I sign up?",
    answer:
      "You go through a short setup: your name and photo, the skills you can teach, the skills you want to learn, and the hours you're free each week. You start with 10 credits in your account, so you can book your first lesson before you've taught anyone.",
  },
  {
    id: "cant-find-skill",
    category: "Getting Started",
    question: "Why can't I type in my own skill?",
    answer:
      "Skills come from one shared catalog of a few hundred entries across 20 categories. Everyone picks from the same list, so 'Guitar', 'guitar playing', and 'GUITAR' can never split into three separate things and searching actually works. Start typing in the skill box and pick the closest match. If something real is genuinely missing, email support and we can add it to the catalog.",
  },
  {
    id: "first-session",
    category: "Getting Started",
    question: "How do I book my first session?",
    answer:
      "Go to Explore. Find someone teaching what you want to learn. Open their profile, pick a skill, a length, and a free time, then send the request. Once they accept, the session shows up on your dashboard with a Join button.",
  },
  {
    id: "how-credits-work",
    category: "Getting Started",
    question: "How do credits work?",
    answer:
      "Each session costs credits based on the teacher's hourly rate and how long the lesson is. When the teacher accepts, your credits are held safely to one side. When the session is marked complete, they go to the teacher. You earn credits back by teaching other people.",
  },
  {
    id: "what-is-subscription",
    category: "Getting Started",
    question: "What's the $2 a month for?",
    answer:
      "It pays for hosting, the video rooms, and keeping the app running. It does not pay teachers. They get paid in credits by you.",
  },
  {
    id: "find-things-fast",
    category: "Getting Started",
    question: "Is there a quick way to find things?",
    answer:
      "Press Ctrl+K (or Cmd+K on a Mac), or just tap the / key. The search box opens from anywhere and covers skills, people, and your own sessions.",
  },
  {
    id: "where-is-everything",
    category: "Getting Started",
    question: "What's on each page?",
    answer:
      "Home is your dashboard: upcoming sessions, credits, swap inbox, and suggestions. Explore finds people. Sessions is your full history, plus reviews and notes. Practice is for solo drilling. Credits shows your balance and every transaction. Messages is chat. Profile is your skills, availability, and verification.",
  },

  // ── Booking & Sessions ────────────────────────────────────────────────────
  {
    id: "session-lengths",
    category: "Booking & Sessions",
    question: "How long can a session be?",
    answer:
      "20, 30, or 60 minutes. You pick when you send the request, and the price moves with it. Need longer than an hour? Book two sessions back to back.",
  },
  {
    id: "session-cost",
    category: "Booking & Sessions",
    question: "How is the price worked out?",
    answer:
      "The teacher sets an hourly rate in credits, and you pay the share that matches your length. A 30 minute lesson costs half the hourly rate, a 20 minute one costs a third. Every session costs at least 1 credit. The exact number is shown before you confirm.",
  },
  {
    id: "pick-a-time",
    category: "Booking & Sessions",
    question: "Why can I only pick certain times?",
    answer:
      "You're seeing the teacher's own free hours, set on their profile. Anything outside those hours isn't offered. Times where either of you is already booked are hidden too, so you can't accidentally double-book yourself.",
  },
  {
    id: "multiple-sessions",
    category: "Booking & Sessions",
    question: "Can I book several lessons at once?",
    answer:
      "Yes. In the request box, switch on Multiple sessions and pick up to 7 start times for the same teacher and skill. They all use the same length. The teacher accepts each one separately, and credits are only held as each is accepted. Your dashboard groups them together and shows how many are done.",
  },
  {
    id: "teacher-offers",
    category: "Booking & Sessions",
    question: "Can a teacher offer me a session first?",
    answer:
      "Yes. If you've listed a skill you want to learn, a teacher can find you under the Learners tab in Explore and send you an offer. You accept it the same way they'd accept yours.",
  },
  {
    id: "accepted-what-happens",
    category: "Booking & Sessions",
    question: "What happens when a request is accepted?",
    answer:
      "Your credits move into a hold, the session gets a private video room, and you both get a notification and an email. From then on it sits on your dashboard until it's time to join.",
  },
  {
    id: "join-window",
    category: "Booking & Sessions",
    question: "When does the Join button appear?",
    answer:
      "10 minutes before the start time, and it stays live until 30 minutes after the session was due to end. Before that it shows a countdown instead.",
  },
  {
    id: "add-to-calendar",
    category: "Booking & Sessions",
    question: "Can I put a session in my calendar?",
    answer:
      "Yes. Open the session and use Add to calendar. You can send it straight to Google Calendar or Outlook on the web, or download an .ics file for anything else. The join link travels with it.",
  },
  {
    id: "cancel-reschedule",
    category: "Booking & Sessions",
    question: "How do I cancel or change the time?",
    answer:
      "Open the session and use Cancel or Reschedule. A reschedule is a proposal: the other person has to agree before the time actually moves. Cancelling returns the held credits to the learner. Cancel more than 2 hours ahead and nothing happens to your record.",
  },
  {
    id: "late-cancel-cost",
    category: "Booking & Sessions",
    question: "What counts as a late cancellation?",
    answer:
      "Less than 2 hours before the start is 1 strike. Less than 30 minutes before is 2 strikes, because at that point the other person has already set the time aside. Cancelling a request that was never accepted costs nothing.",
  },
  {
    id: "session-complete",
    category: "Booking & Sessions",
    question: "How does a session get marked done?",
    answer:
      "Once the time is up, either of you can end it from the session page. That's the moment the held credits move from the learner to the teacher, and both of you get the option to leave a review.",
  },
  {
    id: "tutor-no-show",
    category: "Booking & Sessions",
    question: "My teacher didn't show up. What now?",
    answer:
      "Wait about 10 minutes in the video room. If they never arrive, cancel the session, which sends your held credits straight back to you, then use Report on their profile and pick 'No-show or unresponsive'. A moderator reads it and can issue a strike.",
  },
  {
    id: "leave-review",
    category: "Booking & Sessions",
    question: "How do I leave a review?",
    answer:
      "Go to Sessions, find the completed lesson, and tap Leave a review. Give 1 to 5 stars and add a short note if you want. It shows on the other person's profile and feeds their rating badge.",
  },
  {
    id: "session-history",
    category: "Booking & Sessions",
    question: "Where do I see everything I've booked?",
    answer:
      "The Sessions page. Upcoming, pending requests, and everything finished, with the review button and the notes button on each completed card.",
  },

  // ── Video Calls ───────────────────────────────────────────────────────────
  {
    id: "where-calls-happen",
    category: "Video Calls",
    question: "Where do the lessons actually happen?",
    answer:
      "Inside SkillSwap. Every accepted session gets its own private video room, and only the two of you can get in. There's no Zoom or Meet link to send, which is also why sharing outside meeting links in chat is blocked.",
  },
  {
    id: "video-requirements",
    category: "Video Calls",
    question: "What do I need for the video call?",
    answer:
      "A modern browser and permission to use your camera and microphone. It works on phones too, and recording for AI notes works right in the same browsers — no special setup.",
  },
  {
    id: "video-trouble",
    category: "Video Calls",
    question: "The video room won't load. What do I try?",
    answer:
      "Check that you're inside the join window, allow camera and mic when the browser asks, and refresh once. If it still won't open, leave and re-join from the session page so a fresh room token is issued. Blocking third-party content or a strict VPN can also get in the way.",
  },

  // ── AI Session Notes ──────────────────────────────────────────────────────
  {
    id: "what-are-ai-notes",
    category: "AI Session Notes",
    question: "What are AI Session Notes?",
    answer:
      "If you record a lesson, SkillSwap listens back and writes it up for you: a short summary, the key topics you covered, the takeaways, action items to do before next time, and any questions left open. Both people in the session get the same notes, and either of you can download them as a PDF.",
  },
  {
    id: "how-to-record",
    category: "AI Session Notes",
    question: "How do I record a session?",
    answer:
      "In the video room, tap AI Notes. The other person gets a prompt on their screen and has to accept before anything starts. Once they do, tap Start recording — each device records its own microphone, so both voices are captured without any screen sharing or extra steps.",
  },
  {
    id: "notes-consent",
    category: "AI Session Notes",
    question: "Does the other person have to agree?",
    answer:
      "Always. Nothing is captured until they tap Allow on their own screen — and when they do, both devices start recording their own microphone. They have 30 seconds to answer, and if they decline or don't reply, recording simply never starts. You can ask again later in the call.",
  },
  {
    id: "notes-browser",
    category: "AI Session Notes",
    question: "Which browsers can record for notes?",
    answer:
      "Practically all of them. Each device only records its own microphone, which works in Chrome, Edge, Firefox and Safari, on computers and phones alike. If one side's browser can't record, notes are still generated from the other side's audio.",
  },
  {
    id: "notes-one-sided",
    category: "AI Session Notes",
    question: "The notes only picked up one of us. Why?",
    answer:
      "Each device records its own microphone, so one missing side usually means that person's mic permission was denied, their browser couldn't record, or they lost connection before their audio finished uploading. The notes still generate from whichever side made it through. Check the mic permission on the missing side and record again.",
  },
  {
    id: "notes-audio-kept",
    category: "AI Session Notes",
    question: "Is my recording stored anywhere?",
    answer:
      "No. The audio goes to a private staging area, gets turned into notes, and is deleted straight after. Nobody can play it back, not even us. Only the written notes are kept.",
  },
  {
    id: "notes-limits",
    category: "AI Session Notes",
    question: "How long can a recording be?",
    answer:
      "Around 75 minutes, which covers any session length in the app. If you somehow hit the size cap, recording stops cleanly and whatever was captured up to that point still becomes notes.",
  },
  {
    id: "notes-where",
    category: "AI Session Notes",
    question: "Where do the notes show up?",
    answer:
      "On the session page, and as a Notes button on the card in your Sessions list. They appear on their own within about a minute of you stopping, with no refresh needed, including for the person who did not press record.",
  },
  {
    id: "notes-failed",
    category: "AI Session Notes",
    question: "My notes failed to generate. Can I retry?",
    answer:
      "Yes. The panel tells you what went wrong and you can record again in the same session. A newer recording replaces the older notes, so you always keep just the latest set.",
  },
  {
    id: "notes-cost",
    category: "AI Session Notes",
    question: "Do notes cost credits?",
    answer: "No. Recording and notes are free and don't touch your balance or your subscription.",
  },

  // ── Verified Skills ───────────────────────────────────────────────────────
  {
    id: "what-is-tick",
    category: "Verified Skills",
    question: "What's the blue tick next to a skill?",
    answer:
      "It means that person passed a quiz on that exact skill, at the level they say they teach it. It sits on their profile and on their cards in Explore, so learners can tell at a glance who has proved it.",
  },
  {
    id: "how-to-verify",
    category: "Verified Skills",
    question: "How do I get verified?",
    answer:
      "Go to Profile. The 'Get verified' panel lists every skill you teach with a Verify button next to it. Tap one and the quiz starts. You need at least one teaching skill on your profile before there's anything to verify.",
  },
  {
    id: "quiz-format",
    category: "Verified Skills",
    question: "What's the quiz like?",
    answer:
      "10 multiple-choice questions, all on screen at once, and you need 7 right to pass. There's a single 5 minute countdown for the whole set. When it runs out, whatever you've picked is submitted for you, so answer the easy ones first.",
  },
  {
    id: "quiz-level",
    category: "Verified Skills",
    question: "What level are the questions?",
    answer:
      "Whatever level you listed for that skill on your profile: basic, intermediate, or advanced. You can't request an easier paper. The level you claim is the level you're tested at.",
  },
  {
    id: "quiz-failed",
    category: "Verified Skills",
    question: "I failed. When can I try again?",
    answer:
      "24 hours later, for that skill. Other skills aren't affected and you can attempt them right away. The button tells you exactly how long is left.",
  },
  {
    id: "quiz-answers",
    category: "Verified Skills",
    question: "Do I get to see what I got wrong?",
    answer:
      "Yes, pass or fail. After you submit you get every question back with the right answer, what you picked, and a short explanation. It's worth reading even when you passed.",
  },
  {
    id: "quiz-cheat",
    category: "Verified Skills",
    question: "Can I look up the answers?",
    answer:
      "Your browser never receives the answer key. Questions are generated and graded on our server, and the clock runs there too, so nothing on your screen holds the answers. Please just take it honestly, it's a five minute quiz.",
  },
  {
    id: "tick-expire",
    category: "Verified Skills",
    question: "Does the tick expire?",
    answer:
      "No. Once you've earned it for a skill it stays. If you remove that skill from your profile the tick goes with it, and comes back if you add the skill again.",
  },
  {
    id: "verify-cost",
    category: "Verified Skills",
    question: "Does verifying cost credits?",
    answer: "No. It's free and you can verify every skill you teach.",
  },

  // ── Practice ──────────────────────────────────────────────────────────────
  {
    id: "what-is-practice",
    category: "Practice",
    question: "What is the Practice page?",
    answer:
      "Solo drilling, a bit like LeetCode. Pick a skill and a difficulty, and you get multiple-choice problems one at a time, forever. You find out instantly whether you were right and get an explanation either way. No teacher, no booking, no credits.",
  },
  {
    id: "practice-how",
    category: "Practice",
    question: "How do I start practising?",
    answer:
      "Open Practice, pick a skill, choose Easy, Medium, or Hard, and start. Answer, read the explanation, and move to the next one. Problems are made fresh for the skill you chose, and it keeps track so you don't get the same one twice in a run.",
  },
  {
    id: "practice-which-skills",
    category: "Practice",
    question: "Which skills can I practise?",
    answer:
      "Any skill in the catalog. The skills you're currently learning appear as quick-pick chips at the top, and there's a search box for everything else. You don't need to have booked a session on a skill to drill it.",
  },
  {
    id: "practice-progress",
    category: "Practice",
    question: "Does my progress get saved?",
    answer:
      "Yes. Solved, attempted, and accuracy are tracked per skill and per difficulty, and they carry over between visits. The stats bar at the top adds it all up.",
  },
  {
    id: "practice-vs-verify",
    category: "Practice",
    question: "How is Practice different from Verify?",
    answer:
      "Practice is zero stakes: unlimited problems, instant answers, nothing recorded on your profile. Verify is the real test: 10 questions, 5 minutes, one attempt a day per skill, and a blue tick if you pass. Practice is a good way to warm up before you go and verify.",
  },
  {
    id: "practice-cost",
    category: "Practice",
    question: "Does Practice cost credits?",
    answer:
      "No, it's included. Practising can't affect your credits, your rating, or your strikes.",
  },

  // ── Suggestions ───────────────────────────────────────────────────────────
  {
    id: "what-are-suggestions",
    category: "Suggestions",
    question: "What are the Suggestions on my dashboard?",
    answer:
      "Four small cards nudging you towards your next move: a teacher worth booking, a skill in demand that you already teach, something sensible to learn next, a swap that would work both ways, or a gap in your profile that's costing you requests.",
  },
  {
    id: "suggestions-how",
    category: "Suggestions",
    question: "How are they worked out?",
    answer:
      "From your own activity in the app: your skills, your free hours, who's looking for what, and what you've already booked. It's a fixed set of rules running on our side, not a chatbot, so nothing about you is sent to an outside AI service to produce them.",
  },
  {
    id: "suggestions-refresh",
    category: "Suggestions",
    question: "Can I get different suggestions?",
    answer:
      "Tap the refresh arrow on the card and you get a genuinely different set, not a reshuffle of the same four. They also update by themselves roughly every half hour and whenever your profile or sessions change.",
  },
  {
    id: "suggestions-click",
    category: "Suggestions",
    question: "Are the cards clickable?",
    answer:
      "Yes, every one of them. A card about a teacher opens the booking box with the right skill already picked. A swap card opens the swap form with both sides filled in. A profile card takes you to the exact thing that needs fixing.",
  },

  // ── Skill Swaps ───────────────────────────────────────────────────────────
  {
    id: "what-is-swap",
    category: "Skill Swaps",
    question: "What is a direct skill swap?",
    answer:
      "A straight trade: you teach them something, they teach you something, and no credits change hands either way. It's two linked sessions that live or die together.",
  },
  {
    id: "swap-how",
    category: "Skill Swaps",
    question: "How do I propose a swap?",
    answer:
      "Open the person's profile and tap Propose swap. You pick a skill of yours they want to learn, a skill of theirs you want to learn, and a time for each of the two lessons. Then send it.",
  },
  {
    id: "swap-no-match",
    category: "Skill Swaps",
    question: "Why can't I swap with this person?",
    answer:
      "A swap needs an overlap in both directions: something you teach that they want, and something they teach that you want. If either side is empty, the button explains what's missing. Adding more skills you want to learn is usually what unlocks it.",
  },
  {
    id: "swap-accept",
    category: "Skill Swaps",
    question: "How do I accept a swap someone sent me?",
    answer:
      "It shows up in the swap inbox on your dashboard with both lessons laid out. Accept and both are booked at once. Decline and neither happens. You can't take just the half you like.",
  },
  {
    id: "swap-cancel",
    category: "Skill Swaps",
    question: "What if a swap falls through?",
    answer:
      "Cancelling a swap cancels both lessons together, since a one-sided swap isn't a swap. The same late-cancellation rules apply as for any other session, so give notice if you can.",
  },
  {
    id: "swap-vs-credits",
    category: "Skill Swaps",
    question: "Should I swap or pay credits?",
    answer:
      "Swap when you both want something the other has, especially if you're low on credits. Pay credits when you only want to learn right now, or when the timing only works for one of the two lessons.",
  },

  // ── Credits & Billing ─────────────────────────────────────────────────────
  {
    id: "starter-credits",
    category: "Credits & Billing",
    question: "Do I get any credits to start with?",
    answer:
      "Yes, 10 credits land in your account when you sign up. That's enough for your first lesson or two before you've taught anybody.",
  },
  {
    id: "earn-credits",
    category: "Credits & Billing",
    question: "How do I earn more credits?",
    answer:
      "Teach. Every session you teach pays you the credits the learner put up, the moment the session is marked complete. Listing more skills and keeping your free hours up to date is what gets you booked.",
  },
  {
    id: "credits-run-out",
    category: "Credits & Billing",
    question: "What if I run out of credits?",
    answer:
      "You can't book paid sessions until you have enough again. Two ways out: teach someone and get paid, or set up a direct skill swap, which costs nothing. Practice and verification stay free either way.",
  },
  {
    id: "credits-held",
    category: "Credits & Billing",
    question: "Why do my credits say 'held'?",
    answer:
      "They're set aside for a session that's been accepted but hasn't happened yet. They're still yours, they just can't be spent twice. They go to the teacher when the session completes, or come back to you if it's cancelled.",
  },
  {
    id: "credits-refund",
    category: "Credits & Billing",
    question: "Do I get my credits back if a session is cancelled?",
    answer:
      "Always, and immediately, whoever cancels. Held credits return to the learner in full and show up as a refund on the Credits page.",
  },
  {
    id: "credits-page",
    category: "Credits & Billing",
    question: "Where can I see where my credits went?",
    answer:
      "The Credits page. It shows your balance, what you've earned from teaching, what you've spent learning, refunds, holds, and your welcome bonus, newest first.",
  },
  {
    id: "cancel-subscription",
    category: "Credits & Billing",
    question: "Can I cancel the $2 plan?",
    answer:
      "Yes, whenever you like, no questions asked. Sessions you've already booked and paid for still go ahead.",
  },

  // ── Messages & Safety ─────────────────────────────────────────────────────
  {
    id: "message-anyone",
    category: "Messages & Safety",
    question: "Can I message someone before booking?",
    answer:
      "Yes. Chat is separate from sessions now, so you can open a conversation from anyone's profile and ask a question first, without sending a request. Booking is a separate, deliberate step.",
  },
  {
    id: "messages-live",
    category: "Messages & Safety",
    question: "Do messages arrive instantly?",
    answer:
      "Yes, no refreshing needed. New messages appear as they're sent, and you get a notification if you're on another page.",
  },
  {
    id: "message-attachments",
    category: "Messages & Safety",
    question: "Can I send files in chat?",
    answer:
      "Yes. Images (PNG, JPEG, WebP, GIF) and documents (PDF, Word, Excel, PowerPoint, TXT, CSV), up to 5 MB each. Handy for sharing homework, sheet music, or a screenshot of an error.",
  },
  {
    id: "message-blocked",
    category: "Messages & Safety",
    question: "Why was my message blocked?",
    answer:
      "Phone numbers, email addresses, and links to Zoom, Meet, Teams, Discord and the like aren't allowed. Lessons happen in our own video room, and taking people off-platform is how learners end up with no session and no refund. Say the same thing without the contact details and it'll go through.",
  },
  {
    id: "conduct-rules",
    category: "Messages & Safety",
    question: "What else is not allowed in chat?",
    answer:
      "Insults and put-downs, hate speech and slurs, threats of any kind, and sexual or explicit content. Swearing at someone gets flagged too. This is a learning space shared with people you don't know yet, so keep it civil. These rules are enforced on our server, not just in your browser.",
  },
  {
    id: "report-user",
    category: "Messages & Safety",
    question: "How do I report someone?",
    answer:
      "Open their profile or the session page and tap Report. Pick a reason, from no-show to harassment, and say what happened. A moderator reads every report. False or repeat reports can count against your own account, so only use it when something really went wrong.",
  },
  {
    id: "privacy-basics",
    category: "Messages & Safety",
    question: "Who can see my details?",
    answer:
      "Other students see your name, photo, bio, skills, ratings, and free hours. Your email address and credit balance are never shown to anyone else. Recorded audio is deleted as soon as notes are made, and only the two people in a session can read that session's notes.",
  },

  // ── Strikes & Suspensions ─────────────────────────────────────────────────
  {
    id: "what-is-strike",
    category: "Strikes & Suspensions",
    question: "What's a strike?",
    answer:
      "A mark on your account for letting someone down: cancelling at the last minute, not turning up, or breaking the chat rules. Most are worth 1, serious ones are worth 2. They fade away on their own after 90 days.",
  },
  {
    id: "one-strike",
    category: "Strikes & Suspensions",
    question: "I got 1 strike. Am I in trouble?",
    answer:
      "Not really. You'll see a warning banner on your dashboard, but everything keeps working. It's there so the next one doesn't come as a surprise.",
  },
  {
    id: "teaching-paused",
    category: "Strikes & Suspensions",
    question: "My banner says 'Teaching paused'. What does that mean?",
    answer:
      "You picked up 3 or 4 strikes inside 30 days, so you can't take on new students for 7 days from your most recent strike. You can still learn from others, and sessions already booked go ahead as normal.",
  },
  {
    id: "full-suspension",
    category: "Strikes & Suspensions",
    question: "It says I can't accept any sessions. Why?",
    answer:
      "5 or more strikes inside 30 days means a full pause for 30 days from your most recent strike: no new teaching and no new learning. Sessions already on the books still happen. After the date passes you're back to normal automatically.",
  },
  {
    id: "permanent-suspension",
    category: "Strikes & Suspensions",
    question: "My account is permanently suspended. Help?",
    answer:
      "That happens after a lot of strikes have built up over the account's lifetime. If you think it's wrong, email support with your account email and we'll look at the history properly.",
  },
  {
    id: "strike-expire",
    category: "Strikes & Suspensions",
    question: "When do strikes go away?",
    answer:
      "Each one expires 90 days after it was issued, on its own. Your banner shows how many are still active and when the next one drops off.",
  },
  {
    id: "avoid-strikes",
    category: "Strikes & Suspensions",
    question: "How do I stay out of trouble?",
    answer:
      "Show up. If you have to cancel, do it more than 2 hours ahead and it costs you nothing. Keep contact details and outside links out of chat, and be decent to people. That's genuinely all of it.",
  },
  {
    id: "appeal-strike",
    category: "Strikes & Suspensions",
    question: "Can I appeal a strike I think is unfair?",
    answer:
      "Yes. Email support with what happened and the session date or ID if you have it. An admin can revoke a strike, and revoking it lifts any pause it was causing.",
  },

  // ── Account ───────────────────────────────────────────────────────────────
  {
    id: "change-password",
    category: "Account",
    question: "How do I change my password?",
    answer:
      "Go to Profile and tap Change password at the bottom. You'll need 8 characters or more. If you signed up with Google there's no password to change, so the button isn't there.",
  },
  {
    id: "forgot-password",
    category: "Account",
    question: "I forgot my password.",
    answer:
      "Tap 'Forgot password' on the login screen and we'll email you a reset link. Google accounts don't need this, just use Continue with Google.",
  },
  {
    id: "edit-availability",
    category: "Account",
    question: "How do I set when I'm free?",
    answer:
      "Profile, then the Availability section. You set weekly windows separately for teaching and for learning. Nobody can book you until your teaching hours are set, so it's worth doing early.",
  },
  {
    id: "edit-skills",
    category: "Account",
    question: "How do I add or remove skills?",
    answer:
      "On your profile there are two lists: what you teach and what you want to learn. Pick from the catalog, set your level, and save. Your teaching list is what makes you show up in Explore and what you can verify.",
  },
  {
    id: "dark-mode",
    category: "Account",
    question: "How do I turn on dark mode?",
    answer:
      "Tap the sun, moon, or monitor icon in the header. It cycles between follow-your-device, light, and dark, and remembers your choice.",
  },
  {
    id: "notifications",
    category: "Account",
    question: "Will I get emails about my sessions?",
    answer:
      "Yes. We email you when a session is requested, accepted, declined, rescheduled, cancelled, or completed. Everything else lives in the bell menu in the app.",
  },
  {
    id: "delete-account",
    category: "Account",
    question: "How do I delete my account?",
    answer:
      "Profile, then Delete account at the bottom. It's permanent. Any open sessions are cancelled and held credits go back to the learners. Your profile, skills, and unread notifications are removed. Past sessions, reviews, and chat history stay with the people you exchanged with, shown as a deleted user, so their own records still make sense.",
  },

  // ── Support ───────────────────────────────────────────────────────────────
  {
    id: "contact-support",
    category: "Support",
    question: "How do I talk to a real person?",
    answer:
      "Email support@skillswap.app. Include the email you signed up with and what's going on, plus screenshots if they help. Session dates or IDs make it much quicker to sort out.",
  },
  {
    id: "something-broken",
    category: "Support",
    question: "Something looks broken. What should I do?",
    answer:
      "Refresh the page first, since most hiccups are a stale tab. If it persists, email support with the page you were on, what you clicked, and roughly when it happened.",
  },
  {
    id: "suggest-feature",
    category: "Support",
    question: "Can I suggest a feature or a missing skill?",
    answer:
      "Please do. Email support with the idea, or the skill name and category you'd like added to the catalog. Practice, verification, and AI notes all started as requests from students using the app.",
  },
];
