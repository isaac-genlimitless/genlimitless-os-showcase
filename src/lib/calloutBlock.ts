// Shared definition of the Files editor's "callout" block (Notion-style box with an emoji and a
// color). Plain TS, no React: used by the browser editor and the server markdown converter.

export const CALLOUT_COLORS = ["gray", "blue", "green", "yellow", "red", "purple", "orange", "pink"] as const;

export const CALLOUT_ICONS = [
  "💡", "📌", "⚠️", "❗", "❓", "✅", "❌", "🔥",
  "⭐", "🚀", "🎯", "📝", "📣", "🔒", "💬", "🧠",
  "📅", "💰", "🛠️", "🔎", "👉", "❤️", "🎉", "📎",
];

export const calloutConfig = {
  type: "callout",
  propSchema: {
    icon: { default: "💡" },
    color: { default: "gray" },
  },
  content: "inline",
} as const;
