import {
  Sparkles,
  LayoutDashboard,
  Brain,
  UserRoundSearch,
  CalendarCheck,
  MessageSquare,
  User as UserIcon,
  Star,
  Settings,
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
    body: "SkillSwap is where students teach each other. No cash between us. We use credits.",
    bullets: [
      "Teach something you know. Earn credits.",
      "Learn something new. Spend credits.",
      "The app costs $2 a month to use.",
    ],
  },
  {
    id: "dashboard",
    icon: LayoutDashboard,
    title: "Your home page",
    body: "Everything important lives on your dashboard.",
    bullets: [
      "See your upcoming sessions.",
      "Check your credit balance.",
      "Jump to Explore, Messages, or your Profile.",
    ],
    cta: { label: "Take me there", to: "/dashboard" },
  },
  {
    id: "ai-insights",
    icon: Brain,
    title: "AI tips just for you",
    body: "Your dashboard shows smart suggestions picked for you. They get better the more you use the app.",
    bullets: [
      "Skills that are popular right now.",
      "Teachers we think you'll like.",
      "What to learn next.",
      "Tips to make your profile stronger.",
      "Updates every 6 hours. Tap refresh any time.",
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
      "Tap a card to see the full profile.",
      "Flip between Teachers and Learners.",
    ],
    cta: { label: "Start browsing", to: "/explore" },
  },
  {
    id: "booking",
    icon: CalendarCheck,
    title: "Book a session",
    body: "Pick someone, pick a time, send the request.",
    bullets: [
      "Your credits are held once they accept.",
      "Need to change the time? Both of you have to agree.",
      "Cancelling at the last minute can give you a strike.",
    ],
    cta: { label: "Find a teacher", to: "/explore" },
  },
  {
    id: "messages",
    icon: MessageSquare,
    title: "Chat with each other",
    body: "Talk before or after a session.",
    bullets: [
      "Messages are live, no refresh needed.",
      "Sessions happen inside our video call.",
      "Sharing phone numbers or outside links is blocked to keep everyone safe.",
    ],
    cta: { label: "Open Messages", to: "/messages" },
  },
  {
    id: "profile",
    icon: UserIcon,
    title: "Your profile",
    body: "This is how people find you. Make it count.",
    bullets: [
      "List what you can teach.",
      "List what you want to learn.",
      "Add a photo. People trust faces.",
      "Set when you're free.",
    ],
    cta: { label: "Edit my profile", to: "/profile" },
  },
  {
    id: "reviews",
    icon: Star,
    title: "Leave a review",
    body: "After a session, both of you can rate each other.",
    bullets: [
      "Give 1 to 5 stars.",
      "Add a short note if you like.",
      "Reviews show on the other person's profile.",
    ],
  },
  {
    id: "settings",
    icon: Settings,
    title: "Settings and credits",
    body: "Make the app yours.",
    bullets: [
      "Switch to dark mode any time.",
      "Top up your credits when you run low.",
      "Cancel your $2 plan whenever. No questions asked.",
    ],
    cta: { label: "Manage credits", to: "/credits" },
  },
];
