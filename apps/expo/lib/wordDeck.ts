/**
 * Free flashcard deck, reviewed with spaced repetition. IDs are stored server-side, so never
 * rename an existing ID; add new cards instead.
 */

export interface WordCard {
  id: string;
  term: string;
  hindi: string;
  example: string;
  category: "everyday" | "work" | "phrases" | "feelings";
}

export const WORD_DECK: WordCard[] = [
  { id: "w-actually", term: "actually", hindi: "असल में, वास्तव में", example: "Actually, I prefer tea.", category: "everyday" },
  { id: "w-borrow", term: "borrow", hindi: "उधार लेना", example: "Can I borrow your charger?", category: "everyday" },
  { id: "w-lend", term: "lend", hindi: "उधार देना", example: "Could you lend me a pen?", category: "everyday" },
  { id: "w-commute", term: "commute", hindi: "रोज़ ऑफिस आना-जाना", example: "My commute takes an hour.", category: "everyday" },
  { id: "w-grocery", term: "groceries", hindi: "राशन, किराने का सामान", example: "I buy groceries on Sunday.", category: "everyday" },
  { id: "w-errand", term: "run an errand", hindi: "कोई छोटा काम निपटाना", example: "I need to run a few errands.", category: "everyday" },
  { id: "w-neighbour", term: "neighbour", hindi: "पड़ोसी", example: "Our neighbours are very friendly.", category: "everyday" },
  { id: "w-rent", term: "rent", hindi: "किराया", example: "The rent is due on the first.", category: "everyday" },
  { id: "w-appointment", term: "appointment", hindi: "मुलाक़ात का तय समय", example: "I have a doctor's appointment at 5.", category: "everyday" },
  { id: "w-crowded", term: "crowded", hindi: "भीड़ भरा", example: "The metro is crowded in the morning.", category: "everyday" },
  { id: "w-cancel", term: "cancel", hindi: "रद्द करना", example: "They cancelled the flight.", category: "everyday" },
  { id: "w-afford", term: "afford", hindi: "ख़र्च उठा पाना", example: "I can't afford a new car right now.", category: "everyday" },
  { id: "w-schedule", term: "schedule", hindi: "समय-सारणी, तय करना", example: "Let's schedule a call for Friday.", category: "work" },
  { id: "w-deadline", term: "deadline", hindi: "आख़िरी तारीख़", example: "The deadline is next Monday.", category: "work" },
  { id: "w-follow-up", term: "follow up", hindi: "बाद में फिर से संपर्क करना", example: "I'll follow up with the client tomorrow.", category: "work" },
  { id: "w-get-back", term: "get back to you", hindi: "आपको बाद में जवाब देना", example: "Let me check and get back to you.", category: "work" },
  { id: "w-colleague", term: "colleague", hindi: "सहकर्मी", example: "My colleague helped me with the report.", category: "work" },
  { id: "w-feedback", term: "feedback", hindi: "राय, प्रतिक्रिया", example: "Thanks for the feedback.", category: "work" },
  { id: "w-priority", term: "priority", hindi: "प्राथमिकता", example: "This task is our top priority.", category: "work" },
  { id: "w-update", term: "quick update", hindi: "छोटी-सी ताज़ा जानकारी", example: "Here's a quick update on the project.", category: "work" },
  { id: "w-agenda", term: "agenda", hindi: "बैठक के विषयों की सूची", example: "Please share the agenda before the meeting.", category: "work" },
  { id: "w-responsible", term: "responsible for", hindi: "किसी काम का ज़िम्मेदार", example: "I am responsible for testing.", category: "work" },
  { id: "w-experience", term: "experience", hindi: "अनुभव", example: "I have three years of experience in sales.", category: "work" },
  { id: "w-strength", term: "strength", hindi: "ताक़त, ख़ूबी", example: "My biggest strength is problem-solving.", category: "work" },
  { id: "w-improve", term: "improve", hindi: "सुधारना, बेहतर करना", example: "I want to improve my spoken English.", category: "work" },
  { id: "w-attend", term: "attend", hindi: "भाग लेना, हाज़िर होना", example: "I attended a workshop last week.", category: "work" },
  { id: "w-on-leave", term: "on leave", hindi: "छुट्टी पर", example: "She is on leave until Wednesday.", category: "work" },
  { id: "w-salary", term: "salary", hindi: "वेतन", example: "The salary is paid monthly.", category: "work" },
  { id: "w-promotion", term: "promotion", hindi: "पदोन्नति", example: "He got a promotion this year.", category: "work" },
  { id: "w-handle", term: "handle", hindi: "संभालना", example: "Can you handle this request?", category: "work" },
  { id: "w-how-about", term: "How about ...?", hindi: "... के बारे में क्या ख़याल है?", example: "How about lunch at 1?", category: "phrases" },
  { id: "w-make-sense", term: "That makes sense.", hindi: "यह बात समझ में आती है।", example: "Oh, that makes sense now.", category: "phrases" },
  { id: "w-no-worries", term: "No worries.", hindi: "कोई बात नहीं।", example: "No worries, take your time.", category: "phrases" },
  { id: "w-mind-if", term: "Do you mind if I ...?", hindi: "क्या आपको बुरा लगेगा अगर मैं ...?", example: "Do you mind if I open the window?", category: "phrases" },
  { id: "w-by-the-way", term: "by the way", hindi: "वैसे, बात-बात में", example: "By the way, congratulations!", category: "phrases" },
  { id: "w-on-my-way", term: "I'm on my way.", hindi: "मैं रास्ते में हूँ।", example: "I'm on my way, see you in ten minutes.", category: "phrases" },
  { id: "w-catch-up", term: "catch up", hindi: "मिलकर बातें करना, पीछे छूटा पूरा करना", example: "Let's catch up this weekend.", category: "phrases" },
  { id: "w-figure-out", term: "figure out", hindi: "समझ लेना, हल निकालना", example: "We'll figure out a solution.", category: "phrases" },
  { id: "w-look-forward", term: "look forward to", hindi: "किसी चीज़ का इंतज़ार होना", example: "I look forward to meeting you.", category: "phrases" },
  { id: "w-up-to-you", term: "It's up to you.", hindi: "यह आप पर निर्भर है।", example: "Tea or coffee? It's up to you.", category: "phrases" },
  { id: "w-run-late", term: "running late", hindi: "देर हो रही है", example: "Sorry, I'm running late.", category: "phrases" },
  { id: "w-take-care", term: "Take care.", hindi: "अपना ध्यान रखना।", example: "Bye, take care!", category: "phrases" },
  { id: "w-sounds-good", term: "Sounds good.", hindi: "ठीक है, बढ़िया।", example: "Lunch at one? Sounds good.", category: "phrases" },
  { id: "w-in-a-while", term: "in a while", hindi: "थोड़ी देर में", example: "I'll call you in a while.", category: "phrases" },
  { id: "w-same-here", term: "Same here.", hindi: "मेरे साथ भी ऐसा ही है।", example: "I'm tired. Same here.", category: "phrases" },
  { id: "w-excited", term: "excited", hindi: "उत्साहित", example: "I'm excited about the trip.", category: "feelings" },
  { id: "w-nervous", term: "nervous", hindi: "घबराया हुआ", example: "I feel nervous before interviews.", category: "feelings" },
  { id: "w-confident", term: "confident", hindi: "आत्मविश्वासी", example: "Practice makes you more confident.", category: "feelings" },
  { id: "w-disappointed", term: "disappointed", hindi: "निराश", example: "I was disappointed with the result.", category: "feelings" },
  { id: "w-relieved", term: "relieved", hindi: "राहत महसूस करना", example: "I was relieved when the exam was over.", category: "feelings" },
  { id: "w-frustrated", term: "frustrated", hindi: "झुंझलाया हुआ", example: "Slow internet makes me frustrated.", category: "feelings" },
  { id: "w-grateful", term: "grateful", hindi: "आभारी", example: "I'm grateful for your support.", category: "feelings" },
  { id: "w-proud", term: "proud of", hindi: "पर गर्व होना", example: "My parents are proud of me.", category: "feelings" },
  { id: "w-bored", term: "bored", hindi: "ऊबा हुआ", example: "I get bored on long flights.", category: "feelings" },
  { id: "w-curious", term: "curious", hindi: "जिज्ञासु", example: "I'm curious about how it works.", category: "feelings" },
  { id: "w-embarrassed", term: "embarrassed", hindi: "शर्मिंदा", example: "I was embarrassed when I forgot his name.", category: "feelings" },
  { id: "w-overwhelmed", term: "overwhelmed", hindi: "बहुत ज़्यादा बोझ महसूस करना", example: "I feel overwhelmed with work this week.", category: "feelings" },
  { id: "w-calm", term: "calm", hindi: "शांत", example: "Stay calm and speak slowly.", category: "feelings" },
  { id: "w-motivated", term: "motivated", hindi: "प्रेरित", example: "Small goals keep me motivated.", category: "feelings" },
  { id: "w-apologise", term: "apologise", hindi: "माफ़ी माँगना", example: "I apologise for the delay.", category: "feelings" },
];

/** Cards due today first (most-missed first), then new cards, up to `limit`. */
export function buildReviewQueue(
  cards: Record<string, { box?: number; due?: string }>,
  today: string,
  limit = 10
): WordCard[] {
  const due = WORD_DECK.filter((card) => cards[card.id]?.due && cards[card.id].due! <= today).sort(
    (a, b) => (cards[a.id]?.box ?? 0) - (cards[b.id]?.box ?? 0)
  );
  const fresh = WORD_DECK.filter((card) => !cards[card.id]);
  return [...due, ...fresh].slice(0, limit);
}

export function dueCount(cards: Record<string, { due?: string }>, today: string): number {
  return WORD_DECK.filter((card) => cards[card.id]?.due && cards[card.id].due! <= today).length;
}

/** Same phrase for everyone on a given day. */
export function phraseOfTheDay(today: string): WordCard {
  const phrases = WORD_DECK.filter((card) => card.category === "phrases");
  const dayNumber = Math.floor(new Date(`${today}T00:00:00Z`).getTime() / 86400000);
  return phrases[Math.abs(dayNumber) % phrases.length];
}
