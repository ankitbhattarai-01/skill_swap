export type FaqEntry = {
  id: string;
  category: FaqCategory;
  question: string;
  answer: string;
};

export type FaqCategory =
  | "Getting Started"
  | "Teaching & Learning"
  | "Strikes & Suspensions"
  | "Account"
  | "Support";

export const FAQ_CATEGORIES: FaqCategory[] = [
  "Getting Started",
  "Teaching & Learning",
  "Strikes & Suspensions",
  "Account",
  "Support",
];

export const FAQ_ENTRIES: FaqEntry[] = [
  // Getting Started
  {
    id: "what-is-skillswap",
    category: "Getting Started",
    question: "What is SkillSwap?",
    answer:
      "It's a place where students teach and learn from each other. You pay with credits, not money. Simple as that.",
  },
  {
    id: "first-session",
    category: "Getting Started",
    question: "How do I book my first session?",
    answer:
      "Go to Explore. Find someone teaching what you want to learn. Open their profile, pick a free time, and send a request. Once they accept, you're set.",
  },
  {
    id: "how-credits-work",
    category: "Getting Started",
    question: "How do credits work?",
    answer:
      "Each session costs some credits. When the teacher accepts your request, the credits are held safely. Once the session is done, the teacher gets them. You earn credits by teaching too.",
  },
  {
    id: "what-is-subscription",
    category: "Getting Started",
    question: "What's the $2 a month for?",
    answer:
      "It pays for hosting, video calls, and keeping the app running. It does not pay teachers. They get paid in credits by you.",
  },

  // Teaching & Learning
  {
    id: "become-tutor",
    category: "Teaching & Learning",
    question: "How do I become a teacher?",
    answer:
      "You already can! Just add the skills you can teach to your profile, set your free times, and people will start finding you. There's no application.",
  },
  {
    id: "message-before-booking",
    category: "Teaching & Learning",
    question: "Can I message someone before booking?",
    answer:
      "Yes, but you need to send them a session request first. This stops random spam. Once the chat is open, ask anything you want before locking in the time.",
  },
  {
    id: "cancel-reschedule",
    category: "Teaching & Learning",
    question: "How do I cancel or change the time?",
    answer:
      "Open the session and tap Cancel or Reschedule. If you cancel more than 24 hours before, no problem. Cancelling at the last minute may give you a strike.",
  },
  {
    id: "tutor-no-show",
    category: "Teaching & Learning",
    question: "My teacher didn't show up. What now?",
    answer:
      "Wait 10 minutes inside the video room. If they're still not there, mark it as a no-show from the session page. You get your credits back right away. The teacher gets a strike after an admin checks.",
  },
  {
    id: "leave-review",
    category: "Teaching & Learning",
    question: "How do I leave a review?",
    answer:
      "Once the session ends, a review box pops up on your dashboard. Give 1 to 5 stars. Write a quick note if you want. Easy.",
  },

  // Strikes & Suspensions
  {
    id: "what-is-strike",
    category: "Strikes & Suspensions",
    question: "What's a strike?",
    answer:
      "A strike is a warning on your account. You get one for things like skipping a session, cancelling too late, or breaking the rules. They go away on their own after a while.",
  },
  {
    id: "one-strike",
    category: "Strikes & Suspensions",
    question: "I got 1 strike. Am I in trouble?",
    answer:
      "Not yet. You'll see a yellow warning on your dashboard but everything still works normally. Just don't let it happen again.",
  },
  {
    id: "teaching-paused",
    category: "Strikes & Suspensions",
    question: "My banner says 'Teaching paused'. What does that mean?",
    answer:
      "You can't accept new students for a while. But you can still learn from others, and any sessions already booked still happen. The banner shows when it ends.",
  },
  {
    id: "full-suspension",
    category: "Strikes & Suspensions",
    question: "It says I can't accept any sessions. Why?",
    answer:
      "You've been suspended for a short time. No new teaching or learning until the date passes. Old sessions still happen. After the date, you're back to normal.",
  },
  {
    id: "permanent-suspension",
    category: "Strikes & Suspensions",
    question: "My account is permanently suspended. Help?",
    answer:
      "Too many serious strikes got you here. If you think this is a mistake, email us using the contact info below. We'll take a look.",
  },
  {
    id: "strike-expire",
    category: "Strikes & Suspensions",
    question: "When do strikes go away?",
    answer:
      "Each one expires on its own, usually after 30 to 90 days. Your banner tells you when the next one ends.",
  },
  {
    id: "avoid-strikes",
    category: "Strikes & Suspensions",
    question: "How do I stay out of trouble?",
    answer:
      "Show up on time. Give a day's notice if you really have to cancel. Never share your phone or outside links in chat. Be honest if someone reports you.",
  },
  {
    id: "appeal-strike",
    category: "Strikes & Suspensions",
    question: "Can I fight a strike I think is unfair?",
    answer:
      "Yes! Email us with what happened. Add the session ID if you have it. An admin will look into it and can remove the strike if it shouldn't be there.",
  },

  // Account
  {
    id: "change-password",
    category: "Account",
    question: "How do I change my password?",
    answer:
      "Log out, then tap 'Forgot password' on the login screen. We'll email you a reset link. Going through email is safer than a form inside the app.",
  },
  {
    id: "delete-account",
    category: "Account",
    question: "How do I delete my account?",
    answer:
      "Email us asking to delete it. We'll cancel your plan, sort out any leftover credits, and remove your info. Your old reviews stay (with no name on them) so other people's ratings still make sense.",
  },
  {
    id: "dark-mode",
    category: "Account",
    question: "How do I turn on dark mode?",
    answer:
      "Tap the sun or moon icon at the top of the app. It flips between light, dark, and follow-your-phone modes.",
  },
  {
    id: "message-blocked",
    category: "Account",
    question: "Why was my message blocked?",
    answer:
      "We don't allow phone numbers, emails, or links to Zoom, Google Meet, Teams, and so on. It keeps everyone safe and keeps payments fair. Just say what you wanted to say without those bits.",
  },

  // Support
  {
    id: "report-user",
    category: "Support",
    question: "How do I report someone?",
    answer:
      "Open their profile or the session page and tap Report. Pick a reason and tell us what happened. An admin reads every report. Please only use it when something really went wrong.",
  },
  {
    id: "contact-support",
    category: "Support",
    question: "How do I talk to a real person?",
    answer:
      "Email support@skillswap.app. Tell us your account email and what's going on. Add screenshots if they help. We'll get back to you.",
  },
];
