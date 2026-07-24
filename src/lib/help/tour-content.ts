import {
  Sparkles,
  LayoutDashboard,
  Lightbulb,
  UserRoundSearch,
  CalendarCheck,
  Video,
  FileText,
  ShieldCheck,
  Dumbbell,
  ArrowLeftRight,
  MessageSquare,
  User as UserIcon,
  Star,
  Coins,
} from "lucide-react";
import type { ElementType } from "react";

export type TourCard = {
  id: string;
  icon: ElementType;
  title: string;
  body: string;
  bullets?: string[];
  cta?: { label: string; to: string };
};

export const TOUR_CARDS: TourCard[] = [
  {
    id: "welcome",
    icon: Sparkles,
    title: "Hey, welcome!",
    body: "SkillSwap is where students teach each other. No cash between us. You trade credits, or swap skills straight across.",
    bullets: [
      "Teach something you know. Earn credits.",
      "Learn something new. Spend credits.",
      "You start with 10 credits, free.",
      "The app itself costs $2 a month.",
    ],
  },
  {
    id: "dashboard",
    icon: LayoutDashboard,
    title: "Your home page",
    body: "Everything that needs you lives on the dashboard.",
    bullets: [
      "Your next sessions, with a Join button when it's time.",
      "Requests waiting on your answer.",
      "Swap offers from other students.",
      "Your credit balance and your streak.",
    ],
    cta: { label: "Take me there", to: "/dashboard" },
  },
  {
    id: "suggestions",
    icon: Lightbulb,
    title: "Suggestions",
    body: "Four cards on your dashboard telling you what's worth doing next. They come from your own activity in the app, not from a chatbot.",
    bullets: [
      "A teacher who fits what you want to learn.",
      "A skill people are asking for that you already teach.",
      "A swap that would work in both directions.",
      "Anything missing from your profile that costs you bookings.",
      "Tap a card to act on it. Tap refresh for a different set.",
    ],
    cta: { label: "Show me", to: "/dashboard" },
  },
  {
    id: "explore",
    icon: UserRoundSearch,
    title: "Find people",
    body: "Browse everyone on SkillSwap.",
    bullets: [
      "Search by skill or by name.",
      "Flip between Teachers and Learners.",
      "Blue ticks mean that skill has been quiz-verified.",
      "Press Ctrl+K anywhere to search fast.",
    ],
    cta: { label: "Start browsing", to: "/explore" },
  },
  {
    id: "booking",
    icon: CalendarCheck,
    title: "Book a session",
    body: "Pick someone, pick a length, pick a free time, send the request.",
    bullets: [
      "Sessions run 20, 30, or 60 minutes.",
      "Need a course? Book up to 7 at once.",
      "Your credits are only held once they accept.",
      "Times you or they are already booked are hidden.",
      "Cancel more than 2 hours ahead and it costs you nothing.",
    ],
    cta: { label: "Find a teacher", to: "/explore" },
  },
  {
    id: "video",
    icon: Video,
    title: "The video room",
    body: "Every accepted session gets its own private room inside SkillSwap. No links to send.",
    bullets: [
      "Join opens 10 minutes before the start.",
      "Only the two of you can get in.",
      "Add the session to Google Calendar or Outlook first if you like.",
    ],
  },
  {
    id: "ai-notes",
    icon: FileText,
    title: "AI Session Notes",
    body: "Record a lesson and get it written up for you. Both of you get the same notes.",
    bullets: [
      "Tap Record in the call. The other person has to accept first.",
      "You get a summary, key topics, takeaways, action items, and open questions.",
      "Download it as a PDF any time afterwards.",
      "The audio is deleted as soon as the notes are written.",
      "Recording needs Chrome or Edge on a computer.",
    ],
  },
  {
    id: "verify",
    icon: ShieldCheck,
    title: "Get verified",
    body: "Prove a skill you teach and wear a blue tick for it.",
    bullets: [
      "10 questions, 5 minutes, 7 right to pass.",
      "Tested at the level you say you teach.",
      "Failed? Try that skill again in 24 hours.",
      "You see every answer explained afterwards.",
      "Free, and verified teachers get booked more.",
    ],
    cta: { label: "Verify a skill", to: "/profile" },
  },
  {
    id: "practice",
    icon: Dumbbell,
    title: "Practice on your own",
    body: "Endless multiple-choice problems on any skill, with the answer explained straight away.",
    bullets: [
      "Pick Easy, Medium, or Hard.",
      "Drill the skills you're learning, or any skill in the catalog.",
      "Solved, attempted, and accuracy are tracked for you.",
      "No credits, no pressure. Great warm-up before you verify.",
    ],
    cta: { label: "Start practising", to: "/practice" },
  },
  {
    id: "swaps",
    icon: ArrowLeftRight,
    title: "Swap skills directly",
    body: "You teach them, they teach you, and nobody spends a credit.",
    bullets: [
      "Propose a swap from anyone's profile.",
      "Pick one skill each and a time for both lessons.",
      "They accept both or neither.",
      "Perfect for when you're low on credits.",
    ],
    cta: { label: "Find a match", to: "/explore" },
  },
  {
    id: "messages",
    icon: MessageSquare,
    title: "Chat with each other",
    body: "Message anyone straight from their profile. You don't have to book first.",
    bullets: [
      "Messages are live, no refresh needed.",
      "Send images and documents up to 5 MB.",
      "Phone numbers and outside meeting links are blocked, which keeps sessions and refunds safe.",
      "Insults, threats, and hate speech get you a strike.",
    ],
    cta: { label: "Open Messages", to: "/messages" },
  },
  {
    id: "profile",
    icon: UserIcon,
    title: "Your profile",
    body: "This is how people find you. Make it count.",
    bullets: [
      "List what you can teach and what you want to learn.",
      "Add a photo. People trust faces.",
      "Set your weekly free hours, or nobody can book you.",
      "Verify your teaching skills to stand out.",
    ],
    cta: { label: "Edit my profile", to: "/profile" },
  },
  {
    id: "reviews",
    icon: Star,
    title: "Leave a review",
    body: "After a session, both of you can rate each other from the Sessions page.",
    bullets: [
      "Give 1 to 5 stars.",
      "Add a short note if you like.",
      "Reviews show on the other person's profile.",
    ],
    cta: { label: "Open Sessions", to: "/history" },
  },
  {
    id: "credits",
    icon: Coins,
    title: "Credits and settings",
    body: "Keep an eye on your balance and make the app yours.",
    bullets: [
      "Every credit earned, spent, held, or refunded is listed.",
      "Teaching is how you top up. Swaps cost nothing at all.",
      "Switch between light, dark, and system themes in the header.",
      "Cancel your $2 plan whenever. No questions asked.",
    ],
    cta: { label: "Manage credits", to: "/credits" },
  },
];
