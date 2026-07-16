/**
 * @oxpulse/chat-widget — Curated emoji dataset for the emoji picker (#127).
 *
 * Zero-third-party-dep: no emoji-mart. ~180 emojis across 8 categories
 * with search keywords. Compact enough for the CDN bundle budget.
 *
 * Each entry: [emoji, name, keywords[]]
 * Search matches against name (case-insensitive) + keywords.
 */

export interface EmojiEntry {
  char: string;
  name: string;
  keywords: string[];
}

export interface EmojiCategory {
  id: string;
  label: string;
  labelRu: string;
  emojis: EmojiEntry[];
}

// ── Dataset ──────────────────────────────────────────────────────────────────

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "Smileys & People",
    labelRu: "Смайлы и люди",
    emojis: [
      { char: "😀", name: "grinning", keywords: ["smile", "happy", "joy"] },
      { char: "😃", name: "smiley", keywords: ["smile", "happy", "joy"] },
      { char: "😄", name: "grin", keywords: ["smile", "happy", "joy"] },
      { char: "😁", name: "grin beam", keywords: ["smile", "happy"] },
      { char: "😆", name: "laughing", keywords: ["laugh", "happy", "lol"] },
      { char: "😅", name: "sweat smile", keywords: ["laugh", "happy"] },
      { char: "🤣", name: "rofl", keywords: ["laugh", "lol", "funny"] },
      { char: "😂", name: "joy", keywords: ["laugh", "cry", "lol", "funny"] },
      { char: "🙂", name: "slight smile", keywords: ["smile", "happy"] },
      { char: "😉", name: "wink", keywords: ["flirt", "joke"] },
      { char: "😊", name: "blush", keywords: ["smile", "happy", "shy"] },
      { char: "😍", name: "heart eyes", keywords: ["love", "adore", "crush"] },
      { char: "🥰", name: "smiling heart", keywords: ["love", "affection"] },
      { char: "😘", name: "kiss", keywords: ["love", "affection"] },
      { char: "😎", name: "cool", keywords: ["sunglasses", "cool"] },
      { char: "🤩", name: "star struck", keywords: ["wow", "amazing"] },
      { char: "🤔", name: "thinking", keywords: ["think", "hmm", "wonder"] },
      { char: "🤨", name: "raised eyebrow", keywords: ["skeptical", "suspect"] },
      { char: "😐", name: "neutral", keywords: ["meh", "indifferent"] },
      { char: "😑", name: "expressionless", keywords: ["meh", "blank"] },
      { char: "🙄", name: "rolling eyes", keywords: ["annoyed", "whatever"] },
      { char: "😏", name: "smirk", keywords: ["smug", "flirt"] },
      { char: "😴", name: "sleep", keywords: ["tired", "bored", "zzz"] },
      { char: "😪", name: "sleepy", keywords: ["tired", "sleepy"] },
      { char: "😢", name: "cry", keywords: ["sad", "tear"] },
      { char: "😭", name: "sob", keywords: ["cry", "sad", "tear"] },
      { char: "😤", name: "triumph", keywords: ["angry", "frustrated"] },
      { char: "😡", name: "angry", keywords: ["mad", "rage"] },
      { char: "🤬", name: "cursing", keywords: ["angry", "swear"] },
      { char: "😱", name: "scream", keywords: ["fear", "shock"] },
      { char: "😨", name: "fearful", keywords: ["scared", "afraid"] },
      { char: "🥳", name: "party", keywords: ["celebrate", "birthday"] },
      { char: "🤯", name: "mind blown", keywords: ["shock", "wow"] },
      { char: "🥺", name: "pleading", keywords: ["beg", "cute"] },
      { char: "😅", name: "sweat", keywords: ["nervous", "phew"] },
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    labelRu: "Жесты",
    emojis: [
      { char: "👍", name: "thumbs up", keywords: ["yes", "ok", "good", "like"] },
      { char: "👎", name: "thumbs down", keywords: ["no", "bad", "dislike"] },
      { char: "👌", name: "ok", keywords: ["ok", "yes", "good"] },
      { char: "✌️", name: "peace", keywords: ["victory", "peace"] },
      { char: "🤞", name: "fingers crossed", keywords: ["luck", "hope"] },
      { char: "🤟", name: "love you", keywords: ["love", "rock"] },
      { char: "🤙", name: "call me", keywords: ["phone", "call"] },
      { char: "👋", name: "wave", keywords: ["hello", "hi", "bye"] },
      { char: "🤚", name: "raised back", keywords: ["stop", "hand"] },
      { char: "✋", name: "stop", keywords: ["stop", "hand", "halt"] },
      { char: "👏", name: "clap", keywords: ["applause", "praise"] },
      { char: "🙌", name: "raised hands", keywords: ["praise", "celebrate"] },
      { char: "🙏", name: "pray", keywords: ["please", "thanks", "hope"] },
      { char: "💪", name: "muscle", keywords: ["strong", "flex"] },
      { char: "🤝", name: "handshake", keywords: ["deal", "agreement"] },
      { char: "✍️", name: "write", keywords: ["write", "note"] },
    ],
  },
  {
    id: "hearts",
    label: "Hearts & Symbols",
    labelRu: "Сердца и символы",
    emojis: [
      { char: "❤️", name: "red heart", keywords: ["love", "heart"] },
      { char: "🧡", name: "orange heart", keywords: ["love", "heart"] },
      { char: "💛", name: "yellow heart", keywords: ["love", "heart"] },
      { char: "💚", name: "green heart", keywords: ["love", "heart"] },
      { char: "💙", name: "blue heart", keywords: ["love", "heart"] },
      { char: "💜", name: "purple heart", keywords: ["love", "heart"] },
      { char: "🖤", name: "black heart", keywords: ["love", "heart"] },
      { char: "🤍", name: "white heart", keywords: ["love", "heart"] },
      { char: "💔", name: "broken heart", keywords: ["sad", "heartbreak"] },
      { char: "❣️", name: "heart exclamation", keywords: ["love", "heart"] },
      { char: "💕", name: "two hearts", keywords: ["love", "affection"] },
      { char: "💞", name: "revolving hearts", keywords: ["love", "affection"] },
      { char: "💓", name: "beating heart", keywords: ["love", "pulse"] },
      { char: "✨", name: "sparkles", keywords: ["shine", "magic"] },
      { char: "⭐", name: "star", keywords: ["star", "favorite"] },
      { char: "🌟", name: "glowing star", keywords: ["star", "shine"] },
      { char: "💫", name: "dizzy", keywords: ["star", "spiral"] },
      { char: "🔥", name: "fire", keywords: ["hot", "lit", "cool"] },
      { char: "💥", name: "explosion", keywords: ["boom", "bang"] },
      { char: "💯", name: "hundred", keywords: ["100", "perfect", "cool"] },
      { char: "✅", name: "check", keywords: ["done", "ok", "yes"] },
      { char: "❌", name: "cross", keywords: ["no", "wrong", "cancel"] },
      { char: "❓", name: "question", keywords: ["what", "confused"] },
      { char: "❗", name: "exclamation", keywords: ["important", "alert"] },
      { char: "⚠️", name: "warning", keywords: ["alert", "caution"] },
      { char: "🚫", name: "prohibited", keywords: ["no", "forbidden"] },
    ],
  },
  {
    id: "celebration",
    label: "Celebration",
    labelRu: "Праздник",
    emojis: [
      { char: "🎉", name: "party popper", keywords: ["party", "celebrate"] },
      { char: "🎊", name: "confetti", keywords: ["party", "celebrate"] },
      { char: "🎈", name: "balloon", keywords: ["party", "birthday"] },
      { char: "🎂", name: "birthday cake", keywords: ["birthday", "cake"] },
      { char: "🎁", name: "gift", keywords: ["present", "gift"] },
      { char: "🏆", name: "trophy", keywords: ["win", "award"] },
      { char: "🥇", name: "gold medal", keywords: ["first", "win"] },
      { char: "🥈", name: "silver medal", keywords: ["second"] },
      { char: "🥉", name: "bronze medal", keywords: ["third"] },
      { char: "🍾", name: "champagne", keywords: ["celebrate", "party"] },
      { char: "🥂", name: "cheers", keywords: ["celebrate", "toast"] },
      { char: "🍻", name: "beers", keywords: ["drink", "party"] },
    ],
  },
  {
    id: "animals",
    label: "Animals & Nature",
    labelRu: "Животные и природа",
    emojis: [
      { char: "🐶", name: "dog", keywords: ["pet", "puppy"] },
      { char: "🐱", name: "cat", keywords: ["pet", "kitten"] },
      { char: "🐭", name: "mouse", keywords: ["rodent"] },
      { char: "🐹", name: "hamster", keywords: ["pet", "rodent"] },
      { char: "🐰", name: "rabbit", keywords: ["bunny", "pet"] },
      { char: "🦊", name: "fox", keywords: ["animal"] },
      { char: "🐻", name: "bear", keywords: ["animal"] },
      { char: "🐼", name: "panda", keywords: ["animal"] },
      { char: "🐨", name: "koala", keywords: ["animal"] },
      { char: "🦁", name: "lion", keywords: ["animal"] },
      { char: "🐯", name: "tiger", keywords: ["animal"] },
      { char: "🐸", name: "frog", keywords: ["animal"] },
      { char: "🐵", name: "monkey", keywords: ["animal"] },
      { char: "🦄", name: "unicorn", keywords: ["magic", "horse"] },
      { char: "🐝", name: "bee", keywords: ["insect", "bug"] },
      { char: "🦋", name: "butterfly", keywords: ["insect"] },
      { char: "🌸", name: "cherry blossom", keywords: ["flower", "spring"] },
      { char: "🌹", name: "rose", keywords: ["flower", "love"] },
      { char: "🌻", name: "sunflower", keywords: ["flower"] },
      { char: "🌳", name: "tree", keywords: ["nature", "plant"] },
      { char: "🌍", name: "earth", keywords: ["world", "planet"] },
      { char: "🌙", name: "moon", keywords: ["night", "space"] },
      { char: "☀️", name: "sun", keywords: ["weather", "hot"] },
      { char: "⚡", name: "lightning", keywords: ["storm", "fast"] },
      { char: "🌈", name: "rainbow", keywords: ["color", "sky"] },
    ],
  },
  {
    id: "food",
    label: "Food & Drink",
    labelRu: "Еда и напитки",
    emojis: [
      { char: "🍎", name: "apple", keywords: ["fruit"] },
      { char: "🍌", name: "banana", keywords: ["fruit"] },
      { char: "🍇", name: "grapes", keywords: ["fruit", "wine"] },
      { char: "🍓", name: "strawberry", keywords: ["fruit"] },
      { char: "🍕", name: "pizza", keywords: ["food"] },
      { char: "🍔", name: "burger", keywords: ["food"] },
      { char: "🍟", name: "fries", keywords: ["food"] },
      { char: "🌮", name: "taco", keywords: ["food"] },
      { char: "🍣", name: "sushi", keywords: ["food", "japanese"] },
      { char: "🍜", name: "noodles", keywords: ["food", "ramen"] },
      { char: "🍦", name: "ice cream", keywords: ["dessert", "sweet"] },
      { char: "🍰", name: "cake", keywords: ["dessert", "sweet"] },
      { char: "🍫", name: "chocolate", keywords: ["dessert", "sweet"] },
      { char: "☕", name: "coffee", keywords: ["drink", "morning"] },
      { char: "🍵", name: "tea", keywords: ["drink"] },
      { char: "🍺", name: "beer", keywords: ["drink"] },
      { char: "🍷", name: "wine", keywords: ["drink"] },
      { char: "🥤", name: "soda", keywords: ["drink"] },
    ],
  },
  {
    id: "activities",
    label: "Activities",
    labelRu: "Активности",
    emojis: [
      { char: "⚽", name: "soccer", keywords: ["sport", "ball"] },
      { char: "🏀", name: "basketball", keywords: ["sport", "ball"] },
      { char: "🏈", name: "football", keywords: ["sport", "ball"] },
      { char: "🎾", name: "tennis", keywords: ["sport", "ball"] },
      { char: "🎮", name: "game", keywords: ["play", "video"] },
      { char: "🎯", name: "dart", keywords: ["game", "target"] },
      { char: "🎲", name: "dice", keywords: ["game", "random"] },
      { char: "🎵", name: "music", keywords: ["song", "note"] },
      { char: "🎸", name: "guitar", keywords: ["music", "rock"] },
      { char: "🎤", name: "mic", keywords: ["sing", "karaoke"] },
      { char: "📚", name: "books", keywords: ["read", "study"] },
      { char: "✏️", name: "pencil", keywords: ["write", "edit"] },
      { char: "💡", name: "idea", keywords: ["light", "think"] },
    ],
  },
  {
    id: "travel",
    label: "Travel & Objects",
    labelRu: "Путешествия и объекты",
    emojis: [
      { char: "🚗", name: "car", keywords: ["drive", "auto"] },
      { char: "✈️", name: "plane", keywords: ["fly", "travel"] },
      { char: "🚆", name: "train", keywords: ["travel", "rail"] },
      { char: "🚢", name: "ship", keywords: ["boat", "travel"] },
      { char: "🏠", name: "house", keywords: ["home", "building"] },
      { char: "🏢", name: "office", keywords: ["work", "building"] },
      { char: "🏫", name: "school", keywords: ["education"] },
      { char: "🏥", name: "hospital", keywords: ["health", "medical"] },
      { char: "🏪", name: "store", keywords: ["shop", "buy"] },
      { char: "📍", name: "pin", keywords: ["location", "map"] },
      { char: "🔔", name: "bell", keywords: ["alert", "notify"] },
      { char: "📱", name: "phone", keywords: ["mobile", "call"] },
      { char: "💻", name: "laptop", keywords: ["computer", "work"] },
      { char: "⏰", name: "alarm", keywords: ["time", "clock"] },
      { char: "🔑", name: "key", keywords: ["lock", "unlock"] },
      { char: "📦", name: "package", keywords: ["box", "delivery"] },
    ],
  },
];

/** Flat list of all emojis (for search). */
export const ALL_EMOJIS: EmojiEntry[] = EMOJI_CATEGORIES.flatMap((c) => c.emojis);

/** Search emojis by query string. Returns matching entries. */
export function searchEmojis(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return ALL_EMOJIS;
  return ALL_EMOJIS.filter((e) => {
    if (e.name.includes(q)) return true;
    return e.keywords.some((k) => k.includes(q));
  });
}
