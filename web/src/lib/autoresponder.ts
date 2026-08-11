// Auto-responder presets + preview builder. Keep the copy in sync with the
// backend in supabase/functions/_shared/autorespond.ts.

export type Preset =
  | "on_location"
  | "client_meetings"
  | "deep_work"
  | "ooo"
  | "custom";

export type AutoResponderSettings = {
  enabled: boolean;
  preset: Preset;
  custom_message: string | null;
  respond_quo: boolean;
  respond_slack: boolean;
  cooldown_hours: number;
};

export const DEFAULT_SETTINGS: AutoResponderSettings = {
  enabled: false,
  preset: "on_location",
  custom_message: null,
  respond_quo: true,
  respond_slack: true,
  cooldown_hours: 4,
};

const PRESET_STATUS: Record<Exclude<Preset, "custom">, string> = {
  on_location: "directing an event on location",
  client_meetings: "in client strategy meetings",
  deep_work: "in a focused work block",
  ooo: "out of the office",
};

export const PRESETS: { key: Preset; label: string; hint: string }[] = [
  { key: "on_location", label: "On location", hint: "Directing an event / shoot" },
  { key: "client_meetings", label: "Client meetings", hint: "In strategy sessions" },
  { key: "deep_work", label: "Deep work", hint: "Focused work block" },
  { key: "ooo", label: "Out of office", hint: "Away with limited availability" },
  { key: "custom", label: "Custom", hint: "Write your own" },
];

export const CUSTOM_SCAFFOLD =
  "Hi, this is Eric's AI assistant — Eric is [type your status]. Noted: [paraphrase request]. He'll follow up soon; reply URGENT if it can't wait.";

// Builds the message exactly as the backend will, using a sample paraphrase so
// Eric can preview it. The real send fills in [paraphrase request] from the AI.
export function previewMessage(
  settings: AutoResponderSettings,
  paraphrase = "a booking question",
): string {
  if (settings.preset === "custom") {
    const base = (settings.custom_message ?? "").trim() || CUSTOM_SCAFFOLD;
    return base.replaceAll("[paraphrase request]", paraphrase);
  }
  const status = PRESET_STATUS[settings.preset];
  const closing = settings.preset === "ooo"
    ? "He'll follow up on his return; reply URGENT if it can't wait."
    : "He'll follow up soon; reply URGENT if it can't wait.";
  return `Hi, this is Eric's AI assistant — Eric is ${status}. Noted: ${paraphrase}. ${closing}`;
}
