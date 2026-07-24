import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Pause, Play, Search, Sparkles, Volume2, VolumeX } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOUR_CARDS, type TourCard } from "@/lib/help/tour-content";
import { FAQ_CATEGORIES, FAQ_ENTRIES } from "@/lib/help/faq-content";
import { useSpeech } from "@/lib/help/use-speech";

const VOICE_PREF_KEY = "skillswap-help-voice";

function buildNarration(card: TourCard): string {
  const parts = [card.title, card.body];
  if (card.bullets && card.bullets.length > 0) parts.push(card.bullets.join(". "));
  return parts.join(". ");
}

type HelpAssistantProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function HelpAssistant({ open, onOpenChange }: HelpAssistantProps) {
  const [tab, setTab] = useState<"tour" | "faq">("tour");
  const [query, setQuery] = useState("");
  const [openFaqId, setOpenFaqId] = useState<string>("");
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(VOICE_PREF_KEY) !== "off";
  });
  const navigate = useNavigate();
  const { speakingId, ready: voiceReady, speak, stop } = useSpeech();

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VOICE_PREF_KEY, voiceEnabled ? "on" : "off");
    if (!voiceEnabled) stop();
  }, [voiceEnabled, stop]);

  useEffect(() => {
    if (!open) stop();
  }, [open, stop]);

  useEffect(() => {
    if (tab !== "tour") stop();
  }, [tab, stop]);

  const handlePlayCard = (card: TourCard) => {
    if (speakingId === card.id) {
      stop();
      return;
    }
    speak(card.id, buildNarration(card));
  };

  const filteredFaq = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FAQ_ENTRIES;
    return FAQ_ENTRIES.filter(
      (entry) =>
        entry.question.toLowerCase().includes(q) ||
        entry.answer.toLowerCase().includes(q) ||
        entry.category.toLowerCase().includes(q),
    );
  }, [query]);

  const groupedFaq = useMemo(() => {
    return FAQ_CATEGORIES.map((category) => ({
      category,
      entries: filteredFaq.filter((entry) => entry.category === category),
    })).filter((group) => group.entries.length > 0);
  }, [filteredFaq]);

  const handleNavigate = (to: string) => {
    stop();
    onOpenChange(false);
    void navigate({ to });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full flex-col gap-0 border-l border-border/50 bg-background/95 p-0 backdrop-blur-xl sm:max-w-md",
          "ease-[cubic-bezier(0.32,0.72,0,1)]",
          "data-[state=open]:duration-500 data-[state=closed]:duration-400",
          "data-[state=open]:ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:ease-[cubic-bezier(0.32,0.72,0,1)]",
        )}
      >
        <SheetHeader className="border-b border-border/50 px-6 pb-4 pt-6 text-left">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl gradient-brand text-white shadow-glow">
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base font-semibold">SkillSwap Guide</SheetTitle>
              <SheetDescription className="text-xs">
                New here? Take the tour. Got a question? Try the FAQ.
              </SheetDescription>
            </div>
            {voiceReady && (
              <button
                type="button"
                onClick={() => setVoiceEnabled((v) => !v)}
                aria-label={voiceEnabled ? "Turn voice off" : "Turn voice on"}
                title={voiceEnabled ? "Voice on" : "Voice off"}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/50",
                  "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  voiceEnabled && "bg-primary/10 text-primary",
                )}
              >
                {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            )}
          </div>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "tour" | "faq")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-border/50 px-6 pt-4">
            <TabsList className="grid w-full grid-cols-2 rounded-xl">
              <TabsTrigger value="tour" className="rounded-lg">
                Tour
              </TabsTrigger>
              <TabsTrigger value="faq" className="rounded-lg">
                FAQ
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value="tour"
            className="m-0 min-h-0 flex-1 overflow-y-auto px-6 py-5 data-[state=inactive]:hidden"
          >
            <div className="space-y-4">
              {TOUR_CARDS.map((card, index) => {
                const Icon = card.icon;
                return (
                  <article
                    key={card.id}
                    className={cn(
                      "group rounded-2xl border border-border/50 glass p-5",
                      "transition-[transform,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                      "hover:-translate-y-0.5 hover:shadow-glow",
                    )}
                  >
                    <header className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl gradient-brand text-white">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Step {index + 1} of {TOUR_CARDS.length}
                        </p>
                        <h3 className="mt-0.5 text-sm font-semibold text-foreground">
                          {card.title}
                        </h3>
                      </div>
                      {voiceEnabled && voiceReady && (
                        <button
                          type="button"
                          onClick={() => handlePlayCard(card)}
                          aria-label={
                            speakingId === card.id
                              ? `Stop reading ${card.title}`
                              : `Read ${card.title} aloud`
                          }
                          title={speakingId === card.id ? "Stop" : "Listen"}
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                            "transition-[background,color,transform] duration-200",
                            speakingId === card.id
                              ? "bg-primary text-primary-foreground shadow-glow"
                              : "border border-border/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {speakingId === card.id ? (
                            <Pause className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </header>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {card.body}
                    </p>
                    {card.bullets && card.bullets.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {card.bullets.map((bullet, i) => (
                          <li
                            key={i}
                            className="flex gap-2 text-sm leading-relaxed text-foreground/80"
                          >
                            <span
                              aria-hidden
                              className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary"
                            />
                            <span>{bullet}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {card.cta && (
                      <div className="mt-4">
                        <Button
                          variant="hero"
                          size="sm"
                          onClick={() => handleNavigate(card.cta!.to)}
                          className="gap-1.5"
                        >
                          {card.cta.label}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </article>
                );
              })}

              <p className="pt-2 text-center text-xs text-muted-foreground">
                That's it! Tap the help button any time to come back.
              </p>
            </div>
          </TabsContent>

          <TabsContent
            value="faq"
            className="m-0 min-h-0 flex-1 overflow-y-auto px-6 py-5 data-[state=inactive]:hidden"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search help…"
                className="h-10 rounded-xl pl-9"
              />
            </div>

            <div className="mt-5 space-y-6">
              {groupedFaq.length === 0 && (
                <p className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-6 text-center text-sm text-muted-foreground">
                  Nothing matches "{query}". Try a different word, or check the Tour tab.
                </p>
              )}

              {groupedFaq.map((group) => (
                <section key={group.category}>
                  <h3 className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.category}
                  </h3>
                  <div className="rounded-2xl border border-border/50 glass">
                    <Accordion
                      type="single"
                      collapsible
                      value={openFaqId}
                      onValueChange={setOpenFaqId}
                      className="px-4"
                    >
                      {group.entries.map((entry, idx) => (
                        <AccordionItem
                          key={entry.id}
                          value={entry.id}
                          className={cn(
                            "border-border/40",
                            idx === group.entries.length - 1 && "border-b-0",
                          )}
                        >
                          <AccordionTrigger className="text-sm font-medium hover:no-underline">
                            {entry.question}
                          </AccordionTrigger>
                          <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                            {entry.answer}
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                </section>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
